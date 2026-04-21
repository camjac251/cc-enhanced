import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { bashOutputTail } from "./bash-tail.js";

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
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-tail-runtime-"));
    const modulePath = path.join(tempDir, "patched-bash-tail-runtime.mjs");
    await fs.writeFile(
        modulePath,
        `${output}
export { BashTool, persistBlocks, truncateOutput };`,
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
    assert.equal(output.includes("build commands"), true);
    assert.equal(output.includes("maxOutput > 0"), true);
    assert.equal(output.includes("**NEVER** pipe to `| head -N`"), true);
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

    } finally {
        await cleanup();
    }
});
