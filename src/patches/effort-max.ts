import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch } from "../types.js";
import {
	getObjectKeyName,
	getVerifyAst,
	isFalseLike,
	isTrueLike,
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

function isLowerCasedParam(
	node: t.Node | null | undefined,
	paramName: string,
): boolean {
	if (!node || !t.isCallExpression(node)) return false;
	if (
		!t.isMemberExpression(node.callee) ||
		!t.isIdentifier(node.callee.object, { name: paramName }) ||
		!t.isIdentifier(node.callee.property, { name: "toLowerCase" })
	) {
		return false;
	}
	return node.arguments.length === 0;
}

function isStringIncludesOnLowerCasedParam(
	node: t.Node | null | undefined,
	paramName: string,
	value: string,
): boolean {
	if (!node || !t.isCallExpression(node)) return false;
	if (
		!t.isMemberExpression(node.callee) ||
		!t.isIdentifier(node.callee.property, { name: "includes" }) ||
		node.arguments.length !== 1 ||
		!t.isStringLiteral(node.arguments[0], { value })
	) {
		return false;
	}
	return isLowerCasedParam(node.callee.object, paramName);
}

function isLegacyMaxCapabilityGate(
	path: traverse.NodePath<t.Function>,
): boolean {
	const param = getSingleIdentifierParam(path);
	if (!param) return false;
	const returned = getReturnedExpression(path);
	if (isStringIncludesOnLowerCasedParam(returned, param.name, "opus-4-6")) {
		return true;
	}

	const body = path.node.body;
	if (!t.isBlockStatement(body)) return false;
	// 2.1.84+ prepends a server flag check: let $ = Ms(H, "max_effort"); if ($ !== void 0) return $;
	// Strip optional leading statements to find the 2-statement opus guard + fallback.
	const stmts = body.body;
	if (stmts.length < 2 || stmts.length > 4) return false;
	const [guard, fallback] = stmts.slice(-2);
	if (!t.isIfStatement(guard) || !t.isReturnStatement(fallback)) return false;
	if (!isFalseLike(fallback.argument)) return false;
	if (
		!t.isReturnStatement(guard.consequent) ||
		(guard.alternate !== null && !isFalseLike(guard.alternate)) ||
		!isTrueLike(guard.consequent.argument)
	) {
		return false;
	}
	return isStringIncludesOnLowerCasedParam(guard.test, param.name, "opus-4-6");
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

function makeMaxEffortOption(): t.ObjectExpression {
	return t.objectExpression([
		t.objectProperty(t.identifier("label"), t.stringLiteral("Max")),
		t.objectProperty(t.identifier("value"), t.stringLiteral("max")),
	]);
}

function isUltrathinkLevelObject(node: t.ObjectExpression): boolean {
	let hasType = false;
	let hasLevel = false;
	for (const prop of node.properties) {
		if (!t.isObjectProperty(prop)) continue;
		if (
			getObjectKeyName(prop.key) === "type" &&
			t.isStringLiteral(prop.value, { value: "ultrathink_effort" })
		) {
			hasType = true;
		}
		if (
			getObjectKeyName(prop.key) === "level" &&
			t.isStringLiteral(prop.value, { value: "high" })
		) {
			hasLevel = true;
		}
	}
	return hasType && hasLevel;
}

function isPatchedUltrathinkLevelObject(node: t.ObjectExpression): boolean {
	let hasType = false;
	let hasLevel = false;
	for (const prop of node.properties) {
		if (!t.isObjectProperty(prop)) continue;
		if (
			getObjectKeyName(prop.key) === "type" &&
			t.isStringLiteral(prop.value, { value: "ultrathink_effort" })
		) {
			hasType = true;
		}
		if (
			getObjectKeyName(prop.key) === "level" &&
			t.isStringLiteral(prop.value, { value: "max" })
		) {
			hasLevel = true;
		}
	}
	return hasType && hasLevel;
}

function createEffortMaxMutator(): traverse.Visitor {
	let patchedMaxCapabilityGate = 0;
	let patchedPicker = 0;
	let patchedUltrathinkLevel = 0;
	let patchedNotification = 0;

	function patchFunction(path: traverse.NodePath<t.Function>): void {
		if (!isLegacyMaxCapabilityGate(path)) return;

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

		ArrayExpression(path) {
			if (!isEffortPickerArray(path)) return;
			if (
				path.node.elements.some((element) =>
					hasEffortOptionValue(element, "max"),
				)
			) {
				return;
			}
			path.node.elements.splice(1, 0, makeMaxEffortOption());
			patchedPicker += 1;
		},

		ObjectExpression(path) {
			if (isUltrathinkLevelObject(path.node)) {
				const levelProp = getObjectProp(path.node, "level");
				if (levelProp) {
					levelProp.value = t.stringLiteral("max");
					patchedUltrathinkLevel += 1;
				}
				return;
			}

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
				if (patchedPicker === 0) {
					console.warn("effort-max: Could not find effort picker array");
				}
				if (patchedUltrathinkLevel === 0) {
					console.warn(
						"effort-max: Could not find ultrathink effort level object",
					);
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
		let hasUnpatchedUltrathinkLevel = false;
		let hasPatchedUltrathinkLevel = false;
		let hasHighUltrathinkNotification = false;
		let hasMaxUltrathinkNotification = false;

		traverse.default(verifyAst, {
			Function(path) {
				if (isLegacyMaxCapabilityGate(path)) {
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

			ObjectExpression(path) {
				if (isUltrathinkLevelObject(path.node)) {
					hasUnpatchedUltrathinkLevel = true;
				}
				if (isPatchedUltrathinkLevelObject(path.node)) {
					hasPatchedUltrathinkLevel = true;
				}
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
			return 'Model max-capability gate still restricts "max" to Opus 4.6';
		}
		if (!hasPatchedMaxCapabilityGate) {
			return "Did not find patched max-capability gate";
		}
		if (!hasPatchedPicker) {
			return 'Effort picker does not expose "max"';
		}
		if (hasUnpatchedUltrathinkLevel) {
			return 'Ultrathink still sets effort level to "high"';
		}
		if (!hasPatchedUltrathinkLevel) {
			return 'Did not find patched ultrathink effort level "max"';
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
