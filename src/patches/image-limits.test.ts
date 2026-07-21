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
	"claude-sonnet-5",
	"claude-opus-4-7",
	"claude-opus-4-8",
];

const REQUEST_PIPELINE_FIXTURE = `
function Nqe(buffer) {
  let text = buffer.toString("utf8");
  if (text === "VP8X") return { width: 1, height: 1 };
  let match = text.match(/(\\d+)x(\\d+)/);
  return match ? { width: Number(match[1]), height: Number(match[2]) } : void 0;
}
async function _na(e, t) {
  if (e.source.type !== "base64") return { block: e };
  return U$({ data: e.source.data, mediaType: e.source.media_type, limits: t });
}
async function U$({ data, mediaType, limits }) {
  return {
    block: {
      type: "image",
      source: { type: "base64", media_type: mediaType, data: "downscaled" },
    },
    dimensions: { displayWidth: limits.maxWidth, displayHeight: limits.maxHeight },
  };
}
function cy(model) {
  let s = { maxWidth: 2576, maxHeight: 2576, maxBase64Size: 5242880, targetRawSize: 3932160 };
  return {
    maxWidth: s.maxWidth,
    maxHeight: s.maxHeight,
    maxBase64Size: s.maxBase64Size,
    targetRawSize: s.targetRawSize,
  };
}
function q() {}
function Xp() {}
function zWn() {
  return true;
}
function CVf(e, t) {
  return { messagesPreNormalize: e, messagesForAPI: e, midConvFallback: () => e };
}
function Wq(x) {
  return x;
}
async function* query(e, s) {
  q("tengu_api_before_normalize", { preNormalizedMessageCount: e.length });
  Xp("query_message_normalization_start");
  let h = s.model,
    S = [],
    p = [],
    $ = false,
    _ = false,
    y = void 0;
  let {
      messagesPreNormalize: L,
      messagesForAPI: O,
      midConvFallback: j,
    } = CVf(e, {
      model: s.model,
      bodyModel: h,
      tools: S,
      betas: p,
      midConvLatchedOff: $,
      useToolSearch: _,
      advisorModel: y,
    }),
    N = O,
    M = j;
  let Ct = null,
    el = (Qo) => {
      let Fo = zWn(Qo),
        lo = p.includes("z") && !Fo;
      if (M && (Fo || lo)) {
        if (((N = Fo ? M() : Wq(N)), (M = null), Fo))
          p = p.filter((Do) => Do !== "v");
        return "retry:mid-conv-system";
      }
      return;
    };
  q("tengu_api_after_normalize", { postNormalizedMessageCount: N.length });
  let Pi = el(Ct);
  if (Pi) return Pi;
  return N;
}
`;

function withRequestPipeline(source: string): string {
	return `${source}\n${REQUEST_PIPELINE_FIXTURE}`;
}

async function patchImageLimitsFixture(source: string): Promise<{
	ast: any;
	output: string;
}> {
	const ast = parse(source);
	await runImageLimitsViaPasses(ast);
	return { ast, output: print(ast) };
}

function assertPinnedTo2576(output: string, key: string): void {
	assert.match(
		output,
		new RegExp(
			`id:\\s*"${key}"[\\s\\S]*?image_limits:\\s*\\{\\s*maxWidth:\\s*2576,\\s*maxHeight:\\s*2576\\s*\\}`,
		),
		`expected "${key}" to be pinned to 2576px`,
	);
}

const DOWNGRADED_FIXTURE = `
let baseLimits;
let registry;
function imageLimitsFor(model) {
  let canonical = model ? normalizeModel(model) : void 0;
  let metadataLimits = canonical ? registry.models.find((entry) => entry.id === canonical)?.image_limits : void 0;
  return metadataLimits
    ? { maxWidth: metadataLimits.maxWidth, maxHeight: metadataLimits.maxHeight, maxBase64Size: metadataLimits.maxBase64Size }
    : void 0;
}
function initRegistry() {
  baseLimits = { maxWidth: 2000, maxHeight: 2000, maxBase64Size: 5242880, targetRawSize: 3932160 };
  registry = {
    models: [
      { id: "claude-opus-4-7", image_limits: { maxWidth: 2000, maxHeight: 2000 } },
      { id: "claude-opus-4-8", image_limits: { maxWidth: 2000, maxHeight: 2000 } },
      { id: "claude-fable-5", image_limits: { maxWidth: 2000, maxHeight: 2000 } },
      { id: "claude-sonnet-5", image_limits: { maxWidth: 2000, maxHeight: 2000 } },
      { id: "claude-mythos-5", image_limits: { maxWidth: 2000, maxHeight: 2000 } },
    ],
  };
}
`;

const ALREADY_RESTORED_FIXTURE = `
let registry;
function imageLimitsFor(model) {
  let canonical = model ? normalizeModel(model) : void 0;
  let metadataLimits = canonical ? registry.models.find((entry) => entry.id === canonical)?.image_limits : void 0;
  return metadataLimits
    ? { maxWidth: metadataLimits.maxWidth, maxHeight: metadataLimits.maxHeight, maxBase64Size: metadataLimits.maxBase64Size }
    : void 0;
}
function initRegistry() {
  registry = {
    models: [
      { id: "claude-opus-4-7", image_limits: { maxWidth: 2576, maxHeight: 2576 } },
      { id: "claude-opus-4-8", image_limits: { maxWidth: 2576, maxHeight: 2576 } },
      { id: "claude-fable-5", image_limits: { maxWidth: 2576, maxHeight: 2576 } },
      { id: "claude-sonnet-5", image_limits: { maxWidth: 2576, maxHeight: 2576 } },
      { id: "claude-mythos-5", image_limits: { maxWidth: 2576, maxHeight: 2576 } },
    ],
  };
}
`;

const MULTI_ENTRY_FIXTURE = `
let registry;
function imageLimitsFor(model) {
  let canonical = model ? normalizeModel(model) : void 0;
  let metadataLimits = canonical ? registry.models.find((entry) => entry.id === canonical)?.image_limits : void 0;
  return metadataLimits
    ? { maxWidth: metadataLimits.maxWidth, maxHeight: metadataLimits.maxHeight, maxBase64Size: metadataLimits.maxBase64Size }
    : void 0;
}
function initRegistry() {
  registry = {
    models: [
      { id: "claude-opus-4-7", image_limits: { maxWidth: 2000, maxHeight: 2000 } },
      { id: "claude-opus-4-8", image_limits: { maxWidth: 2000, maxHeight: 2000 } },
      { id: "claude-fable-5", image_limits: { maxWidth: 2000, maxHeight: 2000 } },
      { id: "claude-sonnet-5", image_limits: { maxWidth: 2000, maxHeight: 2000 } },
      { id: "claude-mythos-5", image_limits: { maxWidth: 2000, maxHeight: 2000 } },
      { id: "claude-opus-5-0", image_limits: { maxWidth: 3000, maxHeight: 3000 } },
    ],
  };
}
`;

const PARTIAL_FIXTURE = `
let registry;
function imageLimitsFor(model) {
  let canonical = model ? normalizeModel(model) : void 0;
  let metadataLimits = canonical ? registry.models.find((entry) => entry.id === canonical)?.image_limits : void 0;
  return metadataLimits
    ? { maxWidth: metadataLimits.maxWidth, maxHeight: metadataLimits.maxHeight, maxBase64Size: metadataLimits.maxBase64Size }
    : void 0;
}
function initRegistry() {
  registry = {
    models: [
      { id: "claude-opus-4-7", image_limits: { maxWidth: 2576, maxHeight: 2576 } },
      { id: "claude-opus-4-8", image_limits: { maxWidth: 2576, maxHeight: 2576 } },
    ],
  };
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

test("verify accepts the documented 2576px override", async () => {
	const { ast, output } = await patchImageLimitsFixture(
		withRequestPipeline(ALREADY_RESTORED_FIXTURE),
	);
	assert.equal(imageLimits.verify(output, ast), true);
});

test("image-limits restores every high-res model override to 2576px", async () => {
	const { ast, output } = await patchImageLimitsFixture(
		withRequestPipeline(DOWNGRADED_FIXTURE),
	);

	for (const key of TARGET_KEYS) {
		assertPinnedTo2576(output, key);
	}
	assert.equal(imageLimits.verify(output, ast), true);
});

test("image-limits leaves the base default limits untouched", async () => {
	const { output } = await patchImageLimitsFixture(
		withRequestPipeline(DOWNGRADED_FIXTURE),
	);

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
	const { ast, output } = await patchImageLimitsFixture(
		withRequestPipeline(ALREADY_RESTORED_FIXTURE),
	);

	for (const key of TARGET_KEYS) {
		assertPinnedTo2576(output, key);
	}
	assert.equal(imageLimits.verify(output, ast), true);
});

test("image-limits leaves non-target model metadata untouched", async () => {
	const { output } = await patchImageLimitsFixture(
		withRequestPipeline(MULTI_ENTRY_FIXTURE),
	);

	for (const key of TARGET_KEYS) {
		assertPinnedTo2576(output, key);
	}
	assert.match(
		output,
		/id:\s*"claude-opus-5-0"[\s\S]*?image_limits:\s*\{\s*maxWidth:\s*3000,\s*maxHeight:\s*3000\s*\}/,
	);
});

test("verify rejects when the many-image downscale guard is absent", () => {
	const ast = parse(withRequestPipeline(ALREADY_RESTORED_FIXTURE));
	const code = print(ast);
	const result = imageLimits.verify(code, ast);
	assert.notEqual(result, true);
	assert.match(result as string, /Many-image high-resolution downscale guard/);
});

test("image-limits downscales high-resolution many-image requests before API submission", async () => {
	const { ast, output } = await patchImageLimitsFixture(
		withRequestPipeline(ALREADY_RESTORED_FIXTURE),
	);

	assert.equal(imageLimits.verify(output, ast), true);
	assert.match(output, /__ccEnhancedVisualBlockCount <= 20/);
	assert.match(output, /block\.type === "document"/);
	assert.match(
		output,
		/__ccEnhancedImageBlocks\.some\(__ccEnhancedImageTooLargeForManyImage\)/,
	);
	assert.match(output, /__ccEnhancedBlock\.type === "tool_result"/);
	assert.match(output, /Array\.isArray\(__ccEnhancedBlock\.content\)/);
	assert.match(
		output,
		/Buffer\.from\(source\.data\.slice\(0,\s*87400\),\s*"base64"\)/,
	);
	assert.match(output, /parsed\.width > 2000/);
	assert.match(output, /parsed\.height > 2000/);
	assert.match(output, /maxWidth:\s*2000/);
	assert.match(output, /maxHeight:\s*2000/);
	assert.match(output, /await _na\(block,\s*limits\)/);
	assert.match(output, /normalized\?\.block \?\? block/);
	assert.match(output, /\.\.\.cy\(s\.model\)/);
	assert.doesNotMatch(output, /\.\.\.cy\(h\)/);
	assert.match(
		output,
		/N = await __ccEnhancedDownscaleManyImageMessages\(N,\s*__ccEnhancedManyImageLimits\)/,
	);
	assert.match(
		output,
		/let __ccEnhancedDownscaledMidConvFallback = await __ccEnhancedDownscaleManyImageMessages\(\s*M\(\),/,
	);
	assert.match(output, /M = \(\) => __ccEnhancedDownscaledMidConvFallback/);
	assert.doesNotMatch(output, /M = async \(\)/);
	assert.match(output, /N = Fo \? M\(\) : Wq\(N\)/);
	assert.doesNotMatch(output, /await M\(\)/);
	assert.doesNotMatch(output, /\[media removed: request limit\]/);

	const guardIndex = output.indexOf("__ccEnhancedVisualBlockCount");
	const normalizeEndIndex = output.indexOf('q("tengu_api_after_normalize"');
	assert.ok(guardIndex >= 0, "many-image guard not found");
	assert.ok(
		normalizeEndIndex > guardIndex,
		"guard must run before the API request proceeds",
	);
});

test("verify rejects a fallback wrapper that returns a promise", async () => {
	const { output } = await patchImageLimitsFixture(
		withRequestPipeline(ALREADY_RESTORED_FIXTURE),
	);
	const broken = output.replace(
		"M = () => __ccEnhancedDownscaledMidConvFallback",
		"M = async () => __ccEnhancedDownscaledMidConvFallback",
	);
	assert.notEqual(broken, output);
	const ast = parse(broken);
	const result = imageLimits.verify(broken, ast);
	assert.notEqual(result, true);
});

test("verify treats a non-literal override value as a missing entry", () => {
	const NON_LITERAL_FIXTURE = `
let BASE_W = 2000;
let registry;
function imageLimitsFor(model) {
  let canonical = model ? normalizeModel(model) : void 0;
  let metadataLimits = canonical ? registry.models.find((entry) => entry.id === canonical)?.image_limits : void 0;
  return metadataLimits
    ? { maxWidth: metadataLimits.maxWidth, maxHeight: metadataLimits.maxHeight, maxBase64Size: metadataLimits.maxBase64Size }
    : void 0;
}
function initRegistry() {
  registry = {
    models: [
      { id: "claude-fable-5", image_limits: { maxWidth: BASE_W, maxHeight: BASE_W } },
      { id: "claude-mythos-5", image_limits: { maxWidth: 2576, maxHeight: 2576 } },
      { id: "claude-sonnet-5", image_limits: { maxWidth: 2576, maxHeight: 2576 } },
      { id: "claude-opus-4-7", image_limits: { maxWidth: 2576, maxHeight: 2576 } },
      { id: "claude-opus-4-8", image_limits: { maxWidth: 2576, maxHeight: 2576 } },
    ],
  };
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
let registry;
function imageLimitsFor(model) {
  let canonical = model ? normalizeModel(model) : void 0;
  let metadataLimits = canonical ? registry.models.find((entry) => entry.id === canonical)?.image_limits : void 0;
  return metadataLimits
    ? { maxWidth: metadataLimits.maxWidth, maxHeight: metadataLimits.maxHeight, maxBase64Size: metadataLimits.maxBase64Size }
    : void 0;
}
function initRegistry() {
  registry = {
    models: [
      { id: "claude-fable-5", image_limits: { maxWidth: 2000, maxHeight: 2000 } },
      { id: "claude-mythos-5", image_limits: { maxWidth: 2576, maxHeight: 2576 } },
      { id: "claude-sonnet-5", image_limits: { maxWidth: 2000, maxHeight: 2000 } },
      { id: "claude-opus-4-7", image_limits: { maxWidth: 2000, maxHeight: 2000 } },
      { id: "claude-opus-4-8", image_limits: { maxWidth: 2576, maxHeight: 2576 } },
    ],
  };
}
`;
	const { ast, output } = await patchImageLimitsFixture(
		withRequestPipeline(MIXED_FIXTURE),
	);
	for (const key of TARGET_KEYS) {
		assertPinnedTo2576(output, key);
	}
	assert.equal(imageLimits.verify(output, ast), true);
});

test("image-limits pins exactly the five target entries", async () => {
	const { output } = await patchImageLimitsFixture(
		withRequestPipeline(DOWNGRADED_FIXTURE),
	);
	const pinned =
		output.match(
			/image_limits:\s*\{\s*maxWidth:\s*2576,\s*maxHeight:\s*2576/g,
		) ?? [];
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

test("image-limits pins exactly five entries and never the adjacent base default object", async () => {
	const { output } = await patchImageLimitsFixture(
		withRequestPipeline(DOWNGRADED_FIXTURE),
	);

	const pinned =
		output.match(
			/image_limits:\s*\{\s*maxWidth:\s*2576,\s*maxHeight:\s*2576/g,
		) ?? [];
	assert.equal(
		pinned.length,
		TARGET_KEYS.length,
		"expected exactly the five model entries pinned to 2576",
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

test("verify accepts model metadata with a co-located base default object", async () => {
	const CO_LOCATED_FIXTURE = `
let baseLimits;
let registry;
function imageLimitsFor(model) {
  let canonical = model ? normalizeModel(model) : void 0;
  let metadataLimits = canonical ? registry.models.find((entry) => entry.id === canonical)?.image_limits : void 0;
  return metadataLimits
    ? { maxWidth: metadataLimits.maxWidth, maxHeight: metadataLimits.maxHeight, maxBase64Size: metadataLimits.maxBase64Size }
    : void 0;
}
function initRegistry() {
  baseLimits = { maxWidth: 2000, maxHeight: 2000, maxBase64Size: 5242880, targetRawSize: 3932160 };
  registry = {
    models: [
      { id: "claude-opus-4-7", image_limits: { maxWidth: 2576, maxHeight: 2576 } },
      { id: "claude-opus-4-8", image_limits: { maxWidth: 2576, maxHeight: 2576 } },
      { id: "claude-fable-5", image_limits: { maxWidth: 2576, maxHeight: 2576 } },
      { id: "claude-sonnet-5", image_limits: { maxWidth: 2576, maxHeight: 2576 } },
      { id: "claude-mythos-5", image_limits: { maxWidth: 2576, maxHeight: 2576 } },
    ],
  };
}
`;
	const { ast, output } = await patchImageLimitsFixture(
		withRequestPipeline(CO_LOCATED_FIXTURE),
	);
	// The base default object has numeric maxWidth/maxHeight but no model id,
	// so it must not be counted as one of the target metadata entries.
	assert.equal(imageLimits.verify(output, ast), true);
});
