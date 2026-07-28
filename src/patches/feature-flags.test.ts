import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { featureFlags } from "./feature-flags.js";

const MONITOR_FIXTURE = `
function featureValue(name, fallback) {
  return fallback;
}
function monitorGate() {
  return featureValue("tengu_amber_sentinel", !1);
}
function hasBash() {
  return true;
}
const MonitorTool = {
  userFacingName() {
    return "Monitor";
  },
  isEnabled() {
    return monitorGate() && hasBash();
  },
};
`;

async function applyFeatureFlagsPatch(source: string): Promise<string> {
	const ast = parse(source);
	const passes = (await featureFlags.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: featureFlags.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
	const output = print(ast);
	assert.equal(featureFlags.verify(output, ast), true);
	return output;
}

test("feature-flags makes the Monitor gate independent of GrowthBook", async () => {
	const output = await applyFeatureFlagsPatch(MONITOR_FIXTURE);
	assert.match(output, /function monitorGate\(\) \{\s*return true;\s*\}/);
	assert.doesNotMatch(output, /tengu_amber_sentinel/);
});

test("feature-flags is idempotent", async () => {
	const once = await applyFeatureFlagsPatch(MONITOR_FIXTURE);
	const twice = await applyFeatureFlagsPatch(once);
	assert.equal(twice, once);
});

test("feature-flags verify fails when the Monitor gate remains remote", () => {
	const ast = parse(MONITOR_FIXTURE);
	assert.match(
		String(featureFlags.verify(MONITOR_FIXTURE, ast)),
		/Monitor gate.*not enabled locally/,
	);
});
