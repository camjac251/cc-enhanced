import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { featureFlags } from "./feature-flags.js";

async function runFeatureFlagsViaPasses(ast: any): Promise<void> {
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
}

// Current upstream shape: a multi-branch chain inside one function. The
// patch must rewrite every workflow gate call inside that function; the
// function-scope CLAUDE_CODE_WORKFLOWS check is what keeps unrelated
// mentions of the same flag string elsewhere safe.
const FEATURE_FLAGS_FIXTURE = `
function isTruthy(v) { return !!v; }
function isExplicitlyFalsy(v) { return v === "0" || v === "false"; }
function gate(name, fallback) { return fallback; }
function tier() { return "free"; }

function getWorkflowGate() {
  if (isTruthy(process.env.CLAUDE_CODE_WORKFLOWS)) {
    let cached = gate("tengu_workflows_enabled", true);
    return { available: cached, defaultOn: cached };
  }
  if (isExplicitlyFalsy(process.env.CLAUDE_CODE_WORKFLOWS)) return { available: false, defaultOn: false };
  if (!gate("tengu_workflows_enabled", false)) return { available: false, defaultOn: false };
  return { available: true, defaultOn: tier() !== "pro" };
}

if (isTruthy(process.env.DUMMY_ENV)) {}
`;

// Older single-branch shape from earlier upstream. The new anchor still
// handles it: one gate call inside the workflow function gets replaced.
const LEGACY_FEATURE_FLAGS_FIXTURE = `
function isTruthy(v) { return !!v; }
function gate(name, fallbackValue) { return fallbackValue; }

function workflowsEnabled() {
  let cached;
  if (!isTruthy(process.env.CLAUDE_CODE_WORKFLOWS)) cached = false;
  else cached = gate("tengu_workflows_enabled", true);
  return cached;
}
`;

// Unrelated use of the same flag string OUTSIDE any function that mentions
// the workflow env var must not be touched.
const UNRELATED_FIXTURE = `
function gate(name, fallback) { return fallback; }
function unrelatedFlag() {
  return gate("tengu_workflows_enabled", false);
}
`;

test("feature-flags exports the expected tag", () => {
	assert.equal(featureFlags.tag, "feature-flags");
});

test("verify rejects the current unpatched shape", () => {
	const ast = parse(FEATURE_FLAGS_FIXTURE);
	const code = print(ast);
	const result = featureFlags.verify(code, ast);
	assert.notEqual(result, true, "verify should reject unpatched code");
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("Workflow gate calls still present"),
		true,
	);
});

test("feature-flags patches every workflow gate call in the chain", async () => {
	const ast = parse(FEATURE_FLAGS_FIXTURE);
	await runFeatureFlagsViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes('gate("tengu_workflows_enabled"'),
		false,
		"all workflow gate calls should have been replaced with `true`",
	);
	assert.match(
		output,
		/let cached = true;\s*return \{ available: cached, defaultOn: cached \};/,
	);
	assert.match(
		output,
		/if \(!true\) return \{ available: false, defaultOn: false \};/,
	);
	assert.equal(featureFlags.verify(output, ast), true);
	assert.equal(featureFlags.verify(output), true);
});

test("feature-flags still handles the legacy single-branch shape", async () => {
	const ast = parse(LEGACY_FEATURE_FLAGS_FIXTURE);
	await runFeatureFlagsViaPasses(ast);
	const output = print(ast);

	assert.equal(output.includes('gate("tengu_workflows_enabled"'), false);
	assert.equal(
		output.includes("cached = true;"),
		true,
		"the else branch's gate call should have been replaced with `true`",
	);
	assert.equal(featureFlags.verify(output, ast), true);
});

test("feature-flags ignores gate calls outside the workflow function", async () => {
	const ast = parse(UNRELATED_FIXTURE);
	await runFeatureFlagsViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes('gate("tengu_workflows_enabled", false)'),
		true,
		"unrelated use without a CLAUDE_CODE_WORKFLOWS env reference must not be patched",
	);
});

test("feature-flags verify detects a missing workflow env reference", async () => {
	const ast = parse(FEATURE_FLAGS_FIXTURE);
	await runFeatureFlagsViaPasses(ast);
	const output = print(ast);
	const mutated = output.replaceAll(
		"CLAUDE_CODE_WORKFLOWS",
		"CLAUDE_CODE_WORKFLOWS_BROKEN",
	);
	assert.notEqual(mutated, output);

	const result = featureFlags.verify(mutated);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("Missing CLAUDE_CODE_WORKFLOWS env reference"),
		true,
	);
});
