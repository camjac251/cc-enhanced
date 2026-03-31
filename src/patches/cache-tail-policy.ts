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

function buildTailPolicyDeclarations(): t.VariableDeclaration[] {
	return [
		t.variableDeclaration("var", [
			t.variableDeclarator(
				t.identifier("cacheTailWindow"),
				t.numericLiteral(2),
			),
		]),
		t.variableDeclaration("var", [
			t.variableDeclarator(
				t.identifier("cacheUserOnly"),
				t.booleanLiteral(true),
			),
		]),
	];
}

function ensureTailPolicyDeclarations(body: t.Statement[]): {
	hasTailWindowDecl: boolean;
	hasUserOnlyDecl: boolean;
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

	return { hasTailWindowDecl, hasUserOnlyDecl };
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

			const { hasTailWindowDecl, hasUserOnlyDecl } =
				ensureTailPolicyDeclarations(body);
			if (!hasTailWindowDecl || !hasUserOnlyDecl) {
				body.splice(markerStmtIndex, 0, ...buildTailPolicyDeclarations());
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

							cbDecl.init = t.binaryExpression(
								">",
								t.identifier(indexParamName),
								t.binaryExpression(
									"-",
									t.cloneNode(cbDecl.init.right),
									t.identifier("cacheTailWindow"),
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
function tryPatchPushCacheScope(stmt: t.Statement): boolean {
	if (!t.isExpressionStatement(stmt)) return false;
	const expr = stmt.expression;
	if (!t.isCallExpression(expr)) return false;
	if (!t.isMemberExpression(expr.callee)) return false;
	if (!isMemberPropertyName(expr.callee, "push")) return false;
	if (expr.arguments.length < 1) return false;
	const arg = expr.arguments[0];
	if (!t.isObjectExpression(arg)) return false;

	for (const prop of arg.properties) {
		if (!t.isObjectProperty(prop)) continue;
		if (getObjectKeyName(prop.key) !== "cacheScope") continue;
		if (!t.isStringLiteral(prop.value, { value: "org" })) continue;

		// Found cacheScope: "org", change to "global"
		prop.value = t.stringLiteral("global");
		return true;
	}
	return false;
}

function patchFirstCacheScopeOrgToGlobal(body: t.Statement[]): boolean {
	for (const stmt of body) {
		// Walk into if-statements: handle both block and single-statement forms
		if (t.isIfStatement(stmt)) {
			if (t.isBlockStatement(stmt.consequent)) {
				if (patchFirstCacheScopeOrgToGlobal(stmt.consequent.body)) return true;
			} else if (tryPatchPushCacheScope(stmt.consequent)) {
				return true;
			}
			continue;
		}

		// Direct expression statement
		if (tryPatchPushCacheScope(stmt)) return true;
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
// Cache control 1h TTL mutator ($nH fix)
// ---------------------------------------------------------------------------

/**
 * Find the cache_control builder function ($nH) and modify the TTL conditional
 * from `tx9($)` to `(H || tx9($))` so system prompt blocks (which have a
 * non-null scope parameter) always get ttl: "1h".
 *
 * Anchor: a function that returns {type: "ephemeral", ...} with a spread
 * containing a conditional that produces {ttl: "1h"}.
 */
function createCacheControlTtlMutator(): traverse.Visitor {
	let patched = false;

	return {
		Function(path) {
			if (patched) return;
			if (!t.isBlockStatement(path.node.body)) return;

			// The function must have an ObjectPattern parameter with "scope" key
			const params = path.node.params;
			if (params.length < 1) return;

			// Handle default parameter: ({scope: H, querySource: $} = {})
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

			// Find the local identifier name for "scope"
			let scopeLocalName: string | null = null;
			for (const prop of pattern.properties) {
				if (!t.isObjectProperty(prop)) continue;
				if (
					t.isIdentifier(prop.key, { name: "scope" }) ||
					t.isStringLiteral(prop.key, { value: "scope" })
				) {
					if (t.isIdentifier(prop.value)) {
						scopeLocalName = prop.value.name;
					}
					break;
				}
			}
			if (!scopeLocalName) return;

			// The body should contain a return with {type: "ephemeral", ...}
			let hasEphemeral = false;
			path.traverse({
				StringLiteral(strPath) {
					if (strPath.node.value === "ephemeral") hasEphemeral = true;
				},
			});
			if (!hasEphemeral) return;

			// Find {ttl: "1h"} guarded by fn($) && {ttl:"1h"} and inject scope:
			// fn($) && {ttl:"1h"} -> (scope || fn($)) && {ttl:"1h"}
			path.traverse({
				ObjectExpression(objPath) {
					if (patched) return;
					const hasTtl = objPath.node.properties.some(
						(p) =>
							t.isObjectProperty(p) &&
							getObjectKeyName(p.key) === "ttl" &&
							t.isStringLiteral(p.value, { value: "1h" }),
					);
					if (!hasTtl) return;

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
						t.isIdentifier(left.left, { name: scopeLocalName })
					) {
						patched = true;
						return;
					}
					if (!t.isCallExpression(left)) return;
					parent.node.left = t.logicalExpression(
						"||",
						t.identifier(scopeLocalName),
						left,
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

				if (
					clampFn.body.some(
						(stmt) =>
							t.isVariableDeclaration(stmt) &&
							stmt.declarations.some((decl) =>
								t.isIdentifier(decl.id, {
									name: "cacheControlExcess",
								}),
							),
					)
				) {
					return; // already injected
				}

				const returnIndex = clampFn.body.indexOf(clampFn.returnStmt);
				if (returnIndex < 0) return;

				const injected = template.statements(
					`
					let cacheControlExcess = -4;
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
				`,
					{ placeholderPattern: /^(REQUEST)$/ },
				)({
					REQUEST: t.identifier(clampFn.requestCopyName),
				});
				clampFn.body.splice(returnIndex, 0, ...injected);
			},
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
			visitor: createCacheControlTtlMutator(),
		},
		{
			pass: "mutate",
			visitor: createCacheControlBlockCapClampInjector(ast),
		},
	],

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst)
			return "Unable to parse AST for cache-tail-policy verification";

		// --- Tail window checks ---
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

		traverse.default(verifyAst, {
			Function(path) {
				if (foundMarkerFunction) return;
				if (!t.isBlockStatement(path.node.body)) return;
				if (!path.node.body.body.some((stmt) => nodeContainsMarker(stmt)))
					return;

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

		// --- Sysprompt global scope check ---
		let foundSyspromptMarker = false;
		let hasGlobalScopeOnIdentity = false;

		traverse.default(verifyAst, {
			Function(path) {
				if (foundSyspromptMarker) return;
				if (!t.isBlockStatement(path.node.body)) return;

				for (const stmt of path.node.body.body) {
					if (!t.isIfStatement(stmt)) continue;
					if (!t.isBlockStatement(stmt.consequent)) continue;
					if (!blockContainsSyspromptMarker(stmt.consequent.body)) continue;

					foundSyspromptMarker = true;

					// Check that the first cacheScope in this block is "global"
					const checkStmt = (s: t.Statement): boolean => {
						if (!t.isExpressionStatement(s)) return false;
						if (!t.isCallExpression(s.expression)) return false;
						if (!t.isMemberExpression(s.expression.callee)) return false;
						if (!isMemberPropertyName(s.expression.callee, "push"))
							return false;
						const arg = s.expression.arguments[0];
						if (!t.isObjectExpression(arg)) return false;
						for (const prop of arg.properties) {
							if (!t.isObjectProperty(prop)) continue;
							if (getObjectKeyName(prop.key) !== "cacheScope") continue;
							// Skip null-valued cacheScope (billing header)
							if (t.isNullLiteral(prop.value)) continue;
							if (t.isStringLiteral(prop.value, { value: "global" })) {
								hasGlobalScopeOnIdentity = true;
							}
							return true; // found first non-null cacheScope push, stop
						}
						return false;
					};
					const checkBlock = (stmts: t.Statement[]): void => {
						for (const s of stmts) {
							if (t.isIfStatement(s)) {
								if (t.isBlockStatement(s.consequent)) {
									checkBlock(s.consequent.body);
								} else if (checkStmt(s.consequent)) {
									return;
								}
								if (hasGlobalScopeOnIdentity) return;
								continue;
							}
							if (checkStmt(s)) return;
						}
					};
					checkBlock(stmt.consequent.body);
					break;
				}

				if (foundSyspromptMarker) path.stop();
			},
		});

		// Sysprompt scope check: only fail if the marker exists but isn't patched.
		// In test fixtures that lack the sysprompt function, the marker won't be present. That's OK.
		if (foundSyspromptMarker && !hasGlobalScopeOnIdentity) {
			return 'Sysprompt identity block not patched to cacheScope: "global"';
		}

		// --- 1h TTL on scoped blocks check ---
		let foundCacheControlBuilder = false;
		let hasScopeTtlGate = false;

		traverse.default(verifyAst, {
			Function(path) {
				if (foundCacheControlBuilder) return;
				if (!t.isBlockStatement(path.node.body)) return;

				// Must have ObjectPattern param with "scope" key
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
				if (!pattern || !objectPatternHasKey(pattern, "scope")) return;

				// Must contain "ephemeral" string
				let hasEphemeral = false;
				path.traverse({
					StringLiteral(strPath) {
						if (strPath.node.value === "ephemeral") hasEphemeral = true;
					},
				});
				if (!hasEphemeral) return;

				foundCacheControlBuilder = true;

				// Check for (scope || fn($)) && {ttl: "1h"}
				path.traverse({
					ObjectExpression(objPath) {
						if (hasScopeTtlGate) return;
						const hasTtl = objPath.node.properties.some(
							(p) =>
								t.isObjectProperty(p) &&
								getObjectKeyName(p.key) === "ttl" &&
								t.isStringLiteral(p.value, { value: "1h" }),
						);
						if (!hasTtl) return;

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
							t.isIdentifier(left.left) &&
							t.isCallExpression(left.right)
						) {
							hasScopeTtlGate = true;
						}
					},
				});

				path.stop();
			},
		});

		// TTL check: only fail if the builder function exists but isn't patched.
		if (foundCacheControlBuilder && !hasScopeTtlGate) {
			return "Cache control builder not patched for 1h TTL on scoped blocks";
		}

		const requestClampAnchor = findRequestClampFunction(verifyAst);
		if (requestClampAnchor) {
			let hasCacheControlBlockCap = false;

			traverse.default(verifyAst, {
				Function(path) {
					if (
						!path.isFunctionDeclaration() &&
						!path.isFunctionExpression() &&
						!path.isArrowFunctionExpression()
					) {
						return;
					}
					const functionName = getFunctionIdentifierName(path.node);
					if (functionName !== requestClampAnchor.functionName) return;
					if (!t.isBlockStatement(path.node.body)) return;
					hasCacheControlBlockCap = path.node.body.body.some(
						(stmt) =>
							t.isVariableDeclaration(stmt) &&
							stmt.declarations.some((decl) =>
								t.isIdentifier(decl.id, { name: "cacheControlExcess" }),
							),
					);
				},
			});

			if (!hasCacheControlBlockCap) {
				return "Request clamp helper missing cache_control block cap";
			}
		}

		return true;
	},
};
