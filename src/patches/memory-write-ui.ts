import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch } from "../types.js";
import { hasObjectKeyName, isFalseLike, isTrueLike } from "./ast-helpers.js";

/**
 * Do not collapse memory file writes in the UI.
 *
 * Tool result object: isCollapsible: !0 + isMemoryWrite: !0 on the result
 * → AST patch sets both to !1 so the result renders as a normal file write
 *
 * Note: Prior to 2.1.38, a separate React render path showed "Wrote a memory" /
 * "Updated a memory" instead of the file path+diff. That was removed upstream.
 */

export const memoryWriteUi: Patch = {
	tag: "memory-write-ui",

	astPasses: () => [
		{
			pass: "mutate",
			visitor: createMemoryWriteUiMutator(),
		},
	],

	verify: (_code, ast) => {
		if (!ast) return "Missing AST for memory-write-ui verification";

		// Both isCollapsible and isMemoryWrite should be false-like in the
		// tool result object (AST check — resilient to property reordering)
		let foundResultObject = false;
		let patchedCorrectly = false;
		let foundUnpatchedResultObject = false;

		traverse.default(ast, {
			ReturnStatement(path) {
				const arg = path.node.argument;
				if (!t.isObjectExpression(arg)) return;

				let collapsibleProp: t.ObjectProperty | null = null;
				let memoryWriteProp: t.ObjectProperty | null = null;

				for (const prop of arg.properties) {
					if (!t.isObjectProperty(prop)) continue;
					if (hasObjectKeyName(prop, "isCollapsible")) collapsibleProp = prop;
					else if (hasObjectKeyName(prop, "isMemoryWrite"))
						memoryWriteProp = prop;
				}

				if (!collapsibleProp || !memoryWriteProp) return;
				foundResultObject = true;

				if (
					isFalseLike(collapsibleProp.value) &&
					isFalseLike(memoryWriteProp.value)
				) {
					patchedCorrectly = true;
				}
				if (
					isTrueLike(collapsibleProp.value) ||
					isTrueLike(memoryWriteProp.value)
				) {
					foundUnpatchedResultObject = true;
				}
			},
		});

		if (!foundResultObject) {
			return "Memory write result object (isCollapsible + isMemoryWrite) not found";
		}
		if (foundUnpatchedResultObject) {
			return "Unpatched memory write result object still marks isCollapsible/isMemoryWrite as true";
		}
		if (!patchedCorrectly) {
			return "Memory writes still marked as collapsible or memory write";
		}

		return true;
	},
};

function createMemoryWriteUiMutator(): traverse.Visitor {
	// Set isCollapsible and isMemoryWrite to false on tool result objects
	let patched = false;
	return {
		ReturnStatement(path) {
			const arg = path.node.argument;
			if (!t.isObjectExpression(arg)) return;

			// Find isCollapsible and isMemoryWrite properties
			let collapsibleProp: t.ObjectProperty | null = null;
			let memoryWriteProp: t.ObjectProperty | null = null;

			for (const prop of arg.properties) {
				if (!t.isObjectProperty(prop)) continue;
				if (hasObjectKeyName(prop, "isCollapsible")) {
					collapsibleProp = prop;
				} else if (hasObjectKeyName(prop, "isMemoryWrite")) {
					memoryWriteProp = prop;
				}
			}

			// Must have both properties
			if (!collapsibleProp || !memoryWriteProp) return;

			// isMemoryWrite must be true (!0)
			if (!isTrueLike(memoryWriteProp.value)) return;

			// isCollapsible must currently be true (!0)
			if (!isTrueLike(collapsibleProp.value)) return;

			// Change isCollapsible from !0 to !1
			collapsibleProp.value = t.unaryExpression("!", t.numericLiteral(1));
			// Change isMemoryWrite from !0 to !1 so it renders as normal file write
			memoryWriteProp.value = t.unaryExpression("!", t.numericLiteral(1));
			patched = true;
		},
		Program: {
			exit() {
				if (!patched) {
					console.warn(
						"memory-write-ui: Could not find memory write collapsibility to patch",
					);
				}
			},
		},
	};
}
