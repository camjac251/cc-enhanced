import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch } from "../types.js";
import { getVerifyAst } from "./ast-helpers.js";

// Coupling: targets the same Bash tool prompt as bash-output-tail.ts but in a
// different section (CLI tool recommendations vs disk persistence/tail guidance).

// Functions containing these anchors have an EMBEDDED_SEARCH_TOOLS gate (Yz()
// or equivalent) as the init of their first VariableDeclarator.  Since tools-off
// disables Glob/Grep, we force the gate to true so tool-list conditionals pick
// the branch that omits Glob/Grep names.
const EMBEDDED_SEARCH_GATE_ANCHORS = [
	"Executes a given bash command", // Bash prompt builder (gJf)
	"You are the Claude guide agent", // Guide agent prompt (wX1)
];

function containsAnchor(path: traverse.NodePath<t.Function>): boolean {
	let found = false;
	path.traverse({
		StringLiteral(inner) {
			for (const anchor of EMBEDDED_SEARCH_GATE_ANCHORS) {
				if (inner.node.value.startsWith(anchor)) {
					found = true;
					inner.stop();
					return;
				}
			}
		},
		TemplateLiteral(inner) {
			for (const quasi of inner.node.quasis) {
				const text = quasi.value.cooked ?? quasi.value.raw;
				for (const anchor of EMBEDDED_SEARCH_GATE_ANCHORS) {
					if (text.includes(anchor)) {
						found = true;
						inner.stop();
						return;
					}
				}
			}
		},
	});
	return found;
}

function patchGateInFunction(path: traverse.NodePath<t.Function>): boolean {
	let patched = false;
	path.traverse({
		VariableDeclaration(declPath) {
			if (patched) return;
			for (const decl of declPath.node.declarations) {
				// Direct: let H = Yz()
				if (
					t.isCallExpression(decl.init) &&
					decl.init.arguments.length === 0 &&
					t.isIdentifier(decl.init.callee)
				) {
					decl.init = t.unaryExpression("!", t.numericLiteral(0));
					patched = true;
					declPath.stop();
					return;
				}
				// Ternary: let H = Yz() ? A : B
				if (
					t.isConditionalExpression(decl.init) &&
					t.isCallExpression(decl.init.test) &&
					decl.init.test.arguments.length === 0 &&
					t.isIdentifier(decl.init.test.callee)
				) {
					decl.init.test = t.unaryExpression("!", t.numericLiteral(0));
					patched = true;
					declPath.stop();
					return;
				}
			}
		},
	});
	return patched;
}

function findAnchor(path: traverse.NodePath<t.Function>): string | null {
	let matched: string | null = null;
	path.traverse({
		StringLiteral(inner) {
			for (const anchor of EMBEDDED_SEARCH_GATE_ANCHORS) {
				if (inner.node.value.startsWith(anchor)) {
					matched = anchor;
					inner.stop();
					return;
				}
			}
		},
		TemplateLiteral(inner) {
			for (const quasi of inner.node.quasis) {
				const text = quasi.value.cooked ?? quasi.value.raw;
				for (const anchor of EMBEDDED_SEARCH_GATE_ANCHORS) {
					if (text.includes(anchor)) {
						matched = anchor;
						inner.stop();
						return;
					}
				}
			}
		},
	});
	return matched;
}

const isForcedTrue = (node: t.Expression | null | undefined) =>
	t.isUnaryExpression(node) &&
	node.operator === "!" &&
	t.isNumericLiteral(node.argument) &&
	node.argument.value === 0;

export const bashPrompt: Patch = {
	tag: "bash-prompt",

	// Use a Function visitor directly so the combined-pass engine visits each
	// function node natively, avoiding nested traverse conflicts.
	astPasses: () => [
		{
			pass: "mutate" as const,
			visitor: {
				Function(path: traverse.NodePath<t.Function>) {
					if (!containsAnchor(path)) return;
					if (patchGateInFunction(path)) path.skip();
				},
			},
		},
	],

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) return "Unable to parse AST during verification";

		if (code.includes("Avoid using Bash with the `find`")) {
			return "Old 'Avoid using Bash with' text still present";
		}

		if (
			!code.includes("`cat`, `head`, `tail`, `sed`, `awk`, or `echo`") &&
			!code.includes("IMPORTANT: Avoid using this tool to run ${")
		) {
			return "Expected Bash tool IMPORTANT line with avoid-list or template form";
		}

		// AST check: verify both gates are forced to !0
		const forcedAnchors = new Set<string>();
		traverse.default(verifyAst, {
			Function(path) {
				const anchor = findAnchor(path);
				if (!anchor) return;

				path.traverse({
					VariableDeclarator(declPath) {
						const init = declPath.node.init;
						if (isForcedTrue(init)) {
							forcedAnchors.add(anchor);
							declPath.stop();
							return;
						}
						if (t.isConditionalExpression(init) && isForcedTrue(init.test)) {
							forcedAnchors.add(anchor);
							declPath.stop();
						}
					},
				});

				path.skip();
			},
		});

		for (const anchor of EMBEDDED_SEARCH_GATE_ANCHORS) {
			if (!forcedAnchors.has(anchor)) {
				return `EMBEDDED_SEARCH_TOOLS gate not forced in function with: "${anchor.slice(0, 40)}..."`;
			}
		}

		return true;
	},
};
