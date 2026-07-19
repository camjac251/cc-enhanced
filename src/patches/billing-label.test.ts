import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { billingLabel, resolveBillingLabelForEnv } from "./billing-label.js";

const BILLING_FIXTURE = `
const providerLabels = { partner: "Partner Billing" };
function getBillingType(provider, oauthLabel) {
  return provider !== "firstParty"
    ? providerLabels[provider]
    : oauthLabel !== undefined
      ? oauthLabel
      : "API Usage Billing";
}
function getAvailability(provider, enabled, blocked) {
  return provider !== "firstParty"
    ? "not available on third-party providers"
    : !enabled
      ? "not currently available"
      : blocked
        ? "blocked by org policy"
        : void 0;
}
const unrelatedLabel = "API Usage Billing";
`;

async function patchSource(source: string): Promise<string> {
	const ast = parse(source);
	const passes = (await billingLabel.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: billingLabel.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
	return print(ast);
}

const count = (haystack: string, needle: string): number =>
	haystack.split(needle).length - 1;

test("exports the billing-label tag", () => {
	assert.equal(billingLabel.tag, "billing-label");
});

test("returns the configured billing label", () => {
	const env = { CLAUDE_CODE_BILLING_LABEL: "Subscription Router" };

	assert.equal(resolveBillingLabelForEnv(env), "Subscription Router");
});

test("normalizes line breaks and surrounding whitespace", () => {
	const env = {
		CLAUDE_CODE_BILLING_LABEL: "  Subscription\n\r\nRouter  ",
	};

	assert.equal(resolveBillingLabelForEnv(env), "Subscription Router");
});

test("limits the configured label to 64 characters", () => {
	const configured = "x".repeat(80);

	assert.equal(
		resolveBillingLabelForEnv({ CLAUDE_CODE_BILLING_LABEL: configured }),
		"x".repeat(64),
	);
});

test("keeps the stock fallback when the override is absent or blank", () => {
	assert.equal(resolveBillingLabelForEnv({}), "API Usage Billing");
	assert.equal(
		resolveBillingLabelForEnv({ CLAUDE_CODE_BILLING_LABEL: "  " }),
		"API Usage Billing",
	);
});

test("patches only the nested API fallback", async () => {
	const output = await patchSource(BILLING_FIXTURE);

	assert.equal(count(output, "CLAUDE_CODE_BILLING_LABEL"), 1);
	assert.equal(count(output, '"API Usage Billing"'), 2);
	assert.match(output, /unrelatedLabel\s*=\s*"API Usage Billing"/);
});

test("verifies the patched billing fallback", async () => {
	const output = await patchSource(BILLING_FIXTURE);

	assert.equal(billingLabel.verify(output, parse(output)), true);
});

test("rejects an unpatched billing fallback", () => {
	const ast = parse(BILLING_FIXTURE);
	const result = billingLabel.verify(print(ast), ast);

	assert.notEqual(result, true);
	assert.match(String(result), /not patched/);
});

test("rejects a weakened override expression", () => {
	const weakened = BILLING_FIXTURE.replace(
		'"API Usage Billing";',
		'process.env.CLAUDE_CODE_BILLING_LABEL || "API Usage Billing";',
	);
	const ast = parse(weakened);
	const result = billingLabel.verify(print(ast), ast);

	assert.notEqual(result, true);
	assert.match(String(result), /normalization/);
});

test("rejects source without the billing fallback site", () => {
	const source = 'const unrelatedLabel = "API Usage Billing";';
	const ast = parse(source);
	const result = billingLabel.verify(print(ast), ast);

	assert.notEqual(result, true);
	assert.match(String(result), /not found/);
});

test("is idempotent", async () => {
	const once = await patchSource(BILLING_FIXTURE);
	const twice = await patchSource(once);

	assert.equal(count(twice, "CLAUDE_CODE_BILLING_LABEL"), 1);
	assert.equal(twice, once);
});
