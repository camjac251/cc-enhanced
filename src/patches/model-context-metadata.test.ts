import assert from "node:assert/strict";
import { test } from "node:test";
import type { File } from "@babel/types";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { modelContextMetadata } from "./model-context-metadata.js";

async function runModelContextMetadataViaPasses(ast: File): Promise<void> {
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

const LATEST_MODEL_METADATA_FIXTURE = `
function configuredCatalog() {
  const raw = process.env.CLAUDE_CODE_CONFIGURED_MODEL_CATALOG;
  if (raw === void 0) return [];
  return JSON.parse(raw);
}
function catalogModels(catalog) {
  return catalog.config.models ?? [];
}
function findModel(catalog, model) {
  const normalized = String(model).trim().toLowerCase();
  return catalogModels(catalog).find((entry) => entry.id.toLowerCase() === normalized);
}
function contextWindow(catalog, model) {
  const entry = findModel(catalog, model);
  return entry?.runtime?.max_input_tokens ?? entry?.context_window ?? 333000;
}
function outputLimit(catalog, model) {
  return findModel(catalog, model)?.runtime?.max_output_tokens;
}
function effortLevels(catalog, model) {
  return findModel(catalog, model)?.runtime?.effort_levels;
}
function defaultEffort(catalog, model) {
  return findModel(catalog, model)?.runtime?.default_effort;
}
function capabilities(catalog, model) {
  return findModel(catalog, model)?.runtime?.capabilities;
}
function resolveAutoCompactWindow(model, configuredWindow, catalog) {
  const contextCeiling = contextWindow(catalog, model);
  if (process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW) {
    const environmentWindow = Number(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
    return { window: Math.min(contextCeiling, environmentWindow), configured: environmentWindow, source: "env" };
  }
  if (configuredWindow !== undefined) {
    return { window: Math.min(contextCeiling, configuredWindow), configured: configuredWindow, source: "settings" };
  }
  return { window: contextCeiling, configured: contextCeiling, source: "auto" };
}
`;

async function patchFixture(source = LATEST_MODEL_METADATA_FIXTURE): Promise<{
	ast: File;
	output: string;
}> {
	const ast = parse(source);
	await runModelContextMetadataViaPasses(ast);
	return { ast, output: print(ast) };
}

interface ModelMetadataRuntime {
	catalogModels(
		catalog: Record<string, unknown>,
	): Array<Record<string, unknown>>;
	contextWindow(catalog: Record<string, unknown>, model: string): number;
	outputLimit(
		catalog: Record<string, unknown>,
		model: string,
	): number | undefined;
	effortLevels(
		catalog: Record<string, unknown>,
		model: string,
	): string[] | undefined;
	defaultEffort(
		catalog: Record<string, unknown>,
		model: string,
	): string | undefined;
	capabilities(
		catalog: Record<string, unknown>,
		model: string,
	): string[] | undefined;
	resolveAutoCompactWindow(
		model: string,
		configuredWindow: number | undefined,
		catalog: Record<string, unknown>,
	): { window: number; configured: number; source: string };
}

function isModelMetadataRuntime(value: unknown): value is ModelMetadataRuntime {
	return (
		typeof value === "object" &&
		value !== null &&
		"catalogModels" in value &&
		typeof value.catalogModels === "function" &&
		"contextWindow" in value &&
		typeof value.contextWindow === "function" &&
		"resolveAutoCompactWindow" in value &&
		typeof value.resolveAutoCompactWindow === "function"
	);
}

function evaluatePatched(output: string): ModelMetadataRuntime {
	const value: unknown = new Function(
		`${output}; return { catalogModels, contextWindow, outputLimit, effortLevels, defaultEffort, capabilities, resolveAutoCompactWindow };`,
	)();
	assert.ok(isModelMetadataRuntime(value));
	return value;
}

const nativeCatalog = {
	config: {
		models: [
			{
				id: "native/model",
				name: "Native",
				runtime: { max_input_tokens: 200000 },
			},
		],
	},
};

test("verify rejects unpatched catalog metadata", () => {
	const ast = parse(LATEST_MODEL_METADATA_FIXTURE);
	assert.equal(typeof modelContextMetadata.verify(print(ast), ast), "string");
});

test("model-context-metadata rejects inert generated markers", () => {
	const decoy = LATEST_MODEL_METADATA_FIXTURE.replace(
		"return catalog.config.models ?? [];",
		"const __ccConfiguredModelIds = new Set(); return catalog.config.models ?? [];",
	).replace(
		"const contextCeiling = contextWindow(catalog, model);",
		"const __ccConfiguredAutoCompactWindow = 1; const contextCeiling = contextWindow(catalog, model);",
	);
	assert.notEqual(decoy, LATEST_MODEL_METADATA_FIXTURE);
	const ast = parse(decoy);
	assert.equal(typeof modelContextMetadata.verify(print(ast), ast), "string");
});

test("model-context-metadata rejects a partial catalog merge", async () => {
	const { output } = await patchFixture();
	const broken = output.replace("...__ccConfiguredModels", "...[]");
	assert.notEqual(broken, output);
	const ast = parse(broken);
	assert.equal(typeof modelContextMetadata.verify(broken, ast), "string");
});

test("model-context-metadata rejects a partial auto-compact default", async () => {
	const { output } = await patchFixture();
	const broken = output.replace(
		'source: "model-default"',
		'source: "settings"',
	);
	assert.notEqual(broken, output);
	const ast = parse(broken);
	assert.equal(typeof modelContextMetadata.verify(broken, ast), "string");
});

test("model-context-metadata feeds configured models into native runtime metadata", async () => {
	const { ast, output } = await patchFixture();
	const runtime = evaluatePatched(output);
	const previous = process.env.CLAUDE_CODE_CONFIGURED_MODEL_CATALOG;
	process.env.CLAUDE_CODE_CONFIGURED_MODEL_CATALOG = JSON.stringify([
		{
			id: "provider/custom",
			display_name: "Custom",
			description: "Configured model",
			max_input_tokens: 828400,
			max_tokens: 128000,
			auto_compact_window: 745560,
			capabilities: ["effort", "xhigh_effort", "max_effort"],
			default_effort: "max",
		},
	]);
	try {
		assert.equal(
			runtime.contextWindow(nativeCatalog, "provider/custom"),
			828400,
		);
		assert.equal(runtime.outputLimit(nativeCatalog, "provider/custom"), 128000);
		assert.deepEqual(runtime.effortLevels(nativeCatalog, "provider/custom"), [
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		assert.equal(
			runtime.defaultEffort(nativeCatalog, "provider/custom"),
			"max",
		);
		assert.deepEqual(runtime.capabilities(nativeCatalog, "provider/custom"), [
			"effort",
			"xhigh_effort",
			"max_effort",
		]);
		assert.deepEqual(
			runtime.resolveAutoCompactWindow(
				"provider/custom",
				undefined,
				nativeCatalog,
			),
			{ window: 745560, configured: 745560, source: "model-default" },
		);
		assert.equal(runtime.contextWindow(nativeCatalog, "native/model"), 200000);
		assert.equal(modelContextMetadata.verify(output, ast), true);
	} finally {
		if (previous === undefined) {
			delete process.env.CLAUDE_CODE_CONFIGURED_MODEL_CATALOG;
		} else {
			process.env.CLAUDE_CODE_CONFIGURED_MODEL_CATALOG = previous;
		}
	}
});

test("model-context-metadata gives explicit settings precedence", async () => {
	const { output } = await patchFixture();
	const runtime = evaluatePatched(output);
	const previous = process.env.CLAUDE_CODE_CONFIGURED_MODEL_CATALOG;
	process.env.CLAUDE_CODE_CONFIGURED_MODEL_CATALOG = JSON.stringify([
		{
			id: "provider/custom",
			display_name: "Custom",
			description: "Configured model",
			max_input_tokens: 828400,
			auto_compact_window: 745560,
		},
	]);
	try {
		assert.deepEqual(
			runtime.resolveAutoCompactWindow(
				"provider/custom",
				700000,
				nativeCatalog,
			),
			{ window: 700000, configured: 700000, source: "settings" },
		);
	} finally {
		if (previous === undefined) {
			delete process.env.CLAUDE_CODE_CONFIGURED_MODEL_CATALOG;
		} else {
			process.env.CLAUDE_CODE_CONFIGURED_MODEL_CATALOG = previous;
		}
	}
});

test("model-context-metadata lets configured entries override duplicate native ids", async () => {
	const { output } = await patchFixture();
	const runtime = evaluatePatched(output);
	const previous = process.env.CLAUDE_CODE_CONFIGURED_MODEL_CATALOG;
	process.env.CLAUDE_CODE_CONFIGURED_MODEL_CATALOG = JSON.stringify([
		{
			id: "native/model",
			display_name: "Configured Native",
			description: "Override",
			max_input_tokens: 500000,
		},
	]);
	try {
		const models = runtime.catalogModels(nativeCatalog);
		assert.equal(
			models.filter((model) => model.id === "native/model").length,
			1,
		);
		assert.equal(runtime.contextWindow(nativeCatalog, "native/model"), 500000);
	} finally {
		if (previous === undefined) {
			delete process.env.CLAUDE_CODE_CONFIGURED_MODEL_CATALOG;
		} else {
			process.env.CLAUDE_CODE_CONFIGURED_MODEL_CATALOG = previous;
		}
	}
});

test("model-context-metadata is idempotent", async () => {
	const ast = parse(LATEST_MODEL_METADATA_FIXTURE);
	await runModelContextMetadataViaPasses(ast);
	const once = print(ast);
	await runModelContextMetadataViaPasses(ast);
	const twice = print(ast);
	assert.equal(twice, once);
	assert.equal(modelContextMetadata.verify(twice, ast), true);
});

test("model-context-metadata fails closed on ambiguous catalog accessors", async () => {
	const duplicate = LATEST_MODEL_METADATA_FIXTURE.replace(
		"function catalogModels",
		"function duplicateCatalogModels",
	);
	const { ast, output } = await patchFixture(
		`${LATEST_MODEL_METADATA_FIXTURE}\n${duplicate}`,
	);
	assert.doesNotMatch(output, /__ccConfiguredModelIds/);
	assert.match(
		String(modelContextMetadata.verify(output, ast)),
		/ambiguous|missing/,
	);
});
