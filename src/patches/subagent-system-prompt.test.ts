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

test("subagent-system-prompt verify rejects regression that strips ...basePrompt", () => {
	// Simulates a future regression where the array argument loses the
	// SpreadElement and ships only the append var. Without this check the
	// base subagent prompt would be silently stripped at runtime.
	const broken = `
async function runSubagent(H, q, P, O, F, jH, zH) {
  let wH = O?.systemPrompt ? O.systemPrompt : V4(await hx_(H, q, F, jH, zH)),
    __ccEnhancedSubagentSystemPromptAppend =
      q.options.appendSubagentSystemPrompt ?? q.options.appendSystemPrompt,
    TH =
      !P && __ccEnhancedSubagentSystemPromptAppend
        ? V4([__ccEnhancedSubagentSystemPromptAppend])
        : wH;
  return { systemPrompt: TH };
}
`;
	const ast = parse(broken);
	const result = subagentSystemPrompt.verify(broken, ast);
	assert.notEqual(
		result,
		true,
		"verify must reject patched shape that strips the base prompt spread",
	);
	assert.equal(typeof result, "string");
});

test("subagent-system-prompt verify rejects regression with mismatched spread argument", () => {
	// Mutator emits `[...wH, append]` where wH is the base prompt. If a future
	// edit accidentally spread a different identifier, the patched shape
	// would render the wrong base prompt. The structural-equivalence check
	// in the verifier catches this.
	const mismatched = `
async function runSubagent(H, q, P, O, F, jH, zH) {
  let wH = O?.systemPrompt ? O.systemPrompt : V4(await hx_(H, q, F, jH, zH)),
    bogusBase = ["unrelated"],
    __ccEnhancedSubagentSystemPromptAppend =
      q.options.appendSubagentSystemPrompt ?? q.options.appendSystemPrompt,
    TH =
      !P && __ccEnhancedSubagentSystemPromptAppend
        ? V4([...bogusBase, __ccEnhancedSubagentSystemPromptAppend])
        : wH;
  return { systemPrompt: TH };
}
`;
	const ast = parse(mismatched);
	const result = subagentSystemPrompt.verify(mismatched, ast);
	assert.notEqual(
		result,
		true,
		"verify must reject patched shape where spread arg != alternate",
	);
	assert.equal(typeof result, "string");
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

test("subagent-system-prompt ignores object-literal option reads adjacent to the gate", async () => {
	const withDecoy = `
async function runSubagent(H, q, P, O, F, jH, zH) {
  let wH = O?.systemPrompt ? O.systemPrompt : V4(await hx_(H, q, F, jH, zH)),
    TH =
      !P &&
      EH(process.env.CLAUDE_CODE_ENABLE_APPEND_SUBAGENT_PROMPT) &&
      q.options.appendSubagentSystemPrompt
        ? V4([...wH, q.options.appendSubagentSystemPrompt])
        : wH,
    nested = {
      appendSystemPrompt: q.options.appendSystemPrompt,
      appendSubagentSystemPrompt: q.options.appendSubagentSystemPrompt,
    };
  return { systemPrompt: TH, nested };
}
`;
	const ast = parse(withDecoy);
	await runSubagentSystemPromptViaPasses(ast);
	const output = print(ast);
	// The decoy object-literal read must remain untouched...
	assert.match(
		output,
		/appendSubagentSystemPrompt:\s*q\.options\.appendSubagentSystemPrompt/,
	);
	// ...and exactly the one real conditional must still be patched.
	assert.match(output, /\.\.\.\s*wH,\s*__ccEnhancedSubagentSystemPromptAppend/);
	assert.equal(subagentSystemPrompt.verify(output, ast), true);
});

test("subagent-system-prompt keeps exactly one patched branch with a decoy option read present", async () => {
	const withDecoy = `
async function runSubagent(H, q, P, O, F, jH, zH) {
  let wH = O?.systemPrompt ? O.systemPrompt : V4(await hx_(H, q, F, jH, zH)),
    TH =
      !P &&
      EH(process.env.CLAUDE_CODE_ENABLE_APPEND_SUBAGENT_PROMPT) &&
      q.options.appendSubagentSystemPrompt
        ? V4([...wH, q.options.appendSubagentSystemPrompt])
        : wH,
    nested = { appendSubagentSystemPrompt: q.options.appendSubagentSystemPrompt };
  return { systemPrompt: TH, nested };
}
`;
	const ast = parse(withDecoy);
	await runSubagentSystemPromptViaPasses(ast);
	const output = print(ast);
	// verify()===true transitively requires zero surviving legacy conditionals
	// and exactly one patched conditional; the decoy read must not inflate either.
	assert.equal(subagentSystemPrompt.verify(output, ast), true);
});

test("subagent-system-prompt ignores env name used as a registry property key", async () => {
	const withRegistry = `
const envRegistry = { CLAUDE_CODE_ENABLE_APPEND_SUBAGENT_PROMPT: () => true };
${SUBAGENT_PROMPT_FIXTURE}
`;
	const ast = parse(withRegistry);
	await runSubagentSystemPromptViaPasses(ast);
	const output = print(ast);
	// Registry key left intact, and the single real gate still patched.
	assert.match(
		output,
		/CLAUDE_CODE_ENABLE_APPEND_SUBAGENT_PROMPT:\s*\(\)\s*=>\s*true/,
	);
	assert.match(output, /\.\.\.\s*wH,\s*__ccEnhancedSubagentSystemPromptAppend/);
	assert.equal(subagentSystemPrompt.verify(output, ast), true);
});
