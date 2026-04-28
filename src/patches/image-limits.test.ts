import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { imageLimits } from "./image-limits.js";

async function runImageLimitsViaPasses(ast: any): Promise<void> {
	const passes = (await imageLimits.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: imageLimits.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

const DOWNGRADED_FIXTURE = `
var nQ;
var nr = T(() => {
  nQ = { maxWidth: 2000, maxHeight: 2000, maxBase64Size: 5242880, targetRawSize: 3932160 };
});
var kv1;
var wE = T(() => {
  nr();
  kv1 = { "claude-opus-4-7": { maxWidth: 2000, maxHeight: 2000 } };
});
`;

const ALREADY_RESTORED_FIXTURE = `
var kv1;
var wE = T(() => {
  kv1 = { "claude-opus-4-7": { maxWidth: 2576, maxHeight: 2576 } };
});
`;

const MULTI_ENTRY_FIXTURE = `
var kv1;
var wE = T(() => {
  kv1 = {
    "claude-opus-4-7": { maxWidth: 2000, maxHeight: 2000 },
    "claude-opus-5-0": { maxWidth: 3000, maxHeight: 3000 },
  };
});
`;

const MISSING_FIXTURE = `
var kv1;
var wE = T(() => {
  kv1 = {};
});
`;

test("verify rejects the downgraded 2000px override", () => {
	const ast = parse(DOWNGRADED_FIXTURE);
	const code = print(ast);
	const result = imageLimits.verify(code, ast);
	assert.notEqual(result, true);
	assert.equal(typeof result, "string");
});

test("verify rejects when override is missing entirely", () => {
	const ast = parse(MISSING_FIXTURE);
	const code = print(ast);
	const result = imageLimits.verify(code, ast);
	assert.notEqual(result, true);
});

test("verify accepts the documented 2576px override", () => {
	const ast = parse(ALREADY_RESTORED_FIXTURE);
	const code = print(ast);
	assert.equal(imageLimits.verify(code, ast), true);
});

test("image-limits restores Opus 4.7 to 2576px", async () => {
	const ast = parse(DOWNGRADED_FIXTURE);
	await runImageLimitsViaPasses(ast);
	const output = print(ast);

	assert.match(
		output,
		/"claude-opus-4-7":\s*\{\s*maxWidth:\s*2576,\s*maxHeight:\s*2576\s*\}/,
	);
	assert.equal(imageLimits.verify(output, ast), true);
});

test("image-limits leaves the base default table untouched", async () => {
	const ast = parse(DOWNGRADED_FIXTURE);
	await runImageLimitsViaPasses(ast);
	const output = print(ast);

	assert.match(output, /maxBase64Size:\s*5242880/);
	assert.match(output, /targetRawSize:\s*3932160/);
	const baseDefaultMatch = output.match(
		/nQ\s*=\s*\{\s*maxWidth:\s*(\d+),\s*maxHeight:\s*(\d+)/,
	);
	assert.ok(baseDefaultMatch, "base default table not found");
	assert.equal(baseDefaultMatch[1], "2000");
	assert.equal(baseDefaultMatch[2], "2000");
});

test("image-limits is idempotent", async () => {
	const ast = parse(ALREADY_RESTORED_FIXTURE);
	await runImageLimitsViaPasses(ast);
	const output = print(ast);

	assert.match(
		output,
		/"claude-opus-4-7":\s*\{\s*maxWidth:\s*2576,\s*maxHeight:\s*2576\s*\}/,
	);
	assert.equal(imageLimits.verify(output, ast), true);
});

test("image-limits only touches the Opus 4.7 entry in a multi-entry table", async () => {
	const ast = parse(MULTI_ENTRY_FIXTURE);
	await runImageLimitsViaPasses(ast);
	const output = print(ast);

	assert.match(
		output,
		/"claude-opus-4-7":\s*\{\s*maxWidth:\s*2576,\s*maxHeight:\s*2576\s*\}/,
	);
	assert.match(
		output,
		/"claude-opus-5-0":\s*\{\s*maxWidth:\s*3000,\s*maxHeight:\s*3000\s*\}/,
	);
});
