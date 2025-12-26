/**
 * Context Management Patch
 *
 * Bypasses Statsig experiment check for preserve_thinking, allowing
 * user control via PRESERVE_THINKING_TURNS env var.
 *
 * Env var options:
 *   - "all" or "0": Keep all thinking blocks
 *   - "1", "2", "3", etc.: Keep last N turns of thinking
 *   - unset: Default behavior (server clears old thinking)
 */
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { PatchContext } from "../types.js";

/**
 * AST patch to:
 * 1. Include context-management beta when PRESERVE_THINKING_TURNS is set
 * 2. Modify hzB function to use env var instead of Statsig experiment
 */
export function patchContextManagement(ast: t.File, ctx: PatchContext): void {
	// Patch 1: Modify the beta header logic
	// Find: let Y = Z && pG("preserve_thinking", "enabled", !1)
	// Change to: let Y = Z && (pG("preserve_thinking", "enabled", !1) || process.env.PRESERVE_THINKING_TURNS != null)
	traverse.default(ast, {
		VariableDeclarator(path) {
			const init = path.node.init;
			if (!t.isLogicalExpression(init) || init.operator !== "&&") return;

			const right = init.right;
			if (!t.isCallExpression(right)) return;

			const callee = right.callee;
			if (!t.isIdentifier(callee)) return;

			const args = right.arguments;
			if (args.length < 2) return;
			if (
				!t.isStringLiteral(args[0]) ||
				args[0].value !== "preserve_thinking"
			)
				return;

			// Found: let Y = Z && pG("preserve_thinking", ...)
			// Wrap the pG call in an OR with our env var check
			const envCheck = t.binaryExpression(
				"!=",
				t.memberExpression(
					t.memberExpression(t.identifier("process"), t.identifier("env")),
					t.identifier("PRESERVE_THINKING_TURNS"),
				),
				t.nullLiteral(),
			);

			init.right = t.logicalExpression("||", right, envCheck);
		},
	});

	// Patch 2: Modify the hzB function that builds context_management
	traverse.default(ast, {
		FunctionDeclaration(path) {
			// Find the hzB function by looking for pG("preserve_thinking",...) call
			let hasPGCall = false;
			let pgCallPath: any = null;
			let earlyReturnPath: any = null;
			let thinkingConditionPath: any = null;

			path.traverse({
				CallExpression(innerPath) {
					const callee = innerPath.node.callee;
					if (!t.isIdentifier(callee)) return;

					const args = innerPath.node.arguments;
					if (
						args.length >= 2 &&
						t.isStringLiteral(args[0]) &&
						args[0].value === "preserve_thinking"
					) {
						hasPGCall = true;
						pgCallPath = innerPath;
					}
				},
			});

			if (!hasPGCall) return;

			// Find the early return: if (!B) return;
			path.traverse({
				IfStatement(innerPath) {
					const test = innerPath.node.test;
					if (
						t.isUnaryExpression(test) &&
						test.operator === "!" &&
						t.isIdentifier(test.argument)
					) {
						const consequent = innerPath.node.consequent;
						if (t.isReturnStatement(consequent) && !consequent.argument) {
							earlyReturnPath = innerPath;
						}
					}
				},
			});

			// Find: if (B && Q) { ... keep: "all" ... }
			path.traverse({
				IfStatement(innerPath) {
					const test = innerPath.node.test;
					if (
						t.isLogicalExpression(test) &&
						test.operator === "&&" &&
						t.isIdentifier(test.left) &&
						t.isIdentifier(test.right)
					) {
						// Check if body contains "clear_thinking_20251015"
						let hasThinkingClear = false;
						innerPath.traverse({
							StringLiteral(strPath) {
								if (strPath.node.value === "clear_thinking_20251015") {
									hasThinkingClear = true;
								}
							},
						});
						if (hasThinkingClear) {
							thinkingConditionPath = innerPath;
						}
					}
				},
			});

			if (!pgCallPath || !earlyReturnPath) return;

			// Get the variable name used for the pG result (e.g., "B")
			const pgParent = pgCallPath.parentPath;
			if (!t.isVariableDeclarator(pgParent?.node)) return;
			const pgVarName = (pgParent.node.id as t.Identifier).name;

			// Replace pG call with env var check
			// B = pG("preserve_thinking","enabled",!1)
			// becomes:
			// preserveThinkingEnv = process.env.PRESERVE_THINKING_TURNS,
			// B = preserveThinkingEnv != null
			const envVarExpr = t.memberExpression(
				t.memberExpression(t.identifier("process"), t.identifier("env")),
				t.identifier("PRESERVE_THINKING_TURNS"),
			);

			// Add new variable declarator for env var before B
			const envVarDeclarator = t.variableDeclarator(
				t.identifier("preserveThinkingEnv"),
				envVarExpr,
			);

			// Replace pG call with null check
			pgCallPath.replaceWith(
				t.binaryExpression(
					"!=",
					t.identifier("preserveThinkingEnv"),
					t.nullLiteral(),
				),
			);

			// Insert env var declarator
			const declarationPath = pgParent.parentPath;
			if (t.isVariableDeclaration(declarationPath?.node)) {
				const declarations = declarationPath.node.declarations;
				const pgIndex = declarations.findIndex(
					(d: t.VariableDeclarator) =>
						t.isIdentifier(d.id) && d.id.name === pgVarName,
				);
				if (pgIndex >= 0) {
					declarations.splice(pgIndex, 0, envVarDeclarator);
				}
			}

			// Remove early return - we handle it differently now
			earlyReturnPath.remove();

			// Modify the thinking block creation to use env var value
			// Also change Y.push(J) to Y.unshift(J) so thinking is FIRST in edits array
			// (API requires clear_thinking to be first)
			if (thinkingConditionPath) {
				thinkingConditionPath.traverse({
					CallExpression(callPath: any) {
						const callee = callPath.node.callee;
						if (
							t.isMemberExpression(callee) &&
							t.isIdentifier(callee.property) &&
							callee.property.name === "push"
						) {
							// Change push to unshift
							callee.property.name = "unshift";
						}
					},
					ObjectExpression(objPath: any) {
						const props = objPath.node.properties;
						const keepProp = props.find(
							(p: any): p is t.ObjectProperty =>
								t.isObjectProperty(p) &&
								t.isIdentifier(p.key) &&
								p.key.name === "keep",
						);

						if (keepProp && t.isStringLiteral(keepProp.value)) {
							// Replace keep: "all" with dynamic expression
							// preserveThinkingEnv === "all" || preserveThinkingEnv === "0"
							//   ? "all"
							//   : { type: "thinking_turns", value: parseInt(preserveThinkingEnv) || 1 }
							keepProp.value = t.conditionalExpression(
								t.logicalExpression(
									"||",
									t.binaryExpression(
										"===",
										t.identifier("preserveThinkingEnv"),
										t.stringLiteral("all"),
									),
									t.binaryExpression(
										"===",
										t.identifier("preserveThinkingEnv"),
										t.stringLiteral("0"),
									),
								),
								t.stringLiteral("all"),
								t.objectExpression([
									t.objectProperty(
										t.identifier("type"),
										t.stringLiteral("thinking_turns"),
									),
									t.objectProperty(
										t.identifier("value"),
										t.logicalExpression(
											"||",
											t.callExpression(t.identifier("parseInt"), [
												t.identifier("preserveThinkingEnv"),
											]),
											t.numericLiteral(1),
										),
									),
								]),
							);
						}
					},
				});
			}

			ctx.report.context_management_patched = true;
		},
	});
}
