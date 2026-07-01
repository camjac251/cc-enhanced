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
async function handleAppend(M) {
  let GH = M.appendSystemPrompt;
  if (M.appendSystemPromptFile) {
    if (M.appendSystemPrompt) throw new Error("conflict");
    try {
      let V$ = path.resolve(M.appendSystemPromptFile);
      GH = await fs.readFile(V$, "utf8");
    } catch (V$) {
      throw V$;
    }
  }
  return GH;
}
`;

function countAutoAppendReadAssignments(output: string): number {
	return (
		output.match(
			/GH\s*=\s*await\s*fs\.readFile\(\s*resolvedSystemPromptFile\s*,\s*"utf8"\s*\)/g,
		)?.length ?? 0
	);
}

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
	assert.equal(countAutoAppendReadAssignments(output), 1);
	assert.equal(output.includes("M.systemPromptFile === void 0"), false);
	assert.equal(output.includes("M.systemPrompt === void 0"), false);
	assert.equal(output.includes("existsSync"), false);
	assert.equal(systemPromptFile.verify(output, ast), true);
	assert.equal(systemPromptFile.verify(output), true);
});

test("sys-prompt-file verify rejects auto-append guard outside sibling position", () => {
	const misplacedGuard = `
async function unrelated(M) {
  let GH = M.appendSystemPrompt;
  if (GH === void 0 && M.appendSystemPromptFile === void 0) {
    let configuredSystemPromptFilePath = process.env.CLAUDE_CODE_APPEND_SYSTEM_PROMPT_FILE ?? "/etc/claude-code/system-prompt.md";
    try {
      let resolvedSystemPromptFile = path.resolve(configuredSystemPromptFilePath);
      GH = await fs.readFile(resolvedSystemPromptFile, "utf8");
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

test("sys-prompt-file injects exactly one auto-append guard", async () => {
	const ast = parse(SYS_PROMPT_FILE_FIXTURE);
	await runSystemPromptFileViaPasses(ast);
	const output = print(ast);
	const guardCount =
		output.split("process.env.CLAUDE_CODE_APPEND_SYSTEM_PROMPT_FILE").length -
		1;
	assert.equal(guardCount, 1);
	assert.equal(countAutoAppendReadAssignments(output), 1);
});

test("sys-prompt-file auto-read uses the append branch readFile callee", async () => {
	const ast = parse(SYS_PROMPT_FILE_FIXTURE);
	await runSystemPromptFileViaPasses(ast);
	const output = print(ast);
	assert.equal(countAutoAppendReadAssignments(output), 1);
	assert.equal(output.includes("readFileSync"), false);
});

test("sys-prompt-file patches only the append-file branch when a systemPromptFile twin is present", async () => {
	const twinFixture = `
async function handleAppend(M) {
  let Ce = M.systemPrompt;
  if (M.systemPromptFile) {
    if (M.systemPrompt) throw new Error("conflict");
    try {
      let V$ = path.resolve(M.systemPromptFile);
      Ce = await fs.readFile(V$, "utf8");
    } catch (V$) {
      throw V$;
    }
  }
  let GH = M.appendSystemPrompt;
  if (M.appendSystemPromptFile) {
    if (M.appendSystemPrompt) throw new Error("conflict");
    try {
      let V$ = path.resolve(M.appendSystemPromptFile);
      GH = await fs.readFile(V$, "utf8");
    } catch (V$) {
      throw V$;
    }
  }
  return GH;
}
`;
	const ast = parse(twinFixture);
	await runSystemPromptFileViaPasses(ast);
	const output = print(ast);
	const guardCount =
		output.split("process.env.CLAUDE_CODE_APPEND_SYSTEM_PROMPT_FILE").length -
		1;
	assert.equal(guardCount, 1, "exactly one auto-append guard injected");
	assert.equal(countAutoAppendReadAssignments(output), 1);
	// the replacement-mode branch must not gain an auto-append guard for systemPromptFile
	assert.equal(
		output.includes("M.systemPromptFile = resolvedSystemPromptFile"),
		false,
	);
	assert.equal(systemPromptFile.verify(output, ast), true);
});

test("sys-prompt-file verify rejects an auto-append guard that also checks replacement-mode prompts", () => {
	const overbroadGuard = `
async function handleAppend(M) {
  let GH = M.appendSystemPrompt;
  if (GH === void 0 && M.appendSystemPromptFile === void 0 && M.systemPromptFile === void 0) {
    let configuredSystemPromptFilePath = process.env.CLAUDE_CODE_APPEND_SYSTEM_PROMPT_FILE ?? "/etc/claude-code/system-prompt.md";
    try {
      let resolvedSystemPromptFile = path.resolve(configuredSystemPromptFilePath);
      GH = await fs.readFile(resolvedSystemPromptFile, "utf8");
    } catch (err) {}
  }
  if (M.appendSystemPromptFile) {
    if (M.appendSystemPrompt) throw new Error("conflict");
    try {
      let V$ = path.resolve(M.appendSystemPromptFile);
      GH = await fs.readFile(V$, "utf8");
    } catch (V$) {
      throw V$;
    }
  }
  return GH;
}
`;
	const ast = parse(overbroadGuard);
	const result = systemPromptFile.verify(overbroadGuard, ast);
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("replacement-mode"), true);
});
