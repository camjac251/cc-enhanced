import * as t from "@babel/types";
import { traverse, type Visitor } from "../babel.js";
import { parse } from "../loader.js";
import type { Patch } from "../types.js";
import { getMemberPropertyName, getVerifyAst } from "./ast-helpers.js";

const ENV_NAME = "CLAUDE_CODE_BILLING_LABEL";
const DEFAULT_LABEL = "API Usage Billing";
const FIRST_PARTY_PROVIDER = "firstParty";
const MAX_LABEL_LENGTH = 64;

type BillingLabelEnv = Record<string, string | undefined>;
type MemberCall = t.CallExpression & { callee: t.MemberExpression };

export function resolveBillingLabelForEnv(env: BillingLabelEnv): string {
	return (
		(env[ENV_NAME] || "")
			.trim()
			.replace(/[\r\n]+/g, " ")
			.slice(0, MAX_LABEL_LENGTH) || DEFAULT_LABEL
	);
}

function getMemberCall(
	node: t.Node | null | undefined,
	methodName: string,
): MemberCall | null {
	if (!t.isCallExpression(node) || !t.isMemberExpression(node.callee)) {
		return null;
	}
	if (getMemberPropertyName(node.callee) !== methodName) return null;
	return node as MemberCall;
}

function isFirstPartyProviderTest(node: t.Node): boolean {
	if (!t.isBinaryExpression(node, { operator: "!==" })) return false;
	return (
		t.isStringLiteral(node.left, { value: FIRST_PARTY_PROVIDER }) ||
		t.isStringLiteral(node.right, { value: FIRST_PARTY_PROVIDER })
	);
}

function isBillingFallbackSite(
	node: t.ConditionalExpression,
	parent: t.Node | null | undefined,
): boolean {
	return (
		t.isConditionalExpression(parent) &&
		parent.alternate === node &&
		isFirstPartyProviderTest(parent.test)
	);
}

function buildOverrideExpression(): t.Expression {
	const ast = parse(
		`(process.env.${ENV_NAME} || "").trim().replace(/[\\r\\n]+/g, " ").slice(0, ${MAX_LABEL_LENGTH}) || ${JSON.stringify(DEFAULT_LABEL)}`,
	);
	const statement = ast.program.body[0];
	if (!t.isExpressionStatement(statement)) {
		throw new Error("billing-label: failed to build override expression");
	}
	return statement.expression;
}

function isProcessEnvLabel(node: t.Node | null | undefined): boolean {
	if (!t.isMemberExpression(node)) return false;
	if (getMemberPropertyName(node) !== ENV_NAME) return false;
	if (!t.isMemberExpression(node.object)) return false;
	return (
		getMemberPropertyName(node.object) === "env" &&
		t.isIdentifier(node.object.object, { name: "process" })
	);
}

function containsProcessEnvLabel(node: t.Node): boolean {
	if (isProcessEnvLabel(node)) return true;
	let found = false;
	t.traverseFast(node, (child) => {
		if (!found && isProcessEnvLabel(child)) found = true;
	});
	return found;
}

function isOverrideExpression(node: t.Node | null | undefined): boolean {
	if (!t.isLogicalExpression(node, { operator: "||" })) return false;
	if (!t.isStringLiteral(node.right, { value: DEFAULT_LABEL })) return false;

	const sliceCall = getMemberCall(node.left, "slice");
	if (!sliceCall) return false;
	if (
		sliceCall.arguments.length !== 2 ||
		!t.isNumericLiteral(sliceCall.arguments[0], { value: 0 }) ||
		!t.isNumericLiteral(sliceCall.arguments[1], { value: MAX_LABEL_LENGTH })
	) {
		return false;
	}

	const replaceCall = getMemberCall(sliceCall.callee.object, "replace");
	if (!replaceCall) return false;
	if (
		replaceCall.arguments.length !== 2 ||
		!t.isRegExpLiteral(replaceCall.arguments[0], {
			pattern: "[\\r\\n]+",
			flags: "g",
		}) ||
		!t.isStringLiteral(replaceCall.arguments[1], { value: " " })
	) {
		return false;
	}

	const trimCall = getMemberCall(replaceCall.callee.object, "trim");
	if (!trimCall) return false;
	if (trimCall.arguments.length !== 0) return false;
	const rawLabel = trimCall.callee.object;
	return (
		t.isLogicalExpression(rawLabel, { operator: "||" }) &&
		isProcessEnvLabel(rawLabel.left) &&
		t.isStringLiteral(rawLabel.right, { value: "" })
	);
}

function createBillingLabelMutator(): Visitor {
	let patched = 0;
	return {
		StringLiteral(path) {
			if (path.node.value !== DEFAULT_LABEL) return;
			const conditional = path.parentPath;
			if (
				!conditional?.isConditionalExpression() ||
				conditional.node.alternate !== path.node ||
				!isBillingFallbackSite(conditional.node, conditional.parentPath?.node)
			) {
				return;
			}

			path.replaceWith(buildOverrideExpression());
			patched++;
		},
		Program: {
			exit() {
				if (patched > 0) {
					console.log(`Billing label: patched ${patched} fallback site(s)`);
				}
			},
		},
	};
}

function verifyBillingLabel(code: string, ast?: t.File): true | string {
	const verifyAst = getVerifyAst(code, ast);
	if (!verifyAst) return "Unable to parse AST for billing-label verification";

	let candidates = 0;
	let patched = 0;
	let unpatched = 0;
	traverse(verifyAst, {
		ConditionalExpression(path) {
			if (!isBillingFallbackSite(path.node, path.parentPath?.node)) return;
			const alternate = path.node.alternate;
			if (t.isStringLiteral(alternate, { value: DEFAULT_LABEL })) {
				candidates++;
				unpatched++;
			} else if (isOverrideExpression(alternate)) {
				candidates++;
				patched++;
			} else if (containsProcessEnvLabel(alternate)) {
				candidates++;
			}
		},
	});

	if (candidates === 0) return "Billing fallback site not found";
	if (unpatched > 0) return "Billing fallback site was not patched";
	if (candidates !== 1) {
		return `Expected one billing fallback site, found ${candidates}`;
	}
	if (patched !== 1) {
		return "Billing label override is missing required normalization and fallback";
	}
	return true;
}

export const billingLabel: Patch = {
	tag: "billing-label",
	astPasses: () => [
		{
			pass: "mutate",
			visitor: createBillingLabelMutator(),
		},
	],
	verify: verifyBillingLabel,
};
