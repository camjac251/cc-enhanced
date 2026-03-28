import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { disableTools } from "./tools-off.js";

async function runToolsOffViaPasses(ast: any): Promise<void> {
	const passes = (await disableTools.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: disableTools.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

const TOOL_FIXTURE = `
const builtinTools = [
  {
    name: "Grep",
    description: "Search content",
    inputSchema: {},
    prompt: "Use Read for specifics",
    isEnabled() {
      return false;
    },
    call() {},
  },
  {
    name: "Glob",
    description: "Find files",
    inputSchema: {},
    prompt: "Use Read for specifics",
    isEnabled: false,
    call() {},
  },
  {
    name: "WebSearch",
    description: "Search web",
    inputSchema: {},
    prompt: "Search web",
    isEnabled() {
      return false;
    },
    call() {},
  },
  {
    name: "WebFetch",
    description: "Fetch page",
    inputSchema: {},
    prompt: "Fetch page",
    isEnabled: false,
    call() {},
  },
  {
    name: "NotebookEdit",
    description: "Edit notebook",
    inputSchema: {},
    prompt: "Edit notebook",
    isEnabled() {
      return false;
    },
    call() {},
  },
];
const skillConfig = {
  filePatternTools: ["Read", "Bash"]
};
`;

test("tools-off verify accepts upstream prompt cleanup when tools are still disabled", async () => {
	const stringPatched = disableTools.string?.(TOOL_FIXTURE) ?? TOOL_FIXTURE;
	const ast = parse(stringPatched);
	await runToolsOffViaPasses(ast);
	const result = disableTools.verify(print(ast), ast);
	assert.equal(result, true);
});

test("tools-off rewrites legacy disabled-tool guidance to neutral wording", async () => {
	const legacyPrompt = [
		"Use Grep or Glob when you need to search broadly. Use Read when you know the specific file path.",
		"or use the GrepTool to search for specific content.",
		"any task that can be accomplished with direct Glob, Grep, or Read tool calls.",
		"Reference local project files (CLAUDE.md, .claude/ directory) when relevant using ${Read}, ${Glob}, and ${Grep}",
		"Reference local project files (CLAUDE.md, .claude/ directory) when relevant using ${Read}",
		'- If you are searching for a specific class definition like "class Foo", use ${Glob} instead, to find the match more quickly',
	].join("\n");

	const input = `${TOOL_FIXTURE}\nconst prompt = \`${legacyPrompt}\`;`;
	const rewritten = disableTools.string?.(input) ?? input;
	assert.ok(rewritten);
	assert.match(
		rewritten,
		/Use available search tooling broadly, and use Read when you know the specific file path\./,
	);
	assert.match(
		rewritten,
		/or use available content-search tooling to search for specific content\./,
	);
	assert.match(
		rewritten,
		/any task that can be accomplished with direct Read and available search tool calls\./,
	);
	assert.match(
		rewritten,
		/Reference local project files \(CLAUDE\.md, \.claude\/ directory\) when relevant using Read/,
	);
	assert.match(
		rewritten,
		/- If you are searching for code patterns like "class Foo", use available code-search tooling for faster access/,
	);

	const ast = parse(rewritten);
	await runToolsOffViaPasses(ast);
	assert.equal(disableTools.verify(print(ast), ast), true);
});

test("tools-off verify ignores unrelated GrepTool labels outside prompt guidance", async () => {
	const input = `${TOOL_FIXTURE}\nconst labelMap = { GrepTool: "Searching" };`;
	const stringPatched = disableTools.string?.(input) ?? input;
	const ast = parse(stringPatched);
	await runToolsOffViaPasses(ast);
	assert.equal(disableTools.verify(print(ast), ast), true);
});

test("tools-off verify fails when legacy trigger survives without neutral rewrite", () => {
	const ast = parse(
		`${TOOL_FIXTURE}\nconst prompt = "Use Grep or Glob when you need to search broadly.";`,
	);
	assert.equal(
		disableTools.verify(print(ast), ast),
		"Still contains disabled Grep/Glob guidance: Use Grep or Glob when you need to search broadly",
	);
});

// ---------------------------------------------------------------------------
// Prompt rewrite tests
// ---------------------------------------------------------------------------

test("tools-off rewrites agent search guidance", () => {
	const input = `
- Use \${qV} for broad file pattern matching
- Use \${OX} for searching file contents with regex
    `;
	const output = disableTools.string?.(input) ?? input;
	assert.equal(
		output.includes("available code/file search tooling for focused discovery"),
		true,
	);
	assert.equal(
		output.includes("available content-search tooling for targeted discovery"),
		true,
	);
});

test("tools-off updates legacy Task-tool subagent description", () => {
	const unpatched =
		'describe("Information about an available subagent that can be invoked via the Task tool.")';
	const output = disableTools.string?.(unpatched) ?? unpatched;
	assert.equal(output.includes("invoked via the Task tool"), false);
	assert.equal(output.includes("invoked via the Agent tool"), true);
});

// ---------------------------------------------------------------------------
// Skill tools tests
// ---------------------------------------------------------------------------

async function applyFullPatch(
	input: string,
): Promise<{ output: string; ast: any }> {
	const stringPatched = disableTools.string?.(input) ?? input;
	const ast = parse(stringPatched);
	await runToolsOffViaPasses(ast);
	return { output: print(ast), ast };
}

test("tools-off strips forbidden tools from filePatternTools and skill docs", async () => {
	const input = `
${TOOL_FIXTURE}
const docs = "**Common tool matchers:** \\\`Bash\\\`, \\\`Write\\\`, \\\`Edit\\\`, \\\`Read\\\`, \\\`Glob\\\`, \\\`Grep\\\`";
const webfetchHeader = "## When to Use WebFetch";
const skill = {
  name: "claude-api",
  allowedTools: ["Read", "Grep", "Glob", "WebFetch"],
  filePatternTools: ["Read", "Glob", "Grep"]
};
`;
	const { output, ast } = await applyFullPatch(input);

	assert.match(output, /\*\*Common tool matchers:\*\*[^\n"]*Agent/);
	assert.doesNotMatch(output, /\*\*Common tool matchers:\*\*[^\n"]*Glob/);
	assert.doesNotMatch(output, /\*\*Common tool matchers:\*\*[^\n"]*Grep/);
	assert.equal(output.includes("## When to Use WebFetch"), false);
	assert.equal(output.includes("## When to Fetch Live Documentation"), true);
	assert.equal(output.includes('allowedTools: ["Read", "Bash"]'), true);
	assert.equal(output.includes('filePatternTools: ["Read"]'), true);
	assert.equal(disableTools.verify(output, ast), true);
});
