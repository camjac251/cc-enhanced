import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch } from "../types.js";

function isMarkerCall(node: t.Expression): boolean {
	if (!t.isCallExpression(node)) return false;
	if (node.arguments.length < 1) return false;
	return t.isStringLiteral(node.arguments[0], {
		value: "tengu_api_cache_breakpoints",
	});
}

function isMapCall(node: t.Expression): node is t.CallExpression {
	if (!t.isCallExpression(node)) return false;
	if (!t.isMemberExpression(node.callee)) return false;
	return t.isIdentifier(node.callee.property, { name: "map" });
}

function getConditionalFromCallback(
	callback: t.FunctionExpression | t.ArrowFunctionExpression,
): t.ConditionalExpression | null {
	if (t.isConditionalExpression(callback.body)) {
		return callback.body;
	}

	if (!t.isBlockStatement(callback.body)) return null;
	for (const stmt of callback.body.body) {
		if (!t.isReturnStatement(stmt)) continue;
		if (!stmt.argument || !t.isConditionalExpression(stmt.argument)) continue;
		return stmt.argument;
	}

	return null;
}

function isTailGateExpression(
	node: t.Expression,
): node is t.BinaryExpression & { right: t.BinaryExpression } {
	if (!t.isBinaryExpression(node, { operator: ">" })) return false;
	if (!t.isBinaryExpression(node.right, { operator: "-" })) return false;
	if (!t.isMemberExpression(node.right.left)) return false;
	if (!t.isIdentifier(node.right.left.property, { name: "length" }))
		return false;
	return t.isNumericLiteral(node.right.right);
}

function buildTailPolicyDeclarations(): t.VariableDeclaration[] {
	return [
		t.variableDeclaration("var", [
			t.variableDeclarator(
				t.identifier("cacheTailWindow"),
				t.numericLiteral(3),
			),
		]),
		t.variableDeclaration("var", [
			t.variableDeclarator(
				t.identifier("cacheUserOnly"),
				t.booleanLiteral(true),
			),
		]),
	];
}

export const cacheTailPolicy: Patch = {
	tag: "cache-tail-policy",

	ast: (ast) => {
		let patchedWindow = false;
		let patchedUserOnly = false;
		let patchedDecls = false;

		traverse.default(ast, {
			FunctionDeclaration(path) {
				const body = path.node.body.body;
				let targetReturn: t.ReturnStatement | null = null;
				let targetMapCall: t.CallExpression | null = null;

				for (const stmt of body) {
					if (!t.isReturnStatement(stmt)) continue;
					if (!stmt.argument || !t.isSequenceExpression(stmt.argument))
						continue;
					if (stmt.argument.expressions.length < 2) continue;

					const [firstExpr, secondExpr] = stmt.argument.expressions;
					if (!isMarkerCall(firstExpr)) continue;
					if (!isMapCall(secondExpr)) continue;

					targetReturn = stmt;
					targetMapCall = secondExpr;
					break;
				}

				if (!targetReturn || !targetMapCall) return;
				if (targetMapCall.arguments.length < 1) return;

				const callback = targetMapCall.arguments[0];
				if (
					!t.isFunctionExpression(callback) &&
					!t.isArrowFunctionExpression(callback)
				) {
					return;
				}

				const conditional = getConditionalFromCallback(callback);
				if (!conditional) return;
				if (
					!t.isCallExpression(conditional.consequent) ||
					!t.isCallExpression(conditional.alternate)
				) {
					return;
				}
				if (
					conditional.consequent.arguments.length < 2 ||
					conditional.alternate.arguments.length < 2
				) {
					return;
				}
				if (
					!t.isExpression(conditional.consequent.arguments[1]) ||
					!t.isExpression(conditional.alternate.arguments[1])
				) {
					return;
				}

				const declaredNames = new Set<string>();
				for (const stmt of body) {
					if (!t.isVariableDeclaration(stmt)) continue;
					for (const decl of stmt.declarations) {
						if (t.isIdentifier(decl.id)) declaredNames.add(decl.id.name);
					}
				}

				if (
					!declaredNames.has("cacheTailWindow") &&
					!declaredNames.has("cacheUserOnly")
				) {
					path.node.body.body = [
						...buildTailPolicyDeclarations(),
						...path.node.body.body,
					];
					patchedDecls = true;
				}

				const userTailArg = conditional.consequent.arguments[1];
				if (t.isExpression(userTailArg) && isTailGateExpression(userTailArg)) {
					userTailArg.right.right = t.binaryExpression(
						"+",
						t.identifier("cacheTailWindow"),
						t.numericLiteral(1),
					);
					patchedWindow = true;
				}

				if (t.isExpression(conditional.consequent.arguments[1])) {
					conditional.alternate.arguments[1] = t.conditionalExpression(
						t.identifier("cacheUserOnly"),
						t.booleanLiteral(false),
						t.cloneNode(conditional.consequent.arguments[1]),
					);
					patchedUserOnly = true;
				}

				if (patchedWindow || patchedUserOnly || patchedDecls) {
					path.stop();
				}
			},
		});

		if (!patchedWindow) {
			console.warn(
				"cache-tail-policy: Could not patch cache tail window logic",
			);
		}
		if (!patchedUserOnly) {
			console.warn(
				"cache-tail-policy: Could not patch assistant tail cache policy",
			);
		}
	},

	verify: (_code, ast) => {
		if (!ast) return "Missing AST for cache-tail-policy verification";

		let hasTailWindowDecl = false;
		let hasUserOnlyDecl = false;
		let hasTailWindowPlusOne = false;
		let hasUserOnlyConditional = false;

		traverse.default(ast, {
			VariableDeclarator(path) {
				if (!t.isIdentifier(path.node.id)) return;
				if (path.node.id.name === "cacheTailWindow") {
					if (t.isNumericLiteral(path.node.init, { value: 3 })) {
						hasTailWindowDecl = true;
					}
				}
				if (path.node.id.name === "cacheUserOnly") {
					if (t.isBooleanLiteral(path.node.init, { value: true })) {
						hasUserOnlyDecl = true;
					}
				}
			},
			BinaryExpression(path) {
				if (path.node.operator !== "+") return;
				if (!t.isIdentifier(path.node.left, { name: "cacheTailWindow" }))
					return;
				if (!t.isNumericLiteral(path.node.right, { value: 1 })) return;
				hasTailWindowPlusOne = true;
			},
			ConditionalExpression(path) {
				if (!t.isIdentifier(path.node.test, { name: "cacheUserOnly" })) return;
				if (!t.isBooleanLiteral(path.node.consequent, { value: false })) return;
				hasUserOnlyConditional = true;
			},
		});

		if (!hasTailWindowDecl) {
			return "Missing fixed cacheTailWindow declaration";
		}
		if (!hasUserOnlyDecl) {
			return "Missing cacheUserOnly gating declaration";
		}
		if (!hasTailWindowPlusOne) {
			return "Tail cache window was not patched";
		}
		if (!hasUserOnlyConditional) {
			return "Assistant cache tail gating was not patched to user-only";
		}
		return true;
	},
};
