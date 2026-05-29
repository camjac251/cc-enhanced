import * as t from "@babel/types";
import { traverse, type Visitor } from "../babel.js";
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

// Upstream effort resolver short-circuits to "xhigh" whenever
// settings.ultracode is true, discarding any other configured effort.
// That prevents stacking max effort with ultracode (workflow orchestration).
// The patch rewrites the test to honor CLAUDE_CODE_EFFORT_LEVEL=max so the
// two can coexist: env-var max wins; ultracode-only still resolves to xhigh.

function isUltracodeEqualsTrueTest(
	test: t.Expression,
): { receiverName: string } | null {
	if (!t.isBinaryExpression(test, { operator: "===" })) return null;
	const right = test.right;
	const isTrueLit =
		t.isBooleanLiteral(right, { value: true }) ||
		(t.isUnaryExpression(right, { operator: "!" }) &&
			t.isNumericLiteral(right.argument, { value: 0 }));
	if (!isTrueLit) return null;
	const left = test.left;
	if (!t.isMemberExpression(left)) return null;
	if (!t.isIdentifier(left.property, { name: "ultracode" })) return null;
	const settingsMember = left.object;
	if (!t.isMemberExpression(settingsMember)) return null;
	if (!t.isIdentifier(settingsMember.property, { name: "settings" })) {
		return null;
	}
	const receiver = settingsMember.object;
	if (!t.isIdentifier(receiver)) return null;
	return { receiverName: receiver.name };
}

function consequentReturnsXhigh(consequent: t.Statement): boolean {
	let stmt: t.Statement | null = consequent;
	if (t.isBlockStatement(stmt) && stmt.body.length === 1) {
		stmt = stmt.body[0];
	}
	if (!stmt || !t.isReturnStatement(stmt)) return false;
	return t.isStringLiteral(stmt.argument, { value: "xhigh" });
}

function isUltracodeForcesXhighGuard(
	node: t.IfStatement,
): { receiverName: string } | null {
	const match = isUltracodeEqualsTrueTest(node.test);
	if (!match) return null;
	if (!consequentReturnsXhigh(node.consequent)) return null;
	return match;
}

function buildEnvEffortLevelNotMaxCheck(): t.BinaryExpression {
	return t.binaryExpression(
		"!==",
		t.memberExpression(
			t.memberExpression(t.identifier("process"), t.identifier("env")),
			t.identifier("CLAUDE_CODE_EFFORT_LEVEL"),
		),
		t.stringLiteral("max"),
	);
}

function isPatchedUltracodeResolver(node: t.IfStatement): boolean {
	const test = node.test;
	if (!t.isLogicalExpression(test, { operator: "&&" })) return false;
	const leftMatch = isUltracodeEqualsTrueTest(test.left as t.Expression);
	if (!leftMatch) return false;
	const right = test.right;
	if (!t.isBinaryExpression(right, { operator: "!==" })) return false;
	if (!t.isStringLiteral(right.right, { value: "max" })) return false;
	const rightLeft = right.left;
	if (!t.isMemberExpression(rightLeft)) return false;
	if (
		!t.isIdentifier(rightLeft.property, { name: "CLAUDE_CODE_EFFORT_LEVEL" })
	) {
		return false;
	}
	if (!consequentReturnsXhigh(node.consequent)) return false;
	return true;
}

function createEffortStackMutator(): Visitor {
	let patchedResolver = 0;
	let patchedNotification = 0;

	return {
		IfStatement(path) {
			if (isPatchedUltracodeResolver(path.node)) {
				patchedResolver += 1;
				return;
			}
			const match = isUltracodeForcesXhighGuard(path.node);
			if (!match) return;
			path.node.test = t.logicalExpression(
				"&&",
				path.node.test,
				buildEnvEffortLevelNotMaxCheck(),
			);
			patchedResolver += 1;
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
				if (patchedResolver === 0) {
					console.warn(
						"effort-stack: Could not find ultracode-forces-xhigh resolver guard",
					);
				}
				if (patchedNotification === 0) {
					console.warn(
						"effort-stack: Could not find ultrathink notification text",
					);
				}
			},
		},
	};
}

export const effortStack: Patch = {
	tag: "effort-stack",

	astPasses: () => [
		{
			pass: "mutate",
			visitor: createEffortStackMutator(),
		},
	],

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) return "Unable to parse AST during verification";

		let hasLegacyResolver = false;
		let hasPatchedResolver = false;
		let hasMaxNotification = false;

		traverse(verifyAst, {
			IfStatement(path) {
				if (isUltracodeForcesXhighGuard(path.node)) {
					hasLegacyResolver = true;
				}
				if (isPatchedUltracodeResolver(path.node)) {
					hasPatchedResolver = true;
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
					hasMaxNotification = true;
				}
			},
		});

		if (hasLegacyResolver) {
			return "Ultracode-forces-xhigh resolver still ignores CLAUDE_CODE_EFFORT_LEVEL=max";
		}
		if (!hasPatchedResolver) {
			return "Did not find patched ultracode resolver with env-var guard";
		}
		if (!hasMaxNotification) {
			return 'Did not find "Effort set to max for this turn" notification';
		}
		return true;
	},
};
