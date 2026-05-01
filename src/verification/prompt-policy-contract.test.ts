import assert from "node:assert/strict";
import { test } from "node:test";
import {
	FORBIDDEN_LEGACY_PROMPT_NEEDLES,
	REQUIRED_PROMPT_POLICY_NEEDLES,
	verifyPromptPolicyContract,
} from "./prompt-policy-contract.js";

test("verifyPromptPolicyContract accepts required policy and no legacy needles", () => {
	const content = REQUIRED_PROMPT_POLICY_NEEDLES.map(
		(rule) => rule.needle,
	).join("\n");

	const result = verifyPromptPolicyContract(content);

	assert.equal(result.ok, true);
	assert.equal(
		result.checksRun,
		REQUIRED_PROMPT_POLICY_NEEDLES.length +
			FORBIDDEN_LEGACY_PROMPT_NEEDLES.length,
	);
	assert.deepEqual(result.failures, []);
});

test("verifyPromptPolicyContract reports missing and forbidden policy drift", () => {
	const content = [
		...REQUIRED_PROMPT_POLICY_NEEDLES.slice(1).map((rule) => rule.needle),
		FORBIDDEN_LEGACY_PROMPT_NEEDLES[0].needle,
	].join("\n");

	const result = verifyPromptPolicyContract(content);

	assert.equal(result.ok, false);
	assert.ok(
		result.failures.some(
			(failure) => failure.id === REQUIRED_PROMPT_POLICY_NEEDLES[0].id,
		),
	);
	assert.ok(
		result.failures.some(
			(failure) => failure.id === FORBIDDEN_LEGACY_PROMPT_NEEDLES[0].id,
		),
	);
});
