import * as t from "@babel/types";
import { type NodePath, traverse, type Visitor } from "../babel.js";
import type { Patch } from "../types.js";
import { getObjectKeyName, getVerifyAst } from "./ast-helpers.js";

const MAX_NOTIFICATION_TEXT = "Effort set to max for this turn";

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
	path: NodePath<t.Function>,
): t.Identifier | null {
	return path.node.params.length === 1 && t.isIdentifier(path.node.params[0])
		? path.node.params[0]
		: null;
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

function isMaxCapabilityGate(path: NodePath<t.Function>): boolean {
	const param = getSingleIdentifierParam(path);
	if (!param) return false;
	const body = path.node.body;
	if (!t.isBlockStatement(body)) return false;
	const stmts = body.body;
	if (stmts.length < 2) return false;
	const [overrideInit, overrideGuard] = stmts;
	if (!t.isVariableDeclaration(overrideInit)) return false;
	if (overrideInit.declarations.length !== 1) return false;
	const [overrideDecl] = overrideInit.declarations;
	if (!t.isIdentifier(overrideDecl.id)) return false;
	return (
		isMaxEffortLookupInit(overrideDecl.init, param.name) &&
		isUndefinedOverrideReturn(overrideGuard, overrideDecl.id.name)
	);
}

function isPatchedMaxCapabilityGate(path: NodePath<t.Function>): boolean {
	// Tighten beyond "function returns true" by requiring the exact post-
	// patch shape: a single-identifier-param function whose body is exactly
	// one statement (`return true;`). Many trivial `() => true` functions
	// exist in the bundle; this narrows acceptance to the patch's emitted
	// shape and preserves the parameter signature from the legacy gate.
	const param = getSingleIdentifierParam(path);
	if (!param) return false;
	const body = path.node.body;
	if (!t.isBlockStatement(body)) return false;
	if (body.body.length !== 1) return false;
	const stmt = body.body[0];
	if (!t.isReturnStatement(stmt)) return false;
	return !!stmt.argument && t.isBooleanLiteral(stmt.argument, { value: true });
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

function createEffortMaxMutator(): Visitor {
	let patchedMaxCapabilityGate = 0;
	let patchedNotification = 0;

	function patchFunction(path: NodePath<t.Function>): void {
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
				!keyProp ||
				!textProp ||
				!t.isStringLiteral(keyProp.value, { value: "ultrathink-active" }) ||
				!t.isStringLiteral(textProp.value)
			) {
				return;
			}
			if (textProp.value.value === MAX_NOTIFICATION_TEXT) return;
			textProp.value = t.stringLiteral(MAX_NOTIFICATION_TEXT);
			patchedNotification += 1;
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
		let patchedMaxCapabilityGateCount = 0;
		let hasMaxUltrathinkNotification = false;

		traverse(verifyAst, {
			Function(path) {
				if (isMaxCapabilityGate(path)) {
					hasLegacyMaxCapabilityGate = true;
				}
				if (isPatchedMaxCapabilityGate(path)) {
					patchedMaxCapabilityGateCount++;
				}
			},

			ObjectExpression(path) {
				const keyProp = getObjectProp(path.node, "key");
				const textProp = getObjectProp(path.node, "text");
				if (
					keyProp &&
					textProp &&
					t.isStringLiteral(keyProp.value, { value: "ultrathink-active" }) &&
					t.isStringLiteral(textProp.value, { value: MAX_NOTIFICATION_TEXT })
				) {
					hasMaxUltrathinkNotification = true;
				}
			},
		});

		if (hasLegacyMaxCapabilityGate) {
			return 'Model max-capability gate still restricts "max"';
		}
		if (patchedMaxCapabilityGateCount === 0) {
			return "Did not find patched max-capability gate";
		}
		// The audit flagged the previous picker invariant (requires "max" in
		// the effort-picker array) as orthogonal to this patch: the mutator
		// never adds it. If upstream stops shipping that option, the patch
		// keeps its actual contract (gate returns true, ultrathink text
		// changes), so verify shouldn't fail on an unrelated upstream change.
		if (!hasMaxUltrathinkNotification) {
			return 'Did not find "Effort set to max for this turn" notification';
		}
		return true;
	},
};
