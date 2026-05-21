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

const FEATURE_FLAGS_FIXTURE = `
function eH(v) { return !!v; }
function gate(name, fallbackValue) { return fallbackValue; }

function workflowsEnabled() {
  let cached;
  if (!eH(process.env.CLAUDE_CODE_WORKFLOWS)) cached = false;
  else cached = gate("tengu_workflows_enabled", true);
  return cached;
}

if (eH(process.env.DUMMY_ENV)) {}
`;

test("feature-flags exports the expected tag", () => {
	assert.equal(featureFlags.tag, "feature-flags");
});

test("verify rejects unpatched code", () => {
	const ast = parse(FEATURE_FLAGS_FIXTURE);
	const code = print(ast);
	const result = featureFlags.verify(code, ast);
	assert.notEqual(
		result,
		true,
		"verify should reject unpatched code but got true",
	);
	assert.equal(typeof result, "string");
});

test("feature-flags patches workflow account gate", async () => {
	const ast = parse(FEATURE_FLAGS_FIXTURE);
	await runFeatureFlagsViaPasses(ast);
	const output = print(ast);

	assert.match(
		output,
		/if \(!eH\(process\.env\.CLAUDE_CODE_WORKFLOWS\)\) cached = false;\s*else\s*cached = true;/,
	);
	assert.equal(output.includes('gate("tengu_workflows_enabled", true)'), false);
	assert.equal(featureFlags.verify(output, ast), true);
	assert.equal(featureFlags.verify(output), true);
});

test("feature-flags verify detects unpatched workflow account gate", async () => {
	const ast = parse(FEATURE_FLAGS_FIXTURE);
	await runFeatureFlagsViaPasses(ast);
	const output = print(ast);
	const mutated = output.replace(
		"cached = true;",
		'cached = gate("tengu_workflows_enabled", true);',
	);
	assert.notEqual(mutated, output);

	const result = featureFlags.verify(mutated);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("Old workflow account feature gate"),
		true,
	);
});

test("feature-flags verify detects missing workflow env gate", async () => {
	const ast = parse(FEATURE_FLAGS_FIXTURE);
	await runFeatureFlagsViaPasses(ast);
	const output = print(ast);
	const mutated = output.replace(
		"CLAUDE_CODE_WORKFLOWS",
		"CLAUDE_CODE_WORKFLOWS_BROKEN",
	);
	assert.notEqual(mutated, output);

	const result = featureFlags.verify(mutated);
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("Missing CLAUDE_CODE_WORKFLOWS"), true);
});
