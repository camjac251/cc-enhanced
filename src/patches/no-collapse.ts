import traverse from "@babel/traverse";
import * as t from "@babel/types";
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
 * The old patch set `isCollapsible: false` in the central decision function,
 * which fixed UI collapse but also prevented old Read/search results from being
 * evicted during cache tail management, causing them to accumulate and waste tokens.
 *
 * This version patches the two UI consumer functions instead:
 *   - The collapse-metadata function: its `if (A.isCollapsible || A.isREPL)`
 *     guard is changed to `if (A.isREPL || A.isMemoryWrite)` so search/read results
 *     no longer trigger the collapse path.
 *   - The thin isCollapsible wrapper: patched to always return false, since its
 *     only callers are UI rendering helpers.
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
		let foundPatchedWrapper = false;
		let foundOriginalWrapper = false;
		let isCollapsibleInFactory = false;
		const callStats = new Map<
			string,
			{ count: number; hasSecondArgInputMember: boolean }
		>();

		// Collect 3-arg function call stats first so wrapper verification can
		// require that the patched function is actually called by UI paths.
		traverse.default(ast, {
			CallExpression(path) {
				if (!t.isIdentifier(path.node.callee)) return;
				if (path.node.arguments.length !== 3) return;

				const name = path.node.callee.name;
				const secondArg = path.node.arguments[1];
				const prev = callStats.get(name) ?? {
					count: 0,
					hasSecondArgInputMember: false,
				};
				prev.count += 1;
				if (
					t.isMemberExpression(secondArg) &&
					isMemberPropertyName(secondArg, "input")
				) {
					prev.hasSecondArgInputMember = true;
				}
				callStats.set(name, prev);
			},
		});

		traverse.default(ast, {
			// Check 1: the guard was patched from (isCollapsible||isREPL) to (isREPL||isMemoryWrite)
			IfStatement(path) {
				const test = path.node.test;
				if (!t.isLogicalExpression(test, { operator: "||" })) return;
				if (!t.isMemberExpression(test.left)) return;
				if (!t.isMemberExpression(test.right)) return;

				// Check for original unpatched pattern
				if (
					isMemberPropertyName(test.left, "isCollapsible") &&
					isMemberPropertyName(test.right, "isREPL")
				) {
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
						retStmt &&
						t.isReturnStatement(retStmt) &&
						retStmt.argument &&
						t.isObjectExpression(retStmt.argument)
					) {
						const hasIsSearch = retStmt.argument.properties.some((p) =>
							hasObjectKeyName(p, "isSearch"),
						);
						const hasIsRead = retStmt.argument.properties.some((p) =>
							hasObjectKeyName(p, "isRead"),
						);
						if (hasIsSearch && hasIsRead) foundOriginalGuard = true;
					}
				}

				// Check for patched pattern
				if (
					isMemberPropertyName(test.left, "isREPL") &&
					isMemberPropertyName(test.right, "isMemoryWrite")
				) {
					const consequent = path.node.consequent;
					const retStmt = t.isReturnStatement(consequent)
						? consequent
						: t.isBlockStatement(consequent)
							? (consequent.body.find((s) => t.isReturnStatement(s)) as
									| t.ReturnStatement
									| undefined)
							: undefined;
					if (
						retStmt &&
						t.isReturnStatement(retStmt) &&
						retStmt.argument &&
						t.isObjectExpression(retStmt.argument)
					) {
						const hasIsSearch = retStmt.argument.properties.some((p) =>
							hasObjectKeyName(p, "isSearch"),
						);
						const hasIsRead = retStmt.argument.properties.some((p) =>
							hasObjectKeyName(p, "isRead"),
						);
						if (hasIsSearch && hasIsRead) foundPatchedGuard = true;
					}
				}
			},

			// Check 2: wrapper was patched to return false
			FunctionDeclaration(path) {
				checkWrapperFunction(path);
			},
			FunctionExpression(path) {
				checkWrapperFunction(path);
			},

			// Check 3: factory still has isCollapsible property with isSearch || isRead
			// (cache tail eviction is preserved)
			ObjectProperty(path) {
				if (getObjectKeyName(path.node.key) !== "isCollapsible") return;
				let val = path.node.value;
				if (!path.parentPath?.isObjectExpression()) return;
				const container = path.parentPath.node;
				// Unwrap trailing || false (e.g. D.isSearch || D.isRead || !1)
				if (
					t.isLogicalExpression(val, { operator: "||" }) &&
					isFalseLike(val.right)
				) {
					val = val.left;
				}
				if (
					t.isLogicalExpression(val, { operator: "||" }) &&
					t.isMemberExpression(val.left) &&
					isMemberPropertyName(val.left, "isSearch") &&
					t.isMemberExpression(val.right) &&
					isMemberPropertyName(val.right, "isRead")
				) {
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
				}
			},
		});

		function checkWrapperFunction(
			path: traverse.NodePath<t.FunctionDeclaration | t.FunctionExpression>,
		) {
			const body = path.node.body.body;
			if (body.length !== 1) return;
			const stmt = body[0];
			if (!t.isReturnStatement(stmt) || !stmt.argument) return;
			const params = path.node.params;
			if (
				params.length !== 3 ||
				!params.every((param) => t.isIdentifier(param))
			) {
				return;
			}

			// Original: return <call>(...).isCollapsible
			if (
				t.isMemberExpression(stmt.argument) &&
				isMemberPropertyName(stmt.argument, "isCollapsible") &&
				t.isCallExpression(stmt.argument.object)
			) {
				const callArgs = stmt.argument.object.arguments;
				if (callArgs.length !== params.length) return;
				const forwardsParams = params.every((param, i) => {
					const arg = callArgs[i];
					return (
						t.isIdentifier(param) && t.isIdentifier(arg, { name: param.name })
					);
				});
				if (forwardsParams) foundOriginalWrapper = true;
			}

			// Patched: single-statement function whose sole return is false,
			// AND the function has 3 params AND it is called with a second arg
			// of `.input` (UI call shape).
			if (isFalseLike(stmt.argument)) {
				const callableName = getCallableName(path);
				if (!callableName) return;
				const stats = callStats.get(callableName);
				if (!stats) return;
				if (stats.count < 1 || !stats.hasSecondArgInputMember) return;
				foundPatchedWrapper = true;
			}
		}

		function getCallableName(
			path: traverse.NodePath<t.FunctionDeclaration | t.FunctionExpression>,
		): string | null {
			if (t.isFunctionDeclaration(path.node) && path.node.id?.name) {
				return path.node.id.name;
			}
			if (t.isFunctionExpression(path.node) && path.node.id?.name) {
				return path.node.id.name;
			}

			const parent = path.parentPath;
			if (
				parent?.isVariableDeclarator() &&
				t.isIdentifier(parent.node.id) &&
				parent.node.init === path.node
			) {
				return parent.node.id.name;
			}
			if (
				parent?.isAssignmentExpression() &&
				t.isIdentifier(parent.node.left) &&
				parent.node.right === path.node
			) {
				return parent.node.left.name;
			}

			return null;
		}

		if (foundOriginalGuard) {
			return "Original collapse-metadata guard (isCollapsible || isREPL) still present";
		}
		if (!foundPatchedGuard) {
			return "Patched collapse-metadata guard (isREPL || isMemoryWrite) not found";
		}
		if (foundOriginalWrapper) {
			return "Original isCollapsible wrapper (return ...isCollapsible) still present";
		}
		if (!foundPatchedWrapper) {
			return "Patched isCollapsible wrapper (return false) not found";
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
}

function createMemoryWriteUiMutator(): traverse.Visitor {
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

function createNoCollapseMutator(): traverse.Visitor {
	let patchedCollapseGuard = false;
	let patchedUtWrapper = false;

	const patchUtWrapperBody = (
		path: traverse.NodePath<t.FunctionDeclaration | t.FunctionExpression>,
	) => {
		const body = path.node.body.body;
		if (body.length !== 1) return;

		const stmt = body[0];
		if (!t.isReturnStatement(stmt)) return;
		if (!stmt.argument) return;

		// Match: <call>(...).isCollapsible
		if (!t.isMemberExpression(stmt.argument)) return;
		if (!isMemberPropertyName(stmt.argument, "isCollapsible")) return;
		if (!t.isCallExpression(stmt.argument.object)) return;

		// Verify the call forwards all of this function's params
		const params = path.node.params;
		const callArgs = stmt.argument.object.arguments;
		if (params.length !== 3 || callArgs.length !== params.length) return;

		// Each arg should be an identifier matching the corresponding param
		const allMatch = params.every((param, i) => {
			if (!t.isIdentifier(param)) return false;
			const arg = callArgs[i];
			return t.isIdentifier(arg, { name: param.name });
		});
		if (!allMatch) return;

		// Replace: return <call>(...).isCollapsible  ->  return false
		stmt.argument = t.booleanLiteral(false);
		patchedUtWrapper = true;
		console.log(
			"Disable collapse: Patched isCollapsible wrapper (return ...isCollapsible -> return false)",
		);
	};

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

		FunctionDeclaration(path) {
			if (patchedUtWrapper) return;
			patchUtWrapperBody(path);
		},
		FunctionExpression(path) {
			if (patchedUtWrapper) return;
			patchUtWrapperBody(path);
		},
		Program: {
			exit() {
				if (!patchedCollapseGuard) {
					console.warn(
						"Disable collapse: Could not find collapse guard pattern (isCollapsible || isREPL)",
					);
				}
				if (!patchedUtWrapper) {
					console.warn(
						"Disable collapse: Could not find isCollapsible wrapper function",
					);
				}
			},
		},
	};
}
