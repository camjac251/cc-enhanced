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

export const noCollapse: Patch = {
	tag: "no-collapse",

	astPasses: () => [
		{
			pass: "mutate",
			visitor: createNoCollapseMutator(),
		},
		{
			pass: "mutate",
			visitor: createMemoryWriteUiMutator(),
		},
	],

	verify: (_code, ast) => {
		if (!ast) return "Missing AST for no-collapse verification";

		// --- Memory write UI checks ---
		const memResult = verifyMemoryWriteUi(ast);
		if (memResult !== true) return memResult;

		let foundPatchedGuard = false;
		let foundOriginalGuard = false;
		let isCollapsibleInFactory = false;

		traverse(ast, {
			// Check 1: the guard was patched from (isCollapsible||isREPL) to (isREPL||isMemoryWrite)
			IfStatement(path) {
				const test = path.node.test;
				if (!t.isLogicalExpression(test, { operator: "||" })) return;
				if (!t.isMemberExpression(test.left)) return;
				if (!t.isMemberExpression(test.right)) return;

				// Both operands must read from the SAME identifier object. A
				// malformed mutation like (foo.isREPL || bar.isMemoryWrite)
				// would otherwise satisfy the structural check.
				if (!t.isNodesEquivalent(test.left.object, test.right.object)) return;

				// Verify this is the right function by checking the return object has isSearch/isRead
				const consequent = path.node.consequent;
				const retStmt = t.isReturnStatement(consequent)
					? consequent
					: t.isBlockStatement(consequent)
						? (consequent.body.find((s) => t.isReturnStatement(s)) as
								| t.ReturnStatement
								| undefined)
						: undefined;
				if (
					!retStmt ||
					!t.isReturnStatement(retStmt) ||
					!retStmt.argument ||
					!t.isObjectExpression(retStmt.argument)
				) {
					return;
				}
				const hasIsSearch = retStmt.argument.properties.some((p) =>
					hasObjectKeyName(p, "isSearch"),
				);
				const hasIsRead = retStmt.argument.properties.some((p) =>
					hasObjectKeyName(p, "isRead"),
				);
				if (!hasIsSearch || !hasIsRead) return;

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

			// Check 2: factory still has isCollapsible set to a non-literal,
			// non-boolean value, AND the containing object carries the
			// expected sibling properties (isSearch/isRead/isREPL/
			// isMemoryWrite). The exact AST shape of the value varies
			// across upstream releases (some wrap the value in a
			// conditional expression rather than a plain disjunction).
			// Asserting the value SHAPE was too restrictive; the sibling-
			// properties guard plus non-literal value is the durable invariant.
			ObjectProperty(path) {
				if (getObjectKeyName(path.node.key) !== "isCollapsible") return;
				const val = path.node.value;
				if (!path.parentPath?.isObjectExpression()) return;
				const container = path.parentPath.node;
				if (isFalseLike(val) || isTrueLike(val) || t.isBooleanLiteral(val))
					return;
				const hasIsSearchProp = container.properties.some((p) =>
					hasObjectKeyName(p, "isSearch"),
				);
				const hasIsReadProp = container.properties.some((p) =>
					hasObjectKeyName(p, "isRead"),
				);
				const hasIsReplProp = container.properties.some((p) =>
					hasObjectKeyName(p, "isREPL"),
				);
				const hasIsMemoryWriteProp = container.properties.some((p) =>
					hasObjectKeyName(p, "isMemoryWrite"),
				);
				if (
					hasIsSearchProp &&
					hasIsReadProp &&
					hasIsReplProp &&
					hasIsMemoryWriteProp
				) {
					isCollapsibleInFactory = true;
				}
			},
		});

		if (foundOriginalGuard) {
			return "Original collapse-metadata guard (isCollapsible || isREPL) still present";
		}
		if (!foundPatchedGuard) {
			return "Patched collapse-metadata guard (isREPL || isMemoryWrite) not found";
		}
		if (!isCollapsibleInFactory) {
			return "Result-object factory isCollapsible: isSearch || isRead not found. Cache tail eviction broken";
		}
		return true;
	},
};

// ---------------------------------------------------------------------------
// Memory write UI
// ---------------------------------------------------------------------------

function verifyMemoryWriteUi(ast: t.File): true | string {
	let foundResultObject = false;
	let patchedCorrectly = false;
	let foundUnpatchedResultObject = false;

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
			foundResultObject = true;

			if (
				isFalseLike(collapsibleProp.value) &&
				isFalseLike(memoryWriteProp.value)
			) {
				patchedCorrectly = true;
			}
			if (
				isTrueLike(collapsibleProp.value) &&
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
}

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
