import template from "@babel/template";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch } from "../types.js";
import { getObjectKeyName } from "./ast-helpers.js";

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
	traverse.default(t.file(t.program([node])), {
		StringLiteral(path) {
			if (
				path.node.value === "CLAUDE_CODE_APPEND_SYSTEM_PROMPT_FILE" ||
				path.node.value === "~/.claude/system-prompt.md"
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
				if (!call || call.arguments.length !== 1) continue;
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

export const systemPromptFile: Patch = {
	tag: "sys-prompt-file",

	astPasses: () => [
		{
			pass: "mutate",
			visitor: createSystemPromptFileMutator(),
		},
	],

	verify: (_code, ast) => {
		if (!ast) return "Missing AST for sys-prompt-file verification";

		let hasEnvOverride = false;
		let hasDefaultPath = false;
		let hasAutoAppendGuard = false;
		let hasAppendAssignment = false;
		let hasExistsSyncInGuard = false;

		traverse.default(ast, {
			StringLiteral(path) {
				if (path.node.value === "~/.claude/system-prompt.md") {
					hasDefaultPath = true;
				}
			},
			IfStatement(path) {
				if (!t.isLogicalExpression(path.node.test, { operator: "&&" })) return;
				const { left, right } = path.node.test;
				if (!isUndefinedCheckForOptionProp(left, "appendSystemPromptFile"))
					return;
				if (!isUndefinedCheckForOptionProp(right, "appendSystemPrompt")) return;

				hasAutoAppendGuard = true;

				// Check env override is co-located within the same auto-append guard
				path.traverse({
					MemberExpression(innerPath) {
						if (!isProcessEnvOverrideAccess(innerPath.node)) return;
						hasEnvOverride = true;
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
						hasAppendAssignment = true;
					},
					CallExpression(innerPath) {
						const callee = innerPath.node.callee;
						// existsSync as identifier (extracted binding)
						if (t.isIdentifier(callee) && callee.name.includes("existsSync")) {
							hasExistsSyncInGuard = true;
							return;
						}
						// existsSync as member expression (e.g. fs.existsSync)
						if (
							t.isMemberExpression(callee) &&
							getObjectKeyName(
								callee.property as t.Expression | t.Identifier,
							) === "existsSync"
						) {
							hasExistsSyncInGuard = true;
						}
					},
				});
			},
		});

		if (!hasEnvOverride) {
			return "Missing CLAUDE_CODE_APPEND_SYSTEM_PROMPT_FILE override";
		}
		if (!hasDefaultPath) {
			return "Missing default ~/.claude/system-prompt.md path";
		}
		if (!hasAutoAppendGuard) {
			return "Missing auto-append guard for appendSystemPromptFile/appendSystemPrompt";
		}
		if (!hasAppendAssignment) {
			return "Missing appendSystemPromptFile assignment in auto-append flow";
		}
		if (!hasExistsSyncInGuard) {
			return "Missing existsSync call within auto-append guard body";
		}

		return true;
	},
};

function createSystemPromptFileMutator(): traverse.Visitor {
	let patched = false;
	return {
		IfStatement(path) {
			if (patched) return;

			if (!t.isMemberExpression(path.node.test)) return;
			if (
				getObjectKeyName(
					path.node.test.property as t.Expression | t.Identifier,
				) !== "appendSystemPromptFile"
			)
				return;
			if (!t.isIdentifier(path.node.test.object)) return;

			const optionsName = path.node.test.object.name;
			const helpers = findPathHelpers(path.node, optionsName);
			if (!helpers) return;

			const statementPath = path.getStatementParent();
			if (!statementPath) return;
			const parentPath = statementPath.parentPath;
			if (!parentPath || !parentPath.isBlockStatement()) return;

			const parentBlock = parentPath.node;
			if (hasEnvOverrideStrings(parentBlock)) {
				patched = true;
				return;
			}

			const siblingIndex = parentBlock.body.indexOf(statementPath.node);
			if (siblingIndex < 0) return;
			if (!hasAppendPromptConflictCheck(path.node, optionsName)) return;

			const [autoAppendIf] = template.default.statements(
				`
				if (OPTIONS.appendSystemPromptFile === void 0 && OPTIONS.appendSystemPrompt === void 0) {
					let configuredSystemPromptFilePath = process.env.CLAUDE_CODE_APPEND_SYSTEM_PROMPT_FILE ?? "~/.claude/system-prompt.md";
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
