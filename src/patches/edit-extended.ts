import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as t from "@babel/types";
import { template, traverse } from "../babel.js";
import { parse } from "../loader.js";
import type { Patch } from "../types.js";
import {
	getObjectKeyName,
	getObjectPropertyByName,
	getVerifyAst,
	hasObjectKeyName,
	isMemberPropertyName,
	objectPatternHasKey,
} from "./ast-helpers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EXTENDED_EDIT_TRANSPORT_PREFIX = "__claude_edit_extended_v1__:";
const EXTENDED_EDIT_TRANSPORT_DECODE = "_claudeDecodeExtendedEditTransport";

function adaptHookCodeForRuntime(hookCode: string): string {
	const isNativeMode = process.env.CLAUDE_PATCHER_NATIVE_MODE === "1";
	if (!isNativeMode) return hookCode;

	return hookCode
		.replace(
			/^import \* as _claudeFs from "node:fs";\s*$/m,
			'const _claudeFs = require("node:fs");',
		)
		.replace(
			/^import \* as _claudePath from "node:path";\s*$/m,
			'const _claudePath = require("node:path");',
		);
}

function findNamedToolObjectPath(ast: t.File, toolName: string): any {
	let found: any = null;
	traverse(ast, {
		ObjectExpression(path) {
			if (found) return;
			if (resolveToolName(path) !== toolName) return;
			found = path;
			path.stop();
		},
	});
	return found;
}

function getToolObjectMethod(
	toolObject: t.ObjectExpression,
	methodName: string,
): t.ObjectMethod | null {
	return (
		toolObject.properties.find(
			(prop): prop is t.ObjectMethod =>
				t.isObjectMethod(prop) && getObjectKeyName(prop.key) === methodName,
		) ?? null
	);
}

function visitNodeValues(
	value: unknown,
	visit: (node: t.Node) => boolean,
): boolean {
	if (!value) return false;
	if (Array.isArray(value)) {
		return value.some((item) => visitNodeValues(item, visit));
	}
	if (typeof value !== "object") return false;
	const maybeNode = value as t.Node;
	if (typeof (maybeNode as { type?: unknown }).type !== "string") return false;
	if (visit(maybeNode)) return true;
	return Object.values(maybeNode as unknown as Record<string, unknown>).some(
		(child) => visitNodeValues(child, visit),
	);
}

const EDIT_RENDER_EXCLUDED_KEYS = [
	"range",
	"show_whitespace",
	"pages",
	"offset",
	"limit",
];

function getObjectPatternKeySet(pattern: t.ObjectPattern): Set<string> {
	const keys = new Set<string>();
	for (const prop of pattern.properties) {
		if (!t.isObjectProperty(prop)) continue;
		const keyName = getObjectKeyName(prop.key);
		if (keyName) keys.add(keyName);
	}
	return keys;
}

function getEditRenderReturnArgument(stmt: t.Statement): t.Expression | null {
	let argument: t.Expression | null | undefined = null;
	if (t.isReturnStatement(stmt)) {
		argument = stmt.argument;
	} else if (
		t.isBlockStatement(stmt) &&
		stmt.body.length === 1 &&
		t.isReturnStatement(stmt.body[0])
	) {
		argument = stmt.body[0].argument;
	}
	if (!argument) return null;
	if (
		t.isCallExpression(argument) &&
		t.isIdentifier(argument.callee, { name: "_editAppendOpts" }) &&
		argument.arguments.length === 1 &&
		t.isExpression(argument.arguments[0])
	) {
		return argument.arguments[0];
	}
	return argument;
}

function statementReturnsNull(stmt: t.Statement): boolean {
	return t.isNullLiteral(getEditRenderReturnArgument(stmt));
}

function statementReturnsEmptyString(stmt: t.Statement): boolean {
	return t.isStringLiteral(getEditRenderReturnArgument(stmt), { value: "" });
}

function isFilePathNullGuard(
	stmt: t.Statement,
	filePathBinding: string,
): boolean {
	return (
		t.isIfStatement(stmt) &&
		t.isUnaryExpression(stmt.test, { operator: "!" }) &&
		t.isIdentifier(stmt.test.argument, { name: filePathBinding }) &&
		statementReturnsNull(stmt.consequent)
	);
}

function hasEditRenderGuards(
	body: t.Statement[],
	filePathBinding: string,
): boolean {
	let sawNullGuard = false;

	for (const stmt of body) {
		if (!sawNullGuard) {
			if (isFilePathNullGuard(stmt, filePathBinding)) {
				sawNullGuard = true;
			}
			if (t.isReturnStatement(stmt)) return false;
			continue;
		}

		if (t.isIfStatement(stmt) && statementReturnsEmptyString(stmt.consequent)) {
			return true;
		}
		if (t.isReturnStatement(stmt)) return false;
	}

	return false;
}

function getEditRenderFilePathBinding(
	node: t.FunctionDeclaration,
	opts: {
		requireExtendedFields?: boolean;
		rejectExtendedFields?: boolean;
	} = {},
): string | null {
	if (node.params.length !== 2) return null;
	const firstParam = node.params[0];
	const secondParam = node.params[1];
	if (!t.isObjectPattern(firstParam)) return null;
	if (!t.isObjectPattern(secondParam)) return null;

	const firstKeys = getObjectPatternKeySet(firstParam);
	if (!firstKeys.has("file_path")) return null;
	if (!objectPatternHasKey(secondParam, "verbose")) return null;
	if (EDIT_RENDER_EXCLUDED_KEYS.some((key) => firstKeys.has(key))) return null;
	if (
		opts.requireExtendedFields &&
		(!firstKeys.has("edits") || !firstKeys.has("replace_all"))
	) {
		return null;
	}
	if (
		opts.rejectExtendedFields &&
		(firstKeys.has("edits") || firstKeys.has("replace_all"))
	) {
		return null;
	}

	const filePathBinding = getObjectPatternBindingName(firstParam, "file_path");
	if (!filePathBinding) return null;
	if (!hasEditRenderGuards(node.body.body, filePathBinding)) return null;
	return filePathBinding;
}

function functionBodyHasDeclaration(
	node: t.FunctionDeclaration,
	name: string,
): boolean {
	return node.body.body.some(
		(stmt) =>
			t.isFunctionDeclaration(stmt) && t.isIdentifier(stmt.id, { name }),
	);
}

function returnCallsHelper(
	ret: t.ReturnStatement,
	helperName: string,
): boolean {
	return (
		t.isCallExpression(ret.argument) &&
		t.isIdentifier(ret.argument.callee, { name: helperName })
	);
}

function hasOnlyWrappedTopLevelReturns(path: any, helperName: string): boolean {
	let wrappedReturns = 0;
	let unwrappedReturn = false;

	path.traverse({
		Function(innerPath: any) {
			innerPath.skip();
		},
		ReturnStatement(retPath: any) {
			if (!retPath.node.argument) return;
			if (returnCallsHelper(retPath.node, helperName)) {
				wrappedReturns += 1;
				return;
			}
			unwrappedReturn = true;
		},
	});

	return wrappedReturns > 0 && !unwrappedReturn;
}

function inspectValidateExtendedFlow(validateMethod: t.ObjectMethod | null): {
	hasCanonicalization: boolean;
	hasEarlyReturnTrue: boolean;
} {
	let hasCanonicalization = false;
	let hasEarlyReturnTrue = false;
	if (!validateMethod) {
		return { hasCanonicalization, hasEarlyReturnTrue };
	}

	const validateWrapper = t.file(
		t.program([t.functionDeclaration(null, [], validateMethod.body)]),
	);

	traverse(validateWrapper, {
		IfStatement(ifPath) {
			const test = ifPath.node.test;
			if (!t.isCallExpression(test)) return;
			if (
				!t.isIdentifier(test.callee, {
					name: "_claudeEditHasExtendedFields",
				})
			) {
				return;
			}
			if (
				test.arguments.length !== 1 ||
				!t.isIdentifier(test.arguments[0], { name: "_input" })
			) {
				return;
			}
			if (!t.isBlockStatement(ifPath.node.consequent)) return;

			let sawNormalizeCall = false;
			let sawCanonicalizeCall = false;
			let sawReturnTrue = false;

			traverse(
				ifPath.node.consequent,
				{
					CallExpression(callPath) {
						if (
							t.isIdentifier(callPath.node.callee, {
								name: "_claudeEditNormalizeEdits",
							})
						) {
							sawNormalizeCall = true;
						}
						if (
							t.isIdentifier(callPath.node.callee, {
								name: "_claudeEditCanonicalizeInput",
							})
						) {
							sawCanonicalizeCall = true;
						}
					},
					ReturnStatement(returnPath) {
						const arg = returnPath.node.argument;
						if (!arg || !t.isObjectExpression(arg)) return;
						const resultProp = getObjectPropertyByName(arg, "result");
						if (!resultProp) return;
						if (t.isBooleanLiteral(resultProp.value, { value: true })) {
							sawReturnTrue = true;
						}
					},
				},
				ifPath.scope,
				ifPath,
			);

			if (sawNormalizeCall && sawCanonicalizeCall) {
				hasCanonicalization = true;
			}
			if (sawReturnTrue) {
				hasEarlyReturnTrue = true;
			}
		},
	});

	return { hasCanonicalization, hasEarlyReturnTrue };
}

function patchApprovalDialog(ast: any) {
	traverse(ast, {
		Function(path: any) {
			const body = path.node.body;
			if (!t.isBlockStatement(body)) return;

			let hasEditFileTitle = false;
			path.traverse({
				StringLiteral(innerPath: any) {
					if (innerPath.node.value === "Edit file") {
						hasEditFileTitle = true;
						innerPath.stop();
					}
				},
			});

			if (!hasEditFileTitle) return;

			// Avoid double-patching
			const funcStr = JSON.stringify(path.node.body);
			if (funcStr.includes("EXTENDED_EDIT_PREVIEW_v1")) return;

			if (path.node.params.length < 1 || !t.isIdentifier(path.node.params[0]))
				return;
			const argName = path.node.params[0].name;

			let oldStringTarget: t.Expression | null = null;
			let newStringTarget: t.Expression | null = null;
			let insertBeforePath: any = null;

			// Find the edits array creation: [{ old_string: X, new_string: Y, ... }]
			path.traverse({
				ArrayExpression(innerPath: any) {
					if (insertBeforePath) return;
					const el = innerPath.node.elements?.[0];
					if (!el || !t.isObjectExpression(el)) return;

					const oldProp = el.properties.find(
						(p: any) =>
							t.isObjectProperty(p) && hasObjectKeyName(p, "old_string"),
					) as t.ObjectProperty | undefined;
					const newProp = el.properties.find(
						(p: any) =>
							t.isObjectProperty(p) && hasObjectKeyName(p, "new_string"),
					) as t.ObjectProperty | undefined;

					if (!oldProp || !newProp) return;
					if (
						!t.isIdentifier(oldProp.value) &&
						!t.isMemberExpression(oldProp.value)
					) {
						return;
					}
					if (
						!t.isIdentifier(newProp.value) &&
						!t.isMemberExpression(newProp.value)
					) {
						return;
					}

					oldStringTarget = t.cloneNode(oldProp.value);
					newStringTarget = t.cloneNode(newProp.value);

					const stmtParent = innerPath.getStatementParent();
					if (!stmtParent) return;

					insertBeforePath = stmtParent;
					innerPath.stop();
				},
			});

			if (!oldStringTarget || !newStringTarget || !insertBeforePath) return;

			const directInput =
				path.node.params.length >= 2 && t.isIdentifier(path.node.params[1])
					? t.identifier(path.node.params[1].name)
					: t.nullLiteral();

			const buildPatchCode = template.statements(
				`
                    const _claudeEditPreviewMarker = "EXTENDED_EDIT_PREVIEW_v1";
                    try {
                        const INPUT_RAW = ARG && ARG.toolUseConfirm ? ARG.toolUseConfirm.input : DIRECT_INPUT;
                        const INPUT = ${EXTENDED_EDIT_TRANSPORT_DECODE}(INPUT_RAW);
                        const _hasExtended =
                            INPUT &&
                            _claudeEditHasExtendedFields(INPUT);

                        if (_hasExtended) {
                            const _previewResult = _claudeEditCanonicalizeInput(INPUT);
                            if (!_previewResult.error) {
                                OLD_TARGET = _previewResult.oldString;
                                NEW_TARGET = _previewResult.newString;
                            }
                        }
                    } catch (_e) {}

                    if (typeof OLD_TARGET !== "string") OLD_TARGET = "";
                    if (typeof NEW_TARGET !== "string") NEW_TARGET = "";
                `,
				{
					placeholderPattern: /^ARG$|^DIRECT_INPUT$|^OLD_TARGET$|^NEW_TARGET$/,
				},
			);

			const patchCode = buildPatchCode({
				ARG: t.identifier(argName),
				DIRECT_INPUT: directInput,
				OLD_TARGET: oldStringTarget,
				NEW_TARGET: newStringTarget,
			});

			insertBeforePath.insertBefore(patchCode);
		},
	});
}

function getObjectPropertyName(
	prop: t.ObjectProperty | t.ObjectMethod,
): string | null {
	const key = prop.key;
	if (t.isIdentifier(key)) return key.name;
	if (t.isStringLiteral(key)) return key.value;
	return null;
}

function resolveToolName(path: any): string | null {
	const nameProp = path.node.properties.find(
		(p: any): p is t.ObjectProperty =>
			t.isObjectProperty(p) && getObjectPropertyName(p) === "name",
	);
	if (!nameProp) return null;

	if (t.isStringLiteral(nameProp.value)) return nameProp.value.value;
	if (!t.isIdentifier(nameProp.value)) return null;

	const binding = path.scope.getBinding(nameProp.value.name);
	const bindingNode = binding?.path?.node;
	if (
		t.isVariableDeclarator(bindingNode) &&
		t.isStringLiteral(bindingNode.init)
	) {
		return bindingNode.init.value;
	}
	return null;
}

// Bypass read-state guards inside Edit's validateInput and call methods.
// Upstream splits the read-state precondition into two guard shapes per
// method:
//   - validateInput: `if (!w || w.isPartialView) return {...errorCode: 6}`
//     (not-read / partial-view) and a nested `if (mtime > w.timestamp)`
//     (modified-since-read).
//   - call: `if (!x) throw Error(...)` (not-read) and a sibling
//     `if (mtime > x.timestamp) throw Error(...)` (modified-since-read).
//
// We bypass the not-read guards UNCONDITIONALLY (test -> false) so plain
// Edits work without a prior Read tool call -- canonicalization and the
// edit application both read file contents from disk via
// _claudeFs.readFileSync, not from the readFileState cache. Edit is
// content-addressed, so we also bypass the mtime-only stale-read guards and
// let the later exact-match / ambiguity checks against current file contents
// provide the concurrency protection. Write keeps its stale-read guard because
// it has no old_string anchor.
function patchReadStateGuards(ast: any): { wrappedCount: number } {
	let wrappedCount = 0;

	traverse(ast, {
		ObjectExpression(path: any) {
			const toolName = resolveToolName(path);
			if (toolName !== "Edit") return;

			for (const methodName of ["validateInput", "call"] as const) {
				const method = path.node.properties.find(
					(p: any): p is t.ObjectMethod =>
						t.isObjectMethod(p) && getObjectPropertyName(p) === methodName,
				);
				if (!method) continue;

				traverse(
					method.body,
					{
						IfStatement(ifPath: any) {
							if (tryWrapMtimeGuard(ifPath)) wrappedCount++;
						},
					},
					path.scope,
					path,
				);

				traverse(
					method.body,
					{
						IfStatement(ifPath: any) {
							if (tryBypassValidateNullStateGuard(ifPath)) wrappedCount++;
							if (tryBypassCallNullStateGuard(ifPath)) wrappedCount++;
						},
					},
					path.scope,
					path,
				);
			}
		},
	});

	return { wrappedCount };
}

// Bypass the read-state throws inside the relocated Edit call-path read-state
// precondition helper. On current upstream the Edit call delegates its
// not-read / modified-since checks to a standalone top-level helper that takes a
// destructured options object (absoluteFilePath, fileContents, lastRead,
// oldString, replaceAll, model) and throws when lastRead is absent. We turn the
// not-read branch into `return false` (not stale-recovered) so plain Edits apply
// without a prior Read, and turn the direct modified-since throw into
// `return false` so the normal current-file content checks decide whether the
// Edit applies.
function patchReadStateHelper(ast: t.File): { bypassed: number } {
	let bypassed = 0;

	traverse(ast, {
		FunctionDeclaration(path) {
			const [param] = path.node.params;
			if (path.node.params.length !== 1 || !t.isObjectPattern(param)) return;
			const keys = getObjectPatternKeySet(param);
			if (
				!keys.has("lastRead") ||
				!keys.has("oldString") ||
				!keys.has("replaceAll")
			) {
				return;
			}
			const lastReadBinding = getObjectPatternBindingName(param, "lastRead");
			if (!lastReadBinding) return;

			for (const stmt of path.node.body.body) {
				if (!t.isIfStatement(stmt)) continue;
				if (!t.isUnaryExpression(stmt.test, { operator: "!" })) continue;
				if (!t.isIdentifier(stmt.test.argument, { name: lastReadBinding })) {
					continue;
				}

				const consequent = stmt.consequent;
				if (t.isThrowStatement(consequent)) {
					stmt.consequent = t.returnStatement(t.booleanLiteral(false));
					bypassed++;
				} else if (t.isBlockStatement(consequent)) {
					let replaced = false;
					consequent.body = consequent.body.map((inner) => {
						if (t.isThrowStatement(inner)) {
							replaced = true;
							return t.returnStatement(t.booleanLiteral(false));
						}
						return inner;
					});
					if (replaced) bypassed++;
				}
			}

			const body = path.node.body.body;
			path.node.body.body = body.map((stmt, idx) => {
				if (!isHelperStaleReadTailThrow(body, idx, lastReadBinding)) {
					return stmt;
				}
				bypassed++;
				return t.returnStatement(t.booleanLiteral(false));
			});
		},
	});

	return { bypassed };
}

// Match `if (callExpr > stateVar.timestamp)` with consequent free to be a
// returned error or a thrown error. Replace the test with literal `false` so
// stale read state never blocks Edit before current-content matching runs.
// Idempotent: skip already-bypassed guards.
function tryWrapMtimeGuard(ifPath: any): boolean {
	const test = ifPath.node.test;

	if (t.isBooleanLiteral(test, { value: false })) return false;

	if (!t.isBinaryExpression(test, { operator: ">" })) return false;
	if (!t.isCallExpression(test.left)) return false;
	if (!t.isMemberExpression(test.right)) return false;
	if (!t.isIdentifier(test.right.object)) return false;
	if (!isMemberPropertyName(test.right, "timestamp")) return false;

	ifPath.node.test = t.booleanLiteral(false);
	return true;
}

// Match validateInput's not-read guard: `if (!IDENT || IDENT.isPartialView)`
// with consequent returning an object literal containing `errorCode: 6`.
// Replace test with literal `false` to bypass unconditionally.
// Idempotent: skip if already bypassed.
function tryBypassValidateNullStateGuard(ifPath: any): boolean {
	const test = ifPath.node.test;

	if (t.isBooleanLiteral(test, { value: false })) return false;

	if (!t.isLogicalExpression(test, { operator: "||" })) return false;
	if (!t.isUnaryExpression(test.left, { operator: "!" })) return false;
	if (!t.isIdentifier(test.left.argument)) return false;
	const varName = test.left.argument.name;
	if (!t.isMemberExpression(test.right)) return false;
	if (!t.isIdentifier(test.right.object, { name: varName })) return false;
	if (!t.isIdentifier(test.right.property, { name: "isPartialView" }))
		return false;

	if (!nodeContainsReadStateErrorReturn(ifPath.node.consequent, 6))
		return false;

	ifPath.node.test = t.booleanLiteral(false);
	return true;
}

function isReadStateThrowStatement(stmt: t.Node): boolean {
	if (t.isBlockStatement(stmt) && stmt.body.length === 1) {
		stmt = stmt.body[0];
	}
	if (!t.isThrowStatement(stmt)) return false;
	const argument = stmt.argument;
	if (t.isNewExpression(argument)) return true;
	return (
		t.isCallExpression(argument) &&
		t.isIdentifier(argument.callee, { name: "Error" })
	);
}

function nodeContainsReadStateThrow(node: t.Node): boolean {
	let found = false;
	visitNodeValues(node, (candidate) => {
		if (isReadStateThrowStatement(candidate)) {
			found = true;
			return true;
		}
		return false;
	});
	return found;
}

function nodeContainsReadStateErrorReturn(
	node: t.Node,
	errorCode: number,
): boolean {
	let found = false;
	visitNodeValues(node, (candidate) => {
		if (!t.isReturnStatement(candidate)) return false;
		if (!t.isObjectExpression(candidate.argument)) return false;
		if (
			candidate.argument.properties.some(
				(prop): prop is t.ObjectProperty =>
					t.isObjectProperty(prop) &&
					getObjectPropertyName(prop) === "errorCode" &&
					t.isNumericLiteral(prop.value, { value: errorCode }),
			)
		) {
			found = true;
			return true;
		}
		return false;
	});
	return found;
}

function nodeContainsTimestampRead(
	node: t.Node,
	stateVarName: string,
): boolean {
	let found = false;
	visitNodeValues(node, (candidate) => {
		if (
			t.isMemberExpression(candidate) &&
			t.isIdentifier(candidate.object, { name: stateVarName }) &&
			isMemberPropertyName(candidate, "timestamp")
		) {
			found = true;
			return true;
		}
		return false;
	});
	return found;
}

function isHelperStaleReadTailThrow(
	body: t.Statement[],
	idx: number,
	stateVarName: string,
): boolean {
	if (idx !== body.length - 1) return false;
	if (!t.isThrowStatement(body[idx])) return false;
	const priorStatements = body.slice(0, idx);
	return priorStatements.some((stmt) =>
		nodeContainsTimestampRead(stmt, stateVarName),
	);
}

function prependStateGuardToIfTest(
	ifNode: t.IfStatement,
	varName: string,
): void {
	const test = ifNode.test;
	const alreadyPrepended =
		t.isLogicalExpression(test, { operator: "&&" }) &&
		t.isIdentifier(test.left, { name: varName });
	if (alreadyPrepended) return;

	ifNode.test = t.logicalExpression(
		"&&",
		t.identifier(varName),
		t.cloneNode(test),
	);
}

// Match call's not-read guard: `if (!IDENT) throw ...` immediately
// preceded by `let IDENT = ANY.get(...)` (the readFileState lookup).
// Replace test with literal `false` to bypass unconditionally, and prepend
// `IDENT &&` to the immediately following or alternate IfStatement (the mtime
// guard) so it short-circuits safely when readFileState entry is undefined.
// Idempotent: skip if already bypassed.
function tryBypassCallNullStateGuard(ifPath: any): boolean {
	const test = ifPath.node.test;

	if (t.isBooleanLiteral(test, { value: false })) return false;

	if (!t.isUnaryExpression(test, { operator: "!" })) return false;
	if (!t.isIdentifier(test.argument)) return false;
	const varName = test.argument.name;

	if (!nodeContainsReadStateThrow(ifPath.node.consequent)) return false;

	const parent = ifPath.parent;
	if (!t.isBlockStatement(parent)) return false;
	const idx = parent.body.indexOf(ifPath.node);
	if (idx <= 0) return false;
	const prev = parent.body[idx - 1];
	if (!t.isVariableDeclaration(prev)) return false;
	const declarator = prev.declarations.find((d: any) =>
		t.isIdentifier(d.id, { name: varName }),
	);
	if (!declarator?.init || !t.isCallExpression(declarator.init)) return false;
	if (!t.isMemberExpression(declarator.init.callee)) return false;
	if (!t.isIdentifier(declarator.init.callee.property, { name: "get" }))
		return false;

	ifPath.node.test = t.booleanLiteral(false);

	if (t.isIfStatement(ifPath.node.alternate)) {
		prependStateGuardToIfTest(ifPath.node.alternate, varName);
	}

	if (idx + 1 < parent.body.length) {
		const next = parent.body[idx + 1];
		if (t.isIfStatement(next)) {
			prependStateGuardToIfTest(next, varName);
		}
	}

	return true;
}

function prependStateGuardToNextIf(
	parent: t.BlockStatement,
	idx: number,
	varName: string,
): void {
	if (idx + 1 >= parent.body.length) return;
	const next = parent.body[idx + 1];
	if (!t.isIfStatement(next)) return;

	const alreadyPrepended =
		t.isLogicalExpression(next.test, { operator: "&&" }) &&
		t.isIdentifier(next.test.left, { name: varName });
	if (alreadyPrepended) return;

	next.test = t.logicalExpression(
		"&&",
		t.identifier(varName),
		t.cloneNode(next.test),
	);
}

function getPreviousGetDeclaration(
	ifPath: any,
	varName: string,
): t.VariableDeclarator | null {
	const parent = ifPath.parent;
	if (!t.isBlockStatement(parent)) return null;

	const idx = parent.body.indexOf(ifPath.node);
	if (idx <= 0) return null;
	const prev = parent.body[idx - 1];
	if (!t.isVariableDeclaration(prev)) return null;

	const declarator = prev.declarations.find((decl: any) =>
		t.isIdentifier(decl.id, { name: varName }),
	);
	if (!declarator?.init || !t.isCallExpression(declarator.init)) return null;
	if (!t.isMemberExpression(declarator.init.callee)) return null;
	if (!t.isIdentifier(declarator.init.callee.property, { name: "get" })) {
		return null;
	}

	return declarator;
}

function statementReturnsReadStateError(
	stmt: t.Node,
	errorCode: number,
): boolean {
	return nodeContainsReadStateErrorReturn(stmt, errorCode);
}

function tryBypassWriteValidateNullStateGuard(ifPath: any): boolean {
	const test = ifPath.node.test;

	if (t.isBooleanLiteral(test, { value: false })) return false;
	if (!t.isLogicalExpression(test, { operator: "||" })) return false;
	if (!t.isUnaryExpression(test.left, { operator: "!" })) return false;
	if (!t.isIdentifier(test.left.argument)) return false;
	const varName = test.left.argument.name;
	if (!t.isMemberExpression(test.right)) return false;
	if (!t.isIdentifier(test.right.object, { name: varName })) return false;
	if (!t.isIdentifier(test.right.property, { name: "isPartialView" })) {
		return false;
	}
	if (!statementReturnsReadStateError(ifPath.node.consequent, 2)) return false;
	if (!getPreviousGetDeclaration(ifPath, varName)) return false;

	const parent = ifPath.parent;
	const idx = t.isBlockStatement(parent)
		? parent.body.indexOf(ifPath.node)
		: -1;
	ifPath.node.test = t.booleanLiteral(false);
	if (t.isBlockStatement(parent) && idx >= 0) {
		prependStateGuardToNextIf(parent, idx, varName);
	}
	return true;
}

function tryBypassWriteCallNullStateGuard(ifPath: any): boolean {
	const test = ifPath.node.test;

	if (t.isBooleanLiteral(test, { value: false })) return false;
	if (!t.isUnaryExpression(test, { operator: "!" })) return false;
	if (!t.isIdentifier(test.argument)) return false;
	const varName = test.argument.name;

	if (!nodeContainsReadStateThrow(ifPath.node.consequent)) return false;
	if (!getPreviousGetDeclaration(ifPath, varName)) return false;

	const parent = ifPath.parent;
	const idx = t.isBlockStatement(parent)
		? parent.body.indexOf(ifPath.node)
		: -1;
	ifPath.node.test = t.booleanLiteral(false);
	if (t.isIfStatement(ifPath.node.alternate)) {
		prependStateGuardToIfTest(ifPath.node.alternate, varName);
	}
	if (t.isBlockStatement(parent) && idx >= 0) {
		prependStateGuardToNextIf(parent, idx, varName);
	}
	return true;
}

function patchWriteReadStateGuards(ast: any): void {
	traverse(ast, {
		ObjectExpression(path: any) {
			const toolName = resolveToolName(path);
			if (toolName !== "Write") return;

			for (const methodName of ["validateInput", "call"] as const) {
				const method = path.node.properties.find(
					(p: any): p is t.ObjectMethod =>
						t.isObjectMethod(p) && getObjectPropertyName(p) === methodName,
				);
				if (!method) continue;

				traverse(
					method.body,
					{
						IfStatement(ifPath: any) {
							if (tryBypassWriteValidateNullStateGuard(ifPath)) return;
							tryBypassWriteCallNullStateGuard(ifPath);
						},
					},
					path.scope,
					path,
				);
			}
		},
	});
}

function isAlreadyWrappedWithExtendedBypass(test: any): boolean {
	if (
		t.isLogicalExpression(test, { operator: "&&" }) &&
		t.isUnaryExpression(test.right, { operator: "!" }) &&
		t.isCallExpression(test.right.argument) &&
		t.isIdentifier(test.right.argument.callee, {
			name: "_claudeEditHasExtendedFields",
		})
	) {
		return true;
	}
	if (
		t.isLogicalExpression(test, { operator: "&&" }) &&
		t.isIdentifier(test.left)
	) {
		return isAlreadyWrappedWithExtendedBypass(test.right);
	}
	return false;
}

function patchIdeDiffConfigGuards(ast: t.File): void {
	traverse(ast, {
		ConditionalExpression(path: any) {
			if (!t.isNullLiteral(path.node.alternate)) return;
			if (!t.isCallExpression(path.node.consequent)) return;
			if (!t.isMemberExpression(path.node.consequent.callee)) return;
			if (
				!t.isIdentifier(path.node.consequent.callee.property, {
					name: "getConfig",
				})
			) {
				return;
			}
			if (path.node.consequent.arguments.length !== 1) return;
			const [parsedInput] = path.node.consequent.arguments;
			if (!t.isExpression(parsedInput)) return;

			const diffSupportRef = path.node.consequent.callee.object;
			if (
				!t.isIdentifier(diffSupportRef) ||
				!t.isIdentifier(path.node.test, { name: diffSupportRef.name })
			) {
				return;
			}

			path.node.consequent = t.conditionalExpression(
				t.callExpression(t.identifier("_claudeEditHasExtendedFields"), [
					t.callExpression(t.identifier(EXTENDED_EDIT_TRANSPORT_DECODE), [
						t.cloneNode(parsedInput),
					]),
				]),
				t.nullLiteral(),
				t.callExpression(
					t.memberExpression(
						t.cloneNode(diffSupportRef),
						t.identifier("getConfig"),
					),
					[t.cloneNode(parsedInput)],
				),
			);
		},
	});
}

function injectExtendedEditTransportHelpers(ast: t.File): void {
	const existing = ast.program.body.some(
		(stmt) =>
			t.isFunctionDeclaration(stmt) &&
			t.isIdentifier(stmt.id, {
				name: EXTENDED_EDIT_TRANSPORT_DECODE,
			}),
	);
	if (existing) return;

	const helperStatements = template.statements(
		`
        const _claudeExtendedEditTransportPrefix = ${JSON.stringify(EXTENDED_EDIT_TRANSPORT_PREFIX)};

        function ${EXTENDED_EDIT_TRANSPORT_DECODE}(INPUT) {
            if (!INPUT || typeof INPUT !== "object") return INPUT;
            if (_claudeEditHasExtendedFields(INPUT)) return INPUT;
            if (typeof INPUT.old_string !== "string") return INPUT;
            if (!INPUT.old_string.startsWith(_claudeExtendedEditTransportPrefix)) {
                return INPUT;
            }
            if (typeof INPUT.new_string === "string" && INPUT.new_string !== "") {
                return INPUT;
            }
            try {
                const payload = JSON.parse(
                    INPUT.old_string.slice(_claudeExtendedEditTransportPrefix.length),
                );
                if (!payload || typeof payload !== "object") return INPUT;
                if (payload.file_path === undefined && INPUT.file_path !== undefined) {
                    payload.file_path = INPUT.file_path;
                }
                return payload;
            } catch {
                return INPUT;
            }
        }
        `,
		{ placeholderPattern: false },
	)();

	ast.program.body.push(...helperStatements);
}

/**
 * Modify the Edit tool's Zod strictObject schema for batch edit support:
 * 1. Add `edits` as an optional array field
 * 2. Make `old_string` and `new_string` optional (required enforcement moves to validateInput)
 *
 * Without this, the generic tool dispatch rejects batch payloads during `safeParse()`
 * with "unexpected parameter" and "required parameter missing" errors before the Edit
 * tool's own validation and normalization logic can run.
 */
function patchEditSchemaForBatchEdits(ast: t.File): void {
	traverse(ast, {
		CallExpression(path) {
			if (!t.isMemberExpression(path.node.callee)) return;
			if (!isMemberPropertyName(path.node.callee, "strictObject")) return;
			if (path.node.arguments.length < 1) return;

			const arg0 = path.node.arguments[0];
			if (!t.isObjectExpression(arg0)) return;

			// Match the Edit schema by old_string + new_string + replace_all
			const hasOldString = arg0.properties.some(
				(p) => t.isObjectProperty(p) && hasObjectKeyName(p, "old_string"),
			);
			const hasNewString = arg0.properties.some(
				(p) => t.isObjectProperty(p) && hasObjectKeyName(p, "new_string"),
			);
			const hasReplaceAll = arg0.properties.some(
				(p) => t.isObjectProperty(p) && hasObjectKeyName(p, "replace_all"),
			);
			if (!hasOldString || !hasNewString || !hasReplaceAll) return;

			// Already patched?
			const hasEdits = arg0.properties.some(
				(p) => t.isObjectProperty(p) && hasObjectKeyName(p, "edits"),
			);
			if (hasEdits) return;

			// Resolve the Zod variable name from the method receiver
			if (!t.isIdentifier(path.node.callee.object)) return;
			const zodVar = path.node.callee.object.name;

			// Make old_string and new_string optional so batch-only payloads pass safeParse.
			// Wrap: y.string().describe(...) -> y.string().optional().describe(...)
			for (const prop of arg0.properties) {
				if (!t.isObjectProperty(prop)) continue;
				const keyName = getObjectKeyName(prop.key);
				if (keyName !== "old_string" && keyName !== "new_string") continue;
				if (!t.isCallExpression(prop.value)) continue;

				// Pattern: z.string().describe("...") - insert .optional() before .describe()
				const describeCall = prop.value;
				if (!t.isMemberExpression(describeCall.callee)) continue;
				if (!isMemberPropertyName(describeCall.callee, "describe")) continue;

				// Wrap the receiver with .optional(): receiver.describe(...) -> receiver.optional().describe(...)
				const receiver = describeCall.callee.object;
				describeCall.callee.object = t.callExpression(
					t.memberExpression(
						t.cloneNode(receiver, true) as t.Expression,
						t.identifier("optional"),
					),
					[],
				);
			}

			// Add edits field: z.array(z.object({ old_string, new_string, replace_all })).optional()
			const editEntrySchema = t.callExpression(
				t.memberExpression(t.identifier(zodVar), t.identifier("object")),
				[
					t.objectExpression([
						t.objectProperty(
							t.identifier("old_string"),
							t.callExpression(
								t.memberExpression(
									t.identifier(zodVar),
									t.identifier("string"),
								),
								[],
							),
						),
						t.objectProperty(
							t.identifier("new_string"),
							t.callExpression(
								t.memberExpression(
									t.identifier(zodVar),
									t.identifier("string"),
								),
								[],
							),
						),
						t.objectProperty(
							t.identifier("replace_all"),
							t.callExpression(
								t.memberExpression(
									t.callExpression(
										t.memberExpression(
											t.identifier(zodVar),
											t.identifier("boolean"),
										),
										[],
									),
									t.identifier("optional"),
								),
								[],
							),
						),
					]),
				],
			);

			const editsSchema = t.callExpression(
				t.memberExpression(
					t.callExpression(
						t.memberExpression(t.identifier(zodVar), t.identifier("array")),
						[editEntrySchema],
					),
					t.identifier("optional"),
				),
				[],
			);

			arg0.properties.push(
				t.objectProperty(t.identifier("edits"), editsSchema),
			);

			path.stop();
		},
	});
}

function getObjectPatternBindingName(
	pattern: t.ObjectPattern,
	propertyName: string,
): string | null {
	for (const prop of pattern.properties) {
		if (!t.isObjectProperty(prop) || !hasObjectKeyName(prop, propertyName)) {
			continue;
		}
		if (t.isIdentifier(prop.value)) return prop.value.name;
		if (t.isAssignmentPattern(prop.value) && t.isIdentifier(prop.value.left)) {
			return prop.value.left.name;
		}
	}
	return null;
}

function buildHasExtendedFieldsCall(inputName: string): t.CallExpression {
	return t.callExpression(t.identifier("_claudeEditHasExtendedFields"), [
		t.identifier(inputName),
	]);
}

function getLegacyParsedEditArrayInputName(
	node: t.Expression,
): { inputName: string } | null {
	if (!t.isArrayExpression(node) || node.elements.length !== 1) return null;
	const [entry] = node.elements;
	if (!entry || !t.isObjectExpression(entry)) return null;

	let parsedInputName: string | null = null;
	for (const propertyName of ["old_string", "new_string", "replace_all"]) {
		const prop = entry.properties.find(
			(candidate): candidate is t.ObjectProperty =>
				t.isObjectProperty(candidate) &&
				hasObjectKeyName(candidate, propertyName),
		);
		if (!prop || !t.isMemberExpression(prop.value)) return null;
		if (!t.isIdentifier(prop.value.object)) return null;
		if (!isMemberPropertyName(prop.value, propertyName)) return null;

		if (!parsedInputName) {
			parsedInputName = prop.value.object.name;
			continue;
		}
		if (prop.value.object.name !== parsedInputName) {
			return null;
		}
	}

	if (!parsedInputName) return null;
	return { inputName: parsedInputName };
}

function patchStructuredEditInputNormalization(
	ast: t.File,
	toolVarName: string,
): void {
	traverse(ast, {
		CallExpression(path) {
			if (path.node.arguments.length < 1) return;
			const [inputArg] = path.node.arguments;
			if (!t.isObjectExpression(inputArg)) return;

			const switchCase = path.findParent((parentPath) =>
				parentPath.isSwitchCase(),
			);
			if (!switchCase || !t.isSwitchCase(switchCase.node)) return;
			if (!t.isMemberExpression(switchCase.node.test)) return;
			if (
				!t.isIdentifier(switchCase.node.test.object, { name: toolVarName }) ||
				!isMemberPropertyName(switchCase.node.test, "name")
			) {
				return;
			}

			const variableDeclarator = path.findParent((parentPath) =>
				parentPath.isVariableDeclarator(),
			);
			if (
				!variableDeclarator ||
				!t.isVariableDeclarator(variableDeclarator.node) ||
				variableDeclarator.node.init !== path.node ||
				!t.isObjectPattern(variableDeclarator.node.id)
			) {
				return;
			}

			const normalizedEditsBindingName = getObjectPatternBindingName(
				variableDeclarator.node.id,
				"edits",
			);
			if (!normalizedEditsBindingName) return;

			const normalizedEditsProperty = inputArg.properties.find(
				(prop): prop is t.ObjectProperty =>
					t.isObjectProperty(prop) &&
					hasObjectKeyName(prop, "edits") &&
					t.isExpression(prop.value) &&
					!!getLegacyParsedEditArrayInputName(prop.value),
			);
			if (!normalizedEditsProperty) return;

			if (!t.isExpression(normalizedEditsProperty.value)) return;
			const legacyParsedEditArray = getLegacyParsedEditArrayInputName(
				normalizedEditsProperty.value,
			);
			if (!legacyParsedEditArray) return;

			const parsedInputName = legacyParsedEditArray.inputName;

			let foundReturnObject: t.ObjectExpression | null = null;
			switchCase.traverse({
				ReturnStatement(returnPath) {
					if (!t.isObjectExpression(returnPath.node.argument)) return;
					foundReturnObject = returnPath.node.argument;
					returnPath.stop();
				},
			});
			if (!foundReturnObject) return;
			const returnObject: t.ObjectExpression = foundReturnObject;

			if (
				t.isConditionalExpression(normalizedEditsProperty.value) &&
				t.isCallExpression(normalizedEditsProperty.value.test) &&
				t.isIdentifier(normalizedEditsProperty.value.test.callee, {
					name: "_claudeEditHasExtendedFields",
				})
			) {
				return;
			}

			const hasExtendedFieldsCall = buildHasExtendedFieldsCall(parsedInputName);
			const legacyEdits = t.cloneNode(
				normalizedEditsProperty.value,
				true,
			) as t.Expression;

			normalizedEditsProperty.value = t.conditionalExpression(
				hasExtendedFieldsCall,
				t.memberExpression(
					t.identifier(parsedInputName),
					t.identifier("edits"),
				),
				legacyEdits,
			);

			const alreadyReturnsEdits = returnObject.properties.some(
				(prop) => t.isObjectProperty(prop) && hasObjectKeyName(prop, "edits"),
			);
			if (alreadyReturnsEdits) return;

			returnObject.properties.push(
				t.spreadElement(
					t.conditionalExpression(
						buildHasExtendedFieldsCall(parsedInputName),
						t.objectExpression([
							t.objectProperty(
								t.identifier("edits"),
								t.identifier(normalizedEditsBindingName),
							),
						]),
						t.objectExpression([]),
					),
				),
			);
		},
	});
}

function patchEditAutoClassifierInput(editToolObj: t.ObjectExpression): void {
	const classifierMethod = editToolObj.properties.find(
		(prop): prop is t.ObjectMethod =>
			t.isObjectMethod(prop) &&
			getObjectKeyName(prop.key) === "toAutoClassifierInput",
	);
	if (!classifierMethod || classifierMethod.params.length < 1) return;
	if (!t.isIdentifier(classifierMethod.params[0])) return;

	const inputName = classifierMethod.params[0].name;
	if (
		classifierMethod.body.body.some(
			(stmt) =>
				t.isIfStatement(stmt) &&
				t.isCallExpression(stmt.test) &&
				t.isIdentifier(stmt.test.callee, {
					name: "_claudeEditHasExtendedFields",
				}),
		)
	) {
		return;
	}

	const classifierLogic = template.statements(
		`
            if (_claudeEditHasExtendedFields(INPUT)) {
                const _normalized = _claudeEditNormalizeEdits(INPUT);
                if (!_normalized.error) {
                    return \`\${INPUT.file_path}: \${_normalized.edits.map((edit) => edit.newString).join("\\n")}\`;
                }
            }
        `,
		{ placeholderPattern: /^INPUT$/ },
	)({
		INPUT: t.identifier(inputName),
	});

	classifierMethod.body.body.unshift(...classifierLogic);
}

const _appliedAsts = new WeakSet<t.File>();

function runEditToolPatch(ast: t.File): void {
	// Prevent double-injection if called multiple times on same AST
	if (_appliedAsts.has(ast)) return;
	_appliedAsts.add(ast);

	let toolVarName: string | null = null;
	let editToolObj: any = null;

	traverse(ast, {
		StringLiteral(path: any) {
			if (path.node.value === "A tool for editing files") {
				let p = path.parentPath;
				while (p) {
					if (t.isVariableDeclarator(p.node) && t.isIdentifier(p.node.id)) {
						toolVarName = p.node.id.name;
						break;
					}
					if (t.isAssignmentExpression(p.node) && t.isIdentifier(p.node.left)) {
						toolVarName = p.node.left.name;
						break;
					}
					p = p.parentPath;
				}
			}
		},
		ObjectMethod(path: any) {
			if (getObjectKeyName(path.node.key) === "description") {
				const body = path.node.body.body;
				if (body.length > 0 && t.isReturnStatement(body[0])) {
					const arg = body[0].argument;
					if (
						t.isStringLiteral(arg) &&
						arg.value === "A tool for editing files"
					) {
						editToolObj = path.parentPath.node;
					}
				}
			}
		},
	});

	if (toolVarName && editToolObj) {
		const templatePath = path.join(__dirname, "../templates/edit_hook.js");
		if (!fs.existsSync(templatePath)) {
			throw new Error(`edit_hook.js template not found at ${templatePath}`);
		}
		{
			const hookCode = fs
				.readFileSync(templatePath, "utf-8")
				.replace(/\nexport\s*\{\s*\};?\s*$/, "\n");
			const runtimeHookCode = adaptHookCodeForRuntime(hookCode);
			const hookAst = parse(runtimeHookCode);

			if (ast.program?.body) {
				ast.program.body.push(...hookAst.program.body);
			}

			const validateLogic = `
                {
                    const _normalizeKeys = (obj) => {
                        if (!obj || typeof obj !== "object") return obj;
                        if (obj.replaceAll !== undefined && obj.replace_all === undefined) obj.replace_all = obj.replaceAll;
                        if (obj.oldString !== undefined && obj.old_string === undefined) obj.old_string = obj.oldString;
                        if (obj.newString !== undefined && obj.new_string === undefined) obj.new_string = obj.newString;
                        return obj;
                    };
                    _input = ${EXTENDED_EDIT_TRANSPORT_DECODE}(_input);
                    _input = _normalizeKeys(_input);
                    if (Array.isArray(_input.edits)) {
                        _input.edits = _input.edits.map(_normalizeKeys);
                    }

                    if (!(Array.isArray(_input.edits) && _input.edits.length > 0)) {
                        _input.old_string = typeof _input.old_string === "string" ? _input.old_string : (_input.old_string ?? "");
                        _input.new_string = typeof _input.new_string === "string" ? _input.new_string : (_input.new_string ?? "");
                    }
                    if (_claudeEditHasExtendedFields(_input)) {
                        if (!_context) {
                            return { result: false, behavior: "ask", message: "Read-state validation failed", errorCode: 5 };
                        }
                        let Q = _claudeEditNormalizeEdits(_input);
                        if (Q.error) return Q.error;
                        const _canonical = _claudeEditCanonicalizeInput(_input, Q.edits);
                        if (_canonical.error) return _canonical.error;
                        _input.old_string = _canonical.oldString;
                        _input.new_string = _canonical.newString;
                        _input.replace_all = false;
                    }
                }`;

			const callLogic = `
                {
                    const _normalizeKeys = (obj) => {
                        if (!obj || typeof obj !== "object") return obj;
                        if (obj.replaceAll !== undefined && obj.replace_all === undefined) obj.replace_all = obj.replaceAll;
                        if (obj.oldString !== undefined && obj.old_string === undefined) obj.old_string = obj.oldString;
                        if (obj.newString !== undefined && obj.new_string === undefined) obj.new_string = obj.newString;
                        return obj;
                    };
                    _input = ${EXTENDED_EDIT_TRANSPORT_DECODE}(_input);
                    _input = _normalizeKeys(_input);
                    if (Array.isArray(_input.edits)) {
                        _input.edits = _input.edits.map(_normalizeKeys);
                    }

                    if (!(Array.isArray(_input.edits) && _input.edits.length > 0)) {
                        _input.old_string = typeof _input.old_string === "string" ? _input.old_string : (_input.old_string ?? "");
                        _input.new_string = typeof _input.new_string === "string" ? _input.new_string : (_input.new_string ?? "");
                    }
                    if (_claudeEditHasExtendedFields(_input)) {
                        let Z = _claudeEditNormalizeEdits(_input);
                        if (Z.error) throw Error(Z.error.message);
                        let L = _claudeEditCanonicalizeInput(_input, Z.edits);
                        if (L.error) throw Error(L.error.message);
                        _input.old_string = L.oldString;
                        _input.new_string = L.newString;
                        _input.replace_all = false;
                    }
                    _args[0] = _input;
                }`;

			const validateMethod = editToolObj.properties.find(
				(p: any) =>
					t.isObjectMethod(p) && getObjectKeyName(p.key) === "validateInput",
			);
			if (validateMethod) {
				const originalParams = validateMethod.params;
				validateMethod.params = [
					t.identifier("_input"),
					t.identifier("_context"),
				];

				const restoreParams = t.variableDeclaration("let", [
					t.variableDeclarator(
						t.arrayPattern(originalParams),
						t.arrayExpression([
							t.identifier("_input"),
							t.identifier("_context"),
						]),
					),
				]);

				const logicAst = template.statements(validateLogic, {
					placeholderPattern: false,
				})();
				validateMethod.body.body.unshift(restoreParams);
				validateMethod.body.body.unshift(...logicAst);
			}

			const callMethod = editToolObj.properties.find(
				(p: any) => t.isObjectMethod(p) && getObjectKeyName(p.key) === "call",
			);
			if (callMethod) {
				const originalParams = callMethod.params;
				callMethod.params = [t.restElement(t.identifier("_args"))];

				const restoreParams = t.variableDeclaration("let", [
					t.variableDeclarator(
						t.arrayPattern(originalParams),
						t.identifier("_args"),
					),
				]);

				const initVars = [
					t.variableDeclaration("let", [
						t.variableDeclarator(
							t.identifier("_input"),
							t.memberExpression(
								t.identifier("_args"),
								t.numericLiteral(0),
								true,
							),
						),
					]),
					t.variableDeclaration("let", [
						t.variableDeclarator(
							t.identifier("_context"),
							t.memberExpression(
								t.identifier("_args"),
								t.numericLiteral(1),
								true,
							),
						),
					]),
				];

				const logicAst = template.statements(callLogic, {
					placeholderPattern: false,
				})();

				callMethod.body.body.unshift(restoreParams);
				callMethod.body.body.unshift(...initVars);
				callMethod.body.body.splice(2, 0, ...logicAst);
			}

			const eqMethod = editToolObj.properties.find(
				(p: any) =>
					t.isObjectMethod(p) && getObjectKeyName(p.key) === "inputsEquivalent",
			);
			if (
				eqMethod &&
				eqMethod.params.length >= 2 &&
				t.isIdentifier(eqMethod.params[0]) &&
				t.isIdentifier(eqMethod.params[1])
			) {
				const arg1 = eqMethod.params[0].name;
				const arg2 = eqMethod.params[1].name;

				const eqLogic = `
                    {
                        const _leftInput = ${EXTENDED_EDIT_TRANSPORT_DECODE}(${arg1});
                        const _rightInput = ${EXTENDED_EDIT_TRANSPORT_DECODE}(${arg2});
                        if (_claudeEditHasExtendedFields(_leftInput) || _claudeEditHasExtendedFields(_rightInput)) {
                            return _claudeEditInputsEquivalent(_leftInput, _rightInput);
                        }
                    }`;
				const logicAst = template.statements(eqLogic, {
					placeholderPattern: false,
				})();
				eqMethod.body.body.unshift(...logicAst);
			}

			patchEditAutoClassifierInput(editToolObj);
		}
	}

	if (toolVarName) {
		injectExtendedEditTransportHelpers(ast);
		patchEditSchemaForBatchEdits(ast);
		patchStructuredEditInputNormalization(ast, toolVarName);
	}

	const newPrompt = `Edit files using string replace or batch mode.

Usage:
- The file_path parameter must be an absolute path, not relative
- Use Read when helpful to verify exact file context before editing
- Preserve indentation exactly as shown after Read line-number prefixes
- Prefer editing existing files; do not create new files unless explicitly requested
- Only use emojis if the user explicitly requests them
- File encoding (UTF-8/UTF-16) and line endings (LF/CRLF) are preserved automatically

**String replace** (old_string/new_string):
- Best when you can provide unique surrounding context
- Fuzzy matching normalizes smart quotes and trailing whitespace
- Use replace_all:true only for intentional bulk changes
- If old_string is not unique, add surrounding context or use replace_all intentionally
- Empty old_string with non-empty new_string appends content

**Batch edits** (edits[]):
- Multiple string replace operations in one call
- Each entry: { old_string, new_string, replace_all }
- Edits run in the order provided against the cumulative result
- Use for related changes that should be atomic (renames, refactors)
- Prefer one batch call over multiple separate Edit calls

For structural code search or rewrites, use Bash: \`sg -p 'old($A)' -r 'new($A)' src/\` to preview, then add \`-U\` after checking the diff
For non-code text replacement, use Bash: \`sd 'pattern' 'replacement' file.md -p\` to preview, then rerun without \`-p\`
For large multi-file refactoring, use Bash with sg rules or jscodeshift

Examples:
- String replace: \`{ file_path: "/abs/path/file.ts", old_string: "const x = 1;", new_string: "const x = 2;" }\`
- Bulk rename: \`{ file_path: "/abs/path/file.ts", old_string: "oldName", new_string: "newName", replace_all: true }\`
- Append content: \`{ file_path: "/abs/path/file.ts", old_string: "", new_string: "// appended content" }\`
- Batch edits: \`{ file_path: "/abs/path/file.ts", edits: [{ old_string: "foo", new_string: "bar" }, { old_string: "baz", new_string: "qux" }] }\`

Error recovery:
- "old_string matches N locations": add surrounding context or use replace_all:true
- "String not found": re-read file and copy exact text
- If the file changed, re-read and update old_string to match current content
- For large multi-site changes, prefer batch edits or multiple targeted calls`;

	patchApprovalDialog(ast);
	patchReadStateGuards(ast);
	patchReadStateHelper(ast);
	patchWriteReadStateGuards(ast);
	patchIdeDiffConfigGuards(ast);

	traverse(ast, {
		StringLiteral(path: any) {
			if (
				path.node.value.startsWith(
					"Performs exact string replacements in files",
				)
			) {
				path.node.value = newPrompt;
			} else if (path.node.value === "A tool for editing files") {
				path.node.value = "Edit files (string replace, batch edits)";
			} else if (path.node.value === "File has not been read yet") {
				path.node.value = "Read-state validation failed";
			} else if (path.node.value === "File must be read first") {
				path.node.value = "Error editing file";
			}
		},
		TemplateLiteral(path: any) {
			if (
				path.node.quasis.length > 0 &&
				path.node.quasis[0].value.raw.startsWith(
					"Performs exact string replacements in files",
				)
			) {
				path.replaceWith(t.stringLiteral(newPrompt));
			}
		},
	});

	patchEditRenderToolUseMessage(ast);
}

// Append "· batch(N)" / "· replace_all" suffix to the Edit tool-use chip when
// the agent passes edits or replace_all. Stock renders only the file path, so
// batch ops and global replaces are indistinguishable from single targeted edits.
function patchEditRenderToolUseMessage(ast: t.File): void {
	let patched = false;
	const EDITS_BINDING = "_claudeEditEdits";
	const REPLACE_ALL_BINDING = "_claudeEditReplaceAll";

	traverse(ast, {
		FunctionDeclaration(path) {
			if (patched) return;
			const node = path.node;
			const firstParam = node.params[0];
			if (!t.isObjectPattern(firstParam)) return;
			const filePathBinding = getEditRenderFilePathBinding(node, {
				rejectExtendedFields: true,
			});
			if (!filePathBinding) return;

			// Discriminate Edit's renderer from other 2-param {file_path}/{verbose}
			// renderers (e.g. the operation-summary renderer) by the unique early
			// guard `if (!<filePath>) return null;` followed by a second guard that
			// returns "" for the plan-preview path. The second guard may be rewritten
			// to `if (false)` by plan-diff-ui; we check for either shape.

			firstParam.properties.push(
				t.objectProperty(t.identifier("edits"), t.identifier(EDITS_BINDING)),
				t.objectProperty(
					t.identifier("replace_all"),
					t.identifier(REPLACE_ALL_BINDING),
				),
			);

			path.traverse({
				Function(innerPath) {
					innerPath.skip();
				},
				ReturnStatement(retPath) {
					if (!retPath.node.argument) return;
					const arg = retPath.node.argument;
					if (
						t.isCallExpression(arg) &&
						t.isIdentifier(arg.callee, { name: "_editAppendOpts" })
					)
						return;
					retPath.node.argument = t.callExpression(
						t.identifier("_editAppendOpts"),
						[arg],
					);
				},
			});

			const injected = template.statements(
				`
				var _editOptsRaw = [];
				if (Array.isArray(${EDITS_BINDING}) && ${EDITS_BINDING}.length > 0) {
					_editOptsRaw.push("batch(" + ${EDITS_BINDING}.length + ")");
				}
				if (${REPLACE_ALL_BINDING}) {
					_editOptsRaw.push("replace_all");
				}
				var _editOptsSuffix = _editOptsRaw.length > 0
					? " · " + _editOptsRaw.join(", ")
					: "";
				function _editAppendOpts(_editResult) {
					if (!_editOptsSuffix || _editResult == null || _editResult === "") return _editResult;
					if (typeof _editResult === "string") return _editResult + _editOptsSuffix;
					if (_editResult && typeof _editResult === "object" && _editResult.props) {
						var _editChildren = _editResult.props.children;
						var _editArr = _editChildren == null
							? []
							: (Array.isArray(_editChildren) ? _editChildren.slice() : [_editChildren]);
						_editArr.push(_editOptsSuffix);
						return Object.assign({}, _editResult, {
							props: Object.assign({}, _editResult.props, { children: _editArr }),
						});
					}
					return _editResult;
				}
			`,
				{ placeholderPattern: false },
			)();

			node.body.body.unshift(...injected);
			patched = true;
		},
	});
}

interface EditVerifyContext {
	code: string;
	ast: t.File;
	editToolObject: t.ObjectExpression;
	validateMethod: t.ObjectMethod | null;
	callMethod: t.ObjectMethod | null;
	writeToolObject: t.ObjectExpression;
	writeValidateMethod: t.ObjectMethod | null;
	writeCallMethod: t.ObjectMethod | null;
}

function hasEscapedOrLiteralSnippet(code: string, snippet: string): boolean {
	return (
		code.includes(snippet) || code.includes(snippet.replaceAll("'", "\\'"))
	);
}

function verifyEditPromptAndHook(ctx: EditVerifyContext): string | null {
	const { code } = ctx;
	if (!code.includes("EXTENDED_EDIT_PREVIEW_v1")) {
		return "Missing Edit approval preview marker injection";
	}
	if (!code.includes("Edit files using string replace or batch")) {
		return "Missing updated Edit tool description";
	}
	if (!code.includes("Error recovery")) {
		return "Missing error recovery guidance";
	}
	if (!code.includes("Fuzzy matching")) {
		return "Missing fuzzy matching documentation";
	}
	if (!code.includes("Only use emojis if the user explicitly requests")) {
		return "Missing emoji usage constraint";
	}
	if (!code.includes("_claudeApplyExtendedFileEdits")) {
		return "Missing injected edit hook (edit_hook.js not appended to AST)";
	}
	if (!code.includes("_previewResult")) {
		return "Preview block does not use unified normalize+apply pipeline";
	}
	if (
		!hasEscapedOrLiteralSnippet(
			code,
			"sd 'pattern' 'replacement' file.md -p",
		) ||
		!code.includes("structural code search or rewrites") ||
		!code.includes("sg -p")
	) {
		return "Missing Bash alternative guidance for regex/structural transforms";
	}
	return null;
}

function verifyEditValidateAndCallFlow(ctx: EditVerifyContext): string | null {
	const { code, validateMethod } = ctx;
	if (!code.includes("old_string and new_string cannot both be empty.")) {
		return "Missing empty-string no-op guard";
	}

	const validateFlow = inspectValidateExtendedFlow(validateMethod);
	if (!validateFlow.hasCanonicalization) {
		return "validateInput does not canonicalize extended edits before legacy validation";
	}
	if (validateFlow.hasEarlyReturnTrue) {
		return "validateInput still bypasses legacy string-mode checks for extended edit modes";
	}
	// The canonicalization helper preserves notebook rejection by guarding on
	// an .ipynb path suffix and returning the notebook-tool redirect. Requiring
	// both the suffix guard and the redirect message pins the check to that
	// specific return rather than to the two tokens existing anywhere.
	if (
		!code.includes("_claudeEditCanonicalizeInput") ||
		!code.includes('.endsWith(".ipynb")') ||
		!code.includes(
			"File is a Jupyter Notebook. Use the NotebookEdit tool to edit this file.",
		)
	) {
		return "Extended edit canonicalization does not preserve structural notebook edit rejection";
	}
	if (!code.includes("_input.old_string = _canonical.oldString;")) {
		return "Extended call path does not canonicalize old_string from current file";
	}
	if (!code.includes("_input.new_string = _canonical.newString;")) {
		return "Extended validate path does not feed canonicalized new_string into legacy validation";
	}
	if (!code.includes("_input.old_string = L.oldString;")) {
		return "Extended call path does not canonicalize old_string from current file";
	}
	if (!code.includes("_input.new_string = L.newString;")) {
		return "Extended call path does not canonicalize new_string from transformed content";
	}
	if (!code.includes("_args[0] = _input;")) {
		return "Extended call preprocess does not propagate normalized input back into call arguments";
	}
	return null;
}

function verifyEditAliasNormalization(ctx: EditVerifyContext): string | null {
	const { code } = ctx;
	if (!code.includes("oldString !== undefined")) {
		return "Edit alias normalization is missing oldString -> old_string support";
	}
	if (!code.includes("newString !== undefined")) {
		return "Edit alias normalization is missing newString -> new_string support";
	}
	return null;
}

function hasFunctionDeclaration(ast: t.File, name: string): boolean {
	let found = false;
	traverse(ast, {
		FunctionDeclaration(path) {
			if (t.isIdentifier(path.node.id, { name })) {
				found = true;
				path.stop();
			}
		},
	});
	return found;
}

function hasLegacyIdeDiffConfigCall(ast: t.File): boolean {
	let found = false;

	traverse(ast, {
		ConditionalExpression(path) {
			if (found) {
				path.stop();
				return;
			}
			if (!t.isNullLiteral(path.node.alternate)) return;
			if (!t.isCallExpression(path.node.consequent)) return;
			if (!t.isMemberExpression(path.node.consequent.callee)) return;
			if (
				!t.isIdentifier(path.node.consequent.callee.property, {
					name: "getConfig",
				})
			) {
				return;
			}
			if (path.node.consequent.arguments.length !== 1) return;
			const diffSupportRef = path.node.consequent.callee.object;
			if (!t.isIdentifier(diffSupportRef)) return;
			if (!t.isIdentifier(path.node.test, { name: diffSupportRef.name })) {
				return;
			}

			found = true;
			path.stop();
		},
	});

	return found;
}

function hasLegacyIdeDiffConfigGuard(ast: t.File): boolean {
	let found = false;

	traverse(ast, {
		ConditionalExpression(path) {
			if (found) {
				path.stop();
				return;
			}
			if (!t.isNullLiteral(path.node.alternate)) return;
			if (!t.isConditionalExpression(path.node.consequent)) return;

			const nested = path.node.consequent;
			if (!t.isCallExpression(nested.test)) return;
			if (
				!t.isIdentifier(nested.test.callee, {
					name: "_claudeEditHasExtendedFields",
				})
			) {
				return;
			}
			if (nested.test.arguments.length !== 1) return;
			const [guardArg] = nested.test.arguments;
			// Guard arg must wrap DECODE (or be a direct identifier for legacy)
			let hasDecodeWrapper = false;
			if (t.isIdentifier(guardArg)) {
				hasDecodeWrapper = true;
			} else if (
				t.isCallExpression(guardArg) &&
				t.isIdentifier(guardArg.callee, {
					name: EXTENDED_EDIT_TRANSPORT_DECODE,
				}) &&
				guardArg.arguments.length === 1
			) {
				hasDecodeWrapper = true;
			}
			if (!hasDecodeWrapper) return;
			if (!t.isNullLiteral(nested.consequent)) return;
			if (!t.isCallExpression(nested.alternate)) return;
			if (!t.isMemberExpression(nested.alternate.callee)) return;
			if (
				!t.isIdentifier(nested.alternate.callee.property, {
					name: "getConfig",
				})
			) {
				return;
			}
			if (nested.alternate.arguments.length !== 1) return;

			found = true;
			path.stop();
		},
	});

	return found;
}

function hasIdeDiffConfigGuard(ast: t.File): boolean {
	if (hasLegacyIdeDiffConfigGuard(ast)) return true;
	// A present unpatched getConfig ternary is a real miss. Otherwise either our
	// nested guard is in place or upstream has no such routing at all, and
	// extended payloads are not sent to ideDiff.getConfig.
	return !hasLegacyIdeDiffConfigCall(ast);
}

function hasStructuredEditInputNormalization(ast: t.File): {
	prefersParsedEdits: boolean;
	returnsStructuredEdits: boolean;
} {
	let prefersParsedEdits = false;
	let returnsStructuredEdits = false;

	traverse(ast, {
		ConditionalExpression(path) {
			const test = path.node.test;
			if (
				!t.isCallExpression(test) ||
				!t.isIdentifier(test.callee, {
					name: "_claudeEditHasExtendedFields",
				})
			) {
				return;
			}

			if (
				t.isMemberExpression(path.node.consequent) &&
				isMemberPropertyName(path.node.consequent, "edits")
			) {
				prefersParsedEdits = true;
			}
		},
		SpreadElement(path) {
			const arg = path.node.argument;
			if (!t.isConditionalExpression(arg)) return;
			if (
				!t.isCallExpression(arg.test) ||
				!t.isIdentifier(arg.test.callee, {
					name: "_claudeEditHasExtendedFields",
				})
			) {
				return;
			}
			if (
				t.isObjectExpression(arg.consequent) &&
				arg.consequent.properties.some(
					(prop) => t.isObjectProperty(prop) && hasObjectKeyName(prop, "edits"),
				)
			) {
				returnsStructuredEdits = true;
			}
		},
	});

	return { prefersParsedEdits, returnsStructuredEdits };
}

function methodCallsHelper(
	method: t.ObjectMethod | null,
	helperName: string,
): boolean {
	if (!method) return false;
	let found = false;
	const wrapper = t.file(
		t.program([t.functionDeclaration(null, [], method.body)]),
	);
	traverse(wrapper, {
		CallExpression(path) {
			if (t.isIdentifier(path.node.callee, { name: helperName })) {
				found = true;
				path.stop();
			}
		},
	});
	return found;
}

function verifyStructuredEditInputWiring(
	ctx: EditVerifyContext,
): string | null {
	if (!hasFunctionDeclaration(ctx.ast, EXTENDED_EDIT_TRANSPORT_DECODE)) {
		return "Missing extended Edit transport decode helper";
	}
	if (hasFunctionDeclaration(ctx.ast, "_claudeEncodeExtendedEditTransport")) {
		return "Extended Edit still injects transport encode helper";
	}
	if (ctx.code.includes("_claudeGetExtendedEditToolSchema")) {
		return "Extended Edit still injects schema replacement helpers instead of transport-only wiring";
	}
	if (ctx.code.includes("_claudeGetExtendedEditTool")) {
		return "Extended Edit still injects replacement tool helpers instead of transport-only wiring";
	}
	if (
		ctx.code.includes("inputSchema.parse(_claudeEncodeExtendedEditTransport(")
	) {
		return "Extended Edit still rewrites Edit.inputSchema.parse inputs through transport encoding";
	}
	if (!ctx.code.includes(`${EXTENDED_EDIT_TRANSPORT_DECODE}(_input);`)) {
		return "Extended Edit transport does not decode structured payloads before validate/call handling";
	}
	const structuredInput = hasStructuredEditInputNormalization(ctx.ast);
	if (!structuredInput.prefersParsedEdits) {
		return "Extended Edit input normalization does not preserve parsed edits[] payloads";
	}
	if (!structuredInput.returnsStructuredEdits) {
		return "Extended Edit normalized tool input does not retain edits[] for transcript cleanup";
	}
	const autoClassifierMethod = getToolObjectMethod(
		ctx.editToolObject,
		"toAutoClassifierInput",
	);
	if (!methodCallsHelper(autoClassifierMethod, "_claudeEditNormalizeEdits")) {
		return "Edit.toAutoClassifierInput does not handle structured edits";
	}
	return null;
}

function verifyIdeDiffConfigGuard(ctx: EditVerifyContext): string | null {
	if (!hasIdeDiffConfigGuard(ctx.ast)) {
		return "Extended edit confirmation still routes structured payloads through ideDiffSupport.getConfig";
	}
	return null;
}

function verifyReadStateGuards(ctx: EditVerifyContext): string | null {
	const { validateMethod, callMethod } = ctx;

	for (const method of [validateMethod, callMethod]) {
		if (!method) continue;
		const wrapper = t.file(
			t.program([t.functionDeclaration(null, [], method.body)]),
		);
		let unwrappedFound: string | null = null;

		traverse(wrapper, {
			IfStatement(ifPath) {
				const test = ifPath.node.test;

				if (t.isBooleanLiteral(test, { value: false })) return;
				if (isAlreadyWrappedWithExtendedBypass(test)) {
					unwrappedFound = "mtime-extended-only";
					return;
				}

				if (
					t.isBinaryExpression(test, { operator: ">" }) &&
					t.isCallExpression(test.left) &&
					t.isMemberExpression(test.right) &&
					t.isIdentifier(test.right.object) &&
					t.isIdentifier(test.right.property, { name: "timestamp" })
				) {
					unwrappedFound = "mtime";
					return;
				}

				if (
					t.isLogicalExpression(test, { operator: "||" }) &&
					t.isUnaryExpression(test.left, { operator: "!" }) &&
					t.isIdentifier(test.left.argument) &&
					t.isMemberExpression(test.right) &&
					t.isIdentifier(test.right.object, {
						name: test.left.argument.name,
					}) &&
					t.isIdentifier(test.right.property, { name: "isPartialView" })
				) {
					unwrappedFound = "validate-null";
					return;
				}

				if (
					t.isUnaryExpression(test, { operator: "!" }) &&
					t.isIdentifier(test.argument)
				) {
					const varName = test.argument.name;
					if (nodeContainsReadStateThrow(ifPath.node.consequent)) {
						const parent = ifPath.parent;
						if (t.isBlockStatement(parent)) {
							const idx = parent.body.indexOf(ifPath.node);
							if (idx > 0) {
								const prev = parent.body[idx - 1];
								if (t.isVariableDeclaration(prev)) {
									const decl = prev.declarations.find((d: any) =>
										t.isIdentifier(d.id, { name: varName }),
									);
									if (
										decl?.init &&
										t.isCallExpression(decl.init) &&
										t.isMemberExpression(decl.init.callee) &&
										t.isIdentifier(decl.init.callee.property, { name: "get" })
									) {
										unwrappedFound = "call-null";
									}
								}
							}
						}
					}
				}
			},
		});

		if (unwrappedFound) {
			return `Edit read-state guard left unwrapped (${unwrappedFound}) (read-before-write bypass missing)`;
		}
	}

	return null;
}

// Positive landed-mutation check for the relocated call-path read-state helper.
// The helper is identified by its destructured options param (lastRead +
// oldString + replaceAll). It must exist (a loud failure if upstream reshapes
// it, so patchReadStateHelper gets retargeted) and its not-read branch must no
// longer throw (so the call-path read-before-edit bypass is confirmed landed,
// not inferred from the absence of an in-body guard).
function verifyReadStateHelper(ctx: EditVerifyContext): string | null {
	let helperFound = false;
	let stillThrowsOnNotRead = false;
	let stillThrowsOnStaleRead = false;

	traverse(ctx.ast, {
		FunctionDeclaration(path) {
			const [param] = path.node.params;
			if (path.node.params.length !== 1 || !t.isObjectPattern(param)) return;
			const keys = getObjectPatternKeySet(param);
			if (
				!keys.has("lastRead") ||
				!keys.has("oldString") ||
				!keys.has("replaceAll")
			) {
				return;
			}
			const lastReadBinding = getObjectPatternBindingName(param, "lastRead");
			if (!lastReadBinding) return;
			helperFound = true;

			for (const stmt of path.node.body.body) {
				if (!t.isIfStatement(stmt)) continue;
				if (!t.isUnaryExpression(stmt.test, { operator: "!" })) continue;
				if (!t.isIdentifier(stmt.test.argument, { name: lastReadBinding })) {
					continue;
				}
				if (nodeContainsReadStateThrow(stmt.consequent)) {
					stillThrowsOnNotRead = true;
				}
			}

			const body = path.node.body.body;
			for (const [idx] of body.entries()) {
				if (isHelperStaleReadTailThrow(body, idx, lastReadBinding)) {
					stillThrowsOnStaleRead = true;
				}
			}
		},
	});

	if (!helperFound) {
		return "Edit read-state precondition helper not found (expected a top-level options helper destructuring lastRead/oldString/replaceAll); upstream shape changed, retarget patchReadStateHelper";
	}
	if (stillThrowsOnNotRead) {
		return "Edit read-state helper still throws on not-read (call-path read-before-edit bypass did not land)";
	}
	if (stillThrowsOnStaleRead) {
		return "Edit read-state helper still throws on stale read (content-addressed stale-read bypass did not land)";
	}
	return null;
}

function isTimestampComparison(test: t.Node, stateVarName: string): boolean {
	return (
		t.isBinaryExpression(test, { operator: ">" }) &&
		t.isMemberExpression(test.right) &&
		t.isIdentifier(test.right.object, { name: stateVarName }) &&
		t.isIdentifier(test.right.property, { name: "timestamp" })
	);
}

function isStateGuardedTimestampTest(
	test: t.Node,
	stateVarName: string,
): boolean {
	return (
		t.isLogicalExpression(test, { operator: "&&" }) &&
		t.isIdentifier(test.left, { name: stateVarName }) &&
		isTimestampComparison(test.right, stateVarName)
	);
}

function verifyWriteReadStateGuards(ctx: EditVerifyContext): string | null {
	for (const method of [ctx.writeValidateMethod, ctx.writeCallMethod]) {
		if (!method) continue;
		const wrapper = t.file(
			t.program([t.functionDeclaration(null, [], method.body)]),
		);
		let unwrappedFound: string | null = null;

		traverse(wrapper, {
			IfStatement(ifPath) {
				const test = ifPath.node.test;
				if (t.isBooleanLiteral(test, { value: false })) return;

				if (
					t.isLogicalExpression(test, { operator: "||" }) &&
					t.isUnaryExpression(test.left, { operator: "!" }) &&
					t.isIdentifier(test.left.argument) &&
					t.isMemberExpression(test.right) &&
					t.isIdentifier(test.right.object, {
						name: test.left.argument.name,
					}) &&
					t.isIdentifier(test.right.property, { name: "isPartialView" })
				) {
					unwrappedFound = "write-validate-null";
					return;
				}

				if (
					t.isUnaryExpression(test, { operator: "!" }) &&
					t.isIdentifier(test.argument)
				) {
					if (nodeContainsReadStateThrow(ifPath.node.consequent)) {
						unwrappedFound = "write-call-null";
						return;
					}
				}

				const stateVarName =
					t.isLogicalExpression(test, { operator: "&&" }) &&
					t.isIdentifier(test.left)
						? test.left.name
						: t.isBinaryExpression(test, { operator: ">" }) &&
								t.isMemberExpression(test.right) &&
								t.isIdentifier(test.right.object) &&
								t.isIdentifier(test.right.property, { name: "timestamp" })
							? test.right.object.name
							: null;
				if (!stateVarName) return;
				if (isStateGuardedTimestampTest(test, stateVarName)) return;
				if (isTimestampComparison(test, stateVarName)) {
					unwrappedFound = "write-mtime";
				}
			},
		});

		if (unwrappedFound) {
			return `Write read-state guard left unwrapped (${unwrappedFound})`;
		}
	}

	return null;
}

function verifyEditRenderOpts(ctx: EditVerifyContext): string | null {
	let hasRenderFunction = false;
	let hasHelper = false;
	let hasWrappedReturns = false;
	traverse(ctx.ast, {
		FunctionDeclaration(path) {
			if (
				!getEditRenderFilePathBinding(path.node, {
					requireExtendedFields: true,
				})
			) {
				return;
			}
			hasRenderFunction = true;
			if (functionBodyHasDeclaration(path.node, "_editAppendOpts")) {
				hasHelper = true;
			}
			if (hasOnlyWrappedTopLevelReturns(path, "_editAppendOpts")) {
				hasWrappedReturns = true;
			}
		},
	});
	if (!hasRenderFunction)
		return "Missing Edit renderToolUseMessage current-shape function with extended fields";
	if (!hasHelper)
		return "Missing _editAppendOpts helper in Edit renderToolUseMessage";
	if (!hasWrappedReturns)
		return "Edit renderToolUseMessage returns are not all wrapped with _editAppendOpts";
	return null;
}

function verifyEditSchemaBatchEdits(ctx: EditVerifyContext): string | null {
	const { ast } = ctx;
	// The Edit schema lives outside the tool object in the bundle (the tool's
	// inputSchema getter calls a factory). Walk all strictObject calls and
	// pick the one whose object has file_path + old_string + new_string +
	// replace_all keys. This matches what patchEditSchemaForBatchEdits does.
	let schemaObj: t.ObjectExpression | null = null;
	traverse(ast, {
		CallExpression(path) {
			if (!t.isMemberExpression(path.node.callee)) return;
			if (!isMemberPropertyName(path.node.callee, "strictObject")) return;
			const arg0 = path.node.arguments[0];
			if (!t.isObjectExpression(arg0)) return;
			const keys = new Set<string>();
			for (const prop of arg0.properties) {
				if (t.isObjectProperty(prop)) {
					const k = getObjectKeyName(prop.key);
					if (k) keys.add(k);
				}
			}
			if (
				keys.has("file_path") &&
				keys.has("old_string") &&
				keys.has("new_string") &&
				keys.has("replace_all")
			) {
				schemaObj = arg0;
				path.stop();
			}
		},
	});

	if (!schemaObj) {
		return "Edit schema (strictObject with file_path/old_string/new_string/replace_all) not found";
	}
	// Re-bind to defeat TypeScript's let-narrowing-to-never inside the
	// traverse callback's closure scope.
	const schema: t.ObjectExpression = schemaObj;

	const editsProp = schema.properties.find(
		(p): p is t.ObjectProperty =>
			t.isObjectProperty(p) && hasObjectKeyName(p, "edits"),
	);
	if (!editsProp) {
		return "Edit schema missing batch `edits` field";
	}

	// Validate that edits resolves to z.array(z.object({...})).optional()
	const editsValue = editsProp.value;
	if (
		!t.isCallExpression(editsValue) ||
		!t.isMemberExpression(editsValue.callee) ||
		!isMemberPropertyName(editsValue.callee, "optional")
	) {
		return "Edit `edits` field is not wrapped in .optional()";
	}
	const arrayCall = editsValue.callee.object;
	if (
		!t.isCallExpression(arrayCall) ||
		!t.isMemberExpression(arrayCall.callee) ||
		!isMemberPropertyName(arrayCall.callee, "array")
	) {
		return "Edit `edits` field is not z.array(...).optional()";
	}
	const arrayArg = arrayCall.arguments[0];
	if (
		!t.isCallExpression(arrayArg) ||
		!t.isMemberExpression(arrayArg.callee) ||
		!isMemberPropertyName(arrayArg.callee, "object")
	) {
		return "Edit `edits` entries are not z.object({...})";
	}
	const entryObj = arrayArg.arguments[0];
	if (!t.isObjectExpression(entryObj)) {
		return "Edit `edits` entry schema is not an ObjectExpression";
	}
	const entryKeys = new Set<string>();
	for (const prop of entryObj.properties) {
		if (t.isObjectProperty(prop)) {
			const key = getObjectKeyName(prop.key);
			if (key) entryKeys.add(key);
		}
	}
	for (const required of ["old_string", "new_string", "replace_all"]) {
		if (!entryKeys.has(required)) {
			return `Edit edits entry schema missing required key '${required}'`;
		}
	}

	// Confirm old_string/new_string in the top-level schema are wrapped in .optional()
	// so that batch-only payloads pass safeParse.
	for (const fieldName of ["old_string", "new_string"]) {
		const fieldProp = schema.properties.find(
			(p): p is t.ObjectProperty =>
				t.isObjectProperty(p) && hasObjectKeyName(p, fieldName),
		);
		if (!fieldProp) continue;
		const value = fieldProp.value;
		if (!t.isCallExpression(value)) continue;
		// Walk the chain looking for .optional()
		let chain: t.Node | null = value;
		let foundOptional = false;
		while (chain) {
			if (
				t.isCallExpression(chain) &&
				t.isMemberExpression(chain.callee) &&
				isMemberPropertyName(chain.callee, "optional")
			) {
				foundOptional = true;
				break;
			}
			if (t.isCallExpression(chain) && t.isMemberExpression(chain.callee)) {
				chain = chain.callee.object as t.Node;
				continue;
			}
			break;
		}
		if (!foundOptional) {
			return `Edit schema field '${fieldName}' is not wrapped in .optional() (batch payloads would fail safeParse)`;
		}
	}

	return null;
}

function verifyEditInputsEquivalent(ctx: EditVerifyContext): string | null {
	const { code, editToolObject } = ctx;
	const eqMethod = editToolObject.properties.find(
		(p): p is t.ObjectMethod =>
			t.isObjectMethod(p) && getObjectKeyName(p.key) === "inputsEquivalent",
	);
	if (!eqMethod) {
		return "Edit tool object missing inputsEquivalent method (cannot verify structured-edit equality)";
	}

	// The mutator unshifts a block that calls _claudeEditInputsEquivalent on
	// decoded inputs when either side carries extended fields. Confirm both
	// the decode and the equality helper are referenced in the method body.
	let usesDecode = false;
	let usesHasExtended = false;
	let returnsEqualityHelper = false;
	traverse(
		eqMethod.body,
		{
			CallExpression(path) {
				const callee = path.node.callee;
				if (t.isIdentifier(callee, { name: EXTENDED_EDIT_TRANSPORT_DECODE })) {
					usesDecode = true;
				}
				if (t.isIdentifier(callee, { name: "_claudeEditHasExtendedFields" })) {
					usesHasExtended = true;
				}
				if (t.isIdentifier(callee, { name: "_claudeEditInputsEquivalent" })) {
					// Ensure this call is in a return position inside the gated branch.
					let cursor: any = path.parentPath;
					while (cursor) {
						if (cursor.isReturnStatement()) {
							returnsEqualityHelper = true;
							break;
						}
						cursor = cursor.parentPath;
					}
				}
			},
			noScope: true,
		},
		undefined,
		undefined,
	);

	if (!usesDecode) {
		return "inputsEquivalent does not decode extended edit transport before comparing";
	}
	if (!usesHasExtended) {
		return "inputsEquivalent does not gate on _claudeEditHasExtendedFields";
	}
	if (!returnsEqualityHelper) {
		return "inputsEquivalent does not return _claudeEditInputsEquivalent for extended edits";
	}
	if (!code.includes("_claudeEditInputsEquivalent")) {
		return "Bundle missing _claudeEditInputsEquivalent transport helper";
	}
	return null;
}

export const editTool: Patch = {
	tag: "edit-extended",

	astPasses: (ast) => [
		{
			pass: "mutate",
			visitor: {
				Program: {
					exit() {
						runEditToolPatch(ast);
					},
				},
			},
		},
	],

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) {
			return "Unable to parse AST during edit-extended verification";
		}
		const editToolPath = findNamedToolObjectPath(verifyAst, "Edit");
		if (!editToolPath) {
			return "Unable to resolve Edit tool object for verification";
		}
		const writeToolPath = findNamedToolObjectPath(verifyAst, "Write");
		if (!writeToolPath) {
			return "Unable to resolve Write tool object for verification";
		}
		const context: EditVerifyContext = {
			code,
			ast: verifyAst,
			editToolObject: editToolPath.node,
			validateMethod: getToolObjectMethod(editToolPath.node, "validateInput"),
			callMethod: getToolObjectMethod(editToolPath.node, "call"),
			writeToolObject: writeToolPath.node,
			writeValidateMethod: getToolObjectMethod(
				writeToolPath.node,
				"validateInput",
			),
			writeCallMethod: getToolObjectMethod(writeToolPath.node, "call"),
		};
		const validators = [
			verifyEditPromptAndHook,
			verifyStructuredEditInputWiring,
			verifyEditValidateAndCallFlow,
			verifyEditAliasNormalization,
			verifyIdeDiffConfigGuard,
			verifyReadStateGuards,
			verifyReadStateHelper,
			verifyWriteReadStateGuards,
			verifyEditRenderOpts,
			verifyEditSchemaBatchEdits,
			verifyEditInputsEquivalent,
		];
		for (const validator of validators) {
			const result = validator(context);
			if (result) return result;
		}
		return true;
	},
};
