import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { bashOutputTail } from "./bash-tail.js";
import { MODERN_OUTPUT_LIMIT_WARNING } from "./prompt-policy.js";

async function applyBashTailPatch(source: string): Promise<string> {
	const stringPatched = bashOutputTail.string?.(source) ?? source;
	const ast = parse(stringPatched);
	const passes = (await bashOutputTail.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: bashOutputTail.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
	const output = print(ast);
	assert.equal(bashOutputTail.verify(output, ast), true);
	return output;
}

async function loadPatchedBashTailRuntimeModule() {
	const output = await applyBashTailPatch(BASH_TAIL_FIXTURE);
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "bash-tail-runtime-"),
	);
	const modulePath = path.join(tempDir, "patched-bash-tail-runtime.mjs");
	await fs.writeFile(
		modulePath,
		`${output}
export { BashTool, persistBlocks, truncateOutput, renderBashMessage, isListCommand };`,
		"utf8",
	);
	const mod = await import(pathToFileURL(modulePath).href);
	return {
		mod,
		cleanup: async () => {
			await fs.rm(tempDir, { recursive: true, force: true });
		},
	};
}

const BASH_TAIL_FIXTURE = `
const z = {
  strictObject(x) { return x; },
  string() { return { optional() { return this; }, describe() { return this; } }; },
  number() { return { optional() { return this; }, describe() { return this; } }; },
  boolean() { return { optional() { return this; }, describe() { return this; } }; },
};

function detectImage(text) {
  return false;
}

function getDefaultThreshold() {
  return 8;
}

function buildPreview(stdout, limit) {
  return { preview: stdout.slice(0, limit), hasMore: stdout.length > limit };
}

const listCommands = new Set(["ls", "tree", "du"]);

function isListCommand(command) {
  return listCommands.has(command);
}

function detectSimulatedEdit(command) {
  return command === "sed-edit" ? { filePath: "/tmp/edited.txt" } : null;
}

function formatPath(filePath) {
  return "short:" + filePath;
}

async function storeBlocks(blocks, result, limit) {
  return { blocks, result, limit };
}

const BashTool = {
  name: "Bash",
  prompt() {
    return [
      "Executes a given bash command",
      "When issuing multiple commands:",
    ];
  },
  input_schema: z.strictObject({
    command: z.string().describe("The bash command to execute"),
    run_in_background: z.boolean().optional().describe("Run the command asynchronously"),
    dangerouslyDisableSandbox: z.boolean().optional().describe("Disable the sandbox"),
  }),
  async validateInput(input) {
    return { result: true };
  },
  async call(input, ctx) {
    return {
      type: "tool_result",
      data: {
        stdout: input.command,
        dangerouslyDisableSandbox: "dangerouslyDisableSandbox" in input ? input.dangerouslyDisableSandbox : void 0,
      },
    };
  },
  mapToolResultToToolResultBlockParam({ stdout }, limit) {
    const previewState = buildPreview(stdout, limit);
    return { preview: previewState.preview, hasMore: previewState.hasMore };
  },
};

async function persistBlocks(helper, result, ctx) {
  const blocks = helper.mapToolResultToToolResultBlockParam(
    result.data,
    ctx.maxResultSizeChars,
  );
  return await storeBlocks(blocks, result, ctx.maxResultSizeChars);
}

function truncateOutput(text) {
  let image = detectImage(text);
  let limit = getDefaultThreshold();
  if (image) return { totalLines: 1, truncatedContent: text, isImage: image };
  if (text.length <= limit) {
    return {
      totalLines: text.split("\\n").length,
      truncatedContent: text,
      isImage: image,
    };
  }
  let dropped = text.slice(limit).split("\\n").length;
  let preview = \`\${text.slice(0, limit)}\\n\\n... [\${dropped} lines truncated] ...\`;
  return {
    totalLines: text.split("\\n").length,
    truncatedContent: preview,
    isImage: image,
  };
}

function renderBashMessage(input, { verbose, theme }) {
  let { command } = input;
  if (!command) return null;
  let edit = detectSimulatedEdit(command);
  if (edit) return verbose ? edit.filePath : formatPath(edit.filePath);
  if (command.length > 100) {
    return { type: "Text", props: { children: [command.slice(0, 100), "\\u2026"] } };
  }
  return command;
}

const oversizedOutputWarning = "Pipe output through head, tail, or grep to reduce result size. Avoid cat on large files — use Read with offset/limit instead.";
const escapedOversizedOutputWarning = "Pipe output through head, tail, or grep to reduce result size. Avoid cat on large files \\u2014 use Read with offset/limit instead.";
const powershellOversizedOutputWarning = "Pipe output through Select-Object -First/-Last or Select-String to reduce result size. Avoid Get-Content on large files \\u2014 use Read with offset/limit instead.";
`;

test("bash-tail verify rejects the unpatched fixture", () => {
	const ast = parse(BASH_TAIL_FIXTURE);
	const result = bashOutputTail.verify(BASH_TAIL_FIXTURE, ast);
	assert.notEqual(result, true);
	assert.equal(typeof result, "string");
});

test("bash-tail patches schema, prompt, persistence, and preview surfaces", async () => {
	const output = await applyBashTailPatch(BASH_TAIL_FIXTURE);

	assert.equal(output.includes("output_tail"), true);
	assert.equal(output.includes("max_output"), true);
	assert.equal(output.includes("outputTail"), true);
	assert.equal(output.includes("maxOutput"), true);
	assert.equal(output.includes("globalThis.__bashTailOpts"), true);
	assert.equal(output.includes("Disk persistence"), true);
	assert.equal(output.includes("Output bounds"), true);
	assert.equal(output.includes("Choose the cap by intent"), true);
	assert.equal(output.includes("Producer-native caps"), true);
	assert.equal(output.includes("Bash tool caps"), true);
	assert.equal(output.includes("compiler/test output"), true);
	assert.equal(output.includes("maxOutput > 0"), true);
	assert.equal(output.includes('new Set(["ls", "tree", "du", "eza"])'), true);
	assert.equal(output.includes("directory metadata preview"), true);
	assert.equal(output.includes("build/test diagnostics"), true);
	assert.equal(
		output.includes(
			"Do not add shell pipeline truncation just to shorten output",
		),
		true,
	);
	assert.equal(
		output.includes("Never pipe listing output through head or tail"),
		true,
	);
	assert.equal(output.includes("`| head"), false);
	assert.equal(output.includes("| head -"), false);
	assert.equal(output.includes("`| tail"), false);
	assert.equal(output.includes("| tail -"), false);
	assert.equal(output.includes("__ccEnhancedHasOutputCapPipeline"), false);
	assert.equal(
		output.includes("Pipe output through head, tail, or grep"),
		false,
	);
	assert.equal(
		output.includes("Pipe output through Select-Object -First/-Last"),
		false,
	);
	assert.equal(output.includes(MODERN_OUTPUT_LIMIT_WARNING), true);
});

test("bash-tail runtime keeps tail content, fixes preview, and honors max_output persistence override", async () => {
	const { mod, cleanup } = await loadPatchedBashTailRuntimeModule();
	try {
		await mod.BashTool.call(
			{ command: "ignored", output_tail: true, max_output: 5 },
			{},
		);
		const tailed = mod.truncateOutput("0123456789ABCDEFG");
		assert.equal(tailed.truncatedContent.startsWith("... ["), true);
		assert.equal(tailed.truncatedContent.endsWith("CDEFG"), true);

		await mod.BashTool.call({ command: "ignored", max_output: 5 }, {});
		const headed = mod.truncateOutput("0123456789ABCDEFG");
		assert.equal(headed.truncatedContent.startsWith("01234"), true);
		assert.equal(
			headed.truncatedContent.includes("... [1 lines truncated] ..."),
			true,
		);

		const preview = mod.BashTool.mapToolResultToToolResultBlockParam(
			{
				stdout: "abcdef",
				outputTail: true,
			},
			3,
		);
		assert.deepEqual(preview, { preview: "def", hasMore: true });

		const ctx = { verbose: false, theme: "dark" };
		assert.equal(mod.renderBashMessage({ command: "ls" }, ctx), "ls");
		assert.equal(mod.renderBashMessage({}, ctx), null);
		assert.equal(
			mod.renderBashMessage({ command: "sed-edit" }, ctx),
			"short:/tmp/edited.txt",
		);
		assert.equal(
			mod.renderBashMessage({ command: "sed-edit", output_tail: true }, ctx),
			"short:/tmp/edited.txt · tail",
		);
		assert.equal(
			mod.renderBashMessage({ command: "ls", output_tail: true }, ctx),
			"ls · tail",
		);
		assert.equal(
			mod.renderBashMessage(
				{ command: "ls", run_in_background: true, max_output: 100 },
				ctx,
			),
			"ls · background, max_output: 100",
		);
		assert.equal(
			mod.renderBashMessage({ command: "ls", max_output: 0 }, ctx),
			"ls",
		);
		assert.equal(
			mod.renderBashMessage({ command: "ls", timeout: 5000 }, ctx),
			"ls · timeout: 5000",
		);
		assert.equal(
			mod.renderBashMessage(
				{ command: "ls", run_in_background: true, timeout: 5000 },
				ctx,
			),
			"ls · background, timeout: 5000",
		);
		assert.equal(
			mod.renderBashMessage(
				{ command: "ls", dangerouslyDisableSandbox: true },
				ctx,
			),
			"ls · no-sandbox",
		);
		assert.equal(mod.isListCommand("eza"), true);
		assert.deepEqual(
			await mod.BashTool.validateInput({ command: "printf hi" }),
			{
				result: true,
			},
		);
		assert.deepEqual(
			await mod.BashTool.validateInput({ command: "printf hi | head -40" }),
			{
				result: true,
			},
		);
		assert.deepEqual(
			await mod.BashTool.validateInput({
				command: "tail -F app.log | rg error",
			}),
			{
				result: true,
			},
		);
		const longCmd = "x".repeat(200);
		const el = mod.renderBashMessage(
			{ command: longCmd, output_tail: true },
			ctx,
		);
		assert.equal(el.type, "Text");
		assert.equal(Array.isArray(el.props.children), true);
		assert.equal(el.props.children[el.props.children.length - 1], " · tail");
	} finally {
		await cleanup();
	}
});
