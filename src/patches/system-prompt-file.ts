import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch } from "../types.js";

function isMemberOnOptions(
	node: t.Node,
	optionsName: string,
	propertyName: string,
): node is t.MemberExpression {
	if (!t.isMemberExpression(node)) return false;
	if (!t.isIdentifier(node.object, { name: optionsName })) return false;
	return t.isIdentifier(node.property, { name: propertyName });
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
	if (!t.isIdentifier(node.left.property, { name: propName })) return false;
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
					t.isIdentifier(firstArg, { name: resolvedVarName })
				) {
					existsCallee = t.cloneNode(call.callee);
				}
			}
		}
	}

	if (!resolveCallee || !existsCallee) return null;
	return { resolveCallee, existsCallee };
}

export const systemPromptFile: Patch = {
	tag: "sys-prompt-file",

	ast: (ast) => {
		let patched = false;

		traverse.default(ast, {
			IfStatement(path) {
				if (patched) return;

				if (!t.isMemberExpression(path.node.test)) return;
				if (
					!t.isIdentifier(path.node.test.property, {
						name: "appendSystemPromptFile",
					})
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
					path.stop();
					return;
				}

				const siblingIndex = parentBlock.body.indexOf(statementPath.node);
				if (siblingIndex <= 0) return;

				const previousStmt = parentBlock.body[siblingIndex - 1];
				if (!t.isVariableDeclaration(previousStmt)) return;

				const hasAppendPromptVar = previousStmt.declarations.some((decl) => {
					if (!t.isVariableDeclarator(decl) || !decl.init) return false;
					return isMemberOnOptions(
						decl.init,
						optionsName,
						"appendSystemPrompt",
					);
				});
				if (!hasAppendPromptVar) return;

				const configuredPathId = t.identifier("configuredSystemPromptFilePath");
				const resolvedPathId = t.identifier("resolvedSystemPromptFile");

				const defaultPathExpr = t.logicalExpression(
					"??",
					t.memberExpression(
						t.memberExpression(t.identifier("process"), t.identifier("env")),
						t.identifier("CLAUDE_CODE_APPEND_SYSTEM_PROMPT_FILE"),
					),
					t.stringLiteral("~/.claude/system-prompt.md"),
				);

				const autoAppendIf = t.ifStatement(
					t.logicalExpression(
						"&&",
						t.binaryExpression(
							"===",
							t.memberExpression(
								t.identifier(optionsName),
								t.identifier("appendSystemPromptFile"),
							),
							t.unaryExpression("void", t.numericLiteral(0)),
						),
						t.binaryExpression(
							"===",
							t.memberExpression(
								t.identifier(optionsName),
								t.identifier("appendSystemPrompt"),
							),
							t.unaryExpression("void", t.numericLiteral(0)),
						),
					),
					t.blockStatement([
						t.variableDeclaration("let", [
							t.variableDeclarator(configuredPathId, defaultPathExpr),
						]),
						t.tryStatement(
							t.blockStatement([
								t.variableDeclaration("let", [
									t.variableDeclarator(
										resolvedPathId,
										t.callExpression(t.cloneNode(helpers.resolveCallee), [
											configuredPathId,
										]),
									),
								]),
								t.ifStatement(
									t.callExpression(t.cloneNode(helpers.existsCallee), [
										resolvedPathId,
									]),
									t.expressionStatement(
										t.assignmentExpression(
											"=",
											t.memberExpression(
												t.identifier(optionsName),
												t.identifier("appendSystemPromptFile"),
											),
											resolvedPathId,
										),
									),
								),
							]),
							t.catchClause(t.identifier("err"), t.blockStatement([])),
						),
					]),
				);

				parentBlock.body.splice(siblingIndex, 0, autoAppendIf);
				patched = true;
				path.stop();
			},
		});

		if (!patched) {
			console.warn(
				"system-prompt-file: Could not find appendSystemPromptFile flow to patch",
			);
		}
	},

	verify: (_code, ast) => {
		if (!ast) return "Missing AST for sys-prompt-file verification";

		let hasEnvOverride = false;
		let hasDefaultPath = false;
		let hasAutoAppendGuard = false;
		let hasAppendAssignment = false;

		traverse.default(ast, {
			MemberExpression(path) {
				if (
					!t.isMemberExpression(path.node.object) ||
					!t.isIdentifier(path.node.object.object, { name: "process" }) ||
					!t.isIdentifier(path.node.object.property, { name: "env" }) ||
					!t.isIdentifier(path.node.property, {
						name: "CLAUDE_CODE_APPEND_SYSTEM_PROMPT_FILE",
					})
				) {
					return;
				}
				hasEnvOverride = true;
			},
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
				path.traverse({
					AssignmentExpression(innerPath) {
						if (
							!t.isMemberExpression(innerPath.node.left) ||
							!t.isIdentifier(innerPath.node.left.property, {
								name: "appendSystemPromptFile",
							}) ||
							!t.isIdentifier(innerPath.node.right)
						) {
							return;
						}
						hasAppendAssignment = true;
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

		return true;
	},
};
