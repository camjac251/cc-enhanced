import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { claudeApiScope } from "./claude-api-scope.js";

const FIXTURE = `
const description = [
  "Reference for the Claude API / Anthropic SDK - model ids, pricing, params, streaming, tool use, MCP, agents, caching, token counting, model migration.",
  'TRIGGER - read BEFORE opening the target file; don\\'t skip because it "looks like a one-liner" - whenever: the prompt names Claude/Anthropic in any form (Claude, Anthropic, Fable, Opus, Sonnet, Haiku, \`anthropic\`, \`@anthropic-ai\`, \`claude-*\`, \`us.anthropic.*\`, \`[1m]\`); the user asks about an LLM (pricing/model choice/limits/caching) - never answer from memory; OR the task is LLM-shaped with provider unstated (agent/MCP/tool-definition/multi-agent/RAG/LLM-judge/computer-use; generate/summarize/extract/classify/rewrite/converse over NL; debugging refusals/cutoffs/streaming/tool-calls/tokens).',
  "SKIP only when another provider is being worked on (overrides all triggers): OpenAI/GPT/Gemini/Llama/Mistral/Cohere/Ollama named in the query; OR \`grep -rE 'openai|langchain_openai|google.generativeai|genai|mistralai|cohere|ollama'\` over the project hits (run this grep FIRST if no provider named - don't Read the file).",
].join("\\n");
`;

async function runScopePatch(code: string): Promise<string> {
	const ast = parse(code);
	const passes = (await claudeApiScope.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: claudeApiScope.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
	return print(ast);
}

test("claude-api-scope exports the expected tag", () => {
	assert.equal(claudeApiScope.tag, "claude-api-scope");
});

test("limits automatic activation to API and SDK application work", async () => {
	const output = await runScopePatch(FIXTURE);

	assert.match(
		output,
		/application that directly calls the Claude API or uses an Anthropic SDK/,
	);
	assert.match(
		output,
		/DO NOT TRIGGER merely because a task mentions Claude Code/,
	);
	assert.match(output, /local session JSONL\/transcripts/);
	assert.doesNotMatch(output, /the prompt names Claude\/Anthropic in any form/);
	assert.doesNotMatch(output, /run this grep FIRST/);
	assert.equal(claudeApiScope.verify(output, parse(output)), true);
});

test("verify rejects the broad stock activation rule", () => {
	const result = claudeApiScope.verify(FIXTURE, parse(FIXTURE));

	assert.equal(typeof result, "string");
	assert.match(String(result), /scope/i);
});

test("claude-api-scope is idempotent", async () => {
	const once = await runScopePatch(FIXTURE);
	const twice = await runScopePatch(once);

	assert.equal(twice, once);
});
