import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch } from "../types.js";

/**
 * Fixes the output token cap for Opus 4.6.
 *
 * The upstream Yz1() function checks model strings in order:
 *   if (q.includes("opus-4-5")) K = 64000;
 *   if (q.includes("opus-4"))   K = 32000;  // <-- matches opus-4-6 too!
 *
 * "opus-4-6".includes("opus-4") is true, so Opus 4.6 gets capped at 32000
 * instead of 64000. Sonnet 4 and Haiku 4 both get 64000, making Opus 4.6
 * the only current-gen model with the lower cap.
 *
 * This patch finds the "opus-4" string literal in the if-chain that assigns
 * 32000 and changes it to "opus-4-1" so it only matches the older Opus 4/4.1.
 * Opus 4.6 then falls through to the else branch which assigns 64000
 * (same as sonnet-4/haiku-4).
 *
 * Wait - actually the else branch assigns VCq (32000 default). Let me re-read:
 *   if (opus-4-5) 64000
 *   else if (opus-4) 32000
 *   else if (sonnet-4 || haiku-4) 64000
 *   else VCq (32000)
 *
 * So changing "opus-4" to "opus-4-1" would make opus-4-6 fall through to
 * the sonnet-4/haiku-4 check which it won't match, then to VCq=32000.
 * That doesn't help.
 *
 * Instead, we change the 32000 numeric literal to 64000 in the opus-4 branch.
 * This gives all opus-4* models (including 4.6) 64000 output tokens.
 */
export const outputTokens: Patch = {
	tag: "output-tokens",

	ast: (ast) => {
		let patched = false;

		traverse.default(ast, {
			IfStatement(path) {
				// Look for: if (q.includes("opus-4")) K = 32000;
				const test = path.node.test;
				if (!t.isCallExpression(test)) return;
				if (!t.isMemberExpression(test.callee)) return;

				const prop = test.callee.property;
				if (!t.isIdentifier(prop, { name: "includes" })) return;

				const args = test.arguments;
				if (args.length !== 1) return;
				if (!t.isStringLiteral(args[0], { value: "opus-4" })) return;

				// Found the includes("opus-4") check. Now find the 32000 assignment.
				const consequent = path.node.consequent;
				const body = t.isBlockStatement(consequent)
					? consequent.body
					: [consequent];

				for (const stmt of body) {
					if (!t.isExpressionStatement(stmt)) continue;
					const expr = stmt.expression;
					if (!t.isAssignmentExpression(expr)) continue;
					if (!t.isNumericLiteral(expr.right, { value: 32000 })) continue;

					// Change 32000 → 64000
					expr.right = t.numericLiteral(64000);
					patched = true;
				}
			},
		});

		if (!patched) {
			console.warn(
				"output-tokens: Could not find opus-4 output token cap to patch",
			);
		}
	},

	verify: (_code, ast) => {
		if (!ast) return "Missing AST for output-tokens verification";

		let foundOpusBranch = false;
		let foundPatchedCap = false;
		let foundLegacyCap = false;

		traverse.default(ast, {
			IfStatement(path) {
				const test = path.node.test;
				if (!t.isCallExpression(test)) return;
				if (!t.isMemberExpression(test.callee)) return;
				if (!t.isIdentifier(test.callee.property, { name: "includes" })) return;
				if (test.arguments.length !== 1) return;
				if (!t.isStringLiteral(test.arguments[0], { value: "opus-4" })) return;

				foundOpusBranch = true;

				const consequent = path.node.consequent;
				const body = t.isBlockStatement(consequent)
					? consequent.body
					: [consequent];

				for (const stmt of body) {
					if (!t.isExpressionStatement(stmt)) continue;
					const expr = stmt.expression;
					if (!t.isAssignmentExpression(expr)) continue;
					if (!t.isNumericLiteral(expr.right)) continue;

					if (expr.right.value === 64000) foundPatchedCap = true;
					if (expr.right.value === 32000) foundLegacyCap = true;
				}
			},
		});

		if (!foundOpusBranch) {
			return "opus-4 output token check not found";
		}
		if (!foundPatchedCap) {
			return "opus-4 branch missing 64000 cap assignment";
		}
		if (foundLegacyCap) {
			return "opus-4 still capped at 32000";
		}

		return true;
	},
};
