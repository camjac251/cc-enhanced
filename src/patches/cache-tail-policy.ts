import * as t from "@babel/types";
import { type NodePath, template, traverse, type Visitor } from "../babel.js";
import type { Patch, PatchVerificationWithWitness } from "../types.js";
import {
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

function hasBoundedDecimationLoop(
	body: t.Statement[],
	setName: string,
	primaryIndexName: string,
): boolean {
	return body.some((stmt) =>
		nodeContains(stmt, (candidate) => {
			if (!t.isForStatement(candidate)) return false;
			if (!t.isVariableDeclaration(candidate.init)) return false;
			if (candidate.init.declarations.length !== 1) return false;
			const loopDecl = candidate.init.declarations[0];
			if (!t.isIdentifier(loopDecl.id)) return false;
			const loopIndexName = loopDecl.id.name;
			if (
				!t.isUpdateExpression(candidate.update, { operator: "++" }) ||
				!t.isIdentifier(candidate.update.argument, { name: loopIndexName })
			) {
				return false;
			}
			if (!nodeContainsSetAdd(candidate, setName, loopIndexName)) return false;

			const hasDecimationGate = nodeContains(candidate.body, (descendant) => {
				if (!t.isBinaryExpression(descendant, { operator: "===" })) {
					return false;
				}
				if (!t.isBinaryExpression(descendant.left, { operator: "%" })) {
					return false;
				}
				return (
					t.isNumericLiteral(descendant.left.right, { value: 15 }) &&
					t.isNumericLiteral(descendant.right, { value: 0 })
				);
			});
			if (!hasDecimationGate) return false;
			if (!candidate.test) return false;

			return nodeContains(candidate.test, (descendant) => {
				return (
					t.isBinaryExpression(descendant, { operator: "<=" }) &&
					t.isIdentifier(descendant.left, { name: loopIndexName }) &&
					t.isIdentifier(descendant.right, { name: primaryIndexName })
				);
			});
		}),
	);
}

function createCacheTailWindowStatements(
	messagesName: string,
	setName: string,
): t.Statement[] {
	const setId = t.identifier(setName);
	const primaryIndexId = t.identifier("cachePrimaryIndex");
	const tailIndexId = t.identifier("cacheTailIndex");
	const tailCountId = t.identifier("cacheTailCount");

	const decimationStatements = template.statements(
		`
		var userMsgCount = 0;
		if (Array.isArray(MESSAGES)) {
			for (var idx = 0; idx <= PRIMARY_INDEX && idx < MESSAGES.length; idx++) {
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
		{ placeholderPattern: /^(MESSAGES|SET_NAME|PRIMARY_INDEX)$/ },
	)({
		MESSAGES: t.identifier(messagesName),
		SET_NAME: setId,
		PRIMARY_INDEX: primaryIndexId,
	});

	return [
		t.variableDeclaration("var", [
			t.variableDeclarator(
				t.cloneNode(primaryIndexId),
				t.conditionalExpression(
					t.binaryExpression(
						">",
						t.memberExpression(t.cloneNode(setId), t.identifier("size")),
						t.numericLiteral(0),
					),
					t.callExpression(
						t.memberExpression(t.identifier("Math"), t.identifier("max")),
						[t.spreadElement(t.cloneNode(setId))],
					),
					t.numericLiteral(-1),
				),
			),
		]),
		...decimationStatements,
		t.variableDeclaration("var", [
			t.variableDeclarator(t.cloneNode(tailCountId), t.numericLiteral(0)),
		]),
		t.forStatement(
			t.variableDeclaration("var", [
				t.variableDeclarator(
					t.cloneNode(tailIndexId),
					t.cloneNode(primaryIndexId),
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
			t.updateExpression("--", t.cloneNode(tailIndexId)),
			t.blockStatement([
				t.ifStatement(
					t.logicalExpression(
						"||",
						t.unaryExpression("!", t.identifier("cacheUserOnly")),
						t.binaryExpression(
							"===",
							t.memberExpression(
								t.memberExpression(
									t.identifier(messagesName),
									t.cloneNode(tailIndexId),
									true,
								),
								t.identifier("type"),
							),
							t.stringLiteral("user"),
						),
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
					: null;
				if (messagesVarName) {
					body.splice(
						updatedMarkerStmtIndex,
						0,
						...createCacheTailWindowStatements(messagesVarName, markerSetName),
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

function isRequestBuilderSequenceReturn(
	stmt: t.Statement,
	requestName: string,
): stmt is t.ReturnStatement {
	if (!t.isReturnStatement(stmt)) return false;
	if (!t.isSequenceExpression(stmt.argument)) return false;
	const returnedExpression = stmt.argument.expressions.at(-1);
	return t.isIdentifier(returnedExpression, { name: requestName });
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
				if (cacheBlock && typeof cacheBlock === "object" && cacheBlock.cache_control && typeof cacheBlock.cache_control === "object") {
					cacheBlock.cache_control.ttl = "1h";
				}
			}
		}
		if (Array.isArray(REQUEST.tools) && REQUEST.tools.length > 0) {
			let hasSystemCache = false;
			if (Array.isArray(REQUEST.system)) {
				for (let cacheBlock of REQUEST.system) {
					if (cacheBlock && typeof cacheBlock === "object" && cacheBlock.cache_control && typeof cacheBlock.cache_control === "object") {
						hasSystemCache = true;
						break;
					}
				}
			}
			for (let tool of REQUEST.tools) {
				if (tool && typeof tool === "object" && tool.defer_loading && "cache_control" in tool) {
					delete tool.cache_control;
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
		let systemToolsExcess = -4;
		if (Array.isArray(REQUEST.system)) {
			for (let cacheBlock of REQUEST.system) {
				if (cacheBlock && typeof cacheBlock === "object" && cacheBlock.cache_control && typeof cacheBlock.cache_control === "object") {
					systemToolsExcess++;
				}
			}
		}
		if (Array.isArray(REQUEST.tools)) {
			for (let cacheTool of REQUEST.tools) {
				if (cacheTool && typeof cacheTool === "object" && cacheTool.cache_control && typeof cacheTool.cache_control === "object") {
					systemToolsExcess++;
				}
			}
		}
		if (systemToolsExcess > 0 && Array.isArray(REQUEST.tools)) {
			for (let cacheTool of REQUEST.tools) {
				if (systemToolsExcess <= 0) break;
				if (cacheTool && typeof cacheTool === "object" && cacheTool.cache_control && typeof cacheTool.cache_control === "object") {
					delete cacheTool.cache_control;
					systemToolsExcess--;
				}
			}
		}
		if (systemToolsExcess > 0 && Array.isArray(REQUEST.system)) {
			for (let cacheBlock of REQUEST.system) {
				if (systemToolsExcess <= 0) break;
				if (cacheBlock && typeof cacheBlock === "object" && cacheBlock.cache_control && typeof cacheBlock.cache_control === "object") {
					delete cacheBlock.cache_control;
					systemToolsExcess--;
				}
			}
		}
		let systemCount = 0;
		if (Array.isArray(REQUEST.system)) {
			for (let cacheBlock of REQUEST.system) {
				if (cacheBlock && typeof cacheBlock === "object" && cacheBlock.cache_control && typeof cacheBlock.cache_control === "object") {
					systemCount++;
				}
			}
		}
		let toolsCount = 0;
		if (Array.isArray(REQUEST.tools)) {
			for (let cacheTool of REQUEST.tools) {
				if (cacheTool && typeof cacheTool === "object" && cacheTool.cache_control && typeof cacheTool.cache_control === "object") {
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
							if (block && typeof block === "object" && block.cache_control && typeof block.cache_control === "object") {
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
						if (block && typeof block === "object" && block.cache_control && typeof block.cache_control === "object") {
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
			let latestCheckpoint = msgCheckpoints.length > 0 ? msgCheckpoints[msgCheckpoints.length - 1] : null;
			let latestStableCheckpoint = null;
			for (let i = msgCheckpoints.length - 2; i >= 0; i--) {
				if (!msgCheckpoints[i].isDecimation) {
					latestStableCheckpoint = msgCheckpoints[i];
					break;
				}
			}
			if (latestStableCheckpoint) {
				addKeep(latestStableCheckpoint.block);
			}
			if (latestCheckpoint) {
				addKeep(latestCheckpoint.block);
			}
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

type RequestClampFunction =
	| t.FunctionDeclaration
	| t.FunctionExpression
	| t.ArrowFunctionExpression;

type RequestClampAnchor = {
	functionNode: RequestClampFunction;
	functionName: string;
	requestCopyName: string;
	maxTokensName: string;
	returnStmt: t.ReturnStatement;
	body: t.Statement[];
};

// Cache the request clamp anchor per AST so the verify phase can reuse the
// result the mutator's Program.exit hook already computed during mutate.
const clampAnchorCache = new WeakMap<t.File, RequestClampAnchor | null>();

function getRequestClampAnchor(node: t.Node): RequestClampAnchor | null {
	if (
		!t.isFunctionDeclaration(node) &&
		!t.isFunctionExpression(node) &&
		!t.isArrowFunctionExpression(node)
	) {
		return null;
	}
	if (!t.isBlockStatement(node.body)) return null;
	if (node.params.length !== 2) return null;
	const [requestParam, limitParam] = node.params;
	if (!t.isIdentifier(requestParam) || !t.isIdentifier(limitParam)) return null;
	const functionName = getFunctionIdentifierName(node);
	if (!functionName) return null;

	let requestCopyName: string | null = null;
	let maxTokensName: string | null = null;
	let returnStmt: t.ReturnStatement | null = null;

	for (const stmt of node.body.body) {
		if (t.isVariableDeclaration(stmt)) {
			for (const decl of stmt.declarations) {
				maxTokensName =
					maxTokensName ??
					isMaxTokensClampDeclarator(decl, requestParam.name, limitParam.name);
				requestCopyName =
					requestCopyName ?? isRequestCopyDeclarator(decl, requestParam.name);
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

	if (!requestCopyName || !maxTokensName || !returnStmt) return null;
	return {
		functionNode: node,
		functionName,
		requestCopyName,
		maxTokensName,
		returnStmt,
		body: node.body.body,
	};
}

function findRequestClampFunction(ast: t.File): RequestClampAnchor | null {
	const cached = clampAnchorCache.get(ast);
	if (cached !== undefined) return cached;

	let match: RequestClampAnchor | null = null;

	traverse(ast, {
		Function(path) {
			if (match) return;
			match = getRequestClampAnchor(path.node);
			if (!match) return;
			path.stop();
		},
		noScope: true,
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
						!body.some((bodyStmt) =>
							isRequestBuilderSequenceReturn(bodyStmt, requestName),
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

function findRequestBuilderVariableName(body: t.Statement[]): string | null {
	for (const stmt of body) {
		if (!t.isVariableDeclaration(stmt)) continue;
		for (const decl of stmt.declarations) {
			if (!t.isIdentifier(decl.id)) continue;
			if (!t.isExpression(decl.init)) continue;
			const requestName = decl.id.name;
			const obj = getObjectExpressionFromExpression(decl.init);
			if (!obj || !isMainRequestObjectExpression(obj)) continue;
			if (
				!body.some((bodyStmt) =>
					isRequestBuilderSequenceReturn(bodyStmt, requestName),
				)
			) {
				continue;
			}
			return requestName;
		}
	}
	return null;
}

type CacheTailVerificationCheckId =
	| "tail-window"
	| "sysprompt-scope"
	| "caller-ttl"
	| "agent-allowlist"
	| "block-cap"
	| "one-hour-ttl";

export type CacheTailVerificationInventory = {
	checks: Array<{
		id: CacheTailVerificationCheckId;
		result: true | string;
	}>;
};

export function collectCacheTailVerificationInventory(
	ast: t.File,
): CacheTailVerificationInventory {
	let tailFunctionNode: t.Node | null = null;
	let hasTailWindowDecl = false;
	let hasUserOnlyDecl = false;
	let tailWindowDeclCount = 0;
	let userOnlyDeclCount = 0;
	let hasTailWindowReassign = false;
	let hasUserOnlyReassign = false;
	let hasTailWindowGate = false;
	let hasUserOnlyConditional = false;
	let hasDecimationGate = false;
	let hasDecimationPrimaryBoundary = false;

	let foundSyspromptMarker = false;
	let firstNonNullScope: string | null = null;
	let hasLaterOrgScope = false;
	let nonNullScopeCount = 0;

	let cacheControlBuilderNode: t.Node | null = null;
	let cacheControlScopeName: string | null = null;
	let cacheControlTtlName: string | null = null;
	let hasCallerTtlGate = false;
	let hasScopeForcedTtlGate = false;

	let foundAllowlist = false;
	let hasAgentQuerySource = false;
	let hasRuntimeGuard = false;

	let requestClampAnchor = clampAnchorCache.get(ast);
	let requestBuilderFunctionNode: t.Node | null = null;
	let requestBuilderRequestName: string | null = null;
	let fixedClampDeclCount = 0;
	let fixedRequestBuilderDeclCount = 0;
	let fixedSystemToolsClampCount = 0;
	let fixedSystemToolsRequestBuilderCount = 0;
	let hasDeleteInClamp = false;
	let hasDeleteInRequestBuilder = false;
	let hasToolCapDeleteInClamp = false;
	let hasToolCapDeleteInRequestBuilder = false;
	let hasSystemCapDeleteInClamp = false;
	let hasSystemCapDeleteInRequestBuilder = false;
	let hasStablePriorityInClamp = false;
	let hasStablePriorityInRequestBuilder = false;

	let hasSystemTtlSetInClamp = false;
	let hasSystemTtlSetInRequestBuilder = false;
	let toolsLoopTtlSetCount = 0;
	let guardedToolsLoopTtlSetCount = 0;
	let hasDeferredCleanupInClamp = false;
	let hasDeferredCleanupInRequestBuilder = false;
	const createSystemToolsOverflowAccounting = () => ({
		systemIncrementCount: 0,
		toolsIncrementCount: 0,
		systemPositiveGuardCount: 0,
		toolsPositiveGuardCount: 0,
		systemCoupledDecrementCount: 0,
		toolsCoupledDecrementCount: 0,
	});
	const systemToolsOverflowAccounting = {
		clamp: createSystemToolsOverflowAccounting(),
		"request-builder": createSystemToolsOverflowAccounting(),
	};

	const isWithinFunction = (path: NodePath, functionNode: t.Node): boolean =>
		Boolean(path.findParent((parentPath) => parentPath.node === functionNode));

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

	const getBlockCapOwner = (
		path: NodePath,
	): "clamp" | "request-builder" | null => {
		const functionPath = path.findParent((parentPath) =>
			parentPath.isFunction(),
		);
		if (!functionPath) return null;
		if (functionPath.node === requestClampAnchor?.functionNode) return "clamp";
		if (functionPath.node === requestBuilderFunctionNode) {
			return "request-builder";
		}
		return null;
	};

	const getOwnerRequestName = (
		owner: "clamp" | "request-builder",
	): string | null =>
		owner === "clamp"
			? (requestClampAnchor?.requestCopyName ?? null)
			: requestBuilderRequestName;

	const getOwningRequestCollectionLoop = (
		path: NodePath,
		owner: "clamp" | "request-builder",
	): { collection: "system" | "tools"; targetName: string } | null => {
		const requestName = getOwnerRequestName(owner);
		if (!requestName) return null;
		const loopPath = path.findParent((parentPath) =>
			parentPath.isForOfStatement(),
		);
		if (!loopPath?.isForOfStatement()) return null;
		const loopBinding = loopPath.node.left;
		const collectionAccess = loopPath.node.right;
		if (
			!t.isVariableDeclaration(loopBinding) ||
			loopBinding.declarations.length !== 1 ||
			!t.isIdentifier(loopBinding.declarations[0].id) ||
			!t.isMemberExpression(collectionAccess) ||
			!t.isIdentifier(collectionAccess.object, { name: requestName })
		) {
			return null;
		}
		if (isMemberPropertyName(collectionAccess, "system")) {
			return {
				collection: "system",
				targetName: loopBinding.declarations[0].id.name,
			};
		}
		if (isMemberPropertyName(collectionAccess, "tools")) {
			return {
				collection: "tools",
				targetName: loopBinding.declarations[0].id.name,
			};
		}
		return null;
	};

	const isTargetCacheControlMember = (
		node: t.Node,
		targetName: string,
	): node is t.MemberExpression =>
		t.isMemberExpression(node) &&
		t.isIdentifier(node.object, { name: targetName }) &&
		isMemberPropertyName(node, "cache_control");

	const flattenLogicalAnd = (node: t.Node): t.Node[] => {
		if (!t.isLogicalExpression(node, { operator: "&&" })) return [node];
		return [...flattenLogicalAnd(node.left), ...flattenLogicalAnd(node.right)];
	};

	const hasEffectiveCacheControlGuard = (
		node: t.Node,
		targetName: string,
	): boolean => {
		const operands = flattenLogicalAnd(node);
		const hasTruthyCacheControl = operands.some((operand) =>
			isTargetCacheControlMember(operand, targetName),
		);
		const hasObjectTypeGuard = operands.some(
			(operand) =>
				t.isBinaryExpression(operand, { operator: "===" }) &&
				t.isUnaryExpression(operand.left, { operator: "typeof" }) &&
				isTargetCacheControlMember(operand.left.argument, targetName) &&
				t.isStringLiteral(operand.right, { value: "object" }),
		);
		return hasTruthyCacheControl && hasObjectTypeGuard;
	};

	const isPositiveOverflowGuard = (
		path: NodePath<t.IfStatement>,
		owner: "clamp" | "request-builder",
	): "system" | "tools" | null => {
		const requestName = getOwnerRequestName(owner);
		if (!requestName) return null;
		const test = path.node.test;
		if (!t.isLogicalExpression(test, { operator: "&&" })) return null;
		if (
			!t.isBinaryExpression(test.left, { operator: ">" }) ||
			!t.isIdentifier(test.left.left, { name: "systemToolsExcess" }) ||
			!t.isNumericLiteral(test.left.right, { value: 0 }) ||
			!t.isCallExpression(test.right) ||
			!t.isMemberExpression(test.right.callee) ||
			!t.isIdentifier(test.right.callee.object, { name: "Array" }) ||
			!isMemberPropertyName(test.right.callee, "isArray") ||
			test.right.arguments.length !== 1
		) {
			return null;
		}
		const collectionAccess = test.right.arguments[0];
		if (
			!t.isMemberExpression(collectionAccess) ||
			!t.isIdentifier(collectionAccess.object, { name: requestName })
		) {
			return null;
		}
		const collection = isMemberPropertyName(collectionAccess, "system")
			? "system"
			: isMemberPropertyName(collectionAccess, "tools")
				? "tools"
				: null;
		if (!collection) return null;
		const hasOwnedCleanupLoop = nodeContains(
			path.node.consequent,
			(candidate) => {
				return (
					t.isForOfStatement(candidate) &&
					t.isMemberExpression(candidate.right) &&
					t.isIdentifier(candidate.right.object, { name: requestName }) &&
					isMemberPropertyName(candidate.right, collection)
				);
			},
		);
		return hasOwnedCleanupLoop ? collection : null;
	};

	const hasCoupledOverflowDecrement = (
		path: NodePath<t.UnaryExpression>,
		targetName: string,
	): boolean => {
		const guardPath = path.findParent((parentPath) =>
			parentPath.isIfStatement(),
		);
		if (!guardPath?.isIfStatement()) return false;
		if (!hasEffectiveCacheControlGuard(guardPath.node.test, targetName)) {
			return false;
		}
		if (!t.isBlockStatement(guardPath.node.consequent)) return false;
		const deleteStatement = path.findParent((parentPath) =>
			parentPath.isExpressionStatement(),
		);
		if (!deleteStatement?.isExpressionStatement()) return false;
		const statements = guardPath.node.consequent.body;
		const deleteIndex = statements.indexOf(deleteStatement.node);
		if (deleteIndex < 0) return false;
		const decrement = statements[deleteIndex + 1];
		return (
			t.isExpressionStatement(decrement) &&
			t.isUpdateExpression(decrement.expression, { operator: "--" }) &&
			t.isIdentifier(decrement.expression.argument, {
				name: "systemToolsExcess",
			})
		);
	};

	const isCheckpointCacheControlDelete = (
		path: NodePath<t.UnaryExpression>,
	): boolean => {
		const cacheControlMember = path.node.argument;
		if (
			!t.isMemberExpression(cacheControlMember) ||
			!isMemberPropertyName(cacheControlMember, "cache_control") ||
			!t.isMemberExpression(cacheControlMember.object) ||
			!isMemberPropertyName(cacheControlMember.object, "block") ||
			!t.isIdentifier(cacheControlMember.object.object)
		) {
			return false;
		}

		const checkpointName = cacheControlMember.object.object.name;
		const loopPath = path.findParent((parentPath) =>
			parentPath.isForOfStatement(),
		);
		if (!loopPath?.isForOfStatement()) return false;
		const loopBinding = loopPath.node.left;
		if (
			!t.isVariableDeclaration(loopBinding) ||
			loopBinding.declarations.length !== 1 ||
			!t.isIdentifier(loopBinding.declarations[0].id, {
				name: checkpointName,
			}) ||
			!t.isIdentifier(loopPath.node.right, { name: "msgCheckpoints" })
		) {
			return false;
		}
		return true;
	};

	const getDirectCacheControlDelete = (
		path: NodePath<t.UnaryExpression>,
	): { collection: "system" | "tools"; targetName: string } | null => {
		const cacheControlMember = path.node.argument;
		if (
			!t.isMemberExpression(cacheControlMember) ||
			!isMemberPropertyName(cacheControlMember, "cache_control") ||
			!t.isIdentifier(cacheControlMember.object)
		) {
			return null;
		}
		const targetName = cacheControlMember.object.name;
		const loopPath = path.findParent((parentPath) =>
			parentPath.isForOfStatement(),
		);
		if (!loopPath?.isForOfStatement()) return null;
		const loopBinding = loopPath.node.left;
		if (
			!t.isVariableDeclaration(loopBinding) ||
			loopBinding.declarations.length !== 1 ||
			!t.isIdentifier(loopBinding.declarations[0].id, { name: targetName }) ||
			!t.isMemberExpression(loopPath.node.right)
		) {
			return null;
		}
		if (isMemberPropertyName(loopPath.node.right, "tools")) {
			return { collection: "tools", targetName };
		}
		if (isMemberPropertyName(loopPath.node.right, "system")) {
			return { collection: "system", targetName };
		}
		return null;
	};

	const isDeferredCleanupDelete = (
		path: NodePath<t.UnaryExpression>,
		targetName: string,
	): boolean =>
		Boolean(
			path.findParent(
				(parentPath) =>
					parentPath.isIfStatement() &&
					nodeContains(parentPath.node.test, (candidate) => {
						return (
							t.isMemberExpression(candidate) &&
							isMemberPropertyName(candidate, "defer_loading") &&
							t.isIdentifier(candidate.object, { name: targetName })
						);
					}),
			),
		);

	const isSystemToolsCapDelete = (
		path: NodePath<t.UnaryExpression>,
	): boolean => {
		const loopPath = path.findParent((parentPath) =>
			parentPath.isForOfStatement(),
		);
		if (!loopPath?.isForOfStatement()) return false;
		return nodeContains(loopPath.node.body, (candidate) => {
			return (
				t.isUpdateExpression(candidate, { operator: "--" }) &&
				t.isIdentifier(candidate.argument, { name: "systemToolsExcess" })
			);
		});
	};

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
		Function(path) {
			if (!t.isBlockStatement(path.node.body)) return;
			const body = path.node.body.body;

			if (!tailFunctionNode) {
				const markerStmtIndex = body.findIndex(
					(stmt) => !t.isFunctionDeclaration(stmt) && nodeContainsMarker(stmt),
				);
				const markerStmt = body[markerStmtIndex];
				if (markerStmtIndex >= 0 && markerStmt) {
					tailFunctionNode = path.node;
					const markerSetName = getMarkerCountSetName(markerStmt);
					hasTailWindowGate = markerSetName
						? hasCacheTailWindowLoop(body, markerSetName)
						: false;
					hasDecimationPrimaryBoundary = Boolean(
						markerSetName &&
							hasBoundedDecimationLoop(
								body,
								markerSetName,
								"cachePrimaryIndex",
							),
					);
				}
			}

			if (!foundSyspromptMarker) {
				for (const stmt of body) {
					if (!t.isIfStatement(stmt)) continue;
					if (!t.isBlockStatement(stmt.consequent)) continue;
					if (!blockContainsSyspromptMarker(stmt.consequent.body)) continue;
					foundSyspromptMarker = true;
					walkScopedPushes(stmt.consequent.body);
					break;
				}
			}

			if (!cacheControlBuilderNode) {
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
				if (pattern) {
					const scopeLocalName = getObjectPatternBindingName(pattern, "scope");
					const ttlLocalName = getObjectPatternBindingName(pattern, "ttl");
					const hasEphemeral = nodeContains(path.node, (candidate) =>
						t.isStringLiteral(candidate, { value: "ephemeral" }),
					);
					if (scopeLocalName && ttlLocalName && hasEphemeral) {
						cacheControlBuilderNode = path.node;
						cacheControlScopeName = scopeLocalName;
						cacheControlTtlName = ttlLocalName;
					}
				}
			}

			if (requestClampAnchor === undefined) {
				const candidate = getRequestClampAnchor(path.node);
				if (candidate) {
					requestClampAnchor = candidate;
					clampAnchorCache.set(ast, candidate);
				}
			}

			const requestBuilderName = findRequestBuilderVariableName(body);
			if (
				!requestBuilderFunctionNode &&
				path.node !== requestClampAnchor?.functionNode &&
				requestBuilderName
			) {
				requestBuilderFunctionNode = path.node;
				requestBuilderRequestName = requestBuilderName;
			}
		},
		VariableDeclarator(path) {
			if (tailFunctionNode && isWithinFunction(path, tailFunctionNode)) {
				if (t.isIdentifier(path.node.id, { name: "cacheTailWindow" })) {
					tailWindowDeclCount += 1;
					if (t.isNumericLiteral(path.node.init, { value: 2 })) {
						hasTailWindowDecl = true;
					}
				}
				if (t.isIdentifier(path.node.id, { name: "cacheUserOnly" })) {
					userOnlyDeclCount += 1;
					if (t.isBooleanLiteral(path.node.init, { value: true })) {
						hasUserOnlyDecl = true;
					}
				}
			}

			const owner = getBlockCapOwner(path);
			if (
				owner &&
				t.isIdentifier(path.node.id, { name: "maxMsgCheckpoints" }) &&
				t.isBinaryExpression(path.node.init, { operator: "-" }) &&
				t.isNumericLiteral(path.node.init.left, { value: 4 }) &&
				t.isIdentifier(path.node.init.right, { name: "systemToolsCount" })
			) {
				if (owner === "clamp") {
					fixedClampDeclCount += 1;
				} else {
					fixedRequestBuilderDeclCount += 1;
				}
			}
			if (
				owner &&
				t.isIdentifier(path.node.id, { name: "systemToolsExcess" }) &&
				t.isUnaryExpression(path.node.init, { operator: "-" }) &&
				t.isNumericLiteral(path.node.init.argument, { value: 4 })
			) {
				if (owner === "clamp") {
					fixedSystemToolsClampCount += 1;
				} else {
					fixedSystemToolsRequestBuilderCount += 1;
				}
			}
		},
		AssignmentExpression(assignPath) {
			if (tailFunctionNode && isWithinFunction(assignPath, tailFunctionNode)) {
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
			}

			const left = assignPath.node.left;
			const right = assignPath.node.right;
			if (
				t.isMemberExpression(left) &&
				isMemberPropertyName(left, "ttl") &&
				t.isMemberExpression(left.object) &&
				isMemberPropertyName(left.object, "cache_control") &&
				t.isStringLiteral(right, { value: "1h" })
			) {
				const owner = getBlockCapOwner(assignPath);
				if (owner === "clamp") {
					hasSystemTtlSetInClamp = true;
				} else if (owner === "request-builder") {
					hasSystemTtlSetInRequestBuilder = true;
				}
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
		CallExpression(path) {
			if (
				!t.isIdentifier(path.node.callee, { name: "addKeep" }) ||
				path.node.arguments.length !== 1
			) {
				return;
			}
			const checkpointBlock = path.node.arguments[0];
			if (
				!t.isMemberExpression(checkpointBlock) ||
				!t.isIdentifier(checkpointBlock.object, {
					name: "latestStableCheckpoint",
				}) ||
				!isMemberPropertyName(checkpointBlock, "block")
			) {
				return;
			}
			const isGuarded = Boolean(
				path.findParent(
					(parentPath) =>
						parentPath.isIfStatement() &&
						t.isIdentifier(parentPath.node.test, {
							name: "latestStableCheckpoint",
						}),
				),
			);
			if (!isGuarded) return;

			const owner = getBlockCapOwner(path);
			if (owner === "clamp") {
				hasStablePriorityInClamp = true;
			} else if (owner === "request-builder") {
				hasStablePriorityInRequestBuilder = true;
			}
		},
		IfStatement(path) {
			const owner = getBlockCapOwner(path);
			if (!owner) return;
			const collection = isPositiveOverflowGuard(path, owner);
			if (!collection) return;
			const accounting = systemToolsOverflowAccounting[owner];
			if (collection === "system") {
				accounting.systemPositiveGuardCount += 1;
			} else {
				accounting.toolsPositiveGuardCount += 1;
			}
		},
		UpdateExpression(path) {
			const owner = getBlockCapOwner(path);
			if (
				owner &&
				t.isUpdateExpression(path.node, { operator: "++" }) &&
				t.isIdentifier(path.node.argument, { name: "systemToolsExcess" })
			) {
				const loop = getOwningRequestCollectionLoop(path, owner);
				const guardPath = path.findParent((parentPath) =>
					parentPath.isIfStatement(),
				);
				if (
					loop &&
					guardPath?.isIfStatement() &&
					hasEffectiveCacheControlGuard(guardPath.node.test, loop.targetName)
				) {
					const accounting = systemToolsOverflowAccounting[owner];
					if (loop.collection === "system") {
						accounting.systemIncrementCount += 1;
					} else {
						accounting.toolsIncrementCount += 1;
					}
				}
			}

			if (!tailFunctionNode || !isWithinFunction(path, tailFunctionNode)) {
				return;
			}
			if (
				t.isIdentifier(path.node.argument, {
					name: "cacheTailWindow",
				})
			) {
				hasTailWindowReassign = true;
			}
			if (
				t.isIdentifier(path.node.argument, {
					name: "cacheUserOnly",
				})
			) {
				hasUserOnlyReassign = true;
			}
		},
		ConditionalExpression(path) {
			if (
				tailFunctionNode &&
				isWithinFunction(path, tailFunctionNode) &&
				t.isIdentifier(path.node.test, {
					name: "cacheUserOnly",
				}) &&
				t.isBooleanLiteral(path.node.consequent, {
					value: false,
				}) &&
				t.isExpression(path.node.alternate)
			) {
				hasUserOnlyConditional = true;
			}
		},
		BinaryExpression(path) {
			if (
				tailFunctionNode &&
				isWithinFunction(path, tailFunctionNode) &&
				path.node.operator === "===" &&
				t.isBinaryExpression(path.node.left, { operator: "%" }) &&
				t.isIdentifier(path.node.left.left, { name: "userMsgCount" }) &&
				t.isNumericLiteral(path.node.left.right, { value: 15 }) &&
				t.isNumericLiteral(path.node.right, { value: 0 })
			) {
				hasDecimationGate = true;
			}
		},
		ObjectExpression(path) {
			if (
				!cacheControlBuilderNode ||
				!cacheControlScopeName ||
				!cacheControlTtlName ||
				!isWithinFunction(path, cacheControlBuilderNode)
			) {
				return;
			}
			const ttlProp = path.node.properties.find(
				(prop): prop is t.ObjectProperty =>
					t.isObjectProperty(prop) && getObjectKeyName(prop.key) === "ttl",
			);
			if (!ttlProp) return;

			const parent = path.parentPath;
			if (
				!parent?.isLogicalExpression({ operator: "&&" }) ||
				parent.node.right !== path.node
			) {
				return;
			}

			const left = parent.node.left;
			if (
				t.isIdentifier(left, { name: cacheControlTtlName }) &&
				t.isIdentifier(ttlProp.value, { name: cacheControlTtlName })
			) {
				hasCallerTtlGate = true;
			}
			if (
				t.isLogicalExpression(left, { operator: "||" }) &&
				t.isIdentifier(left.left, { name: cacheControlScopeName }) &&
				t.isIdentifier(left.right, { name: cacheControlTtlName }) &&
				t.isConditionalExpression(ttlProp.value) &&
				t.isIdentifier(ttlProp.value.test, {
					name: cacheControlScopeName,
				}) &&
				t.isStringLiteral(ttlProp.value.consequent, { value: "1h" }) &&
				t.isIdentifier(ttlProp.value.alternate, {
					name: cacheControlTtlName,
				})
			) {
				hasScopeForcedTtlGate = true;
			}
		},
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
		},
		UnaryExpression(path) {
			if (path.node.operator !== "delete") return;

			const owner = getBlockCapOwner(path);
			if (isCheckpointCacheControlDelete(path)) {
				if (owner === "clamp") {
					hasDeleteInClamp = true;
				} else if (owner === "request-builder") {
					hasDeleteInRequestBuilder = true;
				}
			}

			const directDelete = getDirectCacheControlDelete(path);
			if (!directDelete) return;
			if (owner) {
				const loop = getOwningRequestCollectionLoop(path, owner);
				if (
					loop &&
					loop.collection === directDelete.collection &&
					loop.targetName === directDelete.targetName &&
					hasCoupledOverflowDecrement(path, directDelete.targetName)
				) {
					const accounting = systemToolsOverflowAccounting[owner];
					if (loop.collection === "system") {
						accounting.systemCoupledDecrementCount += 1;
					} else {
						accounting.toolsCoupledDecrementCount += 1;
					}
				}
			}

			if (
				directDelete.collection === "tools" &&
				isDeferredCleanupDelete(path, directDelete.targetName)
			) {
				if (owner === "clamp") {
					hasDeferredCleanupInClamp = true;
				} else if (owner === "request-builder") {
					hasDeferredCleanupInRequestBuilder = true;
				}
			}

			if (!isSystemToolsCapDelete(path)) return;
			if (directDelete.collection === "tools") {
				if (owner === "clamp") {
					hasToolCapDeleteInClamp = true;
				} else if (owner === "request-builder") {
					hasToolCapDeleteInRequestBuilder = true;
				}
			} else if (owner === "clamp") {
				hasSystemCapDeleteInClamp = true;
			} else if (owner === "request-builder") {
				hasSystemCapDeleteInRequestBuilder = true;
			}
		},
		noScope: true,
	});

	if (requestClampAnchor === undefined) {
		requestClampAnchor = null;
		clampAnchorCache.set(ast, null);
	}

	const verifyTailWindow = (): true | string => {
		if (!tailFunctionNode) {
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
		if (!hasDecimationPrimaryBoundary) {
			return "Decimation cache loop exceeds the primary cache boundary";
		}
		return true;
	};

	const verifySyspromptScope = (): true | string => {
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
	};

	const verifyCallerTtl = (): true | string => {
		if (!cacheControlBuilderNode) {
			return "Could not locate cache control builder anchor";
		}
		if (hasScopeForcedTtlGate) {
			return "Cache control builder forces 1h TTL from scope instead of respecting caller TTL";
		}
		if (!hasCallerTtlGate) {
			return "Cache control builder no longer respects caller-provided TTL";
		}
		return true;
	};

	const verifyAgentAllowlist = (): true | string => {
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
	};

	const hasCompleteSystemToolsOverflowAccounting = (
		owner: "clamp" | "request-builder",
	): boolean => {
		const accounting = systemToolsOverflowAccounting[owner];
		return (
			accounting.systemIncrementCount === 1 &&
			accounting.toolsIncrementCount === 1 &&
			accounting.systemPositiveGuardCount === 1 &&
			accounting.toolsPositiveGuardCount === 1 &&
			accounting.systemCoupledDecrementCount === 1 &&
			accounting.toolsCoupledDecrementCount === 1
		);
	};

	const verifyBlockCap = (): true | string => {
		if (!requestClampAnchor) {
			return "Could not locate request clamp helper for cache_control cap";
		}
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
		if (
			fixedSystemToolsClampCount !== 1 ||
			fixedSystemToolsRequestBuilderCount !== 1 ||
			!hasToolCapDeleteInClamp ||
			!hasToolCapDeleteInRequestBuilder ||
			!hasSystemCapDeleteInClamp ||
			!hasSystemCapDeleteInRequestBuilder ||
			!hasCompleteSystemToolsOverflowAccounting("clamp") ||
			!hasCompleteSystemToolsOverflowAccounting("request-builder")
		) {
			return "Request paths are missing the four-block system and tool cache_control cap";
		}
		if (!hasStablePriorityInClamp || !hasStablePriorityInRequestBuilder) {
			return "Request paths are missing stable message checkpoint priority";
		}
		if (!hasDeleteInClamp) {
			return "Request clamp helper missing delete cp.block.cache_control statement";
		}
		if (!hasDeleteInRequestBuilder) {
			return "Live request builder missing delete cp.block.cache_control statement";
		}
		return true;
	};

	const verifyOneHourTtl = (): true | string => {
		if (!hasSystemTtlSetInClamp || !hasSystemTtlSetInRequestBuilder) {
			return "System prompt 1h TTL enforcement not found";
		}
		if (toolsLoopTtlSetCount < 2) {
			return "Tools array 1h TTL enforcement not found";
		}
		if (guardedToolsLoopTtlSetCount !== toolsLoopTtlSetCount) {
			return "Tools array 1h TTL enforcement must skip defer_loading tools";
		}
		if (!hasDeferredCleanupInClamp || !hasDeferredCleanupInRequestBuilder) {
			return "Request paths are missing deferred tool cache_control cleanup";
		}
		return true;
	};

	return {
		checks: [
			{ id: "tail-window", result: verifyTailWindow() },
			{ id: "sysprompt-scope", result: verifySyspromptScope() },
			{ id: "caller-ttl", result: verifyCallerTtl() },
			{ id: "agent-allowlist", result: verifyAgentAllowlist() },
			{ id: "block-cap", result: verifyBlockCap() },
			{ id: "one-hour-ttl", result: verifyOneHourTtl() },
		],
	};
}

// ---------------------------------------------------------------------------
// Patch export
// ---------------------------------------------------------------------------

function verifyCacheTailPolicy(
	code: string,
	ast?: t.File,
): PatchVerificationWithWitness {
	const verifyAst = getVerifyAst(code, ast);
	if (!verifyAst) {
		return {
			result: "Unable to parse AST for cache-tail-policy verification",
		};
	}

	const { checks } = collectCacheTailVerificationInventory(verifyAst);
	let semanticChecksPassed = 0;
	for (const check of checks) {
		const { result } = check;
		if (result !== true) {
			return {
				result,
				witness: {
					semanticChecksPassed,
					semanticChecksRequired: checks.length,
				},
			};
		}
		semanticChecksPassed++;
	}

	return {
		result: true,
		witness: {
			semanticChecksPassed,
			semanticChecksRequired: checks.length,
		},
	};
}

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
	],

	verify: (code, ast) => verifyCacheTailPolicy(code, ast).result,
	verifyWithWitness: verifyCacheTailPolicy,
};
