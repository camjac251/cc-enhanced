import * as t from "@babel/types";
import { traverse, type Visitor } from "../babel.js";
import type { Patch } from "../types.js";
import {
	getObjectKeyName,
	hasObjectKeyName,
	isFalseLike,
	isMemberPropertyName,
	isTrueLike,
} from "./ast-helpers.js";

/**
 * Disable tool output collapsing in the UI while preserving cache-tail eviction.
 * Also force memory file writes to render as normal file writes (not collapsed).
 *
 * Stock code uses a single `isCollapsible` property (set when isSearch || isRead)
 * for two unrelated purposes:
 *   1. UI rendering: collapse tool output into a summary line
 *   2. Cache tail scanning: skip old search/read results when finding the
 *      "meaningful" content boundary for eviction
 *
 * The patch changes the collapse-metadata guard from
 * `if (A.isCollapsible || A.isREPL)` to `if (A.isREPL || A.isMemoryWrite)` so
 * search/read results no longer trigger the UI collapse path.
 *
 * Memory write UI:
 *   - Tool result objects with isCollapsible: !0 + isMemoryWrite: !0 are patched
 *     to set both to !1 so memory writes render as normal file writes with
 *     path and diff visible.
 *
 * The central result-object factory and its `isCollapsible` property are LEFT INTACT,
 * so the cache tail scanner still sees `isCollapsible: true` for search/read
 * results and can skip them during eviction scanning.
 */

let memoryWritesPatched = 0;

export interface NoCollapseVerificationInventory {
	foundMemoryWriteResult: boolean;
	foundUnpatchedMemoryWriteResult: boolean;
	foundOriginalGuard: boolean;
	foundPatchedGuard: boolean;
	foundClassificationTail: boolean;
}

export function collectNoCollapseVerification(
	ast: t.File,
): NoCollapseVerificationInventory {
	let foundMemoryWriteResult = false;
	let foundUnpatchedMemoryWriteResult = false;
	let foundOriginalGuard = false;
	let foundPatchedGuard = false;
	let foundClassificationTail = false;

	traverse(ast, {
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
			foundMemoryWriteResult = true;

			if (
				isTrueLike(collapsibleProp.value) &&
				isTrueLike(memoryWriteProp.value)
			) {
				foundUnpatchedMemoryWriteResult = true;
			}
		},

		IfStatement(path) {
			const test = path.node.test;
			if (!t.isLogicalExpression(test, { operator: "||" })) return;
			if (!t.isMemberExpression(test.left)) return;
			if (!t.isMemberExpression(test.right)) return;
			if (!t.isNodesEquivalent(test.left.object, test.right.object)) return;

			const consequent = path.node.consequent;
			const retStmt = t.isReturnStatement(consequent)
				? consequent
				: t.isBlockStatement(consequent)
					? (consequent.body.find((stmt) => t.isReturnStatement(stmt)) as
							| t.ReturnStatement
							| undefined)
					: undefined;
			if (
				!retStmt?.argument ||
				!t.isObjectExpression(retStmt.argument) ||
				!retStmt.argument.properties.some((prop) =>
					hasObjectKeyName(prop, "isSearch"),
				) ||
				!retStmt.argument.properties.some((prop) =>
					hasObjectKeyName(prop, "isRead"),
				)
			) {
				return;
			}

			if (
				isMemberPropertyName(test.left, "isCollapsible") &&
				isMemberPropertyName(test.right, "isREPL")
			) {
				foundOriginalGuard = true;
			}
			if (
				isMemberPropertyName(test.left, "isREPL") &&
				isMemberPropertyName(test.right, "isMemoryWrite")
			) {
				foundPatchedGuard = true;
			}
		},

		ObjectProperty(path) {
			if (getObjectKeyName(path.node.key) !== "isCollapsible") return;
			if (!path.parentPath?.isObjectExpression()) return;
			const value = path.node.value;
			if (isFalseLike(value) || isTrueLike(value) || t.isBooleanLiteral(value))
				return;

			const properties = path.parentPath.node.properties;
			if (
				properties.some((prop) => hasObjectKeyName(prop, "isSearch")) &&
				properties.some((prop) => hasObjectKeyName(prop, "isRead")) &&
				properties.some((prop) => hasObjectKeyName(prop, "isREPL")) &&
				properties.some((prop) => hasObjectKeyName(prop, "isMemoryWrite")) &&
				properties.some((prop) => hasObjectKeyName(prop, "isBash"))
			) {
				foundClassificationTail = true;
			}
		},

		noScope: true,
	});

	return {
		foundMemoryWriteResult,
		foundUnpatchedMemoryWriteResult,
		foundOriginalGuard,
		foundPatchedGuard,
		foundClassificationTail,
	};
}

export const noCollapse: Patch = {
	tag: "no-collapse",

	astPasses: () => {
		memoryWritesPatched = 0;
		return [
			{
				pass: "mutate",
				visitor: createNoCollapseMutator(),
			},
			{
				pass: "mutate",
				visitor: createMemoryWriteUiMutator(),
			},
		];
	},

	verify: (_code, ast) => {
		if (!ast) return "Missing AST for no-collapse verification";

		const inventory = collectNoCollapseVerification(ast);
		if (!inventory.foundMemoryWriteResult) {
			return "Memory write result object (isCollapsible + isMemoryWrite) not found";
		}
		if (inventory.foundUnpatchedMemoryWriteResult) {
			return "Unpatched memory write result object still marks isCollapsible/isMemoryWrite as true";
		}
		if (memoryWritesPatched === 0) {
			return "Memory write collapsibility was not repointed this run";
		}
		if (inventory.foundOriginalGuard) {
			return "Original collapse-metadata guard (isCollapsible || isREPL) still present";
		}
		if (!inventory.foundPatchedGuard) {
			return "Patched collapse-metadata guard (isREPL || isMemoryWrite) not found";
		}
		if (!inventory.foundClassificationTail) {
			return "Result-object factory isCollapsible tail (isBash-bearing branch) not found. Cache tail eviction broken";
		}
		return true;
	},
};

function createMemoryWriteUiMutator(): Visitor {
	let patched = false;
	return {
		ReturnStatement(path) {
			const arg = path.node.argument;
			if (!t.isObjectExpression(arg)) return;

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

			if (!collapsibleProp || !memoryWriteProp) return;
			if (!isTrueLike(memoryWriteProp.value)) return;
			if (!isTrueLike(collapsibleProp.value)) return;

			collapsibleProp.value = t.unaryExpression("!", t.numericLiteral(1));
			memoryWriteProp.value = t.unaryExpression("!", t.numericLiteral(1));
			patched = true;
			memoryWritesPatched++;
		},
		Program: {
			exit() {
				if (!patched) {
					console.warn(
						"no-collapse: Could not find memory write collapsibility to patch",
					);
				}
			},
		},
	};
}

// ---------------------------------------------------------------------------
// Collapse UI mutator
// ---------------------------------------------------------------------------

function createNoCollapseMutator(): Visitor {
	let patchedCollapseGuard = false;

	return {
		IfStatement(path) {
			if (patchedCollapseGuard) return;

			const test = path.node.test;

			// Match: A.isCollapsible || A.isREPL
			if (!t.isLogicalExpression(test, { operator: "||" })) return;
			if (!t.isMemberExpression(test.left)) return;
			if (!isMemberPropertyName(test.left, "isCollapsible")) return;
			if (!t.isMemberExpression(test.right)) return;
			if (!isMemberPropertyName(test.right, "isREPL")) return;

			// Verify the consequent returns an object with isSearch, isRead
			const consequent = path.node.consequent;
			if (!t.isReturnStatement(consequent) && !t.isBlockStatement(consequent))
				return;

			const retStmt = t.isReturnStatement(consequent)
				? consequent
				: consequent.body.find((s) => t.isReturnStatement(s));
			if (
				!retStmt ||
				!t.isReturnStatement(retStmt) ||
				!retStmt.argument ||
				!t.isObjectExpression(retStmt.argument)
			)
				return;

			const retProps = retStmt.argument.properties;
			const hasIsSearch = retProps.some((p) => hasObjectKeyName(p, "isSearch"));
			const hasIsRead = retProps.some((p) => hasObjectKeyName(p, "isRead"));
			if (!hasIsSearch || !hasIsRead) return;

			const obj = test.left.object;

			// Replace: A.isCollapsible || A.isREPL  ->  A.isREPL || A.isMemoryWrite
			path.node.test = t.logicalExpression(
				"||",
				t.memberExpression(
					t.cloneNode(obj) as t.Expression,
					t.identifier("isREPL"),
				),
				t.memberExpression(
					t.cloneNode(obj) as t.Expression,
					t.identifier("isMemoryWrite"),
				),
			);

			patchedCollapseGuard = true;
			console.log(
				"Disable collapse: Patched collapse-metadata guard (isCollapsible||isREPL -> isREPL||isMemoryWrite)",
			);
		},
		Program: {
			exit() {
				if (!patchedCollapseGuard) {
					console.warn(
						"Disable collapse: Could not find collapse guard pattern (isCollapsible || isREPL)",
					);
				}
			},
		},
	};
}
