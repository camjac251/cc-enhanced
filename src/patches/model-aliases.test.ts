import assert from "node:assert/strict";
import { test } from "node:test";
import * as t from "@babel/types";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { traverse } from "../babel.js";
import { parse, print } from "../loader.js";
import { modelAliases } from "./model-aliases.js";

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
`;

function loadNormalizer(
	code: string,
	env: Record<string, string | undefined>,
): (model: string) => string {
	return new Function("process", `${code}; return normalizeModel;`)({
		env,
	}) as (model: string) => string;
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
