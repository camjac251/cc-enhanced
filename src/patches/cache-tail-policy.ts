import * as t from "@babel/types";
import { type NodePath, template, traverse, type Visitor } from "../babel.js";
import type { Patch } from "../types.js";
import {
	getCallableFunctionName,
	getObjectKeyName,
	getVerifyAst,
	isMemberPropertyName,
} from "./ast-helpers.js";

const AGENT_CACHE_TTL_QUERY_SOURCE = "agent:*";
const CACHE_TTL_ALLOWLIST_ANCHORS = [
	"repl_main_thread*",
	"sdk",
	"auto_mode",
] as const;

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
	return isMemberPropertyName(node.callee, "map");
}

function forEachMapCallback(
	node: t.Node | null | undefined,
	visit: (callback: t.FunctionExpression | t.ArrowFunctionExpression) => void,
): void {
	const seen = new Set<t.Node>();

	const walk = (value: unknown): void => {
		if (!value) return;
		if (Array.isArray(value)) {
			for (const item of value) walk(item);
			return;
		}
		if (typeof value !== "object") return;
		const maybeNode = value as t.Node;
		if (typeof (maybeNode as { type?: unknown }).type !== "string") return;
		if (seen.has(maybeNode)) return;
		seen.add(maybeNode);

		if (t.isExpression(maybeNode) && isMapCall(maybeNode)) {
			const callback = maybeNode.arguments[0];
			if (
				t.isFunctionExpression(callback) ||
				t.isArrowFunctionExpression(callback)
			) {
				visit(callback);
			}
		}

		for (const child of Object.values(
			maybeNode as unknown as Record<string, unknown>,
		)) {
			walk(child);
		}
	};

	walk(node);
}

function getMarkerCountSetName(stmt: t.Statement): string | null {
	const match: { payload: t.ObjectExpression | null } = { payload: null };

	nodeContains(stmt, (candidate) => {
		if (match.payload) return false;
		if (!t.isCallExpression(candidate)) return false;
		if (
			!candidate.arguments.some((arg) =>
				t.isStringLiteral(arg, { value: "tengu_api_cache_breakpoints" }),
			)
		) {
			return false;
		}
		match.payload =
			candidate.arguments.find((arg): arg is t.ObjectExpression =>
				t.isObjectExpression(arg),
			) ?? null;
		return false;
	});

	const payload = match.payload;
	if (!payload) return null;

	for (const prop of payload.properties) {
		if (!t.isObjectProperty(prop)) continue;
		if (getObjectKeyName(prop.key) !== "markerCount") continue;
		if (!t.isMemberExpression(prop.value)) continue;
		if (!isMemberPropertyName(prop.value, "size")) continue;
		if (!t.isIdentifier(prop.value.object)) return null;
		return prop.value.object.name;
	}

	return null;
}

function nodeContainsSetAdd(
	node: t.Node | null | undefined,
	setName: string,
	argumentName?: string,
): boolean {
	if (!node) return false;
	return nodeContains(node, (candidate) => {
		if (!t.isCallExpression(candidate)) return false;
		if (!t.isMemberExpression(candidate.callee)) return false;
		if (!t.isIdentifier(candidate.callee.object, { name: setName })) {
			return false;
		}
		if (!isMemberPropertyName(candidate.callee, "add")) return false;
		if (argumentName === undefined) return true;
		return (
			candidate.arguments.length >= 1 &&
			t.isIdentifier(candidate.arguments[0], { name: argumentName })
		);
	});
}

function nodeContainsSetHas(
	node: t.Node | null | undefined,
	setName: string,
	argumentName?: string,
): boolean {
	if (!node) return false;
	return nodeContains(node, (candidate) => {
		if (!t.isCallExpression(candidate)) return false;
		if (!t.isMemberExpression(candidate.callee)) return false;
		if (!t.isIdentifier(candidate.callee.object, { name: setName })) {
			return false;
		}
		if (!isMemberPropertyName(candidate.callee, "has")) return false;
		if (argumentName === undefined) return true;
		return (
			candidate.arguments.length >= 1 &&
			t.isIdentifier(candidate.arguments[0], { name: argumentName })
		);
	});
}

function findPrimaryTailSetAdd(
	body: t.Statement[],
	markerStmtIndex: number,
	setName: string,
	messagesParamName: string,
): { indexName: string; helperName: string } | null {
	// The tail-window loop steps back through cacheable positions using the
	// "previous non-system index" closure. Resolve it from its canonical seed
	// call `helper(messages.length - 1)` so the primary index it is paired with
	// can be produced by any expression (a direct call, a conditional select,
	// ...), not only a direct `helper(...)` declarator.
	const helperName = findLastIndexHelperName(body, messagesParamName);
	if (!helperName) return null;

	for (let index = 0; index < markerStmtIndex; index++) {
		const stmt = body[index];
		let addName: string | null = null;

		nodeContains(stmt, (candidate) => {
			if (addName) return false;
			if (!t.isCallExpression(candidate)) return false;
			if (!t.isMemberExpression(candidate.callee)) return false;
			if (!t.isIdentifier(candidate.callee.object, { name: setName })) {
				return false;
			}
			if (!isMemberPropertyName(candidate.callee, "add")) return false;
			const arg = candidate.arguments[0];
			if (!t.isIdentifier(arg)) return false;
			addName = arg.name;
			return false;
		});

		if (!addName) continue;
		return { indexName: addName, helperName };
	}

	return null;
}

/**
 * Resolve the "previous cacheable index" closure by its canonical seed call
 * `helper(messages.length - 1)` near the top of the breakpoint function. The
 * closure walks backward past trailing system messages; the injected
 * tail-window loop reuses it to step through earlier cacheable positions.
 */
function findLastIndexHelperName(
	body: t.Statement[],
	messagesParamName: string,
): string | null {
	let helperName: string | null = null;
	for (const stmt of body) {
		nodeContains(stmt, (candidate) => {
			if (helperName) return false;
			if (!t.isCallExpression(candidate)) return false;
			if (!t.isIdentifier(candidate.callee)) return false;
			const arg = candidate.arguments[0];
			if (
				!t.isBinaryExpression(arg, { operator: "-" }) ||
				!t.isMemberExpression(arg.left) ||
				!t.isIdentifier(arg.left.object, { name: messagesParamName }) ||
				!isMemberPropertyName(arg.left, "length") ||
				!t.isNumericLiteral(arg.right, { value: 1 })
			) {
				return false;
			}
			helperName = candidate.callee.name;
			return false;
		});
		if (helperName) break;
	}
	return helperName;
}

function hasCacheTailWindowLoop(
	body: t.Statement[],
	setName?: string,
): boolean {
	return body.some((stmt) => {
		if (!t.isForStatement(stmt)) return false;
		if (
			!t.isLogicalExpression(stmt.test, { operator: "&&" }) ||
			!t.isBinaryExpression(stmt.test.right, { operator: "<" }) ||
			!t.isIdentifier(stmt.test.right.left, { name: "cacheTailCount" }) ||
			!t.isIdentifier(stmt.test.right.right, { name: "cacheTailWindow" })
		) {
			return false;
		}
		if (setName && !nodeContainsSetAdd(stmt, setName, "cacheTailIndex")) {
			return false;
		}
		return true;
	});
}

function createCacheTailWindowStatements(
	messagesName: string,
	setName: string,
	indexName: string,
	helperName: string,
): t.Statement[] {
	const setId = t.identifier(setName);
	const indexId = t.identifier(indexName);
	const helperId = t.identifier(helperName);
	const tailIndexId = t.identifier("cacheTailIndex");
	const tailCountId = t.identifier("cacheTailCount");

	const decimationStatements = template.statements(
		`
		var userMsgCount = 0;
		if (Array.isArray(MESSAGES)) {
			for (var idx = 0; idx < MESSAGES.length; idx++) {
				var msg = MESSAGES[idx];
				if (msg && msg.type === "user") {
					userMsgCount++;
					if (userMsgCount % 15 === 0) {
						SET_NAME.add(idx);
					}
				}
			}
		}
		`,
		{ placeholderPattern: /^(MESSAGES|SET_NAME)$/ },
	)({
		MESSAGES: t.identifier(messagesName),
		SET_NAME: setId,
	});

	return [
		...decimationStatements,
		t.variableDeclaration("var", [
			t.variableDeclarator(
				t.cloneNode(tailCountId),
				t.conditionalExpression(
					t.binaryExpression(">=", t.cloneNode(indexId), t.numericLiteral(0)),
					t.numericLiteral(1),
					t.numericLiteral(0),
				),
			),
		]),
		t.forStatement(
			t.variableDeclaration("var", [
				t.variableDeclarator(
					t.cloneNode(tailIndexId),
					t.callExpression(t.cloneNode(helperId), [
						t.binaryExpression("-", t.cloneNode(indexId), t.numericLiteral(1)),
					]),
				),
			]),
			t.logicalExpression(
				"&&",
				t.binaryExpression(">=", t.cloneNode(tailIndexId), t.numericLiteral(0)),
				t.binaryExpression(
					"<",
					t.cloneNode(tailCountId),
					t.identifier("cacheTailWindow"),
				),
			),
			t.assignmentExpression(
				"=",
				t.cloneNode(tailIndexId),
				t.callExpression(t.cloneNode(helperId), [
					t.binaryExpression(
						"-",
						t.cloneNode(tailIndexId),
						t.numericLiteral(1),
					),
				]),
			),
			t.blockStatement([
				t.ifStatement(
					t.unaryExpression(
						"!",
						t.callExpression(
							t.memberExpression(t.cloneNode(setId), t.identifier("has")),
							[t.cloneNode(tailIndexId)],
						),
					),
					t.expressionStatement(
						t.callExpression(
							t.memberExpression(t.cloneNode(setId), t.identifier("add")),
							[t.cloneNode(tailIndexId)],
						),
					),
				),
				t.expressionStatement(
					t.updateExpression("++", t.cloneNode(tailCountId)),
				),
			]),
		),
	];
}

function isSetHasTailVar(
	node: t.Node,
	setName: string | null,
	indexParamName: string | null,
): boolean {
	if (!setName || !indexParamName) return false;
	return nodeContainsSetHas(node, setName, indexParamName);
}

function ensureTailPolicyDeclarations(body: t.Statement[]): {
	hasTailWindowDecl: boolean;
	hasUserOnlyDecl: boolean;
	missingDeclarations: t.VariableDeclaration[];
} {
	let hasTailWindowDecl = false;
	let hasUserOnlyDecl = false;

	for (const stmt of body) {
		if (!t.isVariableDeclaration(stmt)) continue;
		for (const decl of stmt.declarations) {
			if (!t.isIdentifier(decl.id)) continue;
			if (
				decl.id.name === "cacheTailWindow" &&
				t.isNumericLiteral(decl.init, { value: 2 })
			) {
				hasTailWindowDecl = true;
			}
			if (
				decl.id.name === "cacheUserOnly" &&
				t.isBooleanLiteral(decl.init, { value: true })
			) {
				hasUserOnlyDecl = true;
			}
		}
	}

	const missingDeclarations: t.VariableDeclaration[] = [];
	if (!hasTailWindowDecl) {
		missingDeclarations.push(
			t.variableDeclaration("var", [
				t.variableDeclarator(
					t.identifier("cacheTailWindow"),
					t.numericLiteral(2),
				),
			]),
		);
	}
	if (!hasUserOnlyDecl) {
		missingDeclarations.push(
			t.variableDeclaration("var", [
				t.variableDeclarator(
					t.identifier("cacheUserOnly"),
					t.booleanLiteral(true),
				),
			]),
		);
	}

	return { hasTailWindowDecl, hasUserOnlyDecl, missingDeclarations };
}

function nodeContainsMarker(node: t.Node | null | undefined): boolean {
	const visit = (
		value: unknown,
		options: { skipNestedFunctions: boolean },
	): boolean => {
		if (!value) return false;
		if (Array.isArray(value)) return value.some((item) => visit(item, options));
		if (typeof value !== "object") return false;
		const maybeNode = value as t.Node;
		if (typeof (maybeNode as { type?: unknown }).type !== "string")
			return false;
		if (t.isExpression(maybeNode) && isMarkerCall(maybeNode)) return true;
		if (
			options.skipNestedFunctions &&
			t.isFunction(maybeNode) &&
			maybeNode !== node
		) {
			return false;
		}
		return Object.values(maybeNode as unknown as Record<string, unknown>).some(
			(child) => visit(child, options),
		);
	};
	return visit(node, { skipNestedFunctions: false });
}

function nodeContainsMarkerOutsideNestedFunctions(
	node: t.Node | null | undefined,
): boolean {
	const visit = (value: unknown, isRoot: boolean): boolean => {
		if (!value) return false;
		if (Array.isArray(value)) return value.some((item) => visit(item, false));
		if (typeof value !== "object") return false;
		const maybeNode = value as t.Node;
		if (typeof (maybeNode as { type?: unknown }).type !== "string")
			return false;
		if (t.isExpression(maybeNode) && isMarkerCall(maybeNode)) return true;
		if (!isRoot && t.isFunction(maybeNode)) return false;
		return Object.values(maybeNode as unknown as Record<string, unknown>).some(
			(child) => visit(child, false),
		);
	};
	return visit(node, true);
}

function createCacheTailPolicyMutator(): Visitor {
	let patchedWindow = false;
	let patchedUserOnly = false;
	let patchedDecls = false;
	let done = false;

	return {
		Function(path) {
			if (done) return;
			if (!t.isBlockStatement(path.node.body)) return;
			const body = path.node.body.body;
			const markerStmtIndex = body.findIndex(
				(stmt) =>
					!t.isFunctionDeclaration(stmt) &&
					nodeContainsMarkerOutsideNestedFunctions(stmt),
			);
			if (markerStmtIndex < 0) return;
			const markerSetName = getMarkerCountSetName(body[markerStmtIndex]);
			if (!markerSetName) return;

			const { missingDeclarations } = ensureTailPolicyDeclarations(body);
			if (missingDeclarations.length > 0) {
				body.splice(markerStmtIndex, 0, ...missingDeclarations);
				patchedDecls = true;
			}
			const updatedMarkerStmtIndex =
				markerStmtIndex + missingDeclarations.length;

			if (hasCacheTailWindowLoop(body, markerSetName)) {
				patchedWindow = true;
			} else {
				const firstParam = path.node.params[0];
				const messagesVarName = t.isIdentifier(firstParam)
					? firstParam.name
					: "e";
				const primaryAdd = findPrimaryTailSetAdd(
					body,
					updatedMarkerStmtIndex,
					markerSetName,
					messagesVarName,
				);
				if (primaryAdd) {
					body.splice(
						updatedMarkerStmtIndex,
						0,
						...createCacheTailWindowStatements(
							messagesVarName,
							markerSetName,
							primaryAdd.indexName,
							primaryAdd.helperName,
						),
					);
					patchedWindow = true;
				}
			}

			const patchMapCallback = (
				callback: t.FunctionExpression | t.ArrowFunctionExpression,
			): void => {
				if (!t.isBlockStatement(callback.body)) return;

				const tailVars = new Set<string>();
				const indexParamName =
					callback.params.length >= 2 && t.isIdentifier(callback.params[1])
						? callback.params[1].name
						: null;
				let userFnName: string | null = null;

				for (const cbStmt of callback.body.body) {
					if (!t.isVariableDeclaration(cbStmt)) continue;
					for (const cbDecl of cbStmt.declarations) {
						if (!t.isIdentifier(cbDecl.id)) continue;
						if (!cbDecl.init || !t.isExpression(cbDecl.init)) continue;
						if (isSetHasTailVar(cbDecl.init, markerSetName, indexParamName)) {
							tailVars.add(cbDecl.id.name);
						}
					}
				}

				for (const cbStmt of callback.body.body) {
					if (!t.isIfStatement(cbStmt)) continue;
					if (!t.isBlockStatement(cbStmt.consequent)) continue;
					const ret = cbStmt.consequent.body.find((s) =>
						t.isReturnStatement(s),
					);
					if (!ret || !t.isReturnStatement(ret)) continue;
					if (!ret.argument || !t.isCallExpression(ret.argument)) continue;
					if (!t.isIdentifier(ret.argument.callee)) continue;
					if (ret.argument.arguments.length < 2) continue;
					if (!t.isIdentifier(ret.argument.arguments[1])) continue;
					if (!tailVars.has(ret.argument.arguments[1].name)) continue;
					userFnName = ret.argument.callee.name;
					break;
				}

				for (const cbStmt of callback.body.body) {
					if (!t.isReturnStatement(cbStmt)) continue;
					if (!cbStmt.argument || !t.isCallExpression(cbStmt.argument))
						continue;
					if (!t.isIdentifier(cbStmt.argument.callee)) continue;
					if (userFnName && cbStmt.argument.callee.name === userFnName)
						continue;
					if (cbStmt.argument.arguments.length < 2) continue;
					const arg1 = cbStmt.argument.arguments[1];

					if (
						t.isConditionalExpression(arg1) &&
						t.isIdentifier(arg1.test, { name: "cacheUserOnly" }) &&
						t.isBooleanLiteral(arg1.consequent, { value: false }) &&
						t.isIdentifier(arg1.alternate) &&
						tailVars.has(arg1.alternate.name)
					) {
						patchedUserOnly = true;
						continue;
					}

					if (!t.isIdentifier(arg1)) continue;
					if (!tailVars.has(arg1.name)) continue;

					cbStmt.argument.arguments[1] = t.conditionalExpression(
						t.identifier("cacheUserOnly"),
						t.booleanLiteral(false),
						t.identifier(arg1.name),
					);
					patchedUserOnly = true;
				}

				for (const cbStmt of callback.body.body) {
					if (!t.isReturnStatement(cbStmt)) continue;
					if (!cbStmt.argument) continue;
					if (!t.isConditionalExpression(cbStmt.argument)) continue;
					const userCall = cbStmt.argument.consequent;
					const assistantCall = cbStmt.argument.alternate;
					if (
						!t.isCallExpression(userCall) ||
						!t.isCallExpression(assistantCall)
					) {
						continue;
					}
					if (
						assistantCall.arguments.length < 2 ||
						!t.isExpression(assistantCall.arguments[1])
					) {
						continue;
					}
					const assistantArg = assistantCall.arguments[1];
					if (
						t.isConditionalExpression(assistantArg) &&
						t.isIdentifier(assistantArg.test, {
							name: "cacheUserOnly",
						}) &&
						t.isBooleanLiteral(assistantArg.consequent, {
							value: false,
						}) &&
						t.isExpression(assistantArg.alternate)
					) {
						patchedUserOnly = true;
						continue;
					}
					if (!t.isIdentifier(assistantArg)) continue;
					if (!tailVars.has(assistantArg.name)) continue;
					assistantCall.arguments[1] = t.conditionalExpression(
						t.identifier("cacheUserOnly"),
						t.booleanLiteral(false),
						t.identifier(assistantArg.name),
					);
					patchedUserOnly = true;
				}
			};

			for (const stmt of body) {
				forEachMapCallback(stmt, (callback) => patchMapCallback(callback));
			}

			if (patchedWindow || patchedUserOnly || patchedDecls) {
				done = true;
			}
		},
		Program: {
			exit() {
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
		},
	};
}

// ---------------------------------------------------------------------------
// Sysprompt global scope mutator
// ---------------------------------------------------------------------------

const SYSPROMPT_TOOL_CACHE_MARKER = "tengu_sysprompt_using_tool_based_cache";

function isSyspromptToolCacheMarker(node: t.Node): boolean {
	if (!t.isCallExpression(node)) return false;
	return node.arguments.some(
		(arg) =>
			t.isStringLiteral(arg) && arg.value === SYSPROMPT_TOOL_CACHE_MARKER,
	);
}

function blockContainsSyspromptMarker(body: t.Statement[]): boolean {
	const visit = (value: unknown): boolean => {
		if (!value) return false;
		if (Array.isArray(value)) return value.some((item) => visit(item));
		if (typeof value !== "object") return false;
		const maybeNode = value as t.Node;
		if (typeof (maybeNode as { type?: unknown }).type !== "string")
			return false;
		if (t.isExpression(maybeNode) && isSyspromptToolCacheMarker(maybeNode))
			return true;
		return Object.values(maybeNode as unknown as Record<string, unknown>).some(
			(child) => visit(child),
		);
	};
	return body.some((stmt) => visit(stmt));
}

/**
 * Find the first .push({..., cacheScope: "org"}) call in a block of statements
 * and change the cacheScope value to "global".
 *
 * In the sysprompt function, when skipGlobalCacheForSystemPrompt is true (MCP present),
 * the identity block is the FIRST push with cacheScope: "org". The remaining prompt
 * text is the SECOND push with cacheScope: "org". We only change the first one.
 */
function tryPatchPushCacheScope(
	stmt: t.Statement,
): "patched" | "already-patched" | "miss" {
	if (!t.isExpressionStatement(stmt)) return "miss";
	const expr = stmt.expression;
	if (!t.isCallExpression(expr)) return "miss";
	if (!t.isMemberExpression(expr.callee)) return "miss";
	if (!isMemberPropertyName(expr.callee, "push")) return "miss";
	if (expr.arguments.length < 1) return "miss";
	const arg = expr.arguments[0];
	if (!t.isObjectExpression(arg)) return "miss";

	for (const prop of arg.properties) {
		if (!t.isObjectProperty(prop)) continue;
		if (getObjectKeyName(prop.key) !== "cacheScope") continue;
		if (t.isNullLiteral(prop.value)) return "miss";
		if (t.isStringLiteral(prop.value, { value: "global" })) {
			return "already-patched";
		}
		if (!t.isStringLiteral(prop.value, { value: "org" })) {
			return "already-patched";
		}

		prop.value = t.stringLiteral("global");
		return "patched";
	}
	return "miss";
}

function patchFirstCacheScopeOrgToGlobal(body: t.Statement[]): boolean {
	for (const stmt of body) {
		// Walk into if-statements: handle both block and single-statement forms
		if (t.isIfStatement(stmt)) {
			if (t.isBlockStatement(stmt.consequent)) {
				if (patchFirstCacheScopeOrgToGlobal(stmt.consequent.body)) return true;
			} else if (tryPatchPushCacheScope(stmt.consequent) !== "miss") {
				return true;
			}
			continue;
		}

		// Direct expression statement
		if (tryPatchPushCacheScope(stmt) !== "miss") return true;
	}
	return false;
}

function createSyspromptGlobalScopeMutator(): Visitor {
	let patched = false;

	return {
		Function(path) {
			if (patched) return;
			if (!t.isBlockStatement(path.node.body)) return;
			const body = path.node.body.body;

			// Find the if-block that contains the sysprompt tool-based cache marker
			for (const stmt of body) {
				if (!t.isIfStatement(stmt)) continue;
				if (!t.isBlockStatement(stmt.consequent)) continue;
				if (!blockContainsSyspromptMarker(stmt.consequent.body)) continue;

				// Found the skipGlobalCacheForSystemPrompt branch
				if (patchFirstCacheScopeOrgToGlobal(stmt.consequent.body)) {
					patched = true;
					return;
				}
			}
		},
		Program: {
			exit() {
				if (!patched) {
					console.warn(
						"cache-tail-policy: Could not patch sysprompt identity scope to global",
					);
				}
			},
		},
	};
}

// ---------------------------------------------------------------------------
// Cache control 1h TTL allowlist mutator
// ---------------------------------------------------------------------------

function getStringLiteralArrayValues(
	array: t.ArrayExpression,
): string[] | null {
	const values: string[] = [];
	for (const element of array.elements) {
		if (!t.isStringLiteral(element)) return null;
		values.push(element.value);
	}
	return values;
}

function isCacheTtlAllowlistProperty(
	prop: t.ObjectProperty,
): prop is t.ObjectProperty & { value: t.ArrayExpression } {
	if (getObjectKeyName(prop.key) !== "allowlist") return false;
	if (!t.isArrayExpression(prop.value)) return false;
	const values = getStringLiteralArrayValues(prop.value);
	if (!values) return false;
	return CACHE_TTL_ALLOWLIST_ANCHORS.every((entry) => values.includes(entry));
}

function nodeContains(
	node: t.Node,
	predicate: (candidate: t.Node) => boolean,
): boolean {
	const seen = new Set<t.Node>();

	const walk = (value: unknown): boolean => {
		if (!value) return false;
		if (Array.isArray(value)) return value.some((item) => walk(item));
		if (typeof value !== "object") return false;

		const maybeNode = value as t.Node;
		if (typeof (maybeNode as { type?: unknown }).type !== "string") {
			return false;
		}
		if (seen.has(maybeNode)) return false;
		seen.add(maybeNode);

		if (predicate(maybeNode)) return true;
		return Object.values(maybeNode as unknown as Record<string, unknown>).some(
			(child) => walk(child),
		);
	};

	return walk(node);
}

function getSomeCallObjectName(
	node: t.Expression | null | undefined,
): string | null {
	if (!node) return null;
	if (t.isParenthesizedExpression(node)) {
		return getSomeCallObjectName(node.expression);
	}
	if (t.isSequenceExpression(node)) {
		for (const expression of node.expressions) {
			const name = getSomeCallObjectName(expression);
			if (name) return name;
		}
		return null;
	}
	if (t.isLogicalExpression(node)) {
		return (
			getSomeCallObjectName(node.left) ?? getSomeCallObjectName(node.right)
		);
	}
	if (
		t.isCallExpression(node) &&
		t.isMemberExpression(node.callee) &&
		t.isIdentifier(node.callee.object) &&
		isMemberPropertyName(node.callee, "some")
	) {
		return node.callee.object.name;
	}
	return null;
}

function findCacheTtlAllowlistReturn(
	body: t.Statement[],
): { index: number; allowlistName: string } | null {
	for (let index = 0; index < body.length; index++) {
		const stmt = body[index];
		if (!t.isReturnStatement(stmt) || !t.isExpression(stmt.argument)) continue;
		const allowlistName = getSomeCallObjectName(stmt.argument);
		if (allowlistName) return { index, allowlistName };
	}
	return null;
}

function hasAgentCacheTtlRuntimeGuard(
	body: t.Statement[],
	allowlistName: string,
): boolean {
	return body.some(
		(stmt) =>
			nodeContains(stmt, (node) =>
				t.isStringLiteral(node, { value: AGENT_CACHE_TTL_QUERY_SOURCE }),
			) &&
			nodeContains(
				stmt,
				(node) =>
					t.isCallExpression(node) &&
					t.isMemberExpression(node.callee) &&
					t.isIdentifier(node.callee.object, { name: allowlistName }) &&
					isMemberPropertyName(node.callee, "includes"),
			) &&
			nodeContains(
				stmt,
				(node) =>
					t.isCallExpression(node) &&
					t.isMemberExpression(node.callee) &&
					t.isIdentifier(node.callee.object, { name: allowlistName }) &&
					isMemberPropertyName(node.callee, "push"),
			),
	);
}

function createAgentCacheTtlRuntimeGuard(allowlistName: string): t.Statement {
	return template.statement(
		`
        if (Array.isArray(ALLOWLIST) && !ALLOWLIST.includes(AGENT_SOURCE)) {
            ALLOWLIST.push(AGENT_SOURCE);
        }
    `,
		{ placeholderPattern: /^(ALLOWLIST|AGENT_SOURCE)$/ },
	)({
		ALLOWLIST: t.identifier(allowlistName),
		AGENT_SOURCE: t.stringLiteral(AGENT_CACHE_TTL_QUERY_SOURCE),
	});
}

function getEnclosingFunctionBody(path: NodePath): t.Statement[] | null {
	const functionPath = path.findParent((parentPath) => parentPath.isFunction());
	if (!functionPath) return null;

	const functionNode = functionPath.node;
	if (
		!(
			t.isFunctionDeclaration(functionNode) ||
			t.isFunctionExpression(functionNode) ||
			t.isArrowFunctionExpression(functionNode)
		)
	) {
		return null;
	}
	if (!t.isBlockStatement(functionNode.body)) return null;

	return functionNode.body.body;
}

function patchAgentCacheTtlRuntimeGuard(path: NodePath): boolean {
	const body = getEnclosingFunctionBody(path);
	if (!body) return false;
	const allowlistReturn = findCacheTtlAllowlistReturn(body);
	if (!allowlistReturn) return false;
	if (hasAgentCacheTtlRuntimeGuard(body, allowlistReturn.allowlistName)) {
		return true;
	}

	body.splice(
		allowlistReturn.index,
		0,
		createAgentCacheTtlRuntimeGuard(allowlistReturn.allowlistName),
	);
	return true;
}

function createAgentCacheTtlAllowlistMutator(): Visitor {
	let patchedDefault = false;
	let patchedRuntimeGuard = false;

	return {
		ObjectProperty(path) {
			if (patchedDefault && patchedRuntimeGuard) return;
			if (!isCacheTtlAllowlistProperty(path.node)) return;

			const values = getStringLiteralArrayValues(path.node.value);
			if (!values) return;
			if (!values.includes(AGENT_CACHE_TTL_QUERY_SOURCE)) {
				path.node.value.elements.push(
					t.stringLiteral(AGENT_CACHE_TTL_QUERY_SOURCE),
				);
			}
			patchedDefault = true;
			patchedRuntimeGuard = patchAgentCacheTtlRuntimeGuard(path);
		},
		Program: {
			exit() {
				if (!patchedDefault || !patchedRuntimeGuard) {
					console.warn(
						"cache-tail-policy: Could not patch 1h cache TTL allowlist for subagents",
					);
				}
			},
		},
	};
}

// ---------------------------------------------------------------------------
// Cache control block cap mutator
// ---------------------------------------------------------------------------

function getFunctionIdentifierName(
	node:
		| t.FunctionDeclaration
		| t.FunctionExpression
		| t.ArrowFunctionExpression,
): string | null {
	if ("id" in node && node.id && t.isIdentifier(node.id)) return node.id.name;
	return null;
}

function isMaxTokensClampDeclarator(
	decl: t.VariableDeclarator,
	requestParamName: string,
	limitParamName: string,
): string | null {
	if (!t.isIdentifier(decl.id)) return null;
	if (!t.isCallExpression(decl.init)) return null;
	if (!t.isMemberExpression(decl.init.callee)) return null;
	if (!t.isIdentifier(decl.init.callee.object, { name: "Math" })) return null;
	if (!isMemberPropertyName(decl.init.callee, "min")) return null;
	if (decl.init.arguments.length !== 2) return null;
	const [left, right] = decl.init.arguments;
	if (
		!t.isMemberExpression(left) ||
		!t.isIdentifier(left.object, { name: requestParamName }) ||
		!isMemberPropertyName(left, "max_tokens") ||
		!t.isIdentifier(right, { name: limitParamName })
	) {
		return null;
	}
	return decl.id.name;
}

function isRequestCopyDeclarator(
	decl: t.VariableDeclarator,
	requestParamName: string,
): string | null {
	if (!t.isIdentifier(decl.id)) return null;
	if (!t.isObjectExpression(decl.init)) return null;
	if (decl.init.properties.length !== 1) return null;
	const [firstProp] = decl.init.properties;
	if (!t.isSpreadElement(firstProp)) return null;
	if (!t.isIdentifier(firstProp.argument, { name: requestParamName }))
		return null;
	return decl.id.name;
}

function isClampReturnStatement(
	stmt: t.Statement,
	requestCopyName: string,
	maxTokensName: string,
): stmt is t.ReturnStatement {
	if (!t.isReturnStatement(stmt) || !stmt.argument) return false;
	if (!t.isObjectExpression(stmt.argument)) return false;
	let hasRequestSpread = false;
	let hasMaxTokensProp = false;
	for (const prop of stmt.argument.properties) {
		if (
			t.isSpreadElement(prop) &&
			t.isIdentifier(prop.argument, { name: requestCopyName })
		) {
			hasRequestSpread = true;
			continue;
		}
		if (
			t.isObjectProperty(prop) &&
			getObjectKeyName(prop.key) === "max_tokens" &&
			t.isIdentifier(prop.value, { name: maxTokensName })
		) {
			hasMaxTokensProp = true;
		}
	}
	return hasRequestSpread && hasMaxTokensProp;
}

function getObjectExpressionFromExpression(
	node: t.Expression | null | undefined,
): t.ObjectExpression | null {
	if (!node) return null;
	if (t.isObjectExpression(node)) return node;
	if (t.isParenthesizedExpression(node)) {
		return getObjectExpressionFromExpression(node.expression);
	}
	if (t.isSequenceExpression(node)) {
		const last = node.expressions.at(-1);
		return getObjectExpressionFromExpression(last);
	}
	return null;
}

function objectExpressionHasOwnKeys(
	obj: t.ObjectExpression,
	requiredKeys: string[],
): boolean {
	const keys = new Set<string>();
	for (const prop of obj.properties) {
		if (!t.isObjectProperty(prop)) continue;
		const keyName = getObjectKeyName(prop.key);
		if (keyName) keys.add(keyName);
	}
	return requiredKeys.every((key) => keys.has(key));
}

function isMainRequestObjectExpression(obj: t.ObjectExpression): boolean {
	return objectExpressionHasOwnKeys(obj, [
		"model",
		"messages",
		"system",
		"tools",
		"tool_choice",
		"metadata",
		"max_tokens",
	]);
}

function hasCacheControlCapDeclaration(body: t.Statement[]): boolean {
	return body.some(
		(stmt) =>
			t.isVariableDeclaration(stmt) &&
			stmt.declarations.some((decl) =>
				t.isIdentifier(decl.id, {
					name: "maxMsgCheckpoints",
				}),
			),
	);
}

function createCacheControlCapStatements(
	requestIdentifier: t.Identifier,
): t.Statement[] {
	return template.statements(
		`
		if (Array.isArray(REQUEST.system)) {
			for (let cacheBlock of REQUEST.system) {
				if (cacheBlock && typeof cacheBlock === "object" && cacheBlock.cache_control) {
					cacheBlock.cache_control.ttl = "1h";
				}
			}
		}
		if (Array.isArray(REQUEST.tools) && REQUEST.tools.length > 0) {
			let hasSystemCache = false;
			if (Array.isArray(REQUEST.system)) {
				for (let cacheBlock of REQUEST.system) {
					if (cacheBlock && typeof cacheBlock === "object" && cacheBlock.cache_control) {
						hasSystemCache = true;
						break;
					}
				}
			}
			if (hasSystemCache) {
				for (let i = REQUEST.tools.length - 1; i >= 0; i--) {
					let tool = REQUEST.tools[i];
					if (tool && typeof tool === "object" && !tool.defer_loading) {
						tool.cache_control = { type: "ephemeral", ttl: "1h" };
						break;
					}
				}
			}
		}
		let systemCount = 0;
		if (Array.isArray(REQUEST.system)) {
			for (let cacheBlock of REQUEST.system) {
				if (cacheBlock && typeof cacheBlock === "object" && "cache_control" in cacheBlock) {
					systemCount++;
				}
			}
		}
		let toolsCount = 0;
		if (Array.isArray(REQUEST.tools)) {
			for (let cacheTool of REQUEST.tools) {
				if (cacheTool && typeof cacheTool === "object" && "cache_control" in cacheTool) {
					toolsCount++;
				}
			}
		}
		let systemToolsCount = systemCount + toolsCount;
		let maxMsgCheckpoints = 4 - systemToolsCount;
		if (maxMsgCheckpoints < 0) {
			maxMsgCheckpoints = 0;
		}
		let msgCheckpoints = [];
		let userMsgCount = 0;
		if (Array.isArray(REQUEST.messages)) {
			for (let i = 0; i < REQUEST.messages.length; i++) {
				let msg = REQUEST.messages[i];
				if (msg && msg.role === "user") {
					userMsgCount++;
					if (msg.content && Array.isArray(msg.content)) {
						for (let block of msg.content) {
							if (block && typeof block === "object" && "cache_control" in block) {
								msgCheckpoints.push({
									block: block,
									userIndex: userMsgCount,
									isDecimation: (userMsgCount % 15 === 0)
								});
							}
						}
					}
				} else if (msg && msg.content && Array.isArray(msg.content)) {
					for (let block of msg.content) {
						if (block && typeof block === "object" && "cache_control" in block) {
							msgCheckpoints.push({
								block: block,
								userIndex: userMsgCount,
								isDecimation: false
							});
						}
					}
				}
			}
		}
		if (msgCheckpoints.length > maxMsgCheckpoints) {
			let keepBlocks = new Set();
			let addKeep = function(block) {
				if (keepBlocks.size < maxMsgCheckpoints) {
					keepBlocks.add(block);
				}
			};
			let latestDecimation = null;
			for (let i = msgCheckpoints.length - 1; i >= 0; i--) {
				if (msgCheckpoints[i].isDecimation) {
					latestDecimation = msgCheckpoints[i];
					break;
				}
			}
			if (latestDecimation) {
				addKeep(latestDecimation.block);
			}
			if (msgCheckpoints.length > 0) {
				addKeep(msgCheckpoints[msgCheckpoints.length - 1].block);
			}
			for (let i = msgCheckpoints.length - 1; i >= 0; i--) {
				addKeep(msgCheckpoints[i].block);
			}
			for (let cp of msgCheckpoints) {
				if (!keepBlocks.has(cp.block)) {
					delete cp.block.cache_control;
				}
			}
		}
		`,
		{ placeholderPattern: /^(REQUEST)$/ },
	)({
		REQUEST: requestIdentifier,
	});
}

type RequestClampAnchor = {
	functionName: string;
	requestCopyName: string;
	maxTokensName: string;
	returnStmt: t.ReturnStatement;
	body: t.Statement[];
};

// Cache the request clamp anchor per AST so the verify phase can reuse the
// result the mutator's Program.exit hook already computed during mutate.
const clampAnchorCache = new WeakMap<t.File, RequestClampAnchor | null>();

function findRequestClampFunction(ast: t.File): RequestClampAnchor | null {
	const cached = clampAnchorCache.get(ast);
	if (cached !== undefined) return cached;

	let match: RequestClampAnchor | null = null;

	traverse(ast, {
		Function(path) {
			if (match) return;
			if (
				!path.isFunctionDeclaration() &&
				!path.isFunctionExpression() &&
				!path.isArrowFunctionExpression()
			) {
				return;
			}
			if (!t.isBlockStatement(path.node.body)) return;
			if (path.node.params.length !== 2) return;
			const [requestParam, limitParam] = path.node.params;
			if (!t.isIdentifier(requestParam) || !t.isIdentifier(limitParam)) return;
			const functionName = getFunctionIdentifierName(path.node);
			if (!functionName) return;

			let requestCopyName: string | null = null;
			let maxTokensName: string | null = null;
			let returnStmt: t.ReturnStatement | null = null;

			for (const stmt of path.node.body.body) {
				if (t.isVariableDeclaration(stmt)) {
					for (const decl of stmt.declarations) {
						maxTokensName =
							maxTokensName ??
							isMaxTokensClampDeclarator(
								decl,
								requestParam.name,
								limitParam.name,
							);
						requestCopyName =
							requestCopyName ??
							isRequestCopyDeclarator(decl, requestParam.name);
					}
				}
				if (
					requestCopyName &&
					maxTokensName &&
					isClampReturnStatement(stmt, requestCopyName, maxTokensName)
				) {
					returnStmt = stmt;
					break;
				}
			}

			if (!requestCopyName || !maxTokensName || !returnStmt) return;
			match = {
				functionName,
				requestCopyName,
				maxTokensName,
				returnStmt,
				body: path.node.body.body,
			};
			path.stop();
		},
	});

	clampAnchorCache.set(ast, match);
	return match;
}

function createCacheControlBlockCapClampInjector(ast: t.File): Visitor {
	return {
		Program: {
			exit() {
				const clampFn = findRequestClampFunction(ast);
				if (!clampFn) {
					console.warn(
						"cache-tail-policy: Could not find request clamp helper for cache_control cap",
					);
					return;
				}

				if (hasCacheControlCapDeclaration(clampFn.body)) {
					return; // already injected
				}

				const returnIndex = clampFn.body.indexOf(clampFn.returnStmt);
				if (returnIndex < 0) return;

				const injected = createCacheControlCapStatements(
					t.identifier(clampFn.requestCopyName),
				);
				clampFn.body.splice(returnIndex, 0, ...injected);
			},
		},
	};
}

function createCacheControlBlockCapRequestBuilderInjector(): Visitor {
	let patched = false;

	return {
		Function(path) {
			if (patched) return;
			if (!t.isBlockStatement(path.node.body)) return;
			const body = path.node.body.body;
			if (hasCacheControlCapDeclaration(body)) return;

			for (let index = 0; index < body.length; index++) {
				const stmt = body[index];
				if (!t.isVariableDeclaration(stmt)) continue;
				for (const decl of stmt.declarations) {
					if (!t.isIdentifier(decl.id)) continue;
					if (!t.isExpression(decl.init)) continue;
					const requestName = decl.id.name;
					const obj = getObjectExpressionFromExpression(decl.init);
					if (!obj || !isMainRequestObjectExpression(obj)) continue;
					if (
						!body.some(
							(bodyStmt) =>
								t.isReturnStatement(bodyStmt) &&
								t.isIdentifier(bodyStmt.argument, { name: requestName }),
						)
					) {
						continue;
					}

					const injected = createCacheControlCapStatements(
						t.identifier(requestName),
					);
					body.splice(index + 1, 0, ...injected);
					patched = true;
					return;
				}
			}
		},
		Program: {
			exit() {
				if (!patched) {
					console.warn(
						"cache-tail-policy: Could not patch live request cache_control cap",
					);
				}
			},
		},
	};
}

// ---------------------------------------------------------------------------
// Verifiers
// ---------------------------------------------------------------------------

function verifyTailWindowPolicy(ast: t.File): true | string {
	let foundMarkerFunction = false;
	let hasTailWindowDecl = false;
	let hasUserOnlyDecl = false;
	let tailWindowDeclCount = 0;
	let userOnlyDeclCount = 0;
	let hasTailWindowReassign = false;
	let hasUserOnlyReassign = false;
	let hasTailWindowGate = false;
	let hasUserOnlyConditional = false;
	let hasDecimationGate = false;

	traverse(ast, {
		Function(path) {
			if (foundMarkerFunction) return;
			if (!t.isBlockStatement(path.node.body)) return;
			const markerStmt = path.node.body.body.find(
				(stmt) => !t.isFunctionDeclaration(stmt) && nodeContainsMarker(stmt),
			);
			if (!markerStmt) return;
			const markerSetName = getMarkerCountSetName(markerStmt);

			foundMarkerFunction = true;
			hasTailWindowGate = markerSetName
				? hasCacheTailWindowLoop(path.node.body.body, markerSetName)
				: false;

			path.traverse({
				VariableDeclarator(varPath) {
					if (!t.isIdentifier(varPath.node.id)) return;
					if (varPath.node.id.name === "cacheTailWindow") {
						tailWindowDeclCount += 1;
						if (t.isNumericLiteral(varPath.node.init, { value: 2 })) {
							hasTailWindowDecl = true;
						}
					}
					if (varPath.node.id.name === "cacheUserOnly") {
						userOnlyDeclCount += 1;
						if (t.isBooleanLiteral(varPath.node.init, { value: true })) {
							hasUserOnlyDecl = true;
						}
					}
				},
				AssignmentExpression(assignPath) {
					if (
						t.isIdentifier(assignPath.node.left, {
							name: "cacheTailWindow",
						})
					) {
						hasTailWindowReassign = true;
					}
					if (
						t.isIdentifier(assignPath.node.left, {
							name: "cacheUserOnly",
						})
					) {
						hasUserOnlyReassign = true;
					}
				},
				UpdateExpression(updatePath) {
					if (
						t.isIdentifier(updatePath.node.argument, {
							name: "cacheTailWindow",
						})
					) {
						hasTailWindowReassign = true;
					}
					if (
						t.isIdentifier(updatePath.node.argument, {
							name: "cacheUserOnly",
						})
					) {
						hasUserOnlyReassign = true;
					}
				},
				ConditionalExpression(condPath) {
					if (
						t.isIdentifier(condPath.node.test, {
							name: "cacheUserOnly",
						}) &&
						t.isBooleanLiteral(condPath.node.consequent, {
							value: false,
						}) &&
						t.isExpression(condPath.node.alternate)
					) {
						hasUserOnlyConditional = true;
					}
				},
				BinaryExpression(binPath) {
					if (
						binPath.node.operator === "===" &&
						t.isBinaryExpression(binPath.node.left, { operator: "%" }) &&
						t.isIdentifier(binPath.node.left.left, { name: "userMsgCount" }) &&
						t.isNumericLiteral(binPath.node.left.right, { value: 15 }) &&
						t.isNumericLiteral(binPath.node.right, { value: 0 })
					) {
						hasDecimationGate = true;
					}
				},
			});

			path.stop();
		},
	});

	if (!foundMarkerFunction) {
		return "Could not locate cache breakpoint function anchor";
	}
	if (!hasTailWindowDecl) {
		return "Missing fixed cacheTailWindow declaration";
	}
	if (tailWindowDeclCount !== 1) {
		return `cacheTailWindow declaration is ambiguous (${tailWindowDeclCount} declarations)`;
	}
	if (!hasUserOnlyDecl) {
		return "Missing cacheUserOnly gating declaration";
	}
	if (userOnlyDeclCount !== 1) {
		return `cacheUserOnly declaration is ambiguous (${userOnlyDeclCount} declarations)`;
	}
	if (hasTailWindowReassign || hasUserOnlyReassign) {
		return "cacheTailWindow/cacheUserOnly reassignment detected after declaration";
	}
	if (!hasTailWindowGate) {
		return "Tail cache window was not patched";
	}
	if (!hasUserOnlyConditional) {
		return "Assistant cache tail gating was not patched to user-only";
	}
	if (!hasDecimationGate) {
		return "Decimation cache loop was not patched";
	}
	return true;
}

function verifySyspromptGlobalScope(ast: t.File): true | string {
	let foundSyspromptMarker = false;
	let firstNonNullScope: string | null = null;
	let hasLaterOrgScope = false;
	let nonNullScopeCount = 0;

	const readCacheScopePush = (stmt: t.Statement): string | null => {
		if (!t.isExpressionStatement(stmt)) return null;
		if (!t.isCallExpression(stmt.expression)) return null;
		if (!t.isMemberExpression(stmt.expression.callee)) return null;
		if (!isMemberPropertyName(stmt.expression.callee, "push")) return null;
		const arg = stmt.expression.arguments[0];
		if (!t.isObjectExpression(arg)) return null;

		for (const prop of arg.properties) {
			if (!t.isObjectProperty(prop)) continue;
			if (getObjectKeyName(prop.key) !== "cacheScope") continue;
			if (t.isNullLiteral(prop.value)) return null;
			if (!t.isStringLiteral(prop.value)) return null;
			return prop.value.value;
		}

		return null;
	};

	const walkScopedPushes = (stmts: t.Statement[]): void => {
		for (const stmt of stmts) {
			if (t.isIfStatement(stmt)) {
				if (t.isBlockStatement(stmt.consequent)) {
					walkScopedPushes(stmt.consequent.body);
				} else {
					const scope = readCacheScopePush(stmt.consequent);
					if (scope !== null) {
						nonNullScopeCount += 1;
						if (firstNonNullScope === null) {
							firstNonNullScope = scope;
						} else if (scope === "org") {
							hasLaterOrgScope = true;
						}
					}
				}
				continue;
			}

			const scope = readCacheScopePush(stmt);
			if (scope === null) continue;
			nonNullScopeCount += 1;
			if (firstNonNullScope === null) {
				firstNonNullScope = scope;
			} else if (scope === "org") {
				hasLaterOrgScope = true;
			}
		}
	};

	traverse(ast, {
		Function(path) {
			if (foundSyspromptMarker) return;
			if (!t.isBlockStatement(path.node.body)) return;

			for (const stmt of path.node.body.body) {
				if (!t.isIfStatement(stmt)) continue;
				if (!t.isBlockStatement(stmt.consequent)) continue;
				if (!blockContainsSyspromptMarker(stmt.consequent.body)) continue;

				foundSyspromptMarker = true;
				walkScopedPushes(stmt.consequent.body);
				path.stop();
				return;
			}
		},
	});

	if (!foundSyspromptMarker) {
		return "Could not locate sysprompt tool-based cache anchor";
	}
	if (firstNonNullScope !== "global") {
		return 'Sysprompt identity block not patched to cacheScope: "global"';
	}
	if (nonNullScopeCount > 1 && !hasLaterOrgScope) {
		return 'Sysprompt scope rewrite no longer preserves later cacheScope: "org" blocks';
	}
	return true;
}

function getObjectPatternBindingName(
	pattern: t.ObjectPattern,
	keyName: string,
): string | null {
	for (const prop of pattern.properties) {
		if (!t.isObjectProperty(prop)) continue;
		if (getObjectKeyName(prop.key) !== keyName) continue;
		if (t.isIdentifier(prop.value)) return prop.value.name;
		if (t.isAssignmentPattern(prop.value) && t.isIdentifier(prop.value.left)) {
			return prop.value.left.name;
		}
	}
	return null;
}

function verifyCacheControlTtlRespectsCaller(ast: t.File): true | string {
	let foundCacheControlBuilder = false;
	let hasCallerTtlGate = false;
	let hasScopeForcedTtlGate = false;

	traverse(ast, {
		Function(path) {
			if (foundCacheControlBuilder) return;
			if (!t.isBlockStatement(path.node.body)) return;

			const firstParam = path.node.params[0];
			let pattern: t.ObjectPattern | null = null;
			if (t.isObjectPattern(firstParam)) {
				pattern = firstParam;
			} else if (
				t.isAssignmentPattern(firstParam) &&
				t.isObjectPattern(firstParam.left)
			) {
				pattern = firstParam.left;
			}
			if (!pattern) return;

			const scopeLocalName = getObjectPatternBindingName(pattern, "scope");
			const ttlLocalName = getObjectPatternBindingName(pattern, "ttl");
			if (!scopeLocalName || !ttlLocalName) return;

			let hasEphemeral = false;
			path.traverse({
				StringLiteral(strPath) {
					if (strPath.node.value === "ephemeral") {
						hasEphemeral = true;
					}
				},
			});
			if (!hasEphemeral) return;

			foundCacheControlBuilder = true;

			path.traverse({
				ObjectExpression(objPath) {
					if (hasCallerTtlGate && hasScopeForcedTtlGate) return;
					const ttlProp = objPath.node.properties.find(
						(prop): prop is t.ObjectProperty =>
							t.isObjectProperty(prop) && getObjectKeyName(prop.key) === "ttl",
					);
					if (!ttlProp) return;

					const parent = objPath.parentPath;
					if (
						!parent?.isLogicalExpression({ operator: "&&" }) ||
						parent.node.right !== objPath.node
					) {
						return;
					}

					const left = parent.node.left;
					if (
						t.isIdentifier(left, { name: ttlLocalName }) &&
						t.isIdentifier(ttlProp.value, { name: ttlLocalName })
					) {
						hasCallerTtlGate = true;
					}
					if (
						t.isLogicalExpression(left, { operator: "||" }) &&
						t.isIdentifier(left.left, { name: scopeLocalName }) &&
						t.isIdentifier(left.right, { name: ttlLocalName }) &&
						t.isConditionalExpression(ttlProp.value) &&
						t.isIdentifier(ttlProp.value.test, { name: scopeLocalName }) &&
						t.isStringLiteral(ttlProp.value.consequent, { value: "1h" }) &&
						t.isIdentifier(ttlProp.value.alternate, { name: ttlLocalName })
					) {
						hasScopeForcedTtlGate = true;
					}
				},
			});

			path.stop();
		},
	});

	if (!foundCacheControlBuilder) {
		return "Could not locate cache control builder anchor";
	}
	if (hasScopeForcedTtlGate) {
		return "Cache control builder forces 1h TTL from scope instead of respecting caller TTL";
	}
	if (!hasCallerTtlGate) {
		return "Cache control builder no longer respects caller-provided TTL";
	}
	return true;
}

function verifyAgentCacheTtlAllowlist(ast: t.File): true | string {
	let foundAllowlist = false;
	let hasAgentQuerySource = false;
	let hasRuntimeGuard = false;

	traverse(ast, {
		ObjectProperty(path) {
			if (!isCacheTtlAllowlistProperty(path.node)) return;
			foundAllowlist = true;

			const values = getStringLiteralArrayValues(path.node.value);
			if (values?.includes(AGENT_CACHE_TTL_QUERY_SOURCE)) {
				hasAgentQuerySource = true;
			}
			const body = getEnclosingFunctionBody(path);
			const allowlistReturn = body ? findCacheTtlAllowlistReturn(body) : null;
			if (
				body &&
				allowlistReturn &&
				hasAgentCacheTtlRuntimeGuard(body, allowlistReturn.allowlistName)
			) {
				hasRuntimeGuard = true;
			}
			if (hasAgentQuerySource && hasRuntimeGuard) {
				path.stop();
			}
		},
	});

	if (!foundAllowlist) {
		return "Could not locate 1h cache TTL allowlist anchor";
	}
	if (!hasAgentQuerySource) {
		return `1h cache TTL allowlist missing ${JSON.stringify(AGENT_CACHE_TTL_QUERY_SOURCE)} query source`;
	}
	if (!hasRuntimeGuard) {
		return `1h cache TTL runtime allowlist missing ${JSON.stringify(AGENT_CACHE_TTL_QUERY_SOURCE)} query source`;
	}
	return true;
}

function verifyCacheControlBlockCap(
	ast: t.File,
	requestClampAnchor: ReturnType<typeof findRequestClampFunction>,
): true | string {
	if (!requestClampAnchor) {
		return "Could not locate request clamp helper for cache_control cap";
	}

	let fixedClampDeclCount = 0;
	let fixedRequestBuilderDeclCount = 0;
	let hasDeleteInClamp = false;
	let hasDeleteInRequestBuilder = false;

	traverse(ast, {
		Function(path) {
			if (
				!path.isFunctionDeclaration() &&
				!path.isFunctionExpression() &&
				!path.isArrowFunctionExpression()
			) {
				return;
			}
			const functionName = getFunctionIdentifierName(path.node);
			if (!t.isBlockStatement(path.node.body)) return;

			const isClampFunction = functionName === requestClampAnchor.functionName;
			let requestBuilderVarName: string | null = null;

			if (!isClampFunction) {
				for (const stmt of path.node.body.body) {
					if (t.isVariableDeclaration(stmt)) {
						for (const decl of stmt.declarations) {
							if (!t.isIdentifier(decl.id)) continue;
							if (!t.isExpression(decl.init)) continue;
							const obj = getObjectExpressionFromExpression(decl.init);
							if (!obj || !isMainRequestObjectExpression(obj)) continue;
							requestBuilderVarName = decl.id.name;
							break;
						}
					}
					if (requestBuilderVarName) break;
				}
				if (!requestBuilderVarName) return;
			}

			path.traverse({
				VariableDeclarator(varPath) {
					if (
						t.isIdentifier(varPath.node.id, {
							name: "maxMsgCheckpoints",
						}) &&
						t.isBinaryExpression(varPath.node.init, { operator: "-" }) &&
						t.isNumericLiteral(varPath.node.init.left, { value: 4 })
					) {
						if (isClampFunction) {
							fixedClampDeclCount += 1;
						} else {
							fixedRequestBuilderDeclCount += 1;
						}
					}
				},
				UnaryExpression(deletePath) {
					if (
						deletePath.node.operator === "delete" &&
						t.isMemberExpression(deletePath.node.argument) &&
						isMemberPropertyName(deletePath.node.argument, "cache_control")
					) {
						if (isClampFunction) {
							hasDeleteInClamp = true;
						} else {
							hasDeleteInRequestBuilder = true;
						}
					}
				},
			});
		},
	});

	if (fixedClampDeclCount === 0) {
		return "Request clamp helper missing fixed maxMsgCheckpoints block cap";
	}
	if (fixedClampDeclCount !== 1) {
		return `Request clamp maxMsgCheckpoints declaration is ambiguous (${fixedClampDeclCount} declarations)`;
	}
	if (fixedRequestBuilderDeclCount === 0) {
		return "Live request builder missing fixed maxMsgCheckpoints block cap";
	}
	if (fixedRequestBuilderDeclCount !== 1) {
		return `Live request builder maxMsgCheckpoints declaration is ambiguous (${fixedRequestBuilderDeclCount} declarations)`;
	}
	if (!hasDeleteInClamp) {
		return "Request clamp helper missing delete cp.block.cache_control statement";
	}
	if (!hasDeleteInRequestBuilder) {
		return "Live request builder missing delete cp.block.cache_control statement";
	}
	return true;
}

function verifyOneHourTtlEnforced(ast: t.File): true | string {
	let hasSystemTtlSet = false;
	let toolsLoopTtlSetCount = 0;
	let guardedToolsLoopTtlSetCount = 0;

	const isDeferredLoadingExclusionForTarget = (
		node: t.Node,
		targetName: string,
	): boolean =>
		t.isUnaryExpression(node, { operator: "!" }) &&
		t.isMemberExpression(node.argument) &&
		isMemberPropertyName(node.argument, "defer_loading") &&
		t.isIdentifier(node.argument.object, { name: targetName });

	const hasDeferredLoadingExclusion = (
		assignPath: NodePath<t.AssignmentExpression>,
		targetName: string,
	): boolean =>
		Boolean(
			assignPath.findParent(
				(parentPath) =>
					parentPath.isIfStatement() &&
					nodeContains(parentPath.node.test, (candidate) =>
						isDeferredLoadingExclusionForTarget(candidate, targetName),
					),
			),
		);

	const isToolsArrayElementAccess = (node: t.Node): boolean =>
		t.isMemberExpression(node) &&
		t.isMemberExpression(node.object) &&
		isMemberPropertyName(node.object, "tools");

	const hasToolsArrayLoopSource = (
		assignPath: NodePath<t.AssignmentExpression>,
		targetName: string,
	): boolean =>
		Boolean(
			assignPath.findParent((parentPath) => {
				if (!parentPath.isForStatement()) return false;
				if (!t.isBlockStatement(parentPath.node.body)) return false;
				return parentPath.node.body.body.some(
					(stmt) =>
						t.isVariableDeclaration(stmt) &&
						stmt.declarations.some(
							(decl) =>
								t.isIdentifier(decl.id, { name: targetName }) &&
								t.isMemberExpression(decl.init) &&
								isToolsArrayElementAccess(decl.init),
						),
				);
			}),
		);

	traverse(ast, {
		AssignmentExpression(assignPath) {
			const left = assignPath.node.left;
			const right = assignPath.node.right;
			if (
				t.isMemberExpression(left) &&
				isMemberPropertyName(left, "ttl") &&
				t.isMemberExpression(left.object) &&
				isMemberPropertyName(left.object, "cache_control") &&
				t.isStringLiteral(right, { value: "1h" })
			) {
				hasSystemTtlSet = true;
			}
			if (
				t.isMemberExpression(left) &&
				isMemberPropertyName(left, "cache_control") &&
				t.isObjectExpression(right)
			) {
				const typeProp = right.properties.find(
					(prop): prop is t.ObjectProperty =>
						t.isObjectProperty(prop) &&
						getObjectKeyName(prop.key) === "type" &&
						t.isStringLiteral(prop.value, { value: "ephemeral" }),
				);
				const ttlProp = right.properties.find(
					(prop): prop is t.ObjectProperty =>
						t.isObjectProperty(prop) &&
						getObjectKeyName(prop.key) === "ttl" &&
						t.isStringLiteral(prop.value, { value: "1h" }),
				);
				if (typeProp && ttlProp && t.isIdentifier(left.object)) {
					const targetName = left.object.name;
					if (hasToolsArrayLoopSource(assignPath, targetName)) {
						toolsLoopTtlSetCount += 1;
						if (hasDeferredLoadingExclusion(assignPath, targetName)) {
							guardedToolsLoopTtlSetCount += 1;
						}
					}
				}
			}
		},
	});

	if (!hasSystemTtlSet) {
		return "System prompt 1h TTL enforcement not found";
	}
	if (toolsLoopTtlSetCount < 2) {
		return "Tools array 1h TTL enforcement not found";
	}
	if (guardedToolsLoopTtlSetCount !== toolsLoopTtlSetCount) {
		return "Tools array 1h TTL enforcement must skip defer_loading tools";
	}
	return true;
}

function verifyPreWarmingUtility(
	ast: t.File,
	sideQueryFnName: string | null,
): true | string {
	if (!sideQueryFnName) {
		return "Pre-warming verification skipped: side query function name not resolved";
	}
	let foundPreWarmCall = false;

	traverse(ast, {
		CallExpression(path) {
			if (!t.isIdentifier(path.node.callee, { name: sideQueryFnName })) return;
			if (path.node.arguments.length !== 1) return;
			const arg = path.node.arguments[0];
			if (!t.isObjectExpression(arg)) return;

			const maxTokensProp = arg.properties.find(
				(prop): prop is t.ObjectProperty =>
					t.isObjectProperty(prop) &&
					getObjectKeyName(prop.key) === "max_tokens" &&
					t.isNumericLiteral(prop.value, { value: 0 }),
			);
			const querySourceProp = arg.properties.find(
				(prop): prop is t.ObjectProperty =>
					t.isObjectProperty(prop) &&
					getObjectKeyName(prop.key) === "querySource" &&
					t.isStringLiteral(prop.value, { value: "repl_main_thread" }),
			);

			if (maxTokensProp && querySourceProp) {
				foundPreWarmCall = true;
			}
		},
	});

	if (!foundPreWarmCall) {
		return "Pre-warming utility call not found";
	}
	return true;
}

function createPreWarmingMutator(): Visitor {
	let done = false;
	let sideQueryFnName: string | null = null;
	let resolvedInitialModelVarName: string | null = null;
	let optionsVarName: string | null = null;

	return {
		Function(path) {
			if (done) return;
			if (path.node.async && path.node.params.length === 1) {
				let hasSideQuery = false;
				let hasSanitized = false;
				path.traverse({
					StringLiteral(strPath) {
						if (strPath.node.value === "sideQuery") hasSideQuery = true;
						if (strPath.node.value === "tengu_lone_surrogate_sanitized")
							hasSanitized = true;
					},
				});
				if (hasSideQuery && hasSanitized) {
					const fnName = getCallableFunctionName(path);
					if (fnName) {
						sideQueryFnName = fnName;
					}
				}
			}

			if (t.isBlockStatement(path.node.body)) {
				for (const stmt of path.node.body.body) {
					if (t.isVariableDeclaration(stmt)) {
						for (const decl of stmt.declarations) {
							if (t.isObjectPattern(decl.id)) {
								for (const prop of decl.id.properties) {
									if (
										t.isObjectProperty(prop) &&
										getObjectKeyName(prop.key) === "resolvedInitialModel"
									) {
										if (t.isIdentifier(prop.value)) {
											resolvedInitialModelVarName = prop.value.name;
										}
									}
								}
							}
						}
					}
				}
			}
		},
		CallExpression(path) {
			if (done) return;
			if (
				t.isMemberExpression(path.node.callee) &&
				isMemberPropertyName(path.node.callee, "action")
			) {
				const callback = path.node.arguments[0];
				if (t.isFunction(callback) && callback.params.length >= 2) {
					const secondParam = callback.params[1];
					if (t.isIdentifier(secondParam)) {
						optionsVarName = secondParam.name;
					}
				}
			}

			if (
				path.node.arguments.length >= 1 &&
				t.isStringLiteral(path.node.arguments[0], {
					value: "tengu_startup_manual_model_config",
				})
			) {
				if (optionsVarName && resolvedInitialModelVarName && sideQueryFnName) {
					const stmt = path.findParent((p) => p.isExpressionStatement());
					if (stmt?.parentPath && t.isBlockStatement(stmt.parentPath.node)) {
						const preWarmStmt = template.statement(
							`
							if (!OPTIONS.print) {
								SIDE_QUERY({
									model: MODEL,
									system: [],
									messages: [{ role: "user", content: "warm" }],
									max_tokens: 0,
									querySource: "repl_main_thread"
								}).catch(() => {});
							}
							`,
						)({
							OPTIONS: t.identifier(optionsVarName),
							SIDE_QUERY: t.identifier(sideQueryFnName),
							MODEL: t.identifier(resolvedInitialModelVarName),
						});
						const index = stmt.parentPath.node.body.indexOf(
							stmt.node as t.Statement,
						);
						if (index >= 0) {
							stmt.parentPath.node.body.splice(index, 0, preWarmStmt);
							done = true;
						}
					}
				}
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Patch export
// ---------------------------------------------------------------------------

export const cacheTailPolicy: Patch = {
	tag: "cache-tail-policy",

	astPasses: (ast) => [
		{
			pass: "mutate",
			visitor: createCacheTailPolicyMutator(),
		},
		{
			pass: "mutate",
			visitor: createSyspromptGlobalScopeMutator(),
		},
		{
			pass: "mutate",
			visitor: createCacheControlBlockCapClampInjector(ast),
		},
		{
			pass: "mutate",
			visitor: createCacheControlBlockCapRequestBuilderInjector(),
		},
		{
			pass: "mutate",
			visitor: createAgentCacheTtlAllowlistMutator(),
		},
		{
			pass: "mutate",
			visitor: createPreWarmingMutator(),
		},
	],

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) {
			return "Unable to parse AST for cache-tail-policy verification";
		}

		const requestClampAnchor = findRequestClampFunction(verifyAst);

		const checks: Array<() => true | string> = [
			() => verifyTailWindowPolicy(verifyAst),
			() => verifySyspromptGlobalScope(verifyAst),
			() => verifyCacheControlTtlRespectsCaller(verifyAst),
			() => verifyAgentCacheTtlAllowlist(verifyAst),
			() => verifyCacheControlBlockCap(verifyAst, requestClampAnchor),
			() => verifyOneHourTtlEnforced(verifyAst),
			() => {
				let sideQueryFnName: string | null = null;
				traverse(verifyAst, {
					Function(path) {
						if (sideQueryFnName) return;
						if (path.node.async && path.node.params.length === 1) {
							let hasSideQuery = false;
							let hasSanitized = false;
							path.traverse({
								StringLiteral(strPath) {
									if (strPath.node.value === "sideQuery") hasSideQuery = true;
									if (strPath.node.value === "tengu_lone_surrogate_sanitized")
										hasSanitized = true;
								},
							});
							if (hasSideQuery && hasSanitized) {
								const fnName = getCallableFunctionName(path);
								if (fnName) {
									sideQueryFnName = fnName;
								}
							}
						}
					},
				});
				return verifyPreWarmingUtility(verifyAst, sideQueryFnName);
			},
		];
		for (const check of checks) {
			const result = check();
			if (result !== true) {
				return result;
			}
		}

		return true;
	},
};
