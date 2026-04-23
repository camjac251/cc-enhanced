import template from "@babel/template";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch } from "../types.js";
import {
	getObjectKeyName,
	getVerifyAst,
	isMemberPropertyName,
	objectPatternHasKey,
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

function isTailWindowPlusOneExpression(node: t.Node): boolean {
	return (
		t.isBinaryExpression(node, { operator: "+" }) &&
		t.isIdentifier(node.left, { name: "cacheTailWindow" }) &&
		t.isNumericLiteral(node.right, { value: 1 })
	);
}

function isLengthMinusOneExpression(node: t.Node): boolean {
	return (
		t.isBinaryExpression(node, { operator: "-" }) &&
		t.isMemberExpression(node.left) &&
		isMemberPropertyName(node.left, "length") &&
		t.isNumericLiteral(node.right, { value: 1 })
	);
}

function isLengthMinusTailWindowPlusOneExpression(node: t.Node): boolean {
	return (
		t.isBinaryExpression(node, { operator: "-" }) &&
		t.isMemberExpression(node.left) &&
		isMemberPropertyName(node.left, "length") &&
		isTailWindowPlusOneExpression(node.right)
	);
}

function isTailIndexMinusWindowExpression(node: t.Node): boolean {
	return (
		t.isBinaryExpression(node, { operator: "-" }) &&
		t.isIdentifier(node.left) &&
		t.isIdentifier(node.right, { name: "cacheTailWindow" })
	);
}

function patchTailGateExpression(node: t.Expression): boolean {
	if (
		t.isBinaryExpression(node) &&
		(node.operator === ">" || node.operator === "===")
	) {
		if (!t.isBinaryExpression(node.right, { operator: "-" })) return false;
		if (!t.isMemberExpression(node.right.left)) return false;
		if (!isMemberPropertyName(node.right.left, "length")) return false;
		if (isTailWindowPlusOneExpression(node.right.right)) {
			if (node.operator === "===") {
				node.operator = ">";
			}
			return true;
		}
		if (!t.isNumericLiteral(node.right.right)) return false;
		if (node.operator === "===") {
			node.operator = ">";
		}
		node.right.right = t.binaryExpression(
			"+",
			t.identifier("cacheTailWindow"),
			t.numericLiteral(1),
		);
		return true;
	}

	if (t.isLogicalExpression(node)) {
		return (
			(t.isExpression(node.left) && patchTailGateExpression(node.left)) ||
			(t.isExpression(node.right) && patchTailGateExpression(node.right))
		);
	}

	if (t.isUnaryExpression(node) && t.isExpression(node.argument)) {
		return patchTailGateExpression(node.argument);
	}

	if (t.isParenthesizedExpression(node) && t.isExpression(node.expression)) {
		return patchTailGateExpression(node.expression);
	}

	return false;
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

function createCacheTailPolicyMutator(): traverse.Visitor {
	let patchedWindow = false;
	let patchedUserOnly = false;
	let patchedDecls = false;
	let done = false;

	return {
		Function(path) {
			if (done) return;
			if (!t.isBlockStatement(path.node.body)) return;
			const body = path.node.body.body;
			const markerStmtIndex = body.findIndex((stmt) =>
				nodeContainsMarkerOutsideNestedFunctions(stmt),
			);
			if (markerStmtIndex < 0) return;

			const { missingDeclarations } = ensureTailPolicyDeclarations(body);
			if (missingDeclarations.length > 0) {
				body.splice(markerStmtIndex, 0, ...missingDeclarations);
				patchedDecls = true;
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
						if (!patchTailGateExpression(cbDecl.init)) continue;
						tailVars.add(cbDecl.id.name);
						patchedWindow = true;
					}
				}

				if (indexParamName) {
					for (const cbStmt of callback.body.body) {
						if (!t.isVariableDeclaration(cbStmt)) continue;
						for (const cbDecl of cbStmt.declarations) {
							if (
								!t.isIdentifier(cbDecl.id) ||
								tailVars.has(cbDecl.id.name) ||
								!cbDecl.init ||
								!t.isBinaryExpression(cbDecl.init, { operator: "===" }) ||
								!t.isIdentifier(cbDecl.init.left, {
									name: indexParamName,
								}) ||
								!t.isIdentifier(cbDecl.init.right)
							) {
								continue;
							}

							const tailIndexId = cbDecl.init.right;
							cbDecl.init = t.logicalExpression(
								"&&",
								t.binaryExpression(
									"<=",
									t.identifier(indexParamName),
									t.cloneNode(tailIndexId),
								),
								t.binaryExpression(
									">",
									t.identifier(indexParamName),
									t.binaryExpression(
										"-",
										t.cloneNode(tailIndexId),
										t.identifier("cacheTailWindow"),
									),
								),
							);
							tailVars.add(cbDecl.id.name);
							patchedWindow = true;
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
						userCall.arguments.length >= 2 &&
						t.isExpression(userCall.arguments[1]) &&
						patchTailGateExpression(userCall.arguments[1])
					) {
						patchedWindow = true;
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
					assistantCall.arguments[1] = t.conditionalExpression(
						t.identifier("cacheUserOnly"),
						t.booleanLiteral(false),
						t.cloneNode(assistantArg),
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

function createSyspromptGlobalScopeMutator(): traverse.Visitor {
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
// Cache control 1h TTL mutator
// ---------------------------------------------------------------------------

/**
 * Patch the cache_control builder so scoped blocks always get `ttl: "1h"`,
 * regardless of the caller-decided ttl argument. The builder has the shape:
 *
 *   function ({ scope: H, ttl: $ } = {}) {
 *     return { type: "ephemeral", ...($ && { ttl: $ }), ...(H === "global" && { scope: H }) };
 *   }
 *
 * We transform `$ && { ttl: $ }` into `(H || $) && { ttl: H ? "1h" : $ }` so
 * that any non-null scope (including "global") emits `ttl: "1h"` even when the
 * caller did not opt into the 1h TTL flag.
 */
function createCacheControlTtlMutator(): traverse.Visitor {
	let patched = false;

	return {
		Function(path) {
			if (patched) return;
			if (!t.isBlockStatement(path.node.body)) return;

			const params = path.node.params;
			if (params.length < 1) return;

			let pattern: t.ObjectPattern | null = null;
			const firstParam = params[0];
			if (t.isObjectPattern(firstParam)) {
				pattern = firstParam;
			} else if (
				t.isAssignmentPattern(firstParam) &&
				t.isObjectPattern(firstParam.left)
			) {
				pattern = firstParam.left;
			}
			if (!pattern) return;
			if (!objectPatternHasKey(pattern, "scope")) return;
			if (!objectPatternHasKey(pattern, "ttl")) return;

			const scopeLocalName = getObjectPatternBindingName(pattern, "scope");
			const ttlLocalName = getObjectPatternBindingName(pattern, "ttl");
			if (!scopeLocalName || !ttlLocalName) return;

			let hasEphemeral = false;
			path.traverse({
				StringLiteral(strPath) {
					if (strPath.node.value === "ephemeral") hasEphemeral = true;
				},
			});
			if (!hasEphemeral) return;

			path.traverse({
				ObjectExpression(objPath) {
					if (patched) return;

					const ttlProp = objPath.node.properties.find(
						(p): p is t.ObjectProperty =>
							t.isObjectProperty(p) && getObjectKeyName(p.key) === "ttl",
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

					// Idempotent: already patched.
					if (
						t.isLogicalExpression(left, { operator: "||" }) &&
						t.isIdentifier(left.left, { name: scopeLocalName }) &&
						t.isIdentifier(left.right, { name: ttlLocalName }) &&
						t.isConditionalExpression(ttlProp.value) &&
						t.isIdentifier(ttlProp.value.test, { name: scopeLocalName }) &&
						t.isStringLiteral(ttlProp.value.consequent, { value: "1h" }) &&
						t.isIdentifier(ttlProp.value.alternate, { name: ttlLocalName })
					) {
						patched = true;
						return;
					}

					// Pre-patch shape: `<ttl> && { ttl: <ttl> }`.
					if (
						!t.isIdentifier(left, { name: ttlLocalName }) ||
						!t.isIdentifier(ttlProp.value, { name: ttlLocalName })
					) {
						return;
					}

					parent.node.left = t.logicalExpression(
						"||",
						t.identifier(scopeLocalName),
						t.identifier(ttlLocalName),
					);
					ttlProp.value = t.conditionalExpression(
						t.identifier(scopeLocalName),
						t.stringLiteral("1h"),
						t.identifier(ttlLocalName),
					);
					patched = true;
				},
			});
		},
		Program: {
			exit() {
				if (!patched) {
					console.warn(
						"cache-tail-policy: Could not patch cache control 1h TTL for scoped blocks",
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

function getEnclosingFunctionBody(
	path: traverse.NodePath,
): t.Statement[] | null {
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

function patchAgentCacheTtlRuntimeGuard(path: traverse.NodePath): boolean {
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

function createAgentCacheTtlAllowlistMutator(): traverse.Visitor {
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
					name: "cacheControlExcess",
				}),
			),
	);
}

function createCacheControlCapStatements(
	requestIdentifier: t.Identifier,
): t.Statement[] {
	return template.statements(
		`
		let cacheControlExcess = -4;
		if (Array.isArray(REQUEST.tools)) {
			for (let cacheTool of REQUEST.tools) {
				if (cacheTool && typeof cacheTool === "object" && "cache_control" in cacheTool) {
					cacheControlExcess++;
				}
			}
		}
		if (Array.isArray(REQUEST.system)) {
			for (let cacheBlock of REQUEST.system) {
				if (cacheBlock && typeof cacheBlock === "object" && "cache_control" in cacheBlock) {
					cacheControlExcess++;
				}
			}
		}
		if (Array.isArray(REQUEST.messages)) {
			for (let cacheMessage of REQUEST.messages) {
				if (!cacheMessage || typeof cacheMessage !== "object" || !Array.isArray(cacheMessage.content)) continue;
				for (let cacheBlock of cacheMessage.content) {
					if (cacheBlock && typeof cacheBlock === "object" && "cache_control" in cacheBlock) {
						cacheControlExcess++;
					}
				}
			}
		}
		if (cacheControlExcess > 0 && Array.isArray(REQUEST.messages)) {
			REQUEST.messages = REQUEST.messages.map((cacheMessage) => {
				if (cacheControlExcess <= 0 || !cacheMessage || typeof cacheMessage !== "object" || !Array.isArray(cacheMessage.content)) {
					return cacheMessage;
				}
				let cacheContent = cacheMessage.content.map((cacheBlock) => {
					if (cacheControlExcess > 0 && cacheBlock && typeof cacheBlock === "object" && "cache_control" in cacheBlock) {
						cacheControlExcess--;
						let { cache_control: removedCacheControl, ...cacheBlockRest } = cacheBlock;
						return cacheBlockRest;
					}
					return cacheBlock;
				});
				return { ...cacheMessage, content: cacheContent };
			});
		}
		if (cacheControlExcess > 0 && Array.isArray(REQUEST.system)) {
			REQUEST.system = REQUEST.system.map((cacheBlock) => {
				if (cacheControlExcess > 0 && cacheBlock && typeof cacheBlock === "object" && "cache_control" in cacheBlock) {
					cacheControlExcess--;
					let { cache_control: removedCacheControl, ...cacheBlockRest } = cacheBlock;
					return cacheBlockRest;
				}
				return cacheBlock;
			});
		}
		if (cacheControlExcess > 0 && Array.isArray(REQUEST.tools)) {
			REQUEST.tools = REQUEST.tools.map((cacheTool) => {
				if (cacheControlExcess > 0 && cacheTool && typeof cacheTool === "object" && "cache_control" in cacheTool) {
					cacheControlExcess--;
					let { cache_control: removedCacheControl, ...cacheToolRest } = cacheTool;
					return cacheToolRest;
				}
				return cacheTool;
			});
		}
	`,
		{ placeholderPattern: /^(REQUEST)$/ },
	)({
		REQUEST: requestIdentifier,
	});
}

function findRequestClampFunction(ast: t.File): {
	functionName: string;
	requestCopyName: string;
	maxTokensName: string;
	returnStmt: t.ReturnStatement;
	body: t.Statement[];
} | null {
	let match: {
		functionName: string;
		requestCopyName: string;
		maxTokensName: string;
		returnStmt: t.ReturnStatement;
		body: t.Statement[];
	} | null = null;

	traverse.default(ast, {
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

	return match;
}

function createCacheControlBlockCapClampInjector(
	ast: t.File,
): traverse.Visitor {
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

function createCacheControlBlockCapRequestBuilderInjector(): traverse.Visitor {
	let patched = false;

	return {
		Function(path) {
			if (patched) return;
			if (!t.isBlockStatement(path.node.body)) return;
			const body = path.node.body.body;
			if (hasCacheControlCapDeclaration(body)) return;

			for (let index = 0; index < body.length; index++) {
				const stmt = body[index];
				if (!t.isReturnStatement(stmt)) continue;
				if (!stmt.argument || !t.isExpression(stmt.argument)) continue;
				const obj = getObjectExpressionFromExpression(stmt.argument);
				if (!obj || !isMainRequestObjectExpression(obj)) continue;

				const requestId = path.scope.generateUidIdentifier(
					"cacheControlledRequest",
				);
				const requestDeclaration = t.variableDeclaration("let", [
					t.variableDeclarator(requestId, stmt.argument),
				]);
				const injected = createCacheControlCapStatements(requestId);

				stmt.argument = t.cloneNode(requestId);
				body.splice(index, 0, requestDeclaration, ...injected);
				patched = true;
				return;
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
	let hasLegacyTailEqualityGate = false;

	traverse.default(ast, {
		Function(path) {
			if (foundMarkerFunction) return;
			if (!t.isBlockStatement(path.node.body)) return;
			if (!path.node.body.body.some((stmt) => nodeContainsMarker(stmt))) return;

			foundMarkerFunction = true;

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
				BinaryExpression(binaryPath) {
					const node = binaryPath.node;
					if (
						node.operator === ">" &&
						(isLengthMinusTailWindowPlusOneExpression(node.right) ||
							isTailIndexMinusWindowExpression(node.right))
					) {
						hasTailWindowGate = true;
					}
					if (
						node.operator === "===" &&
						isLengthMinusOneExpression(node.right)
					) {
						hasLegacyTailEqualityGate = true;
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
	if (hasLegacyTailEqualityGate) {
		return "Legacy tail cache gate (=== length - 1) still present in cache breakpoint function";
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

	traverse.default(ast, {
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

function verifyScopedCacheControlTtl(ast: t.File): true | string {
	let foundCacheControlBuilder = false;
	let hasScopeTtlGate = false;

	traverse.default(ast, {
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
					if (hasScopeTtlGate) return;
					const ttlProp = objPath.node.properties.find(
						(prop): prop is t.ObjectProperty =>
							t.isObjectProperty(prop) && getObjectKeyName(prop.key) === "ttl",
					);
					if (!ttlProp) return;
					if (
						!t.isConditionalExpression(ttlProp.value) ||
						!t.isIdentifier(ttlProp.value.test, { name: scopeLocalName }) ||
						!t.isStringLiteral(ttlProp.value.consequent, { value: "1h" }) ||
						!t.isIdentifier(ttlProp.value.alternate, { name: ttlLocalName })
					) {
						return;
					}

					const parent = objPath.parentPath;
					if (
						!parent?.isLogicalExpression({ operator: "&&" }) ||
						parent.node.right !== objPath.node
					) {
						return;
					}

					const left = parent.node.left;
					if (
						t.isLogicalExpression(left, { operator: "||" }) &&
						t.isIdentifier(left.left, { name: scopeLocalName }) &&
						t.isIdentifier(left.right, { name: ttlLocalName })
					) {
						hasScopeTtlGate = true;
					}
				},
			});

			path.stop();
		},
	});

	if (!foundCacheControlBuilder) {
		return "Could not locate cache control builder anchor";
	}
	if (!hasScopeTtlGate) {
		return "Cache control builder not patched for 1h TTL on scoped blocks";
	}
	return true;
}

function verifyAgentCacheTtlAllowlist(ast: t.File): true | string {
	let foundAllowlist = false;
	let hasAgentQuerySource = false;
	let hasRuntimeGuard = false;

	traverse.default(ast, {
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

function verifyCacheControlBlockCap(ast: t.File): true | string {
	const requestClampAnchor = findRequestClampFunction(ast);
	if (!requestClampAnchor) {
		return "Could not locate request clamp helper for cache_control cap";
	}

	let fixedClampDeclCount = 0;
	let fixedRequestBuilderDeclCount = 0;
	const strippedClampTargets = new Set<string>();
	const strippedRequestBuilderTargets = new Set<string>();

	traverse.default(ast, {
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
						!t.isIdentifier(varPath.node.id, {
							name: "cacheControlExcess",
						})
					) {
						return;
					}
					if (
						t.isUnaryExpression(varPath.node.init, {
							operator: "-",
						}) &&
						t.isNumericLiteral(varPath.node.init.argument, { value: 4 })
					) {
						if (isClampFunction) {
							fixedClampDeclCount += 1;
						} else {
							fixedRequestBuilderDeclCount += 1;
						}
					}
				},
				AssignmentExpression(assignPath) {
					const left = assignPath.node.left;
					const right = assignPath.node.right;
					if (!t.isMemberExpression(left)) return;
					const expectedTarget = isClampFunction
						? requestClampAnchor.requestCopyName
						: requestBuilderVarName;
					if (!expectedTarget) return;
					if (!t.isIdentifier(left.object, { name: expectedTarget })) return;
					if (
						!t.isCallExpression(right) ||
						!t.isMemberExpression(right.callee)
					) {
						return;
					}
					if (!isMemberPropertyName(right.callee, "map")) return;
					const keyName = getObjectKeyName(left.property);
					if (
						keyName === "messages" ||
						keyName === "system" ||
						keyName === "tools"
					) {
						if (isClampFunction) {
							strippedClampTargets.add(keyName);
						} else {
							strippedRequestBuilderTargets.add(keyName);
						}
					}
				},
			});
		},
	});

	if (fixedClampDeclCount === 0) {
		return "Request clamp helper missing fixed cacheControlExcess = -4 block cap";
	}
	if (fixedClampDeclCount !== 1) {
		return `Request clamp cacheControlExcess declaration is ambiguous (${fixedClampDeclCount} declarations)`;
	}
	if (fixedRequestBuilderDeclCount === 0) {
		return "Live request builder missing fixed cacheControlExcess = -4 block cap";
	}
	if (fixedRequestBuilderDeclCount !== 1) {
		return `Live request builder cacheControlExcess declaration is ambiguous (${fixedRequestBuilderDeclCount} declarations)`;
	}
	for (const target of ["messages", "system", "tools"]) {
		if (!strippedClampTargets.has(target)) {
			return `Request clamp helper missing cache_control strip pass for ${target}`;
		}
		if (!strippedRequestBuilderTargets.has(target)) {
			return `Live request builder missing cache_control strip pass for ${target}`;
		}
	}
	return true;
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
			visitor: createCacheControlTtlMutator(),
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
	],

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) {
			return "Unable to parse AST for cache-tail-policy verification";
		}

		for (const check of [
			verifyTailWindowPolicy,
			verifySyspromptGlobalScope,
			verifyScopedCacheControlTtl,
			verifyAgentCacheTtlAllowlist,
			verifyCacheControlBlockCap,
		]) {
			const result = check(verifyAst);
			if (result !== true) {
				return result;
			}
		}

		return true;
	},
};
