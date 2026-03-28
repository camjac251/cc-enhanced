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
 * Memory-saved notification (session-mem extraction + auto-dream):
 *   - The memory_saved system message renderer shows "Saved/Improved N memories"
 *     with just file basenames. Patched to also show a content snippet (skipping
 *     YAML frontmatter) for each file, so the user can see what was written.
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
		{
			pass: "mutate",
			visitor: createMemorySavedSnippetMutator(),
		},
	],

	verify: (_code, ast) => {
		if (!ast) return "Missing AST for no-collapse verification";

		// --- Memory write UI checks ---
		const memResult = verifyMemoryWriteUi(ast);
		if (memResult !== true) return memResult;

		// --- Memory-saved snippet checks ---
		const snippetResult = verifyMemorySavedSnippet(ast);
		if (snippetResult !== true) return snippetResult;

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
			// Check 1: the _pH guard was patched from (isCollapsible||isREPL) to (isREPL||isMemoryWrite)
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

			// Check 2: UT$ wrapper was patched to return false
			FunctionDeclaration(path) {
				checkWrapperFunction(path);
			},
			FunctionExpression(path) {
				checkWrapperFunction(path);
			},

			// Check 3: Z8H still has isCollapsible property with isSearch || isRead
			// (cache tail eviction is preserved)
			ObjectProperty(path) {
				if (getObjectKeyName(path.node.key) !== "isCollapsible") return;
				let val = path.node.value;
				if (!path.parentPath || !path.parentPath.isObjectExpression()) return;
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
			// AND the function has 3 params (matching UT$'s signature: (H, $, A))
			// AND it is called with a second arg of `.input` (UI call shape).
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
		// Patch 1: _pH function. The collapse-metadata entry point.
		//
		// Find the function containing:
		//   if (H?.type === "tool_use" && H.name) {
		//     let A = <call>(...);
		//     if (A.isCollapsible || A.isREPL)
		//       return { isSearch: A.isSearch, isRead: A.isRead, isREPL: A.isREPL, isMemoryWrite: A.isMemoryWrite };
		//   }
		//   return null;
		//
		// We change the guard `A.isCollapsible || A.isREPL` to `A.isREPL || A.isMemoryWrite`.
		IfStatement(path) {
			if (patchedCollapseGuard) return;

			const test = path.node.test;

			// Match: A.isCollapsible || A.isREPL
			if (!t.isLogicalExpression(test, { operator: "||" })) return;
			if (!t.isMemberExpression(test.left)) return;
			if (!isMemberPropertyName(test.left, "isCollapsible")) return;
			if (!t.isMemberExpression(test.right)) return;
			if (!isMemberPropertyName(test.right, "isREPL")) return;

			// Verify the consequent returns an object with isSearch, isRead, isREPL, isMemoryWrite
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

			// The object variable (e.g. `A`) used in left side: A.isCollapsible
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

		// Patch 2: UT$ function. The thin isCollapsible wrapper used by UI code.
		//
		// Find: function X(H, $, A) { return <call>(H, $, A).isCollapsible; }
		// Replace the return value with: false
		//
		// Structural pattern: a function with exactly one statement (a ReturnStatement)
		// whose argument is a MemberExpression accessing .isCollapsible on a call result,
		// where the call passes through all the function's parameters.
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

// ---------------------------------------------------------------------------
// Memory-saved notification snippet (auto-dream + session-mem extraction)
// ---------------------------------------------------------------------------

/**
 * Match the per-path renderer for memory_saved notifications.
 *
 * Upstream shape (SJ6):
 *   function SJ6(H) {
 *     return <React>.createElement(
 *       <IndentComponent>,
 *       { key: H },
 *       <React>.createElement(T, { dimColor: !0 },
 *         <React>.createElement(<LinkComponent>, { filePath: H }, <path>.basename(H))),
 *     );
 *   }
 *
 * Structural anchors:
 *   - single param, single return statement
 *   - return is createElement with { key: <param> } as props
 *   - nested createElement has { filePath: <param> }
 *   - innermost child is a .basename(<param>) call
 *
 * We wrap the return in a column layout that adds a content snippet below.
 */

const SNIPPET_MAX_LINES = 12;

function isBasenameCallOnParam(node: t.Node, paramName: string): boolean {
	return (
		t.isCallExpression(node) &&
		t.isMemberExpression(node.callee) &&
		isMemberPropertyName(node.callee, "basename") &&
		node.arguments.length >= 1 &&
		t.isIdentifier(node.arguments[0], { name: paramName })
	);
}

function hasFilePathPropWithParam(
	node: t.ObjectExpression,
	paramName: string,
): boolean {
	return node.properties.some(
		(p) =>
			t.isObjectProperty(p) &&
			getObjectKeyName(p.key) === "filePath" &&
			t.isIdentifier(p.value, { name: paramName }),
	);
}

function hasKeyPropWithParam(
	node: t.ObjectExpression,
	paramName: string,
): boolean {
	return node.properties.some(
		(p) =>
			t.isObjectProperty(p) &&
			getObjectKeyName(p.key) === "key" &&
			t.isIdentifier(p.value, { name: paramName }),
	);
}

function containsBasenameCall(node: t.Node, paramName: string): boolean {
	if (isBasenameCallOnParam(node, paramName)) return true;
	if (t.isCallExpression(node)) {
		return node.arguments.some(
			(arg) => t.isNode(arg) && containsBasenameCall(arg, paramName),
		);
	}
	return false;
}

function isMemorySavedPathRenderer(
	path: traverse.NodePath<t.FunctionDeclaration | t.FunctionExpression>,
): { paramName: string; reactId: t.Identifier } | null {
	const params = path.node.params;
	if (params.length !== 1 || !t.isIdentifier(params[0])) return null;
	const paramName = params[0].name;

	const body = path.node.body;
	if (!t.isBlockStatement(body)) return null;
	if (body.body.length !== 1) return null;
	const stmt = body.body[0];
	if (!t.isReturnStatement(stmt) || !stmt.argument) return null;

	// return <React>.createElement(<Component>, { key: H }, ...)
	const ret = stmt.argument;
	if (!t.isCallExpression(ret)) return null;
	if (!t.isMemberExpression(ret.callee)) return null;
	if (!isMemberPropertyName(ret.callee, "createElement")) return null;
	if (!t.isIdentifier(ret.callee.object)) return null;
	const reactId = ret.callee.object;

	// Second arg must be { key: <param> }
	if (ret.arguments.length < 2) return null;
	const props = ret.arguments[1];
	if (!t.isObjectExpression(props)) return null;
	if (!hasKeyPropWithParam(props, paramName)) return null;

	// Third+ args must contain nested createElement with { filePath: <param> }
	// and a .basename(<param>) call
	let hasFilePath = false;
	let hasBasename = false;
	for (let i = 2; i < ret.arguments.length; i++) {
		const arg = ret.arguments[i];
		if (!t.isNode(arg)) continue;
		if (containsBasenameCall(arg, paramName)) hasBasename = true;
		// Check for filePath in nested createElement props
		const visit = (n: t.Node): void => {
			if (
				t.isCallExpression(n) &&
				n.arguments.length >= 2 &&
				t.isObjectExpression(n.arguments[1] as t.Node) &&
				hasFilePathPropWithParam(
					n.arguments[1] as t.ObjectExpression,
					paramName,
				)
			) {
				hasFilePath = true;
			}
			if (t.isCallExpression(n)) {
				for (const a of n.arguments) {
					if (t.isNode(a)) visit(a);
				}
			}
		};
		visit(arg);
	}

	if (!hasFilePath || !hasBasename) return null;
	return { paramName, reactId };
}

/**
 * Build the snippet-reading code injected into the per-path renderer.
 *
 * Generates (conceptually):
 *   let _snippet = "";
 *   try {
 *     let _raw = require("fs").readFileSync(H, "utf8");
 *     let _lines = _raw.split("\n");
 *     let _start = 0;
 *     if (_lines[0] === "---") {
 *       let _end = _lines.indexOf("---", 1);
 *       if (_end > 0) _start = _end + 1;
 *     }
 *     _snippet = _lines.slice(_start).filter(function(_l) { return _l.trim(); }).slice(0, N).join("\n");
 *   } catch (_e) {}
 */
function buildSnippetStatements(paramName: string): t.Statement[] {
	const snippetId = t.identifier("_snippet");
	const rawId = t.identifier("_raw");
	const linesId = t.identifier("_lines");
	const startId = t.identifier("_start");
	const endId = t.identifier("_end");

	// require("fs").readFileSync(H, "utf8")
	const readCall = t.callExpression(
		t.memberExpression(
			t.callExpression(t.identifier("require"), [t.stringLiteral("fs")]),
			t.identifier("readFileSync"),
		),
		[t.identifier(paramName), t.stringLiteral("utf8")],
	);

	// _lines = _raw.split("\n")
	const splitCall = t.callExpression(
		t.memberExpression(rawId, t.identifier("split")),
		[t.stringLiteral("\n")],
	);

	// _lines.indexOf("---", 1)
	const indexOfCall = t.callExpression(
		t.memberExpression(linesId, t.identifier("indexOf")),
		[t.stringLiteral("---"), t.numericLiteral(1)],
	);

	// _lines.slice(_start).filter(function(_l){return _l.trim()}).slice(0, N).join("\n")
	const bodyChain = t.callExpression(
		t.memberExpression(
			t.callExpression(
				t.memberExpression(
					t.callExpression(
						t.memberExpression(
							t.callExpression(
								t.memberExpression(linesId, t.identifier("slice")),
								[startId],
							),
							t.identifier("filter"),
						),
						[
							t.functionExpression(
								null,
								[t.identifier("_l")],
								t.blockStatement([
									t.returnStatement(
										t.callExpression(
											t.memberExpression(
												t.identifier("_l"),
												t.identifier("trim"),
											),
											[],
										),
									),
								]),
							),
						],
					),
					t.identifier("slice"),
				),
				[t.numericLiteral(0), t.numericLiteral(SNIPPET_MAX_LINES)],
			),
			t.identifier("join"),
		),
		[t.stringLiteral("\n")],
	);

	const tryBody = t.blockStatement([
		// let _raw = require("fs").readFileSync(H, "utf8");
		t.variableDeclaration("let", [t.variableDeclarator(rawId, readCall)]),
		// let _lines = _raw.split("\n");
		t.variableDeclaration("let", [t.variableDeclarator(linesId, splitCall)]),
		// let _start = 0;
		t.variableDeclaration("let", [
			t.variableDeclarator(startId, t.numericLiteral(0)),
		]),
		// if (_lines[0] === "---") { let _end = ...; if (_end > 0) _start = _end + 1; }
		t.ifStatement(
			t.binaryExpression(
				"===",
				t.memberExpression(linesId, t.numericLiteral(0), true),
				t.stringLiteral("---"),
			),
			t.blockStatement([
				t.variableDeclaration("let", [
					t.variableDeclarator(endId, indexOfCall),
				]),
				t.ifStatement(
					t.binaryExpression(">", endId, t.numericLiteral(0)),
					t.expressionStatement(
						t.assignmentExpression(
							"=",
							startId,
							t.binaryExpression("+", endId, t.numericLiteral(1)),
						),
					),
				),
			]),
		),
		// _snippet = _lines.slice(...).filter(...).slice(...).join("\n");
		t.expressionStatement(t.assignmentExpression("=", snippetId, bodyChain)),
	]);

	return [
		// let _snippet = "";
		t.variableDeclaration("let", [
			t.variableDeclarator(snippetId, t.stringLiteral("")),
		]),
		// try { ... } catch (_e) {}
		t.tryStatement(
			tryBody,
			t.catchClause(t.identifier("_e"), t.blockStatement([])),
		),
	];
}

function createMemorySavedSnippetMutator(): traverse.Visitor {
	let patched = false;

	const patchFn = (
		path: traverse.NodePath<t.FunctionDeclaration | t.FunctionExpression>,
	) => {
		if (patched) return;
		const match = isMemorySavedPathRenderer(path);
		if (!match) return;

		const { paramName, reactId } = match;
		const body = path.node.body as t.BlockStatement;
		const retStmt = body.body[0] as t.ReturnStatement;
		const originalReturn = retStmt.argument!;

		// Build:
		//   <React>.createElement(
		//     <React>.Fragment,
		//     null,
		//     <originalReturn>,
		//     _snippet ? <React>.createElement(
		//       <Box>, { paddingLeft: 4 },
		//       <React>.createElement(T, { dimColor: !0 }, _snippet)
		//     ) : null,
		//   )

		// We need references to the Box and Text components.
		// We can't know their names, but the original return's outer
		// createElement already has the indent component and we need Text.
		// Text is used in the original: createElement(Text, {dimColor:!0}, ...)
		// We can extract it by finding it in the nested calls.
		//
		// Simpler: wrap in Fragment with a conditional snippet element using
		// the same React reference and Text component from the original tree.

		// Extract the Text component identifier from the original return's nested calls.
		let textComponentId: t.Identifier | null = null;
		const findTextComponent = (node: t.Node): void => {
			if (
				t.isCallExpression(node) &&
				t.isMemberExpression(node.callee) &&
				isMemberPropertyName(node.callee, "createElement") &&
				node.arguments.length >= 2 &&
				t.isIdentifier(node.arguments[0]) &&
				t.isObjectExpression(node.arguments[1] as t.Node)
			) {
				const props = node.arguments[1] as t.ObjectExpression;
				const hasDimColor = props.properties.some(
					(p) =>
						t.isObjectProperty(p) &&
						getObjectKeyName(p.key) === "dimColor" &&
						isTrueLike(p.value),
				);
				if (hasDimColor) {
					textComponentId = node.arguments[0] as t.Identifier;
				}
				for (const arg of node.arguments) {
					if (t.isNode(arg)) findTextComponent(arg);
				}
			}
		};
		findTextComponent(originalReturn);

		if (!textComponentId) {
			console.warn(
				"no-collapse: Could not find Text component in memory-saved path renderer",
			);
			return;
		}

		const snippetId = t.identifier("_snippet");

		// Build: _snippet ? createElement(T, {dimColor:!0}, "    " + _snippet.split("\n").join("\n    ")) : null
		// This indents each line by 4 spaces to align under the filename.

		const indentedSnippet = t.callExpression(
			t.memberExpression(
				t.callExpression(
					t.memberExpression(
						t.binaryExpression("+", t.stringLiteral("    "), snippetId),
						t.identifier("split"),
					),
					[t.stringLiteral("\n")],
				),
				t.identifier("join"),
			),
			[t.stringLiteral("\n    ")],
		);

		const snippetElement = t.conditionalExpression(
			snippetId,
			t.callExpression(
				t.memberExpression(t.cloneNode(reactId), t.identifier("createElement")),
				[
					t.cloneNode(textComponentId),
					t.objectExpression([
						t.objectProperty(
							t.identifier("dimColor"),
							t.unaryExpression("!", t.numericLiteral(0)),
						),
					]),
					t.stringLiteral("\n"),
					indentedSnippet,
				],
			),
			t.nullLiteral(),
		);

		// Wrap in Fragment: createElement(React.Fragment, null, originalReturn, snippetElement)
		const wrappedReturn = t.callExpression(
			t.memberExpression(t.cloneNode(reactId), t.identifier("createElement")),
			[
				t.memberExpression(t.cloneNode(reactId), t.identifier("Fragment")),
				t.nullLiteral(),
				originalReturn,
				snippetElement,
			],
		);

		// Inject snippet-reading statements before the return
		const snippetStmts = buildSnippetStatements(paramName);
		body.body = [...snippetStmts, t.returnStatement(wrappedReturn)];

		patched = true;
		console.log(
			"no-collapse: Patched memory-saved path renderer to show content snippets",
		);
	};

	return {
		FunctionDeclaration(path) {
			patchFn(path);
		},
		FunctionExpression(path) {
			patchFn(path);
		},
		Program: {
			exit() {
				if (!patched) {
					console.warn(
						"no-collapse: Could not find memory-saved path renderer to patch",
					);
				}
			},
		},
	};
}

function verifyMemorySavedSnippet(ast: t.File): true | string {
	let foundOriginal = false;
	let foundPatched = false;

	const checkFn = (
		path: traverse.NodePath<t.FunctionDeclaration | t.FunctionExpression>,
	) => {
		const params = path.node.params;
		if (params.length !== 1 || !t.isIdentifier(params[0])) return;
		const paramName = params[0].name;

		const body = path.node.body;
		if (!t.isBlockStatement(body)) return;

		// Check for basename + filePath pattern in the function
		let hasBasename = false;
		let hasFilePath = false;
		path.traverse({
			CallExpression(inner) {
				if (isBasenameCallOnParam(inner.node, paramName)) {
					hasBasename = true;
				}
			},
			ObjectProperty(inner) {
				if (
					getObjectKeyName(inner.node.key) === "filePath" &&
					t.isIdentifier(inner.node.value, { name: paramName })
				) {
					hasFilePath = true;
				}
			},
		});
		if (!hasBasename || !hasFilePath) return;

		// Check for key prop with param (confirms this is the right function)
		let hasKeyProp = false;
		path.traverse({
			ObjectProperty(inner) {
				if (
					getObjectKeyName(inner.node.key) === "key" &&
					t.isIdentifier(inner.node.value, { name: paramName })
				) {
					hasKeyProp = true;
				}
			},
		});
		if (!hasKeyProp) return;

		// Original: single return, no readFileSync
		if (body.body.length === 1 && t.isReturnStatement(body.body[0])) {
			foundOriginal = true;
			return;
		}

		// Patched: has readFileSync call and _snippet variable
		let hasReadFileSync = false;
		let hasSnippetVar = false;
		path.traverse({
			CallExpression(inner) {
				if (
					t.isMemberExpression(inner.node.callee) &&
					isMemberPropertyName(inner.node.callee, "readFileSync")
				) {
					hasReadFileSync = true;
				}
			},
			VariableDeclarator(inner) {
				if (t.isIdentifier(inner.node.id, { name: "_snippet" })) {
					hasSnippetVar = true;
				}
			},
		});
		if (hasReadFileSync && hasSnippetVar) {
			foundPatched = true;
		}
	};

	traverse.default(ast, {
		FunctionDeclaration(path) {
			checkFn(path);
		},
		FunctionExpression(path) {
			checkFn(path);
		},
	});

	if (foundOriginal) {
		return "Memory-saved path renderer not patched (still original single-return form)";
	}
	if (!foundPatched) {
		// Upstream may have drifted. Don't fail hard, just warn
		return true;
	}
	return true;
}
