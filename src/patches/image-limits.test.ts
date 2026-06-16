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

const TARGET_KEYS = [
	"claude-fable-5",
	"claude-mythos-5",
	"claude-opus-4-7",
	"claude-opus-4-8",
];

function assertPinnedTo2576(output: string, key: string): void {
	assert.match(
		output,
		new RegExp(
			`"${key}":\\s*\\{\\s*maxWidth:\\s*2576,\\s*maxHeight:\\s*2576\\s*\\}`,
		),
		`expected "${key}" to be pinned to 2576px`,
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
  kv1 = {
    "claude-fable-5": { maxWidth: 2000, maxHeight: 2000 },
    "claude-mythos-5": { maxWidth: 2000, maxHeight: 2000 },
    "claude-opus-4-7": { maxWidth: 2000, maxHeight: 2000 },
    "claude-opus-4-8": { maxWidth: 2000, maxHeight: 2000 },
  };
});
`;

const ALREADY_RESTORED_FIXTURE = `
var kv1;
var wE = T(() => {
  kv1 = {
    "claude-fable-5": { maxWidth: 2576, maxHeight: 2576 },
    "claude-mythos-5": { maxWidth: 2576, maxHeight: 2576 },
    "claude-opus-4-7": { maxWidth: 2576, maxHeight: 2576 },
    "claude-opus-4-8": { maxWidth: 2576, maxHeight: 2576 },
  };
});
`;

const MULTI_ENTRY_FIXTURE = `
var kv1;
var wE = T(() => {
  kv1 = {
    "claude-fable-5": { maxWidth: 2000, maxHeight: 2000 },
    "claude-mythos-5": { maxWidth: 2000, maxHeight: 2000 },
    "claude-opus-4-7": { maxWidth: 2000, maxHeight: 2000 },
    "claude-opus-4-8": { maxWidth: 2000, maxHeight: 2000 },
    "claude-opus-5-0": { maxWidth: 3000, maxHeight: 3000 },
  };
});
`;

const PARTIAL_FIXTURE = `
var kv1;
var wE = T(() => {
  kv1 = {
    "claude-opus-4-7": { maxWidth: 2576, maxHeight: 2576 },
    "claude-opus-4-8": { maxWidth: 2576, maxHeight: 2576 },
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

test("verify rejects when a target model entry is absent from the table", () => {
	const ast = parse(PARTIAL_FIXTURE);
	const code = print(ast);
	const result = imageLimits.verify(code, ast);
	assert.notEqual(result, true);
	assert.equal(typeof result, "string");
	assert.match(result as string, /claude-fable-5/);
	assert.match(result as string, /claude-mythos-5/);
});

test("verify accepts the documented 2576px override", () => {
	const ast = parse(ALREADY_RESTORED_FIXTURE);
	const code = print(ast);
	assert.equal(imageLimits.verify(code, ast), true);
});

test("image-limits restores every high-res model override to 2576px", async () => {
	const ast = parse(DOWNGRADED_FIXTURE);
	await runImageLimitsViaPasses(ast);
	const output = print(ast);

	for (const key of TARGET_KEYS) {
		assertPinnedTo2576(output, key);
	}
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

	for (const key of TARGET_KEYS) {
		assertPinnedTo2576(output, key);
	}
	assert.equal(imageLimits.verify(output, ast), true);
});

test("image-limits leaves non-target entries untouched in a multi-entry table", async () => {
	const ast = parse(MULTI_ENTRY_FIXTURE);
	await runImageLimitsViaPasses(ast);
	const output = print(ast);

	for (const key of TARGET_KEYS) {
		assertPinnedTo2576(output, key);
	}
	assert.match(
		output,
		/"claude-opus-5-0":\s*\{\s*maxWidth:\s*3000,\s*maxHeight:\s*3000\s*\}/,
	);
});

test("verify rejects target entries split across two tables", () => {
	const SPLIT_FIXTURE = `
var a1;
var a2;
var wE = T(() => {
  a1 = {
    "claude-fable-5": { maxWidth: 2576, maxHeight: 2576 },
    "claude-mythos-5": { maxWidth: 2576, maxHeight: 2576 },
  };
  a2 = {
    "claude-opus-4-7": { maxWidth: 2576, maxHeight: 2576 },
    "claude-opus-4-8": { maxWidth: 2576, maxHeight: 2576 },
  };
});
`;
	const ast = parse(SPLIT_FIXTURE);
	const code = print(ast);
	const result = imageLimits.verify(code, ast);
	assert.notEqual(result, true);
	assert.equal(typeof result, "string");
	assert.match(result as string, /2 tables/);
});

test("verify treats a non-literal override value as a missing entry", () => {
	const NON_LITERAL_FIXTURE = `
var BASE_W = 2000;
var kv1;
var wE = T(() => {
  kv1 = {
    "claude-fable-5": { maxWidth: BASE_W, maxHeight: BASE_W },
    "claude-mythos-5": { maxWidth: 2576, maxHeight: 2576 },
    "claude-opus-4-7": { maxWidth: 2576, maxHeight: 2576 },
    "claude-opus-4-8": { maxWidth: 2576, maxHeight: 2576 },
  };
});
`;
	const ast = parse(NON_LITERAL_FIXTURE);
	const code = print(ast);
	const result = imageLimits.verify(code, ast);
	assert.notEqual(result, true);
	assert.match(result as string, /claude-fable-5/);
});

test("image-limits pins only the downgraded entries in a mixed table", async () => {
	const MIXED_FIXTURE = `
var kv1;
var wE = T(() => {
  kv1 = {
    "claude-fable-5": { maxWidth: 2000, maxHeight: 2000 },
    "claude-mythos-5": { maxWidth: 2576, maxHeight: 2576 },
    "claude-opus-4-7": { maxWidth: 2000, maxHeight: 2000 },
    "claude-opus-4-8": { maxWidth: 2576, maxHeight: 2576 },
  };
});
`;
	const ast = parse(MIXED_FIXTURE);
	await runImageLimitsViaPasses(ast);
	const output = print(ast);
	for (const key of TARGET_KEYS) {
		assertPinnedTo2576(output, key);
	}
	assert.equal(imageLimits.verify(output, ast), true);
});

test("image-limits pins exactly the four target entries", async () => {
	const ast = parse(DOWNGRADED_FIXTURE);
	await runImageLimitsViaPasses(ast);
	const output = print(ast);
	const pinned = output.match(/maxWidth:\s*2576,\s*maxHeight:\s*2576/g) ?? [];
	assert.equal(pinned.length, TARGET_KEYS.length);
});
