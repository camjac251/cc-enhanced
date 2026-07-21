import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { configuredModelCatalog } from "./configured-model-catalog.js";

async function runConfiguredCatalogViaPasses(ast: any): Promise<void> {
	const passes = (await configuredModelCatalog.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: configuredModelCatalog.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

const CATALOG_FIXTURE = `
const env = {
  ANTHROPIC_CUSTOM_MODEL_OPTION: undefined,
  ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: undefined,
  ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: undefined,
};
const childEnvOne = ["CLAUDE_CODE_SUBAGENT_MODEL"];
const childEnvTwo = new Set(["CLAUDE_CODE_SUBAGENT_MODEL"]);
const childEnvThree = ["CLAUDE_CODE_SUBAGENT_MODEL"];
let cachedModels = [];
function capabilitiesEnabled() { return false; }
function readCapabilities() { return cachedModels; }
function getModelCapability(model) {
  if (!capabilitiesEnabled()) return;
  const models = readCapabilities();
  if (!models || models.length === 0) return;
  const normalized = model.toLowerCase();
  const exact = models.find((entry) => entry.id.toLowerCase() === normalized);
  if (exact) return exact;
  return models.find((entry) => normalized.includes(entry.id.toLowerCase()));
}
let baseModelOptions = [
  { value: "fable", label: "Fable", description: "Native model" },
];
function baseOptions() {
  return baseModelOptions.map((option) => ({ ...option }));
}
function addModelOption(options, model) {
  options.push({ value: model.id, label: model.name, description: "From gateway" });
}
function providerModels() { return []; }
function serverModels() { return []; }
function settings() { return {}; }
function buildModelOptions(includeLongContext) {
  let options = baseOptions(includeLongContext),
    custom = env.ANTHROPIC_CUSTOM_MODEL_OPTION;
  if (custom && !options.some((option) => option.value === custom)) {
    options.push({
      value: custom,
      label: env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME ?? custom,
      description: env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION ?? "Custom model",
    });
  }
  for (const model of providerModels()) addModelOption(options, model);
  for (const model of serverModels()) addModelOption(options, model);
  const { availableModels } = settings();
  if (availableModels) {
    for (const model of availableModels) options.push({ value: model, label: model, description: "Custom model" });
  }
  return options;
}
`;

function evaluatePatched(code: string) {
	const processValue: { env: Record<string, string | undefined> } = { env: {} };
	const runtime = Function(
		"process",
		`${code}
return {
  setCatalog(value) {
    if (value === undefined) delete process.env.CLAUDE_CODE_CONFIGURED_MODEL_CATALOG;
    else process.env.CLAUDE_CODE_CONFIGURED_MODEL_CATALOG = JSON.stringify(value);
  },
  setRawCatalog(value) { process.env.CLAUDE_CODE_CONFIGURED_MODEL_CATALOG = value; },
  setCachedModels(value) { cachedModels = value; },
  setBaseOptions(value) { baseModelOptions = value; },
  getModelCapability,
  buildModelOptions,
  childEnvs: [childEnvOne, [...childEnvTwo], childEnvThree],
};`,
	)(processValue);
	return runtime as {
		setCatalog: (value: unknown) => void;
		setRawCatalog: (value: string) => void;
		setCachedModels: (value: unknown[]) => void;
		setBaseOptions: (
			value: Array<{ value: string; label: string; description: string }>,
		) => void;
		getModelCapability: (model: string) =>
			| {
					id: string;
					display_name: string;
					description: string;
					max_input_tokens?: number;
					max_tokens?: number;
			  }
			| undefined;
		buildModelOptions: () => Array<{
			value: string;
			label: string;
			description: string;
		}>;
		childEnvs: string[][];
	};
}

test("verify rejects a bundle without configured model surfaces", () => {
	const ast = parse(CATALOG_FIXTURE);
	assert.equal(typeof configuredModelCatalog.verify(print(ast), ast), "string");
});

test("adds configured models to capabilities and the model picker", async () => {
	const ast = parse(CATALOG_FIXTURE);
	await runConfiguredCatalogViaPasses(ast);
	const output = print(ast);
	const runtime = evaluatePatched(output);
	runtime.setCatalog([
		{
			id: "clodex:openai-oauth:gpt-5.6-sol",
			displayName: "GPT-5.6 Sol",
			description: "ChatGPT subscription via Clodex",
			maxInputTokens: 258400,
			maxOutputTokens: 128000,
		},
	]);

	assert.deepEqual(
		runtime.getModelCapability("clodex:openai-oauth:gpt-5.6-sol"),
		{
			id: "clodex:openai-oauth:gpt-5.6-sol",
			display_name: "GPT-5.6 Sol",
			description: "ChatGPT subscription via Clodex",
			max_input_tokens: 258400,
			max_tokens: 128000,
		},
	);
	assert.deepEqual(runtime.buildModelOptions(), [
		{ value: "fable", label: "Fable", description: "Native model" },
		{
			value: "clodex:openai-oauth:gpt-5.6-sol",
			label: "GPT-5.6 Sol",
			description: "ChatGPT subscription via Clodex",
		},
	]);
	for (const childEnv of runtime.childEnvs) {
		assert.equal(
			childEnv.filter(
				(value) => value === "CLAUDE_CODE_CONFIGURED_MODEL_CATALOG",
			).length,
			1,
		);
	}
	assert.equal(configuredModelCatalog.verify(output, ast), true);
});

test("leaves model behavior unchanged while the catalog is absent", async () => {
	const ast = parse(CATALOG_FIXTURE);
	await runConfiguredCatalogViaPasses(ast);
	const runtime = evaluatePatched(print(ast));

	assert.equal(runtime.getModelCapability("provider/unknown"), undefined);
	assert.deepEqual(runtime.buildModelOptions(), [
		{ value: "fable", label: "Fable", description: "Native model" },
	]);
});

test("does not activate unrelated cached capabilities while a catalog is present", async () => {
	const ast = parse(CATALOG_FIXTURE);
	await runConfiguredCatalogViaPasses(ast);
	const runtime = evaluatePatched(print(ast));
	runtime.setCatalog([{ id: "clodex:openai-oauth:gpt-5.6-sol" }]);
	runtime.setCachedModels([
		{
			id: "provider/unrelated",
			max_input_tokens: 999_999,
			max_tokens: 64_000,
		},
	]);

	assert.equal(runtime.getModelCapability("provider/unrelated"), undefined);
	assert.equal(
		runtime.getModelCapability("clodex:openai-oauth:gpt-5.6-sol")?.id,
		"clodex:openai-oauth:gpt-5.6-sol",
	);
});

test("does not duplicate an existing picker model with different id casing", async () => {
	const ast = parse(CATALOG_FIXTURE);
	await runConfiguredCatalogViaPasses(ast);
	const runtime = evaluatePatched(print(ast));
	runtime.setBaseOptions([
		{
			value: "Provider/Model",
			label: "Existing model",
			description: "Provider entry",
		},
	]);
	runtime.setCatalog([
		{
			id: "provider/model",
			displayName: "Configured model",
		},
	]);

	assert.deepEqual(runtime.buildModelOptions(), [
		{
			value: "Provider/Model",
			label: "Existing model",
			description: "Provider entry",
		},
	]);
});

test("rejects malformed, duplicate, reserved, and unsafe catalog entries", async () => {
	const ast = parse(CATALOG_FIXTURE);
	await runConfiguredCatalogViaPasses(ast);
	const runtime = evaluatePatched(print(ast));

	runtime.setRawCatalog("not-json");
	assert.throws(() => runtime.buildModelOptions(), /must be valid JSON/);
	runtime.setCatalog({ id: "provider/model" });
	assert.throws(() => runtime.buildModelOptions(), /must be a JSON array/);
	runtime.setCatalog([{ id: "fable" }]);
	assert.throws(() => runtime.buildModelOptions(), /reserved model id/);
	runtime.setCatalog([{ id: "Provider/Model" }, { id: "provider/model" }]);
	assert.throws(() => runtime.buildModelOptions(), /duplicate model ids/);
	runtime.setCatalog([{ id: "provider/model", maxInputTokens: 1_000_001 }]);
	assert.throws(() => runtime.buildModelOptions(), /invalid maxInputTokens/);
	runtime.setCatalog([{ id: "provider/model", maxOutputTokens: 1.5 }]);
	assert.throws(() => runtime.buildModelOptions(), /invalid maxOutputTokens/);
	runtime.setCatalog([{ id: "provider/model", maxOutputTokens: 4095 }]);
	assert.throws(() => runtime.buildModelOptions(), /invalid maxOutputTokens/);
	runtime.setCatalog([{ id: "provider/model", maxOutputTokens: 4096 }]);
	assert.equal(runtime.getModelCapability("provider/model")?.max_tokens, 4096);
});

test("configured-model-catalog forwards the catalog env to two arrays", async () => {
	const twoArrayFixture = CATALOG_FIXTURE.replace(
		'const childEnvThree = ["CLAUDE_CODE_SUBAGENT_MODEL"];\n',
		"",
	);
	assert.notEqual(twoArrayFixture, CATALOG_FIXTURE);
	const ast = parse(twoArrayFixture);
	await runConfiguredCatalogViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.split('"CLAUDE_CODE_CONFIGURED_MODEL_CATALOG"').length - 1,
		2,
		"every remaining forwarding array must receive the catalog env",
	);
	assert.equal(configuredModelCatalog.verify(output, ast), true);
});

test("configured-model-catalog forwards the catalog env to four arrays", async () => {
	const fourArrayFixture = CATALOG_FIXTURE.replace(
		'const childEnvThree = ["CLAUDE_CODE_SUBAGENT_MODEL"];',
		'const childEnvThree = ["CLAUDE_CODE_SUBAGENT_MODEL"];\nconst childEnvFour = ["CLAUDE_CODE_SUBAGENT_MODEL"];',
	);
	assert.notEqual(fourArrayFixture, CATALOG_FIXTURE);
	const ast = parse(fourArrayFixture);
	await runConfiguredCatalogViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.split('"CLAUDE_CODE_CONFIGURED_MODEL_CATALOG"').length - 1,
		4,
		"a fourth forwarding array must also receive the catalog env",
	);
	assert.equal(configuredModelCatalog.verify(output, ast), true);
});

test("configured-model-catalog is idempotent", async () => {
	const ast = parse(CATALOG_FIXTURE);
	await runConfiguredCatalogViaPasses(ast);
	const once = print(ast);
	await runConfiguredCatalogViaPasses(ast);
	const twice = print(ast);

	assert.equal(twice, once);
	assert.equal(configuredModelCatalog.verify(twice, ast), true);
});
