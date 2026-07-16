import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { modelContextMetadata } from "./model-context-metadata.js";

async function runModelContextMetadataViaPasses(ast: any): Promise<void> {
	const passes = (await modelContextMetadata.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: modelContextMetadata.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

const MODEL_CONTEXT_FIXTURE = `
const env = {
  CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: true,
  CLAUDE_CODE_MAX_CONTEXT_TOKENS: 333000,
};
let cachedModels = [];
function cacheDir() { return "/tmp/cache"; }
function modelCapabilitiesPath() { return join(cacheDir(), "model-capabilities.json"); }
function capabilitiesEnabled() { return !1; }
function sortCapabilities(models) {
  return [...models].sort((left, right) => right.id.length - left.id.length);
}
function readCapabilities() { return sortCapabilities(cachedModels); }
function getModelCapability(model) {
  if (!capabilitiesEnabled()) return;
  const models = readCapabilities(modelCapabilitiesPath());
  if (!models || models.length === 0) return;
  const normalized = model.toLowerCase();
  const exact = models.find((entry) => entry.id.toLowerCase() === normalized);
  if (exact) return exact;
  return models.find((entry) => normalized.includes(entry.id.toLowerCase()));
}
const capabilitySchema = schema.object({
  id: schema.string(),
  max_input_tokens: schema.number().optional(),
  max_tokens: schema.number().optional(),
}).strip();
function nativeOneMillion(model) { return model === "native-1m"; }
function providerWindow() { return null; }
function normalizeModel(model) { return model; }
function contextWindow(model, betas) {
  if (model.endsWith("[1m]")) return 1e6;
  if (betas?.includes("context-1m") && nativeOneMillion(model)) return 1e6;
  if (nativeOneMillion(model)) return 1e6;
  const provider = providerWindow(model);
  if (provider !== null) return provider;
  const fallback = env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
  if (fallback !== undefined && fallback > 0 && !normalizeModel(model).startsWith("claude-")) return fallback;
  return 200000;
}
function outputLimit(model) {
  let upper = 32000;
  const capability = getModelCapability(model);
  if (capability?.max_tokens && capability.max_tokens >= 4096) upper = capability.max_tokens;
  return upper;
}
`;

function evaluatePatched(code: string): {
	setModels: (models: unknown[]) => void;
	setDiscovery: (enabled: boolean) => void;
	contextWindow: (model: string, betas?: string[]) => number;
	outputLimit: (model: string) => number;
} {
	return Function(
		"join",
		"schema",
		`${code}
return {
  setModels(models) { cachedModels = models; },
  setDiscovery(enabled) { env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = enabled; },
  contextWindow,
  outputLimit,
};`,
	)((...parts: string[]) => parts.join("/"), {
		object: (value: unknown) => ({ strip: () => value }),
		string: () => "string",
		number: () => ({ optional: () => "number" }),
	});
}

test("verify rejects dormant capability metadata", () => {
	const ast = parse(MODEL_CONTEXT_FIXTURE);
	const result = modelContextMetadata.verify(print(ast), ast);
	assert.equal(typeof result, "string");
});

test("uses discovered model context before the global custom-model fallback", async () => {
	const ast = parse(MODEL_CONTEXT_FIXTURE);
	await runModelContextMetadataViaPasses(ast);
	const output = print(ast);
	const runtime = evaluatePatched(output);
	runtime.setModels([
		{
			id: "provider/worker-258k",
			max_input_tokens: 258400,
			max_tokens: 128000,
		},
	]);

	assert.equal(runtime.contextWindow("provider/worker-258k"), 258400);
	assert.equal(
		runtime.contextWindow("prefix/provider/worker-258k/suffix"),
		258400,
	);
	assert.equal(runtime.contextWindow("provider/unknown"), 333000);
	assert.equal(runtime.outputLimit("provider/worker-258k"), 128000);
	assert.equal(modelContextMetadata.verify(output, ast), true);
});

test("validates and caps discovered context windows", async () => {
	const ast = parse(MODEL_CONTEXT_FIXTURE);
	await runModelContextMetadataViaPasses(ast);
	const runtime = evaluatePatched(print(ast));

	for (const value of [128000, 258400, 500000, 1000000]) {
		runtime.setModels([{ id: "provider/model", max_input_tokens: value }]);
		assert.equal(runtime.contextWindow("provider/model"), value);
	}
	runtime.setModels([{ id: "provider/model", max_input_tokens: 1500000 }]);
	assert.equal(runtime.contextWindow("provider/model"), 1000000);

	for (const value of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
		runtime.setModels([{ id: "provider/model", max_input_tokens: value }]);
		assert.equal(runtime.contextWindow("provider/model"), 333000);
	}
});

test("keeps native one-million handling ahead of discovered metadata", async () => {
	const ast = parse(MODEL_CONTEXT_FIXTURE);
	await runModelContextMetadataViaPasses(ast);
	const runtime = evaluatePatched(print(ast));
	runtime.setModels([{ id: "native-1m", max_input_tokens: 258400 }]);

	assert.equal(runtime.contextWindow("native-1m"), 1000000);
});

test("uses the global fallback while gateway discovery is disabled", async () => {
	const ast = parse(MODEL_CONTEXT_FIXTURE);
	await runModelContextMetadataViaPasses(ast);
	const runtime = evaluatePatched(print(ast));
	runtime.setModels([{ id: "provider/model", max_input_tokens: 258400 }]);
	runtime.setDiscovery(false);

	assert.equal(runtime.contextWindow("provider/model"), 333000);
});

test("model-context-metadata is idempotent", async () => {
	const ast = parse(MODEL_CONTEXT_FIXTURE);
	await runModelContextMetadataViaPasses(ast);
	const once = print(ast);
	await runModelContextMetadataViaPasses(ast);
	const twice = print(ast);

	assert.equal(twice, once);
	assert.equal(modelContextMetadata.verify(twice, ast), true);
});
