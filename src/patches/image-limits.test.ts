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
			`id:\\s*"${key}"[\\s\\S]*?image_limits:\\s*\\{\\s*maxWidth:\\s*2576,\\s*maxHeight:\\s*2576\\s*\\}`,
		),
		`expected "${key}" to be pinned to 2576px`,
	);
}

function assertMythosFallbackPinnedTo2576(output: string): void {
	assert.match(
		output,
		/mythosLimits\s*=\s*\{\s*maxWidth:\s*2576,\s*maxHeight:\s*2576\s*\}/,
		"expected Mythos fallback limits to be pinned to 2576px",
	);
}

const DOWNGRADED_FIXTURE = `
let baseLimits;
let mythosLimits;
let registry;
function imageLimitsFor(model) {
  let canonical = model ? normalizeModel(model) : void 0;
  let metadataLimits = canonical ? registry.models.find((entry) => entry.id === canonical)?.image_limits : void 0;
  return metadataLimits
    ? { maxWidth: metadataLimits.maxWidth, maxHeight: metadataLimits.maxHeight, maxBase64Size: metadataLimits.maxBase64Size }
    : canonical === "claude-mythos-5"
      ? mythosLimits
      : void 0;
}
function initRegistry() {
  baseLimits = { maxWidth: 2000, maxHeight: 2000, maxBase64Size: 5242880, targetRawSize: 3932160 };
  registry = {
    models: [
      { id: "claude-opus-4-7", image_limits: { maxWidth: 2000, maxHeight: 2000 } },
      { id: "claude-opus-4-8", image_limits: { maxWidth: 2000, maxHeight: 2000 } },
      { id: "claude-fable-5", image_limits: { maxWidth: 2000, maxHeight: 2000 } },
      { id: "claude-mythos-5" },
    ],
  };
  mythosLimits = { maxWidth: 2000, maxHeight: 2000 };
}
`;

const ALREADY_RESTORED_FIXTURE = `
let mythosLimits;
let registry;
function imageLimitsFor(model) {
  let canonical = model ? normalizeModel(model) : void 0;
  let metadataLimits = canonical ? registry.models.find((entry) => entry.id === canonical)?.image_limits : void 0;
  return metadataLimits
    ? { maxWidth: metadataLimits.maxWidth, maxHeight: metadataLimits.maxHeight, maxBase64Size: metadataLimits.maxBase64Size }
    : canonical === "claude-mythos-5"
      ? mythosLimits
      : void 0;
}
function initRegistry() {
  registry = {
    models: [
      { id: "claude-opus-4-7", image_limits: { maxWidth: 2576, maxHeight: 2576 } },
      { id: "claude-opus-4-8", image_limits: { maxWidth: 2576, maxHeight: 2576 } },
      { id: "claude-fable-5", image_limits: { maxWidth: 2576, maxHeight: 2576 } },
      { id: "claude-mythos-5" },
    ],
  };
  mythosLimits = { maxWidth: 2576, maxHeight: 2576 };
}
`;

const MULTI_ENTRY_FIXTURE = `
let mythosLimits;
let registry;
function imageLimitsFor(model) {
  let canonical = model ? normalizeModel(model) : void 0;
  let metadataLimits = canonical ? registry.models.find((entry) => entry.id === canonical)?.image_limits : void 0;
  return metadataLimits
    ? { maxWidth: metadataLimits.maxWidth, maxHeight: metadataLimits.maxHeight, maxBase64Size: metadataLimits.maxBase64Size }
    : canonical === "claude-mythos-5"
      ? mythosLimits
      : void 0;
}
function initRegistry() {
  registry = {
    models: [
      { id: "claude-opus-4-7", image_limits: { maxWidth: 2000, maxHeight: 2000 } },
      { id: "claude-opus-4-8", image_limits: { maxWidth: 2000, maxHeight: 2000 } },
      { id: "claude-fable-5", image_limits: { maxWidth: 2000, maxHeight: 2000 } },
      { id: "claude-mythos-5" },
      { id: "claude-opus-5-0", image_limits: { maxWidth: 3000, maxHeight: 3000 } },
    ],
  };
  mythosLimits = { maxWidth: 2000, maxHeight: 2000 };
}
`;

const PARTIAL_FIXTURE = `
let mythosLimits;
let registry;
function imageLimitsFor(model) {
  let canonical = model ? normalizeModel(model) : void 0;
  let metadataLimits = canonical ? registry.models.find((entry) => entry.id === canonical)?.image_limits : void 0;
  return metadataLimits
    ? { maxWidth: metadataLimits.maxWidth, maxHeight: metadataLimits.maxHeight, maxBase64Size: metadataLimits.maxBase64Size }
    : canonical === "claude-mythos-5"
      ? mythosLimits
      : void 0;
}
function initRegistry() {
  registry = {
    models: [
      { id: "claude-opus-4-7", image_limits: { maxWidth: 2576, maxHeight: 2576 } },
      { id: "claude-opus-4-8", image_limits: { maxWidth: 2576, maxHeight: 2576 } },
    ],
  };
  mythosLimits = { maxWidth: 2576, maxHeight: 2576 };
}
`;

const MISSING_FIXTURE = `
let registry = { models: [] };
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

test("verify rejects when a target model entry is absent from metadata", () => {
	const ast = parse(PARTIAL_FIXTURE);
	const code = print(ast);
	const result = imageLimits.verify(code, ast);
	assert.notEqual(result, true);
	assert.equal(typeof result, "string");
	assert.match(result as string, /claude-fable-5/);
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
		if (key === "claude-mythos-5") assertMythosFallbackPinnedTo2576(output);
		else assertPinnedTo2576(output, key);
	}
	assert.equal(imageLimits.verify(output, ast), true);
});

test("image-limits leaves the base default limits untouched", async () => {
	const ast = parse(DOWNGRADED_FIXTURE);
	await runImageLimitsViaPasses(ast);
	const output = print(ast);

	assert.match(output, /maxBase64Size:\s*5242880/);
	assert.match(output, /targetRawSize:\s*3932160/);
	const baseDefaultMatch = output.match(
		/baseLimits\s*=\s*\{\s*maxWidth:\s*(\d+),\s*maxHeight:\s*(\d+)/,
	);
	assert.ok(baseDefaultMatch, "base default limits not found");
	assert.equal(baseDefaultMatch[1], "2000");
	assert.equal(baseDefaultMatch[2], "2000");
});

test("image-limits is idempotent", async () => {
	const ast = parse(ALREADY_RESTORED_FIXTURE);
	await runImageLimitsViaPasses(ast);
	const output = print(ast);

	for (const key of TARGET_KEYS) {
		if (key === "claude-mythos-5") assertMythosFallbackPinnedTo2576(output);
		else assertPinnedTo2576(output, key);
	}
	assert.equal(imageLimits.verify(output, ast), true);
});

test("image-limits leaves non-target model metadata untouched", async () => {
	const ast = parse(MULTI_ENTRY_FIXTURE);
	await runImageLimitsViaPasses(ast);
	const output = print(ast);

	for (const key of TARGET_KEYS) {
		if (key === "claude-mythos-5") assertMythosFallbackPinnedTo2576(output);
		else assertPinnedTo2576(output, key);
	}
	assert.match(
		output,
		/id:\s*"claude-opus-5-0"[\s\S]*?image_limits:\s*\{\s*maxWidth:\s*3000,\s*maxHeight:\s*3000\s*\}/,
	);
});

test("verify treats a non-literal override value as a missing entry", () => {
	const NON_LITERAL_FIXTURE = `
let BASE_W = 2000;
let mythosLimits;
let registry;
function imageLimitsFor(model) {
  let canonical = model ? normalizeModel(model) : void 0;
  let metadataLimits = canonical ? registry.models.find((entry) => entry.id === canonical)?.image_limits : void 0;
  return metadataLimits
    ? { maxWidth: metadataLimits.maxWidth, maxHeight: metadataLimits.maxHeight, maxBase64Size: metadataLimits.maxBase64Size }
    : canonical === "claude-mythos-5"
      ? mythosLimits
      : void 0;
}
function initRegistry() {
  registry = {
    models: [
      { id: "claude-fable-5", image_limits: { maxWidth: BASE_W, maxHeight: BASE_W } },
      { id: "claude-opus-4-7", image_limits: { maxWidth: 2576, maxHeight: 2576 } },
      { id: "claude-opus-4-8", image_limits: { maxWidth: 2576, maxHeight: 2576 } },
    ],
  };
  mythosLimits = { maxWidth: 2576, maxHeight: 2576 };
}
`;
	const ast = parse(NON_LITERAL_FIXTURE);
	const code = print(ast);
	const result = imageLimits.verify(code, ast);
	assert.notEqual(result, true);
	assert.match(result as string, /claude-fable-5/);
});

test("image-limits pins only the downgraded entries in mixed metadata", async () => {
	const MIXED_FIXTURE = `
let mythosLimits;
let registry;
function imageLimitsFor(model) {
  let canonical = model ? normalizeModel(model) : void 0;
  let metadataLimits = canonical ? registry.models.find((entry) => entry.id === canonical)?.image_limits : void 0;
  return metadataLimits
    ? { maxWidth: metadataLimits.maxWidth, maxHeight: metadataLimits.maxHeight, maxBase64Size: metadataLimits.maxBase64Size }
    : canonical === "claude-mythos-5"
      ? mythosLimits
      : void 0;
}
function initRegistry() {
  registry = {
    models: [
      { id: "claude-fable-5", image_limits: { maxWidth: 2000, maxHeight: 2000 } },
      { id: "claude-opus-4-7", image_limits: { maxWidth: 2000, maxHeight: 2000 } },
      { id: "claude-opus-4-8", image_limits: { maxWidth: 2576, maxHeight: 2576 } },
    ],
  };
  mythosLimits = { maxWidth: 2576, maxHeight: 2576 };
}
`;
	const ast = parse(MIXED_FIXTURE);
	await runImageLimitsViaPasses(ast);
	const output = print(ast);
	for (const key of TARGET_KEYS) {
		if (key === "claude-mythos-5") assertMythosFallbackPinnedTo2576(output);
		else assertPinnedTo2576(output, key);
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

test("verify does not count the base default object as model metadata", () => {
	const BASE_DEFAULT_ONLY_FIXTURE = `
let baseLimits;
function initRegistry() {
  baseLimits = { maxWidth: 2000, maxHeight: 2000, maxBase64Size: 5242880, targetRawSize: 3932160 };
}
`;
	const ast = parse(BASE_DEFAULT_ONLY_FIXTURE);
	const code = print(ast);
	const result = imageLimits.verify(code, ast);
	// The base default object has numeric maxWidth/maxHeight but no model id,
	// so it must be structurally excluded from model metadata matching.
	assert.notEqual(result, true);
	assert.match(result as string, /missing/);
});

test("image-limits pins exactly four entries and never the adjacent base default object", async () => {
	const ast = parse(DOWNGRADED_FIXTURE);
	await runImageLimitsViaPasses(ast);
	const output = print(ast);

	const pinned = output.match(/maxWidth:\s*2576,\s*maxHeight:\s*2576/g) ?? [];
	assert.equal(
		pinned.length,
		TARGET_KEYS.length,
		"expected exactly the four model entries pinned to 2576",
	);

	// The base default object lives in an adjacent initializer; the matcher must
	// not leak into it, so its dimensions stay at 2000.
	const baseDefault = output.match(
		/maxWidth:\s*(\d+),\s*maxHeight:\s*(\d+),\s*maxBase64Size/,
	);
	assert.ok(baseDefault, "base default object not found");
	assert.equal(baseDefault[1], "2000");
	assert.equal(baseDefault[2], "2000");
});

test("verify accepts model metadata with a co-located base default object", () => {
	const CO_LOCATED_FIXTURE = `
let baseLimits;
let mythosLimits;
let registry;
function imageLimitsFor(model) {
  let canonical = model ? normalizeModel(model) : void 0;
  let metadataLimits = canonical ? registry.models.find((entry) => entry.id === canonical)?.image_limits : void 0;
  return metadataLimits
    ? { maxWidth: metadataLimits.maxWidth, maxHeight: metadataLimits.maxHeight, maxBase64Size: metadataLimits.maxBase64Size }
    : canonical === "claude-mythos-5"
      ? mythosLimits
      : void 0;
}
function initRegistry() {
  baseLimits = { maxWidth: 2000, maxHeight: 2000, maxBase64Size: 5242880, targetRawSize: 3932160 };
  registry = {
    models: [
      { id: "claude-opus-4-7", image_limits: { maxWidth: 2576, maxHeight: 2576 } },
      { id: "claude-opus-4-8", image_limits: { maxWidth: 2576, maxHeight: 2576 } },
      { id: "claude-fable-5", image_limits: { maxWidth: 2576, maxHeight: 2576 } },
      { id: "claude-mythos-5" },
    ],
  };
  mythosLimits = { maxWidth: 2576, maxHeight: 2576 };
}
`;
	const ast = parse(CO_LOCATED_FIXTURE);
	const code = print(ast);
	// The base default object has numeric maxWidth/maxHeight but no model id,
	// so it must not be counted as one of the target metadata entries.
	assert.equal(imageLimits.verify(code, ast), true);
});
