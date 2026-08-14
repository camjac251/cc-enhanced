import * as t from "@babel/types";
import { template, traverse } from "../babel.js";
import { getObjectPropertyByName, objectPatternHasKey } from "./ast-helpers.js";
import {
	getObjectPatternBindingName,
	getObjectPatternKeySet,
	visitNodeValues,
} from "./edit-extended-shapes.js";

const EDIT_RENDER_EXCLUDED_KEYS = [
	"range",
	"show_whitespace",
	"pages",
	"offset",
	"limit",
];

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

type EditResultCollapseState = "stock" | "patched" | "other";

interface EditResultCollapseSite {
	property: t.ObjectProperty;
	state: EditResultCollapseState;
}

function isEditResultCollapsePredicate(
	node: t.Expression,
	filePathBinding: string,
): boolean {
	if (t.isLogicalExpression(node, { operator: "||" })) {
		return (
			isEditResultCollapsePredicate(node.left, filePathBinding) &&
			isEditResultCollapsePredicate(node.right, filePathBinding)
		);
	}
	return (
		t.isCallExpression(node) &&
		node.arguments.length === 1 &&
		t.isIdentifier(node.arguments[0], { name: filePathBinding })
	);
}

function getEditResultCollapseSite(
	node: t.FunctionDeclaration,
): EditResultCollapseSite | null {
	if (node.params.length !== 3) return null;
	const inputParam = node.params[0];
	const optionsParam = node.params[2];
	if (!t.isObjectPattern(inputParam) || !t.isObjectPattern(optionsParam)) {
		return null;
	}

	const inputKeys = getObjectPatternKeySet(inputParam);
	if (
		!inputKeys.has("filePath") ||
		!inputKeys.has("structuredPatch") ||
		!inputKeys.has("originalFile") ||
		inputKeys.has("content") ||
		inputKeys.has("type") ||
		!objectPatternHasKey(optionsParam, "style") ||
		!objectPatternHasKey(optionsParam, "verbose")
	) {
		return null;
	}

	const filePathBinding = getObjectPatternBindingName(inputParam, "filePath");
	const patchBinding = getObjectPatternBindingName(
		inputParam,
		"structuredPatch",
	);
	if (!filePathBinding || !patchBinding) return null;

	const sites: EditResultCollapseSite[] = [];
	visitNodeValues(node.body, (child) => {
		if (!t.isObjectExpression(child)) return false;
		const filePath = getObjectPropertyByName(child, "filePath");
		const structuredPatch = getObjectPropertyByName(child, "structuredPatch");
		const previewHint = getObjectPropertyByName(child, "previewHint");
		const collapsed = getObjectPropertyByName(child, "collapsed");
		const stockPreviewTestName =
			previewHint &&
			t.isConditionalExpression(previewHint.value) &&
			t.isIdentifier(previewHint.value.test)
				? previewHint.value.test.name
				: null;
		const stockPreviewHint =
			stockPreviewTestName !== null &&
			t.isConditionalExpression(previewHint?.value) &&
			t.isStringLiteral(previewHint.value.consequent, {
				value: "/plan to preview",
			});
		const patchedPreviewHint =
			previewHint &&
			((t.isUnaryExpression(previewHint.value, { operator: "void" }) &&
				t.isNumericLiteral(previewHint.value.argument, { value: 0 })) ||
				t.isIdentifier(previewHint.value, { name: "undefined" }));
		if (
			!filePath ||
			!structuredPatch ||
			!previewHint ||
			!collapsed ||
			!t.isIdentifier(filePath.value, { name: filePathBinding }) ||
			!t.isIdentifier(structuredPatch.value, { name: patchBinding }) ||
			(!stockPreviewHint && !patchedPreviewHint)
		) {
			return false;
		}

		let state: EditResultCollapseState = "other";
		if (t.isBooleanLiteral(collapsed.value, { value: false })) {
			state = "patched";
		} else if (
			t.isLogicalExpression(collapsed.value, { operator: "&&" }) &&
			t.isUnaryExpression(collapsed.value.left, { operator: "!" }) &&
			t.isIdentifier(collapsed.value.left.argument) &&
			(!stockPreviewHint ||
				collapsed.value.left.argument.name === stockPreviewTestName) &&
			isEditResultCollapsePredicate(collapsed.value.right, filePathBinding)
		) {
			state = "stock";
		}
		sites.push({ property: collapsed, state });
		return false;
	});

	return sites.length === 1 ? sites[0] : null;
}

export function patchEditResultCollapse(ast: t.File): void {
	traverse(ast, {
		FunctionDeclaration(path) {
			const site = getEditResultCollapseSite(path.node);
			if (site?.state !== "stock") return;
			site.property.value = t.booleanLiteral(false);
		},
	});
}

export function patchEditRenderToolUseMessage(ast: t.File): void {
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

interface RenderingVerifyContext {
	ast: t.File;
}

export function verifyEditRenderOpts(
	ctx: RenderingVerifyContext,
): string | null {
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

export function verifyEditResultCollapse(
	ctx: RenderingVerifyContext,
): string | null {
	const sites: EditResultCollapseSite[] = [];
	traverse(ctx.ast, {
		FunctionDeclaration(path) {
			const site = getEditResultCollapseSite(path.node);
			if (site) sites.push(site);
		},
	});
	if (sites.length !== 1) {
		return `Edit result renderer is ambiguous or missing (${sites.length} sites found)`;
	}
	if (sites[0].state !== "patched") {
		return "Scratchpad Edit result diffs are still collapsed";
	}
	return null;
}
