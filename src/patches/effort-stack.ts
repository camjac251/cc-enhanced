import * as t from "@babel/types";
import { type NodePath, traverse, type Visitor } from "../babel.js";
import type { Patch } from "../types.js";
import { getObjectKeyName, getVerifyAst } from "./ast-helpers.js";

const MAX_NOTIFICATION_TEXT = "Effort set to max for this turn";
const EM_DASH = "—";

const BYZ_ORIGINAL_QUASIS = [
	"CLAUDE_CODE_EFFORT_LEVEL=",
	` overrides effort this session ${EM_DASH} clear it and ultracode takes over`,
] as const;
const BYZ_PATCHED_QUASIS = [
	"Ultracode active. Effort stays at ",
	" via env (stacked); workflow guidance is armed for this session.",
] as const;

const UYZ_ORIGINAL_QUASIS = [
	"CLAUDE_CODE_EFFORT_LEVEL=",
	` overrides this session ${EM_DASH} clear it and `,
	" takes over",
] as const;
const UYZ_PATCHED_QUASIS = [
	"CLAUDE_CODE_EFFORT_LEVEL=",
	" still wins this session. Stored ",
	" for next session (clear the env var to drop the override).",
] as const;

const HY8_ULTRACODE_ANCHOR =
	"Current effort level: ultracode (xhigh + dynamic workflow orchestration; this session only)";
const HY8_NEW_BRANCH_MESSAGE =
	"Current effort level: max effort + ultracode workflows (env-stacked, this session only)";

const YN4_ULTRACODE_QUASI_TAIL =
	" ultracode · xhigh effort + dynamic workflows for maximum thoroughness";
const YN4_MAX_QUASI_TAIL =
	" ultracode · max effort + dynamic workflows for maximum thoroughness";

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

function buildEnvEffortLevelEqualsMaxCheck(): t.BinaryExpression {
	return t.binaryExpression(
		"===",
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

function quasiCookedAt(tmpl: t.TemplateLiteral, index: number): string | null {
	const q = tmpl.quasis[index];
	if (!q) return null;
	return q.value.cooked ?? q.value.raw;
}

function setQuasiText(
	tmpl: t.TemplateLiteral,
	index: number,
	text: string,
): void {
	const q = tmpl.quasis[index];
	if (!q) return;
	q.value = { raw: text, cooked: text };
}

function templateMatchesQuasiPattern(
	tmpl: t.TemplateLiteral,
	expected: readonly string[],
): boolean {
	if (tmpl.quasis.length !== expected.length) return false;
	for (let i = 0; i < expected.length; i++) {
		if (quasiCookedAt(tmpl, i) !== expected[i]) return false;
	}
	return true;
}

function isHy8FunctionByContent(funcPath: NodePath<t.Function>): boolean {
	let found = false;
	funcPath.traverse({
		StringLiteral(p) {
			if (p.node.value === HY8_ULTRACODE_ANCHOR) found = true;
		},
	});
	return found;
}

function getThirdParameterName(fn: t.Function): string | null {
	const param = fn.params[2];
	if (!param || !t.isIdentifier(param)) return null;
	return param.name;
}

function isPatchedHy8FirstStatement(stmt: t.Statement): boolean {
	if (!t.isIfStatement(stmt)) return false;
	let returnStmt: t.Statement | null = stmt.consequent;
	if (t.isBlockStatement(returnStmt) && returnStmt.body.length === 1) {
		returnStmt = returnStmt.body[0];
	}
	if (!returnStmt || !t.isReturnStatement(returnStmt)) return false;
	const arg = returnStmt.argument;
	if (!arg || !t.isObjectExpression(arg)) return false;
	const msgProp = arg.properties.find(
		(p) => t.isObjectProperty(p) && getObjectKeyName(p.key) === "message",
	);
	if (!msgProp || !t.isObjectProperty(msgProp)) return false;
	return t.isStringLiteral(msgProp.value, { value: HY8_NEW_BRANCH_MESSAGE });
}

function buildHy8StackingBranch(ultracodeParamName: string): t.IfStatement {
	return t.ifStatement(
		t.logicalExpression(
			"&&",
			t.binaryExpression(
				"===",
				t.identifier(ultracodeParamName),
				t.booleanLiteral(true),
			),
			buildEnvEffortLevelEqualsMaxCheck(),
		),
		t.returnStatement(
			t.objectExpression([
				t.objectProperty(
					t.identifier("message"),
					t.stringLiteral(HY8_NEW_BRANCH_MESSAGE),
				),
			]),
		),
	);
}

function isYN4LegacyReturnArg(arg: t.Expression | null | undefined): boolean {
	if (!arg || !t.isTemplateLiteral(arg)) return false;
	if (arg.quasis.length !== 2 || arg.expressions.length !== 1) return false;
	if ((arg.quasis[0].value.cooked ?? arg.quasis[0].value.raw) !== "") {
		return false;
	}
	return (
		(arg.quasis[1].value.cooked ?? arg.quasis[1].value.raw) ===
		YN4_ULTRACODE_QUASI_TAIL
	);
}

function isPatchedYN4Return(node: t.ReturnStatement): boolean {
	const arg = node.argument;
	if (!arg || !t.isConditionalExpression(arg)) return false;
	const test = arg.test;
	if (!t.isBinaryExpression(test, { operator: "===" })) return false;
	if (!t.isStringLiteral(test.right, { value: "max" })) return false;
	const left = test.left;
	if (!t.isMemberExpression(left)) return false;
	if (!t.isIdentifier(left.property, { name: "CLAUDE_CODE_EFFORT_LEVEL" })) {
		return false;
	}
	if (!t.isTemplateLiteral(arg.consequent)) return false;
	const consequentTail =
		arg.consequent.quasis[1]?.value.cooked ??
		arg.consequent.quasis[1]?.value.raw;
	if (consequentTail !== YN4_MAX_QUASI_TAIL) return false;
	if (!t.isTemplateLiteral(arg.alternate)) return false;
	const alternateTail =
		arg.alternate.quasis[1]?.value.cooked ?? arg.alternate.quasis[1]?.value.raw;
	if (alternateTail !== YN4_ULTRACODE_QUASI_TAIL) return false;
	return true;
}

function buildYN4Conditional(
	original: t.TemplateLiteral,
): t.ConditionalExpression {
	const expr = t.cloneNode(original.expressions[0] as t.Expression);
	const maxTmpl = t.templateLiteral(
		[
			t.templateElement({ raw: "", cooked: "" }, false),
			t.templateElement(
				{ raw: YN4_MAX_QUASI_TAIL, cooked: YN4_MAX_QUASI_TAIL },
				true,
			),
		],
		[expr],
	);
	return t.conditionalExpression(
		buildEnvEffortLevelEqualsMaxCheck(),
		maxTmpl,
		t.cloneNode(original),
	);
}

function createEffortStackMutator(): Visitor {
	let patchedResolver = 0;
	let patchedNotification = 0;
	let patchedByz = 0;
	let patchedUyz = 0;
	let patchedHy8 = 0;
	let patchedYN4 = 0;

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

		TemplateLiteral(path) {
			if (templateMatchesQuasiPattern(path.node, BYZ_PATCHED_QUASIS)) {
				patchedByz += 1;
				return;
			}
			if (templateMatchesQuasiPattern(path.node, BYZ_ORIGINAL_QUASIS)) {
				setQuasiText(path.node, 0, BYZ_PATCHED_QUASIS[0]);
				setQuasiText(path.node, 1, BYZ_PATCHED_QUASIS[1]);
				patchedByz += 1;
				return;
			}
			if (templateMatchesQuasiPattern(path.node, UYZ_PATCHED_QUASIS)) {
				patchedUyz += 1;
				return;
			}
			if (templateMatchesQuasiPattern(path.node, UYZ_ORIGINAL_QUASIS)) {
				setQuasiText(path.node, 0, UYZ_PATCHED_QUASIS[0]);
				setQuasiText(path.node, 1, UYZ_PATCHED_QUASIS[1]);
				setQuasiText(path.node, 2, UYZ_PATCHED_QUASIS[2]);
				patchedUyz += 1;
				return;
			}
		},

		Function(path) {
			if (!isHy8FunctionByContent(path)) return;
			const body = path.node.body;
			if (!t.isBlockStatement(body)) return;
			if (body.body.length > 0 && isPatchedHy8FirstStatement(body.body[0])) {
				patchedHy8 += 1;
				return;
			}
			const ultracodeParam = getThirdParameterName(path.node);
			if (!ultracodeParam) return;
			body.body.unshift(buildHy8StackingBranch(ultracodeParam));
			patchedHy8 += 1;
		},

		ReturnStatement(path) {
			if (isPatchedYN4Return(path.node)) {
				patchedYN4 += 1;
				return;
			}
			const arg = path.node.argument;
			if (!isYN4LegacyReturnArg(arg)) return;
			path.node.argument = buildYN4Conditional(arg as t.TemplateLiteral);
			patchedYN4 += 1;
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
				if (patchedByz === 0) {
					console.warn(
						"effort-stack: Could not find ultracode-picker override message",
					);
				}
				if (patchedUyz === 0) {
					console.warn(
						"effort-stack: Could not find effort-picker override message",
					);
				}
				if (patchedHy8 === 0) {
					console.warn(
						"effort-stack: Could not find current-effort display function",
					);
				}
				if (patchedYN4 === 0) {
					console.warn(
						"effort-stack: Could not find ultracode description template",
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
		let hasPatchedByz = false;
		let hasLegacyByz = false;
		let hasPatchedUyz = false;
		let hasLegacyUyz = false;
		let hasPatchedHy8 = false;
		let hasPatchedYN4 = false;
		let hasLegacyYN4 = false;

		traverse(verifyAst, {
			IfStatement(path) {
				if (isUltracodeForcesXhighGuard(path.node)) hasLegacyResolver = true;
				if (isPatchedUltracodeResolver(path.node)) hasPatchedResolver = true;
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
			TemplateLiteral(path) {
				if (templateMatchesQuasiPattern(path.node, BYZ_PATCHED_QUASIS)) {
					hasPatchedByz = true;
				}
				if (templateMatchesQuasiPattern(path.node, BYZ_ORIGINAL_QUASIS)) {
					hasLegacyByz = true;
				}
				if (templateMatchesQuasiPattern(path.node, UYZ_PATCHED_QUASIS)) {
					hasPatchedUyz = true;
				}
				if (templateMatchesQuasiPattern(path.node, UYZ_ORIGINAL_QUASIS)) {
					hasLegacyUyz = true;
				}
			},
			Function(path) {
				if (!isHy8FunctionByContent(path)) return;
				const body = path.node.body;
				if (!t.isBlockStatement(body)) return;
				if (body.body.length > 0 && isPatchedHy8FirstStatement(body.body[0])) {
					hasPatchedHy8 = true;
				}
			},
			ReturnStatement(path) {
				if (isPatchedYN4Return(path.node)) hasPatchedYN4 = true;
				if (isYN4LegacyReturnArg(path.node.argument)) hasLegacyYN4 = true;
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
		if (hasLegacyByz) {
			return "Ultracode-picker override message still uses misleading 'overrides' phrasing";
		}
		if (!hasPatchedByz) {
			return "Did not find patched ultracode-picker override message";
		}
		if (hasLegacyUyz) {
			return "Effort-picker override message still uses misleading 'takes over' phrasing";
		}
		if (!hasPatchedUyz) {
			return "Did not find patched effort-picker override message";
		}
		if (!hasPatchedHy8) {
			return "Did not find env-stacking branch in current-effort display";
		}
		if (hasLegacyYN4) {
			return "Ultracode description still hardcodes 'xhigh effort'";
		}
		if (!hasPatchedYN4) {
			return "Did not find env-aware ultracode description";
		}
		return true;
	},
};
