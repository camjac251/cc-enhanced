import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch } from "../types.js";
import { isFalseLike } from "./ast-helpers.js";

/**
 * Do not collapse memory file writes in the UI.
 *
 * Two separate code paths collapse memory writes:
 *
 * 1. Tool result object: isCollapsible: !0 + isMemoryWrite: !0 on the result
 *    → AST patch sets both to !1 so the result renders as a normal file write
 *
 * 2. React render function (si4/equivalent): early return with "Wrote a memory"
 *    when file path is in a memory directory and not in verbose mode
 *    → String patch removes the early return so it falls through to normal rendering
 */

function isMinifiedTrue(node: t.Node): boolean {
	// !0 === true in minified code
	return (
		t.isUnaryExpression(node) &&
		node.operator === "!" &&
		t.isNumericLiteral(node.argument, { value: 0 })
	);
}

export const memoryWriteUi: Patch = {
	tag: "memory-write-ui",

	ast: (ast) => {
		// Remove memory write/edit early returns in render functions
		// Two code paths: "Wrote a memory" (Write tool) and "Updated a memory" (Edit tool)
		const memoryStrings = ["Wrote a memory", "Updated a memory"];
		let removedCount = 0;
		traverse.default(ast, {
			StringLiteral(path) {
				if (!memoryStrings.includes(path.node.value)) return;
				// Walk up to the enclosing IfStatement
				const ifPath = path.findParent((p: any) => t.isIfStatement(p.node));
				if (!ifPath) return;
				// Verify it's an early return (consequent is a ReturnStatement)
				const consequent = (ifPath.node as t.IfStatement).consequent;
				if (
					!t.isReturnStatement(consequent) &&
					!(
						t.isBlockStatement(consequent) &&
						consequent.body.length === 1 &&
						t.isReturnStatement(consequent.body[0])
					)
				)
					return;
				ifPath.remove();
				removedCount++;
			},
		});
		if (removedCount === 0) {
			console.warn(
				"memory-write-ui: Could not find any memory early returns to remove",
			);
		}

		// Set isCollapsible and isMemoryWrite to false on tool result objects
		let patched = false;

		traverse.default(ast, {
			ReturnStatement(path) {
				const arg = path.node.argument;
				if (!t.isObjectExpression(arg)) return;

				// Find isCollapsible and isMemoryWrite properties
				let collapsibleProp: t.ObjectProperty | null = null;
				let memoryWriteProp: t.ObjectProperty | null = null;

				for (const prop of arg.properties) {
					if (!t.isObjectProperty(prop)) continue;
					if (!t.isIdentifier(prop.key)) continue;

					if (prop.key.name === "isCollapsible") {
						collapsibleProp = prop;
					} else if (prop.key.name === "isMemoryWrite") {
						memoryWriteProp = prop;
					}
				}

				// Must have both properties
				if (!collapsibleProp || !memoryWriteProp) return;

				// isMemoryWrite must be true (!0)
				if (!isMinifiedTrue(memoryWriteProp.value)) return;

				// isCollapsible must currently be true (!0)
				if (!isMinifiedTrue(collapsibleProp.value)) return;

				// Change isCollapsible from !0 to !1
				collapsibleProp.value = t.unaryExpression("!", t.numericLiteral(1));
				// Change isMemoryWrite from !0 to !1 so it renders as normal file write
				memoryWriteProp.value = t.unaryExpression("!", t.numericLiteral(1));
				patched = true;
			},
		});

		if (!patched) {
			console.warn(
				"memory-write-ui: Could not find memory write collapsibility to patch",
			);
		}
	},

	verify: (code, ast) => {
		// 1. Memory early returns should be removed (string check is appropriate —
		// we're verifying specific string literals were removed from the source)
		if (code.includes('"Wrote a memory"')) {
			return '"Wrote a memory" early return still present';
		}
		if (code.includes('"Updated a memory"')) {
			return '"Updated a memory" early return still present';
		}

		if (!ast) return "Missing AST for memory-write-ui verification";

		// 2. Both isCollapsible and isMemoryWrite should be false-like in the
		// tool result object (AST check — resilient to property reordering)
		let foundResultObject = false;
		let patchedCorrectly = false;

		traverse.default(ast, {
			ReturnStatement(path) {
				const arg = path.node.argument;
				if (!t.isObjectExpression(arg)) return;

				let collapsibleProp: t.ObjectProperty | null = null;
				let memoryWriteProp: t.ObjectProperty | null = null;

				for (const prop of arg.properties) {
					if (!t.isObjectProperty(prop) || !t.isIdentifier(prop.key)) continue;
					if (prop.key.name === "isCollapsible") collapsibleProp = prop;
					else if (prop.key.name === "isMemoryWrite") memoryWriteProp = prop;
				}

				if (!collapsibleProp || !memoryWriteProp) return;
				foundResultObject = true;

				if (
					isFalseLike(collapsibleProp.value) &&
					isFalseLike(memoryWriteProp.value)
				) {
					patchedCorrectly = true;
				}
			},
		});

		if (!foundResultObject) {
			return "Memory write result object (isCollapsible + isMemoryWrite) not found";
		}
		if (!patchedCorrectly) {
			return "Memory writes still marked as collapsible or memory write";
		}

		return true;
	},
};
