import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch } from "../types.js";
import {
	getObjectKeyName,
	getVerifyAst,
	isFalseLike,
} from "./ast-helpers.js";

const MAX_NOTIFICATION_TEXT = "Effort set to max for this turn";
const HIGH_NOTIFICATION_TEXT = "Effort set to high for this turn";

function objectValueValue(
	prop: t.ObjectProperty | t.ObjectMethod | t.SpreadElement,
): string | null {
	if (!t.isObjectProperty(prop)) return null;
	if (getObjectKeyName(prop.key) !== "value") return null;
	return t.isStringLiteral(prop.value) ? prop.value.value : null;
}

function getObjectProp(
	objectExpr: t.ObjectExpression,
	keyName: string,
): t.ObjectProperty | null {
	for (const prop of objectExpr.properties) {
		if (t.isObjectProperty(prop) && getObjectKeyName(prop.key) === keyName) {
			return prop;
		}
	}
	return null;
}

function getSingleIdentifierParam(
	path: traverse.NodePath<t.Function>,
): t.Identifier | null {
	return path.node.params.length === 1 && t.isIdentifier(path.node.params[0])
		? path.node.params[0]
		: null;
}

function getReturnedExpression(
	path: traverse.NodePath<t.Function>,
): t.Expression | null {
	const body = path.node.body;
	if (t.isExpression(body)) return body;
	if (body.body.length !== 1) return null;
	const [statement] = body.body;
	return t.isReturnStatement(statement) ? (statement.argument ?? null) : null;
}

function isMaxEffortLookupInit(
	node: t.Node | null | undefined,
	paramName: string,
): boolean {
	return (
		!!node &&
		t.isCallExpression(node) &&
		node.arguments.length === 2 &&
		isSameParameterReference(node.arguments[0], paramName) &&
		t.isStringLiteral(node.arguments[1], { value: "max_effort" })
	);
}

function isUndefinedOverrideReturn(
	node: t.Node | null | undefined,
	overrideName: string,
): boolean {
	return (
		!!node &&
		t.isIfStatement(node) &&
		t.isBinaryExpression(node.test, { operator: "!==" }) &&
		isSameParameterReference(node.test.left, overrideName) &&
		isVoidZero(node.test.right) &&
		t.isReturnStatement(node.consequent) &&
		isSameParameterReference(node.consequent.argument, overrideName) &&
		node.alternate === null
	);
}

function isDirectHaikuReject(
	node: t.Node | null | undefined,
	paramName: string,
): boolean {
	if (!node || !t.isIfStatement(node) || node.alternate !== null) return false;
	const test = node.test;
	if (
		!t.isCallExpression(test) ||
		!t.isMemberExpression(test.callee) ||
		!t.isIdentifier(test.callee.property, { name: "includes" }) ||
		test.arguments.length !== 1 ||
		!t.isStringLiteral(test.arguments[0], { value: "haiku" })
	) {
		return false;
	}
	const includesObject = test.callee.object;
	if (
		!t.isCallExpression(includesObject) ||
		!t.isMemberExpression(includesObject.callee) ||
		!t.isIdentifier(includesObject.callee.object, { name: paramName }) ||
		!t.isIdentifier(includesObject.callee.property, { name: "toLowerCase" }) ||
		includesObject.arguments.length !== 0
	) {
		return false;
	}
	return t.isReturnStatement(node.consequent) && isFalseLike(node.consequent.argument);
}

function isNormalizedDenylistReturn(
	node: t.Node | null | undefined,
	paramName: string,
): boolean {
	if (!node || !t.isReturnStatement(node)) return false;
	const argument = node.argument;
	if (
		!argument ||
		!t.isUnaryExpression(argument, { operator: "!" }) ||
		!t.isCallExpression(argument.argument) ||
		!t.isMemberExpression(argument.argument.callee) ||
		!t.isIdentifier(argument.argument.callee.property, { name: "has" }) ||
		argument.argument.arguments.length !== 1
	) {
		return false;
	}
	const [normalizedModel] = argument.argument.arguments;
	return (
		t.isCallExpression(normalizedModel) &&
		normalizedModel.arguments.length === 1 &&
		isSameParameterReference(normalizedModel.arguments[0], paramName)
	);
}

function isMaxCapabilityGate(
	path: traverse.NodePath<t.Function>,
): boolean {
	const param = getSingleIdentifierParam(path);
	if (!param) return false;
	const body = path.node.body;
	if (!t.isBlockStatement(body)) return false;
	const stmts = body.body;
	if (stmts.length !== 4) return false;
	const [overrideInit, overrideGuard, haikuGuard, fallback] = stmts;
	if (!t.isVariableDeclaration(overrideInit)) return false;
	if (overrideInit.declarations.length !== 1) return false;
	const [overrideDecl] = overrideInit.declarations;
	if (!t.isIdentifier(overrideDecl.id)) return false;
	return (
		isMaxEffortLookupInit(overrideDecl.init, param.name) &&
		isUndefinedOverrideReturn(overrideGuard, overrideDecl.id.name) &&
		isDirectHaikuReject(haikuGuard, param.name) &&
		isNormalizedDenylistReturn(fallback, param.name)
	);
}

function isPatchedMaxCapabilityGate(
	path: traverse.NodePath<t.Function>,
): boolean {
	const returned = getReturnedExpression(path);
	return !!returned && t.isBooleanLiteral(returned, { value: true });
}

function hasEffortOptionValue(
	node: t.Node | null | undefined,
	value: string,
): node is t.ObjectExpression {
	if (!node || !t.isObjectExpression(node)) return false;
	return node.properties.some((prop) => objectValueValue(prop) === value);
}

function isEffortPickerArray(
	path: traverse.NodePath<t.ArrayExpression>,
): boolean {
	const values = new Set<string>();
	for (const element of path.node.elements) {
		if (!element || !t.isObjectExpression(element)) continue;
		for (const prop of element.properties) {
			const value = objectValueValue(prop);
			if (value) values.add(value);
		}
	}
	return values.has("low") && values.has("medium") && values.has("high");
}

function isSameParameterReference(
	node: t.Node | null | undefined,
	paramName: string,
): boolean {
	return !!node && t.isIdentifier(node, { name: paramName });
}

function isVoidZero(node: t.Node | null | undefined): boolean {
	return (
		!!node &&
		t.isUnaryExpression(node, { operator: "void" }) &&
		t.isNumericLiteral(node.argument, { value: 0 })
	);
}

function createEffortMaxMutator(): traverse.Visitor {
	let patchedMaxCapabilityGate = 0;
	let patchedNotification = 0;

	function patchFunction(path: traverse.NodePath<t.Function>): void {
		if (!isMaxCapabilityGate(path)) return;

		path
			.get("body")
			.replaceWith(
				t.blockStatement([t.returnStatement(t.booleanLiteral(true))]),
			);
		patchedMaxCapabilityGate += 1;
	}

	return {
		FunctionDeclaration(path) {
			patchFunction(path);
		},

		FunctionExpression(path) {
			patchFunction(path);
		},

		ArrowFunctionExpression(path) {
			patchFunction(path);
		},

		ObjectExpression(path) {
			const keyProp = getObjectProp(path.node, "key");
			const textProp = getObjectProp(path.node, "text");
			if (
				keyProp &&
				textProp &&
				t.isStringLiteral(keyProp.value, { value: "ultrathink-active" }) &&
				t.isStringLiteral(textProp.value, { value: HIGH_NOTIFICATION_TEXT })
			) {
				textProp.value = t.stringLiteral(MAX_NOTIFICATION_TEXT);
				patchedNotification += 1;
			}
		},

		Program: {
			exit() {
				if (patchedMaxCapabilityGate === 0) {
					console.warn("effort-max: Could not find max-capability gate");
				}
				if (patchedNotification === 0) {
					console.warn(
						"effort-max: Could not find ultrathink notification text",
					);
				}
			},
		},
	};
}

export const effortMax: Patch = {
	tag: "effort-max",

	astPasses: () => [
		{
			pass: "mutate",
			visitor: createEffortMaxMutator(),
		},
	],

	verify: (_code, ast) => {
		const verifyAst = getVerifyAst(_code, ast);
		if (!verifyAst) return "Unable to parse AST during verification";

		let hasLegacyMaxCapabilityGate = false;
		let hasPatchedMaxCapabilityGate = false;
		let hasPatchedPicker = false;
		let hasHighUltrathinkNotification = false;
		let hasMaxUltrathinkNotification = false;

		traverse.default(verifyAst, {
			Function(path) {
				if (isMaxCapabilityGate(path)) {
					hasLegacyMaxCapabilityGate = true;
				}
				if (isPatchedMaxCapabilityGate(path)) {
					hasPatchedMaxCapabilityGate = true;
				}
			},

			ArrayExpression(path) {
				if (!isEffortPickerArray(path)) return;
				hasPatchedPicker = path.node.elements.some((element) =>
					hasEffortOptionValue(element, "max"),
				);
			},

			StringLiteral(path) {
				if (path.node.value === HIGH_NOTIFICATION_TEXT) {
					hasHighUltrathinkNotification = true;
				}
				if (path.node.value === MAX_NOTIFICATION_TEXT) {
					hasMaxUltrathinkNotification = true;
				}
			},
		});

		if (hasLegacyMaxCapabilityGate) {
			return 'Model max-capability gate still restricts "max"';
		}
		if (!hasPatchedMaxCapabilityGate) {
			return "Did not find patched max-capability gate";
		}
		if (!hasPatchedPicker) {
			return 'Effort picker does not expose "max"';
		}
		if (hasHighUltrathinkNotification) {
			return 'Ultrathink notification still says "high"';
		}
		if (!hasMaxUltrathinkNotification) {
			return 'Did not find "Effort set to max for this turn" notification';
		}
		return true;
	},
};
