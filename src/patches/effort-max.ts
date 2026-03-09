import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch } from "../types.js";
import { getObjectKeyName, getVerifyAst } from "./ast-helpers.js";

const INTERACTIVE_MAX_ERROR =
	'Effort level "max" is not available in interactive mode.';
const SUBSCRIBER_MAX_ERROR =
	'Effort level "max" is not available for Claude.ai subscribers.';
const MAX_NOTIFICATION_TEXT = "Effort set to max for this turn";
const HIGH_NOTIFICATION_TEXT = "Effort set to high for this turn";
const CLI_EFFORT_HELP = "Effort level for the current session (low, medium, high)";
const CLI_EFFORT_HELP_PATCHED =
	"Effort level for the current session (low, medium, high, max)";

function objectLabelValue(
	prop: t.ObjectProperty | t.ObjectMethod | t.SpreadElement,
): string | null {
	if (!t.isObjectProperty(prop)) return null;
	if (getObjectKeyName(prop.key) !== "label") return null;
	return t.isStringLiteral(prop.value) ? prop.value.value : null;
}

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

function isEffortOptionObject(
	node: t.Node | null | undefined,
	label: string,
	value: string,
): node is t.ObjectExpression {
	if (!node || !t.isObjectExpression(node)) return false;
	let hasLabel = false;
	let hasValue = false;
	for (const prop of node.properties) {
		hasLabel ||= objectLabelValue(prop) === label;
		hasValue ||= objectValueValue(prop) === value;
	}
	return hasLabel && hasValue;
}

function isEffortPickerArray(path: traverse.NodePath<t.ArrayExpression>): boolean {
	const values = new Set<string>();
	const labels = new Set<string>();
	for (const element of path.node.elements) {
		if (!element || !t.isObjectExpression(element)) continue;
		for (const prop of element.properties) {
			const label = objectLabelValue(prop);
			if (label) labels.add(label);
			const value = objectValueValue(prop);
			if (value) values.add(value);
		}
	}
	return (
		values.has("low") &&
		values.has("medium") &&
		values.has("high") &&
		labels.has("Use medium effort (recommended)") &&
		labels.has("Use high effort") &&
		labels.has("Use low effort")
	);
}

function isInteractiveMaxGuard(path: traverse.NodePath<t.IfStatement>): boolean {
	const test = path.node.test;
	if (
		!t.isLogicalExpression(test, { operator: "&&" }) ||
		!t.isBinaryExpression(test.left, { operator: "===" }) ||
		!t.isMemberExpression(test.left.left) ||
		!t.isIdentifier(test.left.left.object, { name: "K" }) ||
		!t.isIdentifier(test.left.left.property, { name: "effort" }) ||
		!t.isStringLiteral(test.left.right, { value: "max" })
	) {
		return false;
	}
	if (!t.isLogicalExpression(test.right, { operator: "||" })) return false;

	let hasInteractiveMessage = false;
	let hasSubscriberMessage = false;
	path.traverse({
		Function(innerPath) {
			innerPath.skip();
		},
		StringLiteral(stringPath) {
			if (stringPath.node.value === INTERACTIVE_MAX_ERROR) {
				hasInteractiveMessage = true;
			}
			if (stringPath.node.value === SUBSCRIBER_MAX_ERROR) {
				hasSubscriberMessage = true;
			}
		},
	});
	return hasInteractiveMessage && hasSubscriberMessage;
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

function isGhqSwitch(path: traverse.NodePath<t.SwitchStatement>): boolean {
	if (!t.isIdentifier(path.node.discriminant, { name: "H" })) return false;
	const seen = new Set<string>();
	for (const switchCase of path.node.cases) {
		if (switchCase.test && t.isStringLiteral(switchCase.test)) {
			seen.add(switchCase.test.value);
		}
	}
	return seen.has("low") && seen.has("medium") && seen.has("high") && seen.has("max");
}

function switchCaseReturns(
	switchCase: t.SwitchCase,
	value: number,
): boolean {
	return switchCase.consequent.some(
		(statement) =>
			t.isReturnStatement(statement) &&
			t.isNumericLiteral(statement.argument, { value }),
	);
}

function makeMaxEffortOption(): t.ObjectExpression {
	return t.objectExpression([
		t.objectProperty(
			t.identifier("label"),
			t.stringLiteral("Use max effort"),
		),
		t.objectProperty(t.identifier("value"), t.stringLiteral("max")),
	]);
}

function createEffortMaxMutator(): traverse.Visitor {
	let patchedInteractiveGuard = 0;
	let patchedPicker = 0;
	let patchedUltrathinkLevel = 0;
	let patchedNotification = 0;
	let patchedMeter = 0;
	let patchedMeterBarCount = 0;
	let patchedCliHelp = 0;

	return {
		IfStatement(path) {
			if (!isInteractiveMaxGuard(path)) return;
			path.node.test = t.booleanLiteral(false);
			patchedInteractiveGuard += 1;
		},

		ArrayExpression(path) {
			if (!isEffortPickerArray(path)) return;
			const hasMax = path.node.elements.some((element) =>
				isEffortOptionObject(element, "Use max effort", "max"),
			);
			if (!hasMax) {
				path.node.elements.splice(1, 0, makeMaxEffortOption());
				patchedPicker += 1;
			}
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

		SwitchStatement(path) {
			if (!isGhqSwitch(path)) return;
			for (const switchCase of path.node.cases) {
				if (switchCase.test && t.isStringLiteral(switchCase.test, { value: "max" })) {
					if (!switchCaseReturns(switchCase, 4)) {
						switchCase.consequent = [t.returnStatement(t.numericLiteral(4))];
						patchedMeter += 1;
					}
				}
			}
		},

		VariableDeclarator(path) {
			if (
				t.isIdentifier(path.node.id, { name: "Uhq" }) &&
				t.isNumericLiteral(path.node.init, { value: 3 })
			) {
				path.node.init = t.numericLiteral(4);
				patchedMeterBarCount += 1;
			}
		},

		StringLiteral(path) {
			if (path.node.value === CLI_EFFORT_HELP) {
				path.node.value = CLI_EFFORT_HELP_PATCHED;
				patchedCliHelp += 1;
			}
		},

		Program: {
			exit() {
				if (patchedInteractiveGuard === 0) {
					console.warn("effort-max: Could not find interactive max-effort guard");
				}
				if (patchedPicker === 0) {
					console.warn("effort-max: Could not find effort picker array");
				}
				if (patchedUltrathinkLevel === 0) {
					console.warn("effort-max: Could not find ultrathink effort level object");
				}
				if (patchedNotification === 0) {
					console.warn("effort-max: Could not find ultrathink notification text");
				}
				if (patchedMeter === 0) {
					console.warn("effort-max: Could not find max effort meter case");
				}
				if (patchedMeterBarCount === 0) {
					console.warn("effort-max: Could not find effort meter bar count");
				}
				if (patchedCliHelp === 0) {
					console.warn("effort-max: Could not find CLI effort help text");
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

		let hasInteractiveMaxGuard = false;
		let hasPatchedInteractiveGuard = false;
		let sawAnyInteractiveMaxGuardAnchor = false;
		let hasPatchedPicker = false;
		let hasUnpatchedUltrathinkLevel = false;
		let hasPatchedUltrathinkLevel = false;
		let hasHighUltrathinkNotification = false;
		let hasMaxUltrathinkNotification = false;
		let hasPatchedMeter = false;
		let hasUnpatchedMeter = false;
		let hasPatchedMeterBarCount = false;
		let hasUnpatchedMeterBarCount = false;
		let hasPatchedCliHelp = false;

		traverse.default(verifyAst, {
			IfStatement(path) {
				if (isInteractiveMaxGuard(path)) {
					hasInteractiveMaxGuard = true;
					sawAnyInteractiveMaxGuardAnchor = true;
				}
				if (
					t.isBooleanLiteral(path.node.test, { value: false }) &&
					path.toString().includes(INTERACTIVE_MAX_ERROR) &&
					path.toString().includes(SUBSCRIBER_MAX_ERROR)
				) {
					hasPatchedInteractiveGuard = true;
					sawAnyInteractiveMaxGuardAnchor = true;
				}
			},

			ArrayExpression(path) {
				if (isEffortPickerArray(path)) {
					hasPatchedPicker = path.node.elements.some((element) =>
						isEffortOptionObject(element, "Use max effort", "max"),
					);
				}
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
				if (path.node.value === CLI_EFFORT_HELP_PATCHED) {
					hasPatchedCliHelp = true;
				}
			},

			SwitchStatement(path) {
				if (!isGhqSwitch(path)) return;
				for (const switchCase of path.node.cases) {
					if (!switchCase.test || !t.isStringLiteral(switchCase.test, { value: "max" })) {
						continue;
					}
					if (switchCaseReturns(switchCase, 4)) hasPatchedMeter = true;
					if (switchCaseReturns(switchCase, 3)) hasUnpatchedMeter = true;
				}
			},

			VariableDeclarator(path) {
				if (!t.isIdentifier(path.node.id, { name: "Uhq" })) return;
				if (t.isNumericLiteral(path.node.init, { value: 4 })) {
					hasPatchedMeterBarCount = true;
				}
				if (t.isNumericLiteral(path.node.init, { value: 3 })) {
					hasUnpatchedMeterBarCount = true;
				}
			},
		});

		if (hasInteractiveMaxGuard) {
			return "Interactive max-effort guard is still present";
		}
		if (sawAnyInteractiveMaxGuardAnchor && !hasPatchedInteractiveGuard) {
			return "Did not find patched max-effort guard anchor";
		}
		if (!hasPatchedPicker) {
			return 'Effort picker does not expose "Use max effort"';
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
		if (hasUnpatchedMeter) {
			return 'Effort meter still renders "max" with high-tier bars';
		}
		if (!hasPatchedMeter) {
			return 'Did not find patched "max" effort meter case';
		}
		if (hasUnpatchedMeterBarCount) {
			return "Effort meter bar count is still capped at 3";
		}
		if (!hasPatchedMeterBarCount) {
			return "Did not find patched effort meter bar count";
		}
		if (!hasPatchedCliHelp) {
			return 'CLI help text still omits "max" effort';
		}

		return true;
	},
};
