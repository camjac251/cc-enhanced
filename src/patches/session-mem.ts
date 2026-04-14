import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch } from "../types.js";
import {
	getMemberPropertyName,
	getObjectKeyName,
	getVerifyAst,
} from "./ast-helpers.js";

/**
 * Expand session memory controls with env overrides.
 *
 * Session memory maintains a structured summary.md file with:
 * - Current state, task spec, files, workflow
 * - Errors & corrections, learnings, worklog
 *
 * Key behaviors:
 * 1. Extraction (creating/updating summary.md) - controlled by tengu_session_memory
 * 2. Past-session retrieval prompt - controlled by tengu_coral_fern
 * This patch adds:
 * - ENABLE_SESSION_MEMORY: extraction override (OR with the built-in flag)
 * - ENABLE_SESSION_MEMORY_PAST: past-session retrieval override
 * - CC_SM_PER_SECTION_TOKENS / CC_SM_TOTAL_FILE_LIMIT: section/total memory limits
 * - CC_SM_MINIMUM_MESSAGE_TOKENS_TO_INIT / CC_SM_MINIMUM_TOKENS_BETWEEN_UPDATE /
 *   CC_SM_TOOL_CALLS_BETWEEN_UPDATES: update thresholds
 */

function isProcessReference(node: t.Expression): boolean {
	if (t.isIdentifier(node)) return node.name === "process";
	if (!t.isMemberExpression(node)) return false;
	return (
		getMemberPropertyName(node) === "process" &&
		t.isIdentifier(node.object) &&
		node.object.name === "globalThis"
	);
}

function findTruthyCheckFn(ast: t.File): string | null {
	const scores = new Map<string, number>();
	const bump = (name: string, weight: number) => {
		scores.set(name, (scores.get(name) ?? 0) + weight);
	};

	traverse.default(ast, {
		CallExpression(path) {
			// Look for pattern: X(process.env.SOME_VAR)
			if (!t.isIdentifier(path.node.callee)) return;
			if (path.node.arguments.length !== 1) return;

			const arg = path.node.arguments[0];
			if (!t.isMemberExpression(arg)) return;
			if (!t.isMemberExpression(arg.object)) return;

			const innerObj = arg.object;
			if (!isProcessReference(innerObj.object)) return;
			if (getMemberPropertyName(innerObj) !== "env") return;

			const fnName = path.node.callee.name;
			// Any env helper call gets a baseline score.
			bump(fnName, 1);

			// Prefer helpers used directly as if-test predicates.
			const parent = path.parentPath;
			if (t.isIfStatement(parent?.node) && parent.node.test === path.node) {
				bump(fnName, 5);
				return;
			}

			// Also support negated and compound predicate forms:
			// if (!truthy(process.env.X)) ...
			if (
				t.isUnaryExpression(parent?.node, { operator: "!" }) &&
				parent.node.argument === path.node
			) {
				const grandParent = parent.parentPath;
				if (
					t.isIfStatement(grandParent?.node) &&
					grandParent.node.test === parent.node
				) {
					bump(fnName, 4);
					return;
				}
			}

			// if (truthy(process.env.X) || ...)
			if (
				t.isLogicalExpression(parent?.node) &&
				(parent.node.operator === "||" || parent.node.operator === "&&")
			) {
				const grandParent = parent.parentPath;
				if (
					t.isIfStatement(grandParent?.node) &&
					grandParent.node.test === parent.node
				) {
					bump(fnName, 3);
				}
			}
		},
	});

	if (scores.size === 0) return null;

	const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
	if (ranked.length === 1) return ranked[0][0];
	if (ranked[0][1] === ranked[1][1]) return null;
	return ranked[0][0];
}

function envMember(name: string): t.MemberExpression {
	return t.memberExpression(
		t.memberExpression(t.identifier("process"), t.identifier("env")),
		t.identifier(name),
	);
}

function numberFromEnv(
	primaryEnv: string,
	defaultValue: number,
	fallbackEnv?: string,
): t.CallExpression {
	let fallbackExpr: t.Expression = t.numericLiteral(defaultValue);
	if (fallbackEnv) {
		fallbackExpr = t.logicalExpression(
			"??",
			envMember(fallbackEnv),
			fallbackExpr,
		);
	}
	return t.callExpression(
		t.memberExpression(t.identifier("Math"), t.identifier("max")),
		[
			t.numericLiteral(1),
			t.logicalExpression(
				"||",
				t.callExpression(t.identifier("Number"), [
					t.logicalExpression("??", envMember(primaryEnv), fallbackExpr),
				]),
				t.numericLiteral(defaultValue),
			),
		],
	);
}

function isNullOrEmptyArrayReturn(node: t.Statement): boolean {
	if (t.isReturnStatement(node)) {
		if (t.isNullLiteral(node.argument)) return true;
		if (
			t.isArrayExpression(node.argument) &&
			node.argument.elements.length === 0
		) {
			return true;
		}
	}
	if (t.isBlockStatement(node) && node.body.length === 1) {
		return isNullOrEmptyArrayReturn(node.body[0]);
	}
	return false;
}

function isFlagCall(node: t.Node, flagName: string): boolean {
	if (!t.isCallExpression(node)) return false;
	if (node.arguments.length < 1) return false;
	return t.isStringLiteral(node.arguments[0], { value: flagName });
}

function nodeContainsFlagCall(node: t.Node, flagName: string): boolean {
	const visit = (value: unknown): boolean => {
		if (!value) return false;
		if (Array.isArray(value)) return value.some((item) => visit(item));
		if (typeof value !== "object") return false;
		const maybeNode = value as t.Node;
		if (typeof (maybeNode as { type?: unknown }).type !== "string")
			return false;
		if (isFlagCall(maybeNode, flagName)) return true;
		return Object.values(maybeNode as unknown as Record<string, unknown>).some(
			(child) => visit(child),
		);
	};
	return visit(node);
}

function isProcessEnvMember(
	node: t.Node | null | undefined,
	envName: string,
): boolean {
	if (!node || !t.isMemberExpression(node)) return false;
	if (getMemberPropertyName(node) !== envName) return false;
	if (!t.isMemberExpression(node.object)) return false;
	const envObject = node.object;
	if (getMemberPropertyName(envObject) !== "env") return false;
	if (!t.isExpression(envObject.object)) return false;
	return isProcessReference(envObject.object);
}

function nodeContainsEnvRef(node: t.Node, envName: string): boolean {
	const visit = (value: unknown): boolean => {
		if (!value) return false;
		if (Array.isArray(value)) return value.some((item) => visit(item));
		if (typeof value !== "object") return false;
		const maybeNode = value as t.Node;
		if (typeof (maybeNode as { type?: unknown }).type !== "string")
			return false;
		if (t.isIdentifier(maybeNode, { name: envName })) return true;
		return Object.values(maybeNode as unknown as Record<string, unknown>).some(
			(child) => visit(child),
		);
	};
	return visit(node);
}

function createSessionMemoryMutator(truthyFn: string): traverse.Visitor {
	let patchedExtraction = false;
	let patchedPastSessions = false;
	let patchedSectionLimits = false;
	let patchedThresholds = false;
    return {
		Function(path: any) {
			if (patchedExtraction) return;
			if (!t.isBlockStatement(path.node.body)) return;
			const body = path.node.body.body;
			// Must be a single return statement
			if (body.length !== 1 || !t.isReturnStatement(body[0])) return;

			const returnArg = body[0].argument;
			if (!t.isCallExpression(returnArg)) return;

			// Check for xK("tengu_session_memory", ...)
			const callee = returnArg.callee;
			if (!t.isIdentifier(callee)) return;

			const args = returnArg.arguments;
			if (args.length < 1) return;
			if (
				!t.isStringLiteral(args[0]) ||
				args[0].value !== "tengu_session_memory"
			)
				return;

			// Check if already patched - parent would be LogicalExpression
			const returnStmt = body[0];
			if (
				t.isReturnStatement(returnStmt) &&
				t.isLogicalExpression(returnStmt.argument)
			) {
				patchedExtraction = true;
				return;
			}

			// Build: truthyFn(process.env.ENABLE_SESSION_MEMORY)
			const envCheck = t.callExpression(t.identifier(truthyFn), [
				t.memberExpression(
					t.memberExpression(t.identifier("process"), t.identifier("env")),
					t.identifier("ENABLE_SESSION_MEMORY"),
				),
			]);

			// Replace return with: return truthyFn(process.env.ENABLE_SESSION_MEMORY) || xK(...)
			body[0].argument = t.logicalExpression("||", envCheck, returnArg);
			patchedExtraction = true;
			console.log(`Patched session memory with truthy fn: ${truthyFn}`);
		},
		IfStatement(path) {
			const test = path.node.test;

			// Skip already-patched nodes
			if (
				t.isLogicalExpression(test) &&
				nodeContainsEnvRef(test, "ENABLE_SESSION_MEMORY_PAST")
			) {
				patchedPastSessions = true;
				return;
			}

			const envPastCheck = t.callExpression(t.identifier(truthyFn), [
				envMember("ENABLE_SESSION_MEMORY_PAST"),
			]);

			// Pattern 1 (old): if (!flagCall("tengu_coral_fern", ...)) return null|[];
			if (
				t.isUnaryExpression(test, { operator: "!" }) &&
				isFlagCall(test.argument, "tengu_coral_fern") &&
				isNullOrEmptyArrayReturn(path.node.consequent)
			) {
				path.node.test = t.logicalExpression(
					"&&",
					t.unaryExpression("!", envPastCheck),
					test,
				);
				patchedPastSessions = true;
				return;
			}

			// Pattern 2 (new): if (flagCall("tengu_coral_fern", ...)) { ... }
			if (isFlagCall(test, "tengu_coral_fern")) {
				path.node.test = t.logicalExpression("||", envPastCheck, test);
				patchedPastSessions = true;
			}
		},
		VariableDeclaration(path) {
			const decls = path.node.declarations;
			const hasSessionTitleTemplate = decls.some(
				(d) =>
					t.isVariableDeclarator(d) &&
					t.isTemplateLiteral(d.init) &&
					d.init.quasis.some((q) => q.value.raw.includes("# Session Title")),
			);
			if (!hasSessionTitleTemplate) return;

			let touched = false;
			for (const decl of decls) {
				if (!t.isVariableDeclarator(decl) || !t.isNumericLiteral(decl.init))
					continue;
				if (decl.init.value === 2000) {
					decl.init = numberFromEnv("CC_SM_PER_SECTION_TOKENS", 2000);
					touched = true;
				} else if (decl.init.value === 12000) {
					decl.init = numberFromEnv(
						"CC_SM_TOTAL_FILE_LIMIT",
						12000,
						"CM_SM_TOTAL_FILE_LIMIT",
					);
					touched = true;
				}
			}
			if (touched) patchedSectionLimits = true;
		},
		ObjectExpression(path) {
			const props = path.node.properties.filter((p): p is t.ObjectProperty =>
				t.isObjectProperty(p),
			);
			const getProp = (name: string) =>
				props.find(
					(p) =>
						getObjectKeyName(p.key) === name && t.isNumericLiteral(p.value),
				);

            const minInit = getProp("minimumMessageTokensToInit");
            const minBetween = getProp("minimumTokensBetweenUpdate");
            const toolCalls = getProp("toolCallsBetweenUpdates");
			if (!minInit || !minBetween || !toolCalls) return;

			if (
				!(t.isNumericLiteral(minInit.value) && minInit.value.value === 10000) ||
				!(
					t.isNumericLiteral(minBetween.value) &&
					minBetween.value.value === 5000
				) ||
				!(t.isNumericLiteral(toolCalls.value) && toolCalls.value.value === 3)
			) {
				return;
			}

			minInit.value = numberFromEnv(
				"CC_SM_MINIMUM_MESSAGE_TOKENS_TO_INIT",
				10000,
			);
			minBetween.value = numberFromEnv(
				"CC_SM_MINIMUM_TOKENS_BETWEEN_UPDATE",
				5000,
			);
			toolCalls.value = numberFromEnv("CC_SM_TOOL_CALLS_BETWEEN_UPDATES", 3);
			patchedThresholds = true;
		},
		Program: {
			exit() {
				if (!patchedExtraction) {
					console.warn(
						"Session memory: Could not find tengu_session_memory function",
					);
				}
				if (!patchedPastSessions) {
					console.warn(
						"Session memory: Could not find tengu_coral_fern past-session gate",
					);
				}
				if (!patchedSectionLimits) {
					console.warn(
						"Session memory: Could not find session section/total token limits",
					);
				}
				if (!patchedThresholds) {
					console.warn(
						"Session memory: Could not find session update threshold defaults",
					);
				}
            },
        },
    };
}

export const sessionMemory: Patch = {
	tag: "session-mem",

	astPasses: (ast) => {
		const truthyFn = findTruthyCheckFn(ast);
		if (!truthyFn) {
			console.warn("Session memory: Could not find truthy check function");
			return [];
		}
		return [
			{
				pass: "mutate",
				visitor: createSessionMemoryMutator(truthyFn),
			},
		];
	},

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) {
			return "Unable to parse AST during session-memory verification";
		}

		let hasSessionMemoryInLogicalOr = false;
		let hasCoralFernCall = false;
		let hasOldCoralFernGuard = false;
		let hasPastSessionsEnv = false;

		// Env vars that must appear as arguments to call expressions
        const callScopedEnvVars = new Set([
            "CC_SM_PER_SECTION_TOKENS",
            "CC_SM_TOTAL_FILE_LIMIT",
            "CC_SM_MINIMUM_MESSAGE_TOKENS_TO_INIT",
            "CC_SM_MINIMUM_TOKENS_BETWEEN_UPDATE",
            "CC_SM_TOOL_CALLS_BETWEEN_UPDATES",
        ]);
		const seenCallScopedEnv = new Set<string>();

		traverse.default(verifyAst, {
			MemberExpression(path) {
				// ENABLE_SESSION_MEMORY must be in a LogicalExpression(||)
				if (isProcessEnvMember(path.node, "ENABLE_SESSION_MEMORY")) {
					const logicalParent = path.findParent((p) =>
						p.isLogicalExpression({ operator: "||" }),
					);
					if (logicalParent) {
						// The other side of the || should contain a tengu_session_memory call
						const logicalNode = logicalParent.node as t.LogicalExpression;
						if (
							nodeContainsEnvRef(logicalNode, "ENABLE_SESSION_MEMORY") &&
							(isFlagCall(logicalNode.left, "tengu_session_memory") ||
								isFlagCall(logicalNode.right, "tengu_session_memory") ||
								nodeContainsFlagCall(logicalNode, "tengu_session_memory"))
						) {
							hasSessionMemoryInLogicalOr = true;
						}
					}
				}

				if (isProcessEnvMember(path.node, "ENABLE_SESSION_MEMORY_PAST")) {
					hasPastSessionsEnv = true;
				}

				// CC_SM_* vars must appear inside a CallExpression
				for (const envName of callScopedEnvVars) {
					if (isProcessEnvMember(path.node, envName)) {
						const callParent = path.findParent((p) => p.isCallExpression());
						if (callParent) {
							seenCallScopedEnv.add(envName);
						}
					}
				}
			},
			CallExpression(path) {
				if (isFlagCall(path.node, "tengu_coral_fern")) {
					hasCoralFernCall = true;
				}
			},
			IfStatement(path) {
				const { test, consequent } = path.node;
				if (
					t.isUnaryExpression(test, { operator: "!" }) &&
					isFlagCall(test.argument, "tengu_coral_fern") &&
					isNullOrEmptyArrayReturn(consequent)
				) {
					hasOldCoralFernGuard = true;
				}
			},
		});

		if (!hasSessionMemoryInLogicalOr) {
			return "ENABLE_SESSION_MEMORY must be in a || expression with tengu_session_memory flag call";
		}
		if (hasCoralFernCall && !hasPastSessionsEnv) {
			return "Missing ENABLE_SESSION_MEMORY_PAST env var check";
		}
		for (const envName of callScopedEnvVars) {
			if (!seenCallScopedEnv.has(envName)) {
				return `${envName} must appear as an argument to a call expression`;
			}
		}
		if (hasOldCoralFernGuard) {
			return "Old tengu_coral_fern gate still present";
		}
		return true;
	},
};
