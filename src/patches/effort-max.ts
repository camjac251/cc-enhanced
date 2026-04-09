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

function isStringIncludesOnIdentifier(
	node: t.Node | null | undefined,
	identifierName: string,
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
	return t.isIdentifier(node.callee.object, { name: identifierName });
}

function collectStringIncludesOnIdentifier(
	node: t.Node | null | undefined,
	identifierName: string,
): string[] | null {
	if (!node) return null;
	if (t.isLogicalExpression(node, { operator: "||" })) {
		const left = collectStringIncludesOnIdentifier(node.left, identifierName);
		const right = collectStringIncludesOnIdentifier(node.right, identifierName);
		if (!left || !right) return null;
		return [...left, ...right];
	}
	if (!t.isCallExpression(node)) return null;
	if (
		!t.isMemberExpression(node.callee) ||
		!t.isIdentifier(node.callee.property, { name: "includes" }) ||
		!t.isIdentifier(node.callee.object, { name: identifierName }) ||
		node.arguments.length !== 1 ||
		!t.isStringLiteral(node.arguments[0])
	) {
		return null;
	}
	return [node.arguments[0].value];
}

function isModelFamilyGate(
	node: t.Node | null | undefined,
	identifierName: string,
): boolean {
	const includes = collectStringIncludesOnIdentifier(node, identifierName);
	if (!includes || includes.length !== 3) return false;
	const values = new Set(includes);
	return (
		values.size === 3 &&
		values.has("haiku") &&
		values.has("sonnet") &&
		values.has("opus")
	);
}

function isNamedMember(
	node: t.Node | null | undefined,
	objectName: string,
	propertyName: string,
): boolean {
	return (
		!!node &&
		t.isMemberExpression(node) &&
		t.isIdentifier(node.object, { name: objectName }) &&
		t.isIdentifier(node.property, { name: propertyName })
	);
}

function isStringMemberComparison(
	node: t.Node | null | undefined,
	objectName: string,
	propertyName: string,
	value: string,
): boolean {
	return (
		!!node &&
		t.isBinaryExpression(node, { operator: "===" }) &&
		isNamedMember(node.left, objectName, propertyName) &&
		t.isStringLiteral(node.right, { value })
	);
}

function isNumericMemberComparison(
	node: t.Node | null | undefined,
	objectName: string,
	propertyName: string,
	operator: ">" | ">=" | "===",
	value: number,
): boolean {
	return (
		!!node &&
		t.isBinaryExpression(node, { operator }) &&
		isNamedMember(node.left, objectName, propertyName) &&
		t.isNumericLiteral(node.right, { value })
	);
}

function isParsedVersionGuard(
	node: t.Node | null | undefined,
	versionName: string,
): boolean {
	return (
		!!node &&
		t.isLogicalExpression(node, { operator: "||" }) &&
		t.isUnaryExpression(node.left, { operator: "!" }) &&
		t.isIdentifier(node.left.argument, { name: versionName }) &&
		isStringMemberComparison(node.right, versionName, "family", "haiku")
	);
}

function isSupportedVersionThreshold(
	node: t.Node | null | undefined,
	versionName: string,
): boolean {
	return (
		!!node &&
		t.isLogicalExpression(node, { operator: "||" }) &&
		isNumericMemberComparison(node.left, versionName, "major", ">", 4) &&
		t.isLogicalExpression(node.right, { operator: "&&" }) &&
		isNumericMemberComparison(node.right.left, versionName, "major", "===", 4) &&
		isNumericMemberComparison(node.right.right, versionName, "minor", ">=", 6)
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
	if (stmts.length !== 5) return false;
	const [overrideInit, overrideGuard, lowerCaseInit, familyGuard, fallback] = stmts;
	if (!t.isVariableDeclaration(overrideInit)) return false;
	if (overrideInit.declarations.length !== 1) return false;
	const [overrideDecl] = overrideInit.declarations;
	if (!t.isIdentifier(overrideDecl.id)) return false;
	if (!t.isCallExpression(overrideDecl.init)) return false;
	if (
		overrideDecl.init.arguments.length !== 2 ||
		!isSameParameterReference(overrideDecl.init.arguments[0], param.name) ||
		!t.isStringLiteral(overrideDecl.init.arguments[1], {
			value: "max_effort",
		})
	) {
		return false;
	}
	if (!t.isIfStatement(overrideGuard) || !t.isVariableDeclaration(lowerCaseInit)) {
		return false;
	}
	if (lowerCaseInit.declarations.length !== 1) return false;
	const [lowerCaseDecl] = lowerCaseInit.declarations;
	if (!t.isIdentifier(lowerCaseDecl.id)) return false;
	if (!isLowerCasedParam(lowerCaseDecl.init, param.name)) return false;
	if (!t.isIfStatement(familyGuard)) return false;
	if (!t.isReturnStatement(fallback)) return false;
	if (
		!t.isBinaryExpression(overrideGuard.test, { operator: "!==" }) ||
		!isSameParameterReference(overrideGuard.test.left, overrideDecl.id.name) ||
		!isVoidZero(overrideGuard.test.right) ||
		!t.isReturnStatement(overrideGuard.consequent) ||
		overrideGuard.alternate !== null
	) {
		return false;
	}
	if (!isSameParameterReference(overrideGuard.consequent.argument, overrideDecl.id.name)) {
		return false;
	}
	if (
		!isModelFamilyGate(familyGuard.test, lowerCaseDecl.id.name) ||
		familyGuard.alternate !== null ||
		!t.isBlockStatement(familyGuard.consequent) ||
		familyGuard.consequent.body.length !== 3
	) {
		return false;
	}
	const [parsedVersionInit, parsedVersionGuard, parsedVersionReturn] =
		familyGuard.consequent.body;
	if (!t.isVariableDeclaration(parsedVersionInit)) return false;
	if (parsedVersionInit.declarations.length !== 1) return false;
	const [parsedVersionDecl] = parsedVersionInit.declarations;
	if (!t.isIdentifier(parsedVersionDecl.id)) return false;
	if (
		!t.isCallExpression(parsedVersionDecl.init) ||
		parsedVersionDecl.init.arguments.length !== 1 ||
		!isSameParameterReference(parsedVersionDecl.init.arguments[0], param.name)
	) {
		return false;
	}
	if (
		!t.isIfStatement(parsedVersionGuard) ||
		parsedVersionGuard.alternate !== null ||
		!isParsedVersionGuard(parsedVersionGuard.test, parsedVersionDecl.id.name) ||
		!t.isReturnStatement(parsedVersionGuard.consequent) ||
		!isFalseLike(parsedVersionGuard.consequent.argument)
	) {
		return false;
	}
	return (
		t.isReturnStatement(parsedVersionReturn) &&
		isSupportedVersionThreshold(
			parsedVersionReturn.argument,
			parsedVersionDecl.id.name,
		)
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
