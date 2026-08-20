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
 *     to false so memory writes render as normal file writes with path and
 *     diff visible. The isMemoryWrite flag uses a stable false-valued AST
 *     marker so serialized artifacts remain independently verifiable.
 *
 * The central result-object factory and its `isCollapsible` property are LEFT INTACT,
 * so the cache tail scanner still sees `isCollapsible: true` for search/read
 * results and can skip them during eviction scanning.
 *
 * Display-path collapse:
 *   - Two path predicates decide whether a file write renders as a summary line
 *     instead of its diff. They are display-only, so both are rewritten to
 *     return false and every write shows its diff. Scratchpad paths are where
 *     nearly all throwaway work lands, which made the summary the common case.
 */

let memoryWritesPatched = 0;
let displayPredicatesPatched = 0;

// Export-map names for the two path predicates that gate the collapsed render.
const DISPLAY_COLLAPSE_PREDICATE_EXPORTS = new Set([
	"isScratchpadDisplayPath",
	"isWorkshopDisplayPath",
]);

export interface NoCollapseVerificationInventory {
	patchedMemoryWriteResultCount: number;
	unpatchedMemoryWriteResultCount: number;
	foundOriginalGuard: boolean;
	foundPatchedGuard: boolean;
	foundClassificationTail: boolean;
	displayPredicateNames: string[];
	neutralizedDisplayPredicates: string[];
	displayPredicateCallSites: number;
}

export function collectNoCollapseVerification(
	ast: t.File,
): NoCollapseVerificationInventory {
	let patchedMemoryWriteResultCount = 0;
	let unpatchedMemoryWriteResultCount = 0;
	let foundOriginalGuard = false;
	let foundPatchedGuard = false;
	let foundClassificationTail = false;
	const displayPredicateNames = new Set<string>();
	const neutralizedDisplayPredicates = new Set<string>();
	let displayPredicateCallSites = 0;

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
			if (isTrueLike(memoryWriteProp.value)) {
				unpatchedMemoryWriteResultCount++;
				return;
			}
			if (isPatchedMemoryWriteFalseFlag(memoryWriteProp.value)) {
				patchedMemoryWriteResultCount++;
				if (!isFalseLike(collapsibleProp.value)) {
					unpatchedMemoryWriteResultCount++;
				}
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
			const exportName = getObjectKeyName(path.node.key);
			if (exportName && DISPLAY_COLLAPSE_PREDICATE_EXPORTS.has(exportName)) {
				const target = getExportThunkIdentifierName(path.node.value);
				if (target) displayPredicateNames.add(target);
				return;
			}
			if (exportName !== "isCollapsible") return;
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

	// The predicate names only resolve during the pass above, so the bodies and
	// call sites they name are counted in a second walk.
	traverse(ast, {
		FunctionDeclaration(path) {
			const name = path.node.id?.name;
			if (!name || !displayPredicateNames.has(name)) return;
			if (isAlwaysFalseBody(path.node.body)) {
				neutralizedDisplayPredicates.add(name);
			}
		},

		CallExpression(path) {
			const callee = path.node.callee;
			if (!t.isIdentifier(callee)) return;
			if (!displayPredicateNames.has(callee.name)) return;
			displayPredicateCallSites++;
		},

		noScope: true,
	});

	return {
		patchedMemoryWriteResultCount,
		unpatchedMemoryWriteResultCount,
		foundOriginalGuard,
		foundPatchedGuard,
		foundClassificationTail,
		displayPredicateNames: [...displayPredicateNames].sort(),
		neutralizedDisplayPredicates: [...neutralizedDisplayPredicates].sort(),
		displayPredicateCallSites,
	};
}

/**
 * Read the target identifier out of an export-map thunk (`name: () => target`).
 */
function getExportThunkIdentifierName(
	value: t.Node | null | undefined,
): string | null {
	if (!t.isArrowFunctionExpression(value)) return null;
	if (value.params.length !== 0) return null;
	return t.isIdentifier(value.body) ? value.body.name : null;
}

function isAlwaysFalseBody(body: t.BlockStatement): boolean {
	if (body.body.length !== 1) return false;
	const [only] = body.body;
	return t.isReturnStatement(only) && isFalseLike(only.argument);
}

export const noCollapse: Patch = {
	tag: "no-collapse",

	astPasses: () => {
		memoryWritesPatched = 0;
		displayPredicatesPatched = 0;
		const displayPredicateNames = new Set<string>();
		return [
			{
				pass: "discover",
				visitor: createDisplayPredicateDiscoverer(displayPredicateNames),
			},
			{
				pass: "mutate",
				visitor: createNoCollapseMutator(),
			},
			{
				pass: "mutate",
				visitor: createMemoryWriteUiMutator(),
			},
			{
				pass: "mutate",
				visitor: createDisplayPredicateMutator(displayPredicateNames),
			},
		];
	},

	verify: (_code, ast, context) => {
		if (!ast) return "Missing AST for no-collapse verification";

		const inventory = collectNoCollapseVerification(ast);
		if (inventory.unpatchedMemoryWriteResultCount !== 0) {
			return "Memory write result object is not fully patched";
		}
		if (inventory.patchedMemoryWriteResultCount !== 1) {
			return `Expected exactly one patched memory write result marker, found ${inventory.patchedMemoryWriteResultCount}`;
		}
		if (context?.phase !== "artifact" && memoryWritesPatched !== 1) {
			return `Expected exactly one memory write mutation this run, found ${memoryWritesPatched}`;
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
		if (
			inventory.displayPredicateNames.length !==
			DISPLAY_COLLAPSE_PREDICATE_EXPORTS.size
		) {
			return `Expected ${DISPLAY_COLLAPSE_PREDICATE_EXPORTS.size} display-path collapse predicate exports, found ${inventory.displayPredicateNames.length}`;
		}
		if (
			inventory.neutralizedDisplayPredicates.length !==
			inventory.displayPredicateNames.length
		) {
			return "Display-path collapse predicate still reports paths as collapsible; scratchpad and workshop writes would render without a diff";
		}
		// A neutralized predicate nobody calls is a silent no-op: it means the
		// collapsed render now decides some other way and this patch stopped
		// covering it.
		if (inventory.displayPredicateCallSites === 0) {
			return "Display-path collapse predicates are no longer consulted; the collapsed write render moved";
		}
		if (
			context?.phase !== "artifact" &&
			displayPredicatesPatched !== DISPLAY_COLLAPSE_PREDICATE_EXPORTS.size
		) {
			return `Expected ${DISPLAY_COLLAPSE_PREDICATE_EXPORTS.size} display-path predicate mutations this run, found ${displayPredicatesPatched}`;
		}
		return true;
	},
};

function createDisplayPredicateDiscoverer(names: Set<string>): Visitor {
	return {
		ObjectProperty(path) {
			const exportName = getObjectKeyName(path.node.key);
			if (!exportName || !DISPLAY_COLLAPSE_PREDICATE_EXPORTS.has(exportName)) {
				return;
			}
			const target = getExportThunkIdentifierName(path.node.value);
			if (target) names.add(target);
		},
	};
}

function createDisplayPredicateMutator(names: Set<string>): Visitor {
	return {
		FunctionDeclaration(path) {
			const name = path.node.id?.name;
			if (!name || !names.has(name)) return;
			// Module-scope only: a minified name can be reused by an unrelated
			// nested function, and the export map names the top-level one.
			if (!path.parentPath?.isProgram()) return;
			if (isAlwaysFalseBody(path.node.body)) return;
			path.node.body = t.blockStatement([
				t.returnStatement(t.unaryExpression("!", t.numericLiteral(1))),
			]);
			displayPredicatesPatched++;
		},
		Program: {
			exit() {
				if (
					displayPredicatesPatched !== DISPLAY_COLLAPSE_PREDICATE_EXPORTS.size
				) {
					console.warn(
						`Disable collapse: patched ${displayPredicatesPatched} display-path predicates, expected ${DISPLAY_COLLAPSE_PREDICATE_EXPORTS.size}`,
					);
				}
			},
		},
	};
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
			memoryWriteProp.value = t.unaryExpression(
				"!",
				t.unaryExpression("!", t.numericLiteral(0)),
			);
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

function isPatchedMemoryWriteFalseFlag(
	node: t.Node | null | undefined,
): boolean {
	return (
		t.isUnaryExpression(node, { operator: "!" }) &&
		t.isUnaryExpression(node.argument, { operator: "!" }) &&
		t.isNumericLiteral(node.argument.argument, { value: 0 })
	);
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
