import assert from "node:assert/strict";
import { test } from "node:test";
import { featureFlags } from "./feature-flags.js";

test("feature-flags is a reserved no-op: defines no bundle-touching hooks", () => {
	assert.equal(featureFlags.tag, "feature-flags");
	assert.equal(
		featureFlags.string,
		undefined,
		"no string transform expected on the reserved slot",
	);
	assert.equal(
		featureFlags.astPasses,
		undefined,
		"no astPasses expected on the reserved slot",
	);
	assert.equal(
		featureFlags.postApply,
		undefined,
		"no postApply expected on the reserved slot",
	);
});

test("feature-flags verify() passes unconditionally for the no-op slot", () => {
	assert.equal(featureFlags.verify(""), true);
	assert.equal(featureFlags.verify("any arbitrary code body"), true);
});

test("feature-flags exposes only tag and verify (no mutation hooks of any kind)", () => {
	const keys = Object.keys(featureFlags).sort();
	assert.deepEqual(
		keys,
		["tag", "verify"],
		`reserved slot must define only tag+verify, got: ${keys.join(",")}`,
	);
});
