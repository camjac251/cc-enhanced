import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { featureFlags } from "./flag-bypass.js";

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

// gateA has 2 target-flag calls, audit has 1 => gateA wins unambiguously
const FIXTURE = `
const keep = gate("unrelated_flag", false);
const amber = gateA("tengu_amber_flint", !1);
const amber2 = gateA("tengu_amber_flint", !1);
const unrelated = gateB("tengu_mulberry_fog_meta", false);
const auditOnly = audit("tengu_amber_flint", false);
`;

test("verify rejects unpatched code", () => {
	const ast = parse(FIXTURE);
	const code = print(ast);
	const result = featureFlags.verify(code, ast);
	assert.notEqual(
		result,
		true,
		"verify should reject unpatched code but got true",
	);
	assert.equal(typeof result, "string");
});

test("flag-bypass patches only the resolved gate callee", async () => {
	const input = FIXTURE;
	const ast = parse(input);
	await runFeatureFlagsViaPasses(ast);
	const output = print(ast);

	assert.equal(output.includes('gateA("tengu_amber_flint"'), false);
	assert.equal(output.includes("const amber = true"), true);
	assert.equal(output.includes("const amber2 = true"), true);
	assert.equal(output.includes('gate("unrelated_flag", false)'), true);
	assert.equal(
		output.includes('gateB("tengu_mulberry_fog_meta", false)'),
		true,
	);
	assert.equal(output.includes('audit("tengu_amber_flint", false)'), true);
	assert.equal(featureFlags.verify(output, ast), true);
});

test("flag-bypass fails verification when selected gate callee still has target flag call", () => {
	const output = `
const keep = gateA("tengu_amber_flint", false);
`;
	const ast = parse(output);
	const result = featureFlags.verify(output, ast);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("Feature flag gate calls still present"),
		true,
	);
});

test("flag-bypass verification passes when target flags are absent upstream", () => {
	const output = `
const keep = gate("different_flag", false);
const other = gateB("still_not_targeted", true);
`;
	const ast = parse(output);
	assert.equal(featureFlags.verify(output, ast), true);
});

test("flag-bypass fails closed when cached scan sees target flags but no patchable gate shape", async () => {
	const drifted = `
const amber = gateA("tengu_amber_flint", readDefault());
`;
	const ast = parse(drifted);
	await featureFlags.astPasses?.(ast);
	const result = featureFlags.verify(print(ast), ast);
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("no patchable gate calls found"), true);
});
