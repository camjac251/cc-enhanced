import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { subagentSystemPrompt } from "./subagent-system-prompt.js";

async function runSubagentSystemPromptViaPasses(ast: any): Promise<void> {
	const passes = (await subagentSystemPrompt.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: subagentSystemPrompt.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

const SUBAGENT_PROMPT_FIXTURE = `
async function runSubagent(H, q, P, O, F, jH, zH) {
  let wH = O?.systemPrompt ? O.systemPrompt : V4(await hx_(H, q, F, jH, zH)),
    TH =
      !P &&
      EH(process.env.CLAUDE_CODE_ENABLE_APPEND_SUBAGENT_PROMPT) &&
      q.options.appendSubagentSystemPrompt
        ? V4([...wH, q.options.appendSubagentSystemPrompt])
        : wH,
    WH = O?.abortController ? O.abortController : q.abortController;
  return { systemPrompt: TH, abortController: WH };
}
`;

test("verify rejects unpatched subagent append branch", () => {
	const ast = parse(SUBAGENT_PROMPT_FIXTURE);
	const code = print(ast);
	const result = subagentSystemPrompt.verify(code, ast);
	assert.notEqual(
		result,
		true,
		"verify should reject unpatched code but got true",
	);
	assert.equal(typeof result, "string");
});

test("subagent-system-prompt bridges main append prompt into subagents", async () => {
	const ast = parse(SUBAGENT_PROMPT_FIXTURE);
	await runSubagentSystemPromptViaPasses(ast);
	const output = print(ast);

	assert.match(
		output,
		/__ccEnhancedSubagentSystemPromptAppend\s*=\s*q\.options\.appendSubagentSystemPrompt\s*\?\?\s*q\.options\.appendSystemPrompt/,
	);
	assert.equal(
		output.includes("CLAUDE_CODE_ENABLE_APPEND_SUBAGENT_PROMPT) &&"),
		false,
	);
	assert.match(output, /\.\.\.\s*wH,\s*__ccEnhancedSubagentSystemPromptAppend/);
	assert.equal(subagentSystemPrompt.verify(output, ast), true);
});

test("subagent-system-prompt preserves explicit subagent override precedence", async () => {
	const ast = parse(SUBAGENT_PROMPT_FIXTURE);
	await runSubagentSystemPromptViaPasses(ast);
	const output = print(ast);

	const subagentIndex = output.indexOf("q.options.appendSubagentSystemPrompt");
	const mainAppendIndex = output.indexOf("q.options.appendSystemPrompt");

	assert.equal(subagentIndex > -1, true);
	assert.equal(mainAppendIndex > -1, true);
	assert.equal(subagentIndex < mainAppendIndex, true);
});

test("subagent-system-prompt allows unrelated env documentation string", async () => {
	const ast = parse(`
const docs = "CLAUDE_CODE_ENABLE_APPEND_SUBAGENT_PROMPT";
${SUBAGENT_PROMPT_FIXTURE}
`);
	await runSubagentSystemPromptViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes(
			'const docs = "CLAUDE_CODE_ENABLE_APPEND_SUBAGENT_PROMPT";',
		),
		true,
	);
	assert.equal(subagentSystemPrompt.verify(output, ast), true);
});

test("subagent-system-prompt fails closed on ambiguous branches", async () => {
	const ast = parse(`
${SUBAGENT_PROMPT_FIXTURE}
${SUBAGENT_PROMPT_FIXTURE.replace("runSubagent", "runSubagentAgain")}
`);
	await runSubagentSystemPromptViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes("__ccEnhancedSubagentSystemPromptAppend"),
		false,
	);
	const result = subagentSystemPrompt.verify(output, ast);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("Legacy env-gated subagent system prompt append"),
		true,
	);
});
