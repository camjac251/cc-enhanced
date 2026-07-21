import assert from "node:assert/strict";
import { test } from "node:test";
import * as t from "@babel/types";
import {
	type PatchPassEntry,
	runCombinedAstPasses,
} from "../ast-pass-engine.js";
import { traverse } from "../babel.js";
import { parse, print } from "../loader.js";
import { configuredModelCatalog } from "./configured-model-catalog.js";
import { modelAliases } from "./model-aliases.js";
import { modelPickerSessionOnly } from "./model-picker-session-only.js";

async function patchSource(source: string): Promise<string> {
	const ast = parse(source);
	const passes = (await modelAliases.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: modelAliases.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
	return print(ast);
}

const MODEL_ROUTING_FIXTURE = String.raw`
const forwardedEnvA = ["ANTHROPIC_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL", "DO_NOT_TRACK"];
const forwardedEnvB = ["CLAUDE_CODE_SKIP_VERTEX_AUTH", "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_USE_BEDROCK"];
const forwardedEnvC = ["ANTHROPIC_BEDROCK_SERVICE_TIER", "CLAUDE_CODE_SUBAGENT_MODEL", "ANTHROPIC_BASE_URL"];

function isBuiltInAlias(alias) {
  return ["fable", "opusplan", "sonnet", "haiku", "opus", "best"].includes(alias);
}

function sanitizeModel(model) {
  return "sanitized:" + model;
}

function normalizeModel(model) {
  let trimmed = model.trim();
  let lowered = trimmed.toLowerCase();
  let oneMillion = lowered.endsWith("[1m]");
  let alias = oneMillion ? lowered.slice(0, -4) : lowered;
  if (isBuiltInAlias(alias)) {
    switch (alias) {
      case "fable": return "fable-model";
      case "opusplan": return "opus-plan-model";
      case "sonnet": return "sonnet-model";
      case "haiku": return "haiku-model";
      case "opus": return "opus-model";
      case "best": return "best-model";
      default: break;
    }
  }
  if (oneMillion) return trimmed.replace(/(\\[1m\\])+$/i, "") + "[1m]";
  return sanitizeModel(trimmed);
}

function resolveTeammateModel(explicitModel, parentModel) {
  const globalModel = process.env.CLAUDE_CODE_SUBAGENT_MODEL;
  if (globalModel && globalModel !== "inherit") {
    const normalized = normalizeModel(globalModel);
    if (isAllowed(normalized)) return normalized;
    warnTeammate(globalModel);
    return defaultTeammate(parentModel);
  }
  if (explicitModel === "inherit") return parentModel ?? defaultTeammate(parentModel);
  if (explicitModel !== void 0 && !isAllowed(explicitModel)) {
    warnTeammate(explicitModel);
    return defaultTeammate(parentModel);
  }
  return explicitModel ?? defaultTeammate(parentModel);
}

function canonicalModel(model) {
  return model.trim().toLowerCase();
}

function knownModelDisplayName(model) {
  if (model === "claude-opus-4-8") return "Opus";
  return undefined;
}

const workflowModelArrow = "→";

function formatWorkflowModel(model, fallbackModel) {
  let displayName = (candidate) => knownModelDisplayName(candidate) ?? candidate;
  if (fallbackModel != null) {
    return (
      (model == null ? "" : displayName(model) + " ") +
      workflowModelArrow +
      " " +
      displayName(fallbackModel)
    );
  }
  return model != null ? displayName(model) : "";
}

function collectWorkflowModel(requestedModel, responseModel) {
  let canonicalRequestedModel = canonicalModel(requestedModel);
  let fallbackModel;
  const assistant = {
    type: "assistant",
    isApiErrorMessage: false,
    message: { model: responseModel, content: [], usage: {} },
  };
  if (assistant.type === "assistant" && !assistant.isApiErrorMessage) {
    let actualModel = assistant.message.model;
    if (
      actualModel &&
      canonicalRequestedModel &&
      actualModel !== requestedModel &&
      canonicalModel(actualModel) !== canonicalRequestedModel
    ) {
      fallbackModel = actualModel;
    }
  }
  return {
    type: "workflow_agent",
    model: requestedModel,
    fallbackModel,
  };
}

function renderWorkflowAgent(agent) {
  const details = [];
  if (agent.model != null) {
    details.push(formatWorkflowModel(agent.model, agent.fallbackModel));
  }
  return details.join(" · ");
}

function renderWorkflowCompact(agent) {
  return formatWorkflowModel(agent.model, agent.fallbackModel);
}
`;

function loadNormalizer(
	code: string,
	env: Record<string, string | undefined>,
): (model: string) => string {
	return new Function("process", `${code}; return normalizeModel;`)({
		env,
	}) as (model: string) => string;
}

function loadWorkflowFunctions(
	code: string,
	env: Record<string, string | undefined>,
): {
	collectWorkflowModel: (
		requestedModel: string,
		responseModel: string,
	) => { model: string; fallbackModel?: string };
	renderWorkflowAgent: (agent: {
		model: string;
		fallbackModel?: string;
	}) => string;
} {
	return new Function(
		"process",
		`${code}; return { collectWorkflowModel, renderWorkflowAgent };`,
	)({ env }) as {
		collectWorkflowModel: (
			requestedModel: string,
			responseModel: string,
		) => { model: string; fallbackModel?: string };
		renderWorkflowAgent: (agent: {
			model: string;
			fallbackModel?: string;
		}) => string;
	};
}

function disableValidationGuard(code: string, errorNeedle: string): string {
	const ast = parse(code);
	let changed = 0;
	traverse(ast, {
		IfStatement(path) {
			const statements = t.isBlockStatement(path.node.consequent)
				? path.node.consequent.body
				: [path.node.consequent];
			const hasError = statements.some(
				(statement) =>
					t.isThrowStatement(statement) &&
					t.isNewExpression(statement.argument) &&
					statement.argument.arguments.some(
						(argument) =>
							t.isStringLiteral(argument) &&
							argument.value.includes(errorNeedle),
					),
			);
			if (!hasError) return;
			path.node.test = t.booleanLiteral(false);
			changed++;
		},
	});
	assert.equal(changed, 1, errorNeedle);
	return print(ast);
}

test("model-aliases resolves a case-insensitive configured alias before stock normalization", async () => {
	const output = await patchSource(MODEL_ROUTING_FIXTURE);
	const normalizeModel = loadNormalizer(output, {
		CLAUDE_CODE_MODEL_ALIASES: JSON.stringify({ SoL: "openai/gpt-5.6-sol" }),
	});

	assert.equal(normalizeModel("  sOl  "), "sanitized:openai/gpt-5.6-sol");
});

test("model-aliases normalizes explicit teammate models and forwards the alias map", async () => {
	const output = await patchSource(MODEL_ROUTING_FIXTURE);

	assert.equal(
		output.includes("explicitModel = normalizeModel(explicitModel)"),
		true,
	);
	assert.equal(
		output.split('"CLAUDE_CODE_MODEL_ALIASES"').length - 1,
		3,
		"every subagent environment registry must forward the alias map",
	);
});

test("model-aliases renders an exact configured target with its friendly alias", async () => {
	const output = await patchSource(MODEL_ROUTING_FIXTURE);
	const routedModel = "clodex:openai-oauth:gpt-5.6-sol";
	const { renderWorkflowAgent } = loadWorkflowFunctions(output, {
		CLAUDE_CODE_MODEL_ALIASES: JSON.stringify({ sol: routedModel }),
	});

	assert.equal(renderWorkflowAgent({ model: routedModel }), "Sol");
});

test("model-aliases preserves canonical workflow identity and real fallbacks", async () => {
	const output = await patchSource(MODEL_ROUTING_FIXTURE);
	const routedModel = "clodex:openai-oauth:gpt-5.6-sol";
	const { collectWorkflowModel, renderWorkflowAgent } = loadWorkflowFunctions(
		output,
		{
			CLAUDE_CODE_MODEL_ALIASES: JSON.stringify({ sol: routedModel }),
		},
	);

	const canonical = collectWorkflowModel(routedModel, routedModel);
	assert.deepEqual(canonical, {
		type: "workflow_agent",
		model: routedModel,
		fallbackModel: undefined,
	});
	assert.equal(renderWorkflowAgent(canonical), "Sol");

	const mismatch = collectWorkflowModel(routedModel, "gpt-5.6-other");
	assert.equal(renderWorkflowAgent(mismatch), "Sol → gpt-5.6-other");
	assert.equal(output.includes("claude-ccr-h"), false);
	assert.equal(output.includes("TextDecoder"), false);
	assert.equal(output.includes("configuredModelsEquivalent"), false);
});

test("model-aliases fails fast on malformed or unsafe alias maps", async () => {
	const output = await patchSource(MODEL_ROUTING_FIXTURE);
	const invalidMaps: Array<[string, RegExp]> = [
		["{", /valid JSON object/],
		["[]", /must be a JSON object/],
		[JSON.stringify({ opus: "openai/gpt-5.6-sol" }), /cannot override native/],
		[
			JSON.stringify({ inherit: "openai/gpt-5.6-sol" }),
			/cannot override native/,
		],
		[JSON.stringify({ "sol[1m]": "openai/gpt-5.6-sol" }), /alias names/],
		[
			JSON.stringify({ sol: "openai/gpt-5.6-sol[1m]" }),
			/targets cannot include/,
		],
		[
			JSON.stringify({ Sol: "openai/gpt-5.6-sol", sol: "openai/other" }),
			/duplicate aliases/,
		],
		[
			JSON.stringify({ sol: "worker", worker: "openai/gpt-5.6-sol" }),
			/alias chaining/,
		],
		[JSON.stringify({ sol: "fable" }), /native alias targets/],
		[JSON.stringify({ sol: "" }), /nonempty model ID strings/],
		[JSON.stringify({ sol: 56 }), /nonempty model ID strings/],
	];

	for (const [rawMap, expected] of invalidMaps) {
		const normalizeModel = loadNormalizer(output, {
			CLAUDE_CODE_MODEL_ALIASES: rawMap,
		});
		assert.throws(() => normalizeModel("sol"), expected, rawMap);
	}
});

test("model-aliases leaves stock model handling unchanged when the map is absent", async () => {
	const output = await patchSource(MODEL_ROUTING_FIXTURE);
	const normalizeModel = loadNormalizer(output, {});

	assert.equal(normalizeModel("fable"), "fable-model");
	assert.equal(normalizeModel("provider/custom"), "sanitized:provider/custom");
});

test("model-aliases resolves the current map on every model-normalization call", async () => {
	const output = await patchSource(MODEL_ROUTING_FIXTURE);
	const env: Record<string, string | undefined> = {
		CLAUDE_CODE_MODEL_ALIASES: JSON.stringify({ sol: "openai/first" }),
	};
	const normalizeModel = loadNormalizer(output, env);

	assert.equal(normalizeModel("sol"), "sanitized:openai/first");
	env.CLAUDE_CODE_MODEL_ALIASES = JSON.stringify({ sol: "openai/second" });
	assert.equal(normalizeModel("sol"), "sanitized:openai/second");
	assert.equal(
		output.includes("explicitModel !== void 0 && !isAllowed(explicitModel)"),
		true,
		"resolved teammate IDs must still pass the stock allowlist check",
	);
});

test("model-aliases does not rewrite shared prompts", () => {
	assert.equal(modelAliases.string, undefined);
});

const FORWARDED_ENV_C =
	'const forwardedEnvC = ["ANTHROPIC_BEDROCK_SERVICE_TIER", "CLAUDE_CODE_SUBAGENT_MODEL", "ANTHROPIC_BASE_URL"];';

test("model-aliases forwards the alias map to two subagent environment arrays", async () => {
	const twoArrayFixture = MODEL_ROUTING_FIXTURE.replace(
		`${FORWARDED_ENV_C}\n`,
		"",
	);
	assert.notEqual(twoArrayFixture, MODEL_ROUTING_FIXTURE);
	const output = await patchSource(twoArrayFixture);

	assert.equal(
		output.split('"CLAUDE_CODE_MODEL_ALIASES"').length - 1,
		2,
		"every remaining forwarding array must receive the alias map",
	);
	assert.equal(modelAliases.verify(output), true);
});

test("model-aliases forwards the alias map to four subagent environment arrays", async () => {
	const fourArrayFixture = MODEL_ROUTING_FIXTURE.replace(
		FORWARDED_ENV_C,
		`${FORWARDED_ENV_C}\nconst forwardedEnvD = ["ANTHROPIC_CUSTOM_MODEL_OPTION", "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CONFIG_DIR"];`,
	);
	assert.notEqual(fourArrayFixture, MODEL_ROUTING_FIXTURE);
	const output = await patchSource(fourArrayFixture);

	assert.equal(
		output.split('"CLAUDE_CODE_MODEL_ALIASES"').length - 1,
		4,
		"a fourth forwarding array must also receive the alias map",
	);
	assert.equal(modelAliases.verify(output), true);
});

test("model-aliases verifier rejects partial routing integration", async () => {
	const patched = await patchSource(MODEL_ROUTING_FIXTURE);
	assert.equal(modelAliases.verify(patched), true);

	const missingTeammateNormalization = patched.replace(
		"explicitModel = normalizeModel(explicitModel);",
		"explicitModel = explicitModel;",
	);
	assert.notEqual(missingTeammateNormalization, patched);
	assert.match(
		String(modelAliases.verify(missingTeammateNormalization)),
		/Teammate model resolver/,
	);

	const missingForwarding = patched.replace('"CLAUDE_CODE_MODEL_ALIASES",', "");
	assert.notEqual(missingForwarding, patched);
	assert.match(
		String(modelAliases.verify(missingForwarding)),
		/environment forwarding/,
	);

	const weakenedLabelHelper = patched.replace(".toUpperCase()", "");
	assert.notEqual(weakenedLabelHelper, patched);
	assert.notEqual(modelAliases.verify(weakenedLabelHelper), true);
});

test("model-aliases verifier rejects weakened alias-map validation", async () => {
	const patched = await patchSource(MODEL_ROUTING_FIXTURE);
	for (const errorNeedle of [
		"alias names must be nonempty",
		"cannot override native model aliases",
		"duplicate aliases after case-insensitive normalization",
		"targets must be nonempty model ID strings",
		"targets cannot include [1m]",
		"does not allow alias chaining",
	]) {
		const weakened = disableValidationGuard(patched, errorNeedle);
		assert.notEqual(modelAliases.verify(weakened), true, errorNeedle);
	}
});

// Surfaces the two finalize-pass env forwarders (configured-model-catalog and
// model-picker-session-only) need to classify, minus their own forwarding
// arrays. Combined with the model-aliases surfaces they share ONE array set, so
// a single combined-engine run exercises all three forwarders composing on the
// same nodes across the mutate and finalize passes.
const MODEL_ALIAS_SURFACES = MODEL_ROUTING_FIXTURE.slice(
	MODEL_ROUTING_FIXTURE.indexOf("function isBuiltInAlias"),
);

const CATALOG_SURFACE = `
const env = {
  ANTHROPIC_CUSTOM_MODEL_OPTION: undefined,
  ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: undefined,
  ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: undefined,
};
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
let baseModelOptions = [{ value: "fable", label: "Fable", description: "Native model" }];
function baseOptions() { return baseModelOptions.map((option) => ({ ...option })); }
function addModelOption(options, model) { options.push({ value: model.id, label: model.name, description: "From gateway" }); }
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
  return options;
}
`;

const PICKER_SURFACE = `
function renderModelPicker(props) {
  let {
    initial,
    sessionModel,
    onSelect,
    onSetDefault,
    onCancel,
    isStandaloneCommand,
    showFastModeNotice,
    headerText,
    options,
    skipSettingsWrite,
  } = props,
    state = initial;
  function select(value) {
    if (onSetDefault) onSetDefault(value);
    onSelect(value);
    state = value;
  }
  const header = headerText ?? "Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names, specify with --model.";
  return { select, header, canSetDefault: Boolean(onSetDefault), state };
}
`;

function buildCombinedEnvFixture(arrayCount: number): string {
	const arrays = Array.from(
		{ length: arrayCount },
		(_unused, index) =>
			`const forwardedEnv${index} = ["ANTHROPIC_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL", "ANTHROPIC_BASE_URL"];`,
	).join("\n");
	return `${arrays}\n${MODEL_ALIAS_SURFACES}\n${CATALOG_SURFACE}\n${PICKER_SURFACE}`;
}

async function runCombinedEnvPatches(ast: t.File): Promise<void> {
	const entries: PatchPassEntry[] = [];
	for (const patch of [
		modelAliases,
		configuredModelCatalog,
		modelPickerSessionOnly,
	]) {
		const passes = (await patch.astPasses?.(ast)) ?? [];
		for (const pass of passes) entries.push({ tag: patch.tag, pass });
	}
	await runCombinedAstPasses(
		ast,
		entries,
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

for (const arrayCount of [2, 3, 4]) {
	test(`model env forwarders compose across ${arrayCount} passthrough arrays`, async () => {
		const ast = parse(buildCombinedEnvFixture(arrayCount));
		await runCombinedEnvPatches(ast);
		const output = print(ast);

		for (const envKey of [
			"CLAUDE_CODE_MODEL_ALIASES",
			"CLAUDE_CODE_CONFIGURED_MODEL_CATALOG",
			"CLAUDE_CODE_MODEL_PICKER_SESSION_ONLY",
		]) {
			assert.equal(
				output.split(`"${envKey}"`).length - 1,
				arrayCount,
				`${envKey} must land in every one of the ${arrayCount} forwarding arrays`,
			);
		}

		const reparsed = parse(output);
		assert.equal(modelAliases.verify(output, reparsed), true);
		assert.equal(configuredModelCatalog.verify(output, reparsed), true);
		assert.equal(modelPickerSessionOnly.verify(output, reparsed), true);
	});
}
