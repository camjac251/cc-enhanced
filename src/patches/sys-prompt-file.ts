import * as t from "@babel/types";
import { type NodePath, template, traverse, type Visitor } from "../babel.js";
import type { Patch } from "../types.js";
import { getObjectKeyName, getVerifyAst } from "./ast-helpers.js";

function isMemberOnOptions(
	node: t.Node,
	optionsName: string,
	propertyName: string,
): node is t.MemberExpression {
	if (!t.isMemberExpression(node)) return false;
	if (!t.isIdentifier(node.object)) return false;
	if (node.object.name !== optionsName) {
		return false;
	}
	return (
		getObjectKeyName(node.property as t.Expression | t.Identifier) ===
		propertyName
	);
}

function hasEnvOverrideStrings(node: t.Statement): boolean {
	let found = false;
	traverse(t.file(t.program([node])), {
		StringLiteral(path) {
			if (
				path.node.value === "CLAUDE_CODE_APPEND_SYSTEM_PROMPT_FILE" ||
				path.node.value === "/etc/claude-code/system-prompt.md"
			) {
				found = true;
				path.stop();
			}
		},
	});
	return found;
}

function isUndefinedCheckForOptionProp(
	node: t.Node,
	propName: string,
): node is t.BinaryExpression {
	if (!t.isBinaryExpression(node, { operator: "===" })) return false;
	if (!t.isMemberExpression(node.left)) return false;
	if (
		getObjectKeyName(node.left.property as t.Expression | t.Identifier) !==
		propName
	)
		return false;
	return (
		t.isUnaryExpression(node.right, { operator: "void" }) &&
		t.isNumericLiteral(node.right.argument, { value: 0 })
	);
}

function flattenLogicalAnd(node: t.Node): t.Node[] {
	if (t.isLogicalExpression(node, { operator: "&&" })) {
		return [...flattenLogicalAnd(node.left), ...flattenLogicalAnd(node.right)];
	}
	return [node];
}

function findPathHelpers(
	appendIf: t.IfStatement,
	optionsName: string,
): { resolveCallee: t.Expression; existsCallee: t.Expression } | null {
	if (!t.isBlockStatement(appendIf.consequent)) return null;

	let resolvedVarName: string | null = null;
	let resolveCallee: t.Expression | null = null;
	let existsCallee: t.Expression | null = null;
	let readFileSyncObject: t.Expression | null = null;

	for (const stmt of appendIf.consequent.body) {
		if (!t.isTryStatement(stmt) || !t.isBlockStatement(stmt.block)) continue;

		for (const innerStmt of stmt.block.body) {
			if (t.isVariableDeclaration(innerStmt)) {
				for (const decl of innerStmt.declarations) {
					if (!t.isIdentifier(decl.id) || !t.isCallExpression(decl.init))
						continue;
					if (!t.isExpression(decl.init.callee)) continue;
					if (decl.init.arguments.length !== 1) continue;
					const [firstArg] = decl.init.arguments;
					if (
						isMemberOnOptions(firstArg, optionsName, "appendSystemPromptFile")
					) {
						resolvedVarName = decl.id.name;
						if (t.isExpression(decl.init.callee)) {
							resolveCallee = t.cloneNode(decl.init.callee);
						}
					}
				}
			}

			if (t.isIfStatement(innerStmt)) {
				let call: t.CallExpression | null = null;
				if (
					t.isUnaryExpression(innerStmt.test, { operator: "!" }) &&
					t.isCallExpression(innerStmt.test.argument)
				) {
					call = innerStmt.test.argument;
				} else if (t.isCallExpression(innerStmt.test)) {
					call = innerStmt.test;
				}
				if (call?.arguments.length !== 1) continue;
				if (!t.isExpression(call.callee)) continue;
				const [firstArg] = call.arguments;
				if (
					resolvedVarName &&
					t.isIdentifier(firstArg) &&
					firstArg.name === resolvedVarName
				) {
					existsCallee = t.cloneNode(call.callee);
				}
			}

			const readFileSyncCall =
				t.isExpressionStatement(innerStmt) &&
				t.isCallExpression(innerStmt.expression)
					? innerStmt.expression
					: t.isExpressionStatement(innerStmt) &&
							t.isAssignmentExpression(innerStmt.expression) &&
							t.isCallExpression(innerStmt.expression.right)
						? innerStmt.expression.right
						: null;
			if (
				readFileSyncCall &&
				t.isMemberExpression(readFileSyncCall.callee) &&
				getObjectKeyName(
					readFileSyncCall.callee.property as t.Expression | t.Identifier,
				) === "readFileSync" &&
				readFileSyncCall.arguments.length >= 1
			) {
				const [firstArg] = readFileSyncCall.arguments;
				if (
					resolvedVarName &&
					t.isIdentifier(firstArg) &&
					firstArg.name === resolvedVarName
				) {
					readFileSyncObject = t.cloneNode(readFileSyncCall.callee.object);
				}
			}
		}
	}

	if (!existsCallee && readFileSyncObject) {
		existsCallee = t.memberExpression(
			readFileSyncObject,
			t.identifier("existsSync"),
		);
	}

	if (!resolveCallee || !existsCallee) return null;
	return { resolveCallee, existsCallee };
}

function hasAppendPromptConflictCheck(
	appendIf: t.IfStatement,
	optionsName: string,
): boolean {
	if (!t.isBlockStatement(appendIf.consequent)) return false;

	return appendIf.consequent.body.some((stmt) => {
		if (!t.isIfStatement(stmt)) return false;
		return isMemberOnOptions(stmt.test, optionsName, "appendSystemPrompt");
	});
}

function isProcessEnvOverrideAccess(node: t.Node): boolean {
	if (!t.isMemberExpression(node)) return false;
	if (!t.isMemberExpression(node.object)) return false;

	const envObj = node.object;
	const envProp = getObjectKeyName(
		envObj.property as t.Expression | t.Identifier,
	);
	if (envProp !== "env") return false;

	const processRef =
		(t.isIdentifier(envObj.object) && envObj.object.name === "process") ||
		(t.isMemberExpression(envObj.object) &&
			getObjectKeyName(
				envObj.object.property as t.Expression | t.Identifier,
			) === "process" &&
			t.isIdentifier(envObj.object.object, { name: "globalThis" }));
	if (!processRef) return false;

	return (
		getObjectKeyName(node.property as t.Expression | t.Identifier) ===
		"CLAUDE_CODE_APPEND_SYSTEM_PROMPT_FILE"
	);
}

function inspectAutoAppendGuard(path: NodePath<t.IfStatement>): {
	hasEnvOverride: boolean;
	hasDefaultPath: boolean;
	hasAppendAssignment: boolean;
	hasExistsSync: boolean;
	guardsReplacementPrompt: boolean;
} | null {
	const guardedProps = new Set<string>();
	for (const part of flattenLogicalAnd(path.node.test)) {
		for (const propName of [
			"appendSystemPromptFile",
			"appendSystemPrompt",
			"systemPromptFile",
			"systemPrompt",
		]) {
			if (isUndefinedCheckForOptionProp(part, propName)) {
				guardedProps.add(propName);
			}
		}
	}
	if (!guardedProps.has("appendSystemPromptFile")) return null;
	if (!guardedProps.has("appendSystemPrompt")) return null;

	// The mutator injects a single wired shape:
	//   if (existsSync(resolvedVar)) { options.appendSystemPromptFile = resolvedVar; }
	// inside a try { ... } catch, where resolvedVar = resolve(
	//   process.env.<ENV> ?? "/etc/claude-code/system-prompt.md"
	// ). Verify mirrors that wiring rather than checking the four pieces
	// independently, so a dead env read, a swapped fallback, or a dropped
	// catch fails instead of passing on incidental presence.
	let hasEnvOverride = false;
	let hasDefaultPath = false;
	let existsSyncArgName: string | null = null;
	let assignmentName: string | null = null;
	let assignmentWiredToExists = false;

	path.traverse({
		LogicalExpression(innerPath) {
			if (innerPath.node.operator !== "??") return;
			if (!isProcessEnvOverrideAccess(innerPath.node.left)) return;
			hasEnvOverride = true;
			if (
				t.isStringLiteral(innerPath.node.right, {
					value: "/etc/claude-code/system-prompt.md",
				})
			) {
				hasDefaultPath = true;
			}
		},
		CallExpression(innerPath) {
			if (!isExistsSyncCall(innerPath.node)) return;
			const [arg] = innerPath.node.arguments;
			if (t.isIdentifier(arg)) existsSyncArgName = arg.name;
		},
		AssignmentExpression(innerPath) {
			if (
				!t.isMemberExpression(innerPath.node.left) ||
				getObjectKeyName(
					innerPath.node.left.property as t.Expression | t.Identifier,
				) !== "appendSystemPromptFile" ||
				!t.isIdentifier(innerPath.node.right)
			) {
				return;
			}
			assignmentName = innerPath.node.right.name;
			// The assignment must live inside the existsSync guard's consequent
			// and inside a try-statement, both within this auto-append branch.
			const insideExistsGuard = Boolean(
				innerPath.findParent(
					(parent) =>
						parent.isIfStatement() && isExistsSyncCall(parent.node.test),
				),
			);
			const insideTry = Boolean(
				innerPath.findParent((parent) => parent.isTryStatement()),
			);
			if (insideExistsGuard && insideTry) assignmentWiredToExists = true;
		},
	});

	const hasExistsSync = existsSyncArgName !== null;
	const hasAppendAssignment =
		assignmentName !== null &&
		assignmentName === existsSyncArgName &&
		assignmentWiredToExists;

	return {
		hasEnvOverride,
		hasDefaultPath,
		hasAppendAssignment,
		hasExistsSync,
		guardsReplacementPrompt:
			guardedProps.has("systemPromptFile") || guardedProps.has("systemPrompt"),
	};
}

/**
 * True for an `existsSync(arg)` call, whether invoked bare or as a member
 * (e.g. `fs.existsSync(arg)`), matching the receiver-agnostic helper the
 * mutator synthesizes from the readFileSync source object.
 */
function isExistsSyncCall(node: t.Node): node is t.CallExpression {
	if (!t.isCallExpression(node)) return false;
	const callee = node.callee;
	if (t.isIdentifier(callee) && callee.name.includes("existsSync")) return true;
	return (
		t.isMemberExpression(callee) &&
		getObjectKeyName(callee.property as t.Expression | t.Identifier) ===
			"existsSync"
	);
}

function findAutoAppendGuardBeforeAppendBranch(ast: t.File): {
	hasEnvOverride: boolean;
	hasDefaultPath: boolean;
	hasAppendAssignment: boolean;
	hasExistsSync: boolean;
	guardsReplacementPrompt: boolean;
} | null {
	let found: {
		hasEnvOverride: boolean;
		hasDefaultPath: boolean;
		hasAppendAssignment: boolean;
		hasExistsSync: boolean;
		guardsReplacementPrompt: boolean;
	} | null = null;

	traverse(ast, {
		IfStatement(path) {
			if (found) return;
			if (!isAppendSystemPromptFileBranch(path)) return;

			const statementPath = path.getStatementParent();
			if (!statementPath) return;
			const parentPath = statementPath.parentPath;
			if (!parentPath?.isBlockStatement()) return;

			const siblingIndex = parentPath.node.body.indexOf(statementPath.node);
			if (siblingIndex <= 0) return;
			const previousSibling = statementPath.getSibling(
				siblingIndex - 1,
			) as NodePath<t.Statement>;
			if (!previousSibling.isIfStatement()) return;

			found = inspectAutoAppendGuard(previousSibling);
			path.stop();
		},
	});

	return found;
}

function isAppendSystemPromptFileBranch(
	path: NodePath<t.IfStatement>,
): path is NodePath<t.IfStatement> {
	if (!t.isMemberExpression(path.node.test)) return false;
	if (
		getObjectKeyName(path.node.test.property as t.Expression | t.Identifier) !==
		"appendSystemPromptFile"
	) {
		return false;
	}
	if (!t.isIdentifier(path.node.test.object)) return false;
	return (
		hasAppendPromptConflictCheck(path.node, path.node.test.object.name) &&
		findPathHelpers(path.node, path.node.test.object.name) !== null
	);
}

export const systemPromptFile: Patch = {
	tag: "sys-prompt-file",

	astPasses: () => [
		{
			pass: "mutate",
			visitor: createSystemPromptFileMutator(),
		},
	],

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst)
			return "Unable to parse AST during sys-prompt-file verification";

		const autoAppendGuard = findAutoAppendGuardBeforeAppendBranch(verifyAst);
		if (!autoAppendGuard) {
			return "Missing auto-append guard immediately before appendSystemPromptFile branch";
		}
		if (!autoAppendGuard.hasEnvOverride) {
			return "Missing CLAUDE_CODE_APPEND_SYSTEM_PROMPT_FILE override";
		}
		if (!autoAppendGuard.hasDefaultPath) {
			return "Missing default /etc/claude-code/system-prompt.md path";
		}
		if (!autoAppendGuard.hasAppendAssignment) {
			return "Missing appendSystemPromptFile assignment in auto-append flow";
		}
		if (!autoAppendGuard.hasExistsSync) {
			return "Missing existsSync call within auto-append guard body";
		}
		if (autoAppendGuard.guardsReplacementPrompt) {
			return "Auto-append guard must not skip replacement-mode systemPrompt/systemPromptFile";
		}

		return true;
	},
};

function createSystemPromptFileMutator(): Visitor {
	let patched = false;
	return {
		IfStatement(path) {
			if (patched) return;

			if (!isAppendSystemPromptFileBranch(path)) return;
			if (!t.isMemberExpression(path.node.test)) return;
			if (!t.isIdentifier(path.node.test.object)) return;

			const optionsName = path.node.test.object.name;
			const helpers = findPathHelpers(path.node, optionsName);
			if (!helpers) return;

			const statementPath = path.getStatementParent();
			if (!statementPath) return;
			const parentPath = statementPath.parentPath;
			if (!parentPath?.isBlockStatement()) return;

			const parentBlock = parentPath.node;
			if (hasEnvOverrideStrings(parentBlock)) {
				patched = true;
				return;
			}

			const siblingIndex = parentBlock.body.indexOf(statementPath.node);
			if (siblingIndex < 0) return;
			if (!hasAppendPromptConflictCheck(path.node, optionsName)) return;

			const [autoAppendIf] = template.statements(
				`
                if (OPTIONS.appendSystemPromptFile === void 0 && OPTIONS.appendSystemPrompt === void 0) {
                    let configuredSystemPromptFilePath = process.env.CLAUDE_CODE_APPEND_SYSTEM_PROMPT_FILE ?? "/etc/claude-code/system-prompt.md";
                    try {
						let resolvedSystemPromptFile = RESOLVE(configuredSystemPromptFilePath);
						if (EXISTS(resolvedSystemPromptFile)) {
							OPTIONS.appendSystemPromptFile = resolvedSystemPromptFile;
						}
					} catch (err) {}
				}
			`,
				{ placeholderPattern: /^(OPTIONS|RESOLVE|EXISTS)$/ },
			)({
				OPTIONS: t.identifier(optionsName),
				RESOLVE: t.cloneNode(helpers.resolveCallee),
				EXISTS: t.cloneNode(helpers.existsCallee),
			});

			parentBlock.body.splice(siblingIndex, 0, autoAppendIf);
			patched = true;
		},
		Program: {
			exit() {
				if (!patched) {
					console.warn(
						"system-prompt-file: Could not find appendSystemPromptFile flow to patch",
					);
				}
			},
		},
	};
}
