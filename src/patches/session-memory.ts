import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch } from "../types.js";

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
 * 3. Compact (using summary.md during compaction) - controlled by ENABLE_CLAUDE_CODE_SM_COMPACT env
 *
 * This patch adds:
 * - ENABLE_SESSION_MEMORY: extraction override (OR with upstream flag)
 * - ENABLE_SESSION_MEMORY_PAST: past-session retrieval override
 * - CC_SM_PER_SECTION_TOKENS / CC_SM_TOTAL_FILE_LIMIT: section/total memory limits
 * - CC_SM_MINIMUM_MESSAGE_TOKENS_TO_INIT / CC_SM_MINIMUM_TOKENS_BETWEEN_UPDATE /
 *   CC_SM_TOOL_CALLS_BETWEEN_UPDATES: update thresholds
 */

// Helper to find the truthy check function (e.g., f1, P1) used for env vars
function findTruthyCheckFn(ast: t.File): string | null {
	let truthyFn: string | null = null;

	traverse.default(ast, {
		CallExpression(path) {
			// Look for pattern: X(process.env.SOME_VAR)
			if (!t.isIdentifier(path.node.callee)) return;
			if (path.node.arguments.length !== 1) return;

			const arg = path.node.arguments[0];
			if (!t.isMemberExpression(arg)) return;
			if (!t.isMemberExpression(arg.object)) return;

			const innerObj = arg.object;
			if (!t.isIdentifier(innerObj.object, { name: "process" })) return;
			if (!t.isIdentifier(innerObj.property, { name: "env" })) return;

			// Found a call like X(process.env.SOMETHING)
			// Check if it's used in an if condition (typical for truthy checks)
			const parent = path.parentPath;
			if (t.isIfStatement(parent?.node) && parent.node.test === path.node) {
				truthyFn = path.node.callee.name;
				path.stop();
			}
		},
	});

	return truthyFn;
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
	return t.callExpression(t.identifier("Number"), [
		t.logicalExpression("??", envMember(primaryEnv), fallbackExpr),
	]);
}

function isReturnNull(node: t.Statement): boolean {
	if (t.isReturnStatement(node) && t.isNullLiteral(node.argument)) return true;
	if (
		t.isBlockStatement(node) &&
		node.body.length === 1 &&
		t.isReturnStatement(node.body[0]) &&
		t.isNullLiteral(node.body[0].argument)
	) {
		return true;
	}
	return false;
}

function isFlagCheckIfStatement(
	node: t.IfStatement,
	flagName: string,
): boolean {
	if (!t.isUnaryExpression(node.test, { operator: "!" })) return false;
	if (!t.isCallExpression(node.test.argument)) return false;
	const call = node.test.argument;
	if (call.arguments.length < 1) return false;
	if (!t.isStringLiteral(call.arguments[0], { value: flagName })) return false;
	return isReturnNull(node.consequent);
}

export const sessionMemory: Patch = {
	tag: "session-mem",

	ast: (ast) => {
		// First, dynamically find the truthy check function
		const truthyFn = findTruthyCheckFn(ast);
		if (!truthyFn) {
			console.warn("session-memory: Could not find truthy check function");
			return;
		}

		let patchedExtraction = false;
		let patchedPastSessions = false;
		let patchedSectionLimits = false;
		let patchedThresholds = false;

		// Find function that returns xK("tengu_session_memory", !1)
		// and add env var check: truthyFn(process.env.ENABLE_SESSION_MEMORY) || ...
		traverse.default(ast, {
			Function(path: any) {
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
				path.stop();
			},
		});

		if (!patchedExtraction) {
			console.warn(
				"session-memory: Could not find tengu_session_memory function",
			);
		}

		// Remove past-session gate:
		// if (!xK("tengu_coral_fern", !1)) return null;
		// and replace with env-gated equivalent:
		// if (!truthy(process.env.ENABLE_SESSION_MEMORY_PAST) && !xK(...)) return null;
		traverse.default(ast, {
			IfStatement(path) {
				if (!isFlagCheckIfStatement(path.node, "tengu_coral_fern")) return;
				if (!t.isUnaryExpression(path.node.test, { operator: "!" })) return;
				if (!t.isCallExpression(path.node.test.argument)) return;
				const gateCall = path.node.test.argument;

				const envPastCheck = t.callExpression(t.identifier(truthyFn), [
					envMember("ENABLE_SESSION_MEMORY_PAST"),
				]);
				const keepGateWhenDisabled = t.logicalExpression(
					"&&",
					t.unaryExpression("!", envPastCheck),
					t.unaryExpression("!", gateCall),
				);
				path.node.test = keepGateWhenDisabled;
				patchedPastSessions = true;
			},
		});
		if (!patchedPastSessions) {
			console.warn(
				"session-memory: Could not find tengu_coral_fern past-session gate",
			);
		}

		// Patch section/total memory limits when colocated with Session Title template:
		// var X=2000, Y=12000, Z=`# Session Title...`
		traverse.default(ast, {
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
		});
		if (!patchedSectionLimits) {
			console.warn(
				"session-memory: Could not find session section/total token limits",
			);
		}

		// Patch update thresholds object:
		// { minimumMessageTokensToInit: 1e4, minimumTokensBetweenUpdate: 5000, toolCallsBetweenUpdates: 3 }
		traverse.default(ast, {
			ObjectExpression(path) {
				const props = path.node.properties.filter((p): p is t.ObjectProperty =>
					t.isObjectProperty(p),
				);
				const getProp = (name: string) =>
					props.find(
						(p) =>
							t.isIdentifier(p.key, { name }) && t.isNumericLiteral(p.value),
					);

				const minInit = getProp("minimumMessageTokensToInit");
				const minBetween = getProp("minimumTokensBetweenUpdate");
				const toolCalls = getProp("toolCallsBetweenUpdates");
				if (!minInit || !minBetween || !toolCalls) return;

				if (
					!(
						t.isNumericLiteral(minInit.value) && minInit.value.value === 10000
					) ||
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
		});
		if (!patchedThresholds) {
			console.warn(
				"session-memory: Could not find session update threshold defaults",
			);
		}
	},

	verify: (code) => {
		if (!code.includes("ENABLE_SESSION_MEMORY")) {
			return "Missing ENABLE_SESSION_MEMORY env var check";
		}
		const hasPastSessionGate = code.includes("tengu_coral_fern");
		if (hasPastSessionGate && !code.includes("ENABLE_SESSION_MEMORY_PAST")) {
			return "Missing ENABLE_SESSION_MEMORY_PAST env var check";
		}
		if (!code.includes("CC_SM_PER_SECTION_TOKENS")) {
			return "Missing CC_SM_PER_SECTION_TOKENS env override";
		}
		if (!code.includes("CC_SM_TOTAL_FILE_LIMIT")) {
			return "Missing CC_SM_TOTAL_FILE_LIMIT env override";
		}
		if (!code.includes("CC_SM_MINIMUM_MESSAGE_TOKENS_TO_INIT")) {
			return "Missing CC_SM_MINIMUM_MESSAGE_TOKENS_TO_INIT env override";
		}
		if (!code.includes("CC_SM_MINIMUM_TOKENS_BETWEEN_UPDATE")) {
			return "Missing CC_SM_MINIMUM_TOKENS_BETWEEN_UPDATE env override";
		}
		if (!code.includes("CC_SM_TOOL_CALLS_BETWEEN_UPDATES")) {
			return "Missing CC_SM_TOOL_CALLS_BETWEEN_UPDATES env override";
		}
		const oldGatePattern =
			/if\s*\(![A-Za-z0-9_$]+\("tengu_coral_fern",\s*(?:!1|false)\)\)\s*\{?\s*return null;\s*\}?/;
		if (hasPastSessionGate && oldGatePattern.test(code)) {
			return "Old tengu_coral_fern gate still present";
		}
		return true;
	},
};
