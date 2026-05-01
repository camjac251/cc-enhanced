import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { systemPromptFile } from "./sys-prompt-file.js";

async function runSystemPromptFileViaPasses(ast: any): Promise<void> {
	const passes = (await systemPromptFile.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: systemPromptFile.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

const SYS_PROMPT_FILE_FIXTURE = `
function handleAppend(M) {
  let GH = M.appendSystemPrompt;
  if (M.appendSystemPromptFile) {
    if (M.appendSystemPrompt) throw new Error("conflict");
    try {
      let V$ = path.resolve(M.appendSystemPromptFile);
      GH = fs.readFileSync(V$, "utf8");
    } catch (V$) {
      throw V$;
    }
  }
  return GH;
}
`;

test("sys-prompt-file verify rejects unpatched fixture", () => {
	const ast = parse(SYS_PROMPT_FILE_FIXTURE);
	const result = systemPromptFile.verify(SYS_PROMPT_FILE_FIXTURE, ast);
	assert.notEqual(result, true);
	assert.equal(typeof result, "string");
});

test("sys-prompt-file injects auto-append guard ahead of append file branch", async () => {
	const ast = parse(SYS_PROMPT_FILE_FIXTURE);
	await runSystemPromptFileViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes("process.env.CLAUDE_CODE_APPEND_SYSTEM_PROMPT_FILE"),
		true,
	);
	assert.equal(output.includes('"/etc/claude-code/system-prompt.md"'), true);
	assert.equal(
		output.includes("M.appendSystemPromptFile = resolvedSystemPromptFile"),
		true,
	);
	assert.equal(output.includes("M.systemPromptFile === void 0"), true);
	assert.equal(output.includes("M.systemPrompt === void 0"), true);
	assert.equal(output.includes("existsSync"), true);
	assert.equal(systemPromptFile.verify(output, ast), true);
	assert.equal(systemPromptFile.verify(output), true);
});

test("sys-prompt-file verify rejects auto-append guard outside sibling position", () => {
	const misplacedGuard = `
function unrelated(M) {
  if (M.systemPromptFile === void 0 && M.systemPrompt === void 0 && M.appendSystemPromptFile === void 0 && M.appendSystemPrompt === void 0) {
    let configuredSystemPromptFilePath = process.env.CLAUDE_CODE_APPEND_SYSTEM_PROMPT_FILE ?? "/etc/claude-code/system-prompt.md";
    try {
      let resolvedSystemPromptFile = path.resolve(configuredSystemPromptFilePath);
      if (fs.existsSync(resolvedSystemPromptFile)) {
        M.appendSystemPromptFile = resolvedSystemPromptFile;
      }
    } catch (err) {}
  }
}
${SYS_PROMPT_FILE_FIXTURE}
`;
	const ast = parse(misplacedGuard);
	const result = systemPromptFile.verify(misplacedGuard, ast);
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("immediately before"), true);
});

test("sys-prompt-file is idempotent when auto-append guard already exists", async () => {
	const ast = parse(SYS_PROMPT_FILE_FIXTURE);
	await runSystemPromptFileViaPasses(ast);
	const firstPass = print(ast);

	const ast2 = parse(firstPass);
	await runSystemPromptFileViaPasses(ast2);
	const secondPass = print(ast2);

	assert.equal(firstPass, secondPass);
	assert.equal(systemPromptFile.verify(secondPass, ast2), true);
});
