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

test("tools-off verify accepts prompt cleanup when tools are still disabled", async () => {
	const stringPatched = disableTools.string?.(TOOL_FIXTURE) ?? TOOL_FIXTURE;
	const ast = parse(stringPatched);
	await runToolsOffViaPasses(ast);
	const result = disableTools.verify(print(ast), ast);
	assert.equal(result, true);
});

test("tools-off rewrites claude-code-guide reference text to neutral wording", async () => {
	const currentPrompt =
		"Reference local project files (CLAUDE.md, .claude/ directory) when relevant using ${Read}";

	const input = `${TOOL_FIXTURE}\nconst prompt = \`${currentPrompt}\`;`;
	const rewritten = disableTools.string?.(input) ?? input;
	assert.ok(rewritten);
	assert.match(
		rewritten,
		/Reference local project files \(CLAUDE\.md, \.claude\/ directory\) when relevant using Read/,
	);
	assert.doesNotMatch(rewritten, /using \$\{Read\}/);

	const ast = parse(rewritten);
	await runToolsOffViaPasses(ast);
	assert.equal(disableTools.verify(print(ast), ast), true);
});

test("tools-off rewrites runtime-conditional plan-mode exploration template", () => {
	// Mirrors the live upstream shape: "1. Thoroughly explore the codebase
	// using ${expr}\n" where expr is a balanced template expression. Stale
	// PLAN_REWRITES (`Glob, Grep, and Read tools` literal) would silently
	// no-op against this shape.
	const input = [
		"## What Happens in Plan Mode",
		"",
		"In plan mode, you'll:",
		"1. Thoroughly explore the codebase using ${_L() && O1() ? `\\`find\\`/${J5}, \\`grep\\`/${B1}, and ${YK}` : `${J5}, ${B1}, and ${YK}`}",
		"2. Understand existing patterns",
	].join("\n");

	const output = disableTools.string?.(input) ?? input;
	assert.equal(
		output.includes(
			"1. Thoroughly explore the codebase using available search tooling and Read",
		),
		true,
		`expected neutral plan-mode line in output:\n${output}`,
	);
	assert.equal(
		output.includes("Thoroughly explore the codebase using ${"),
		false,
		"runtime-conditional template should be fully replaced",
	);
});

test("tools-off verify ignores unrelated GrepTool labels outside prompt guidance", async () => {
	const input = `${TOOL_FIXTURE}\nconst labelMap = { GrepTool: "Searching" };`;
	const stringPatched = disableTools.string?.(input) ?? input;
	const ast = parse(stringPatched);
	await runToolsOffViaPasses(ast);
	assert.equal(disableTools.verify(print(ast), ast), true);
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

test("tools-off rewrites REPL disabled-tool examples", () => {
	const input = [
		"const prompt = `",
		"const { filenames } = await Glob({ pattern: 'src/**/*.ts' })",
		"All tools work as async functions: \\`Read\\`, \\`Write\\`, \\`Edit\\`, \\`Glob\\`, \\`Grep\\`, \\`${bashTool}\\`, etc.",
		"const { filenames } = await Glob({ pattern: '*.ts' })",
		"const { file } = await Read({ file_path: 'config.json' })",
		"const { stdout } = await ${bashTool}({ command: 'git status' })",
		"For filesystem access use \\`Read\\`/\\`Write\\`/\\`Glob\\`; for shell use \\`${bashTool}\\`.",
		"`;",
	].join("\n");

	const output = disableTools.string?.(input) ?? input;
	assert.equal(output.includes("Glob"), false);
	assert.equal(output.includes("Grep"), false);
	assert.equal(output.includes("fd -e ts src"), true);
	assert.equal(output.includes("split('\\\\n')"), true);
	assert.equal(output.includes("fd -e ts . --max-results 20"), true);
	assert.equal(
		output.includes(
			"const { stdout } = await ${bashTool}({ command: 'fd -e ts src' })",
		),
		true,
	);
	assert.equal(output.includes("${q}"), false);
	assert.equal(
		output.includes(
			"prefer MCP code-search tools or \\`sg\\` through \\`${bashTool}\\`",
		),
		true,
	);
});

test("tools-off rewrites ToolSearch disabled-tool example", () => {
	const input =
		'Query forms:\n- "select:Read,Edit,Grep" — fetch these exact tools by name';
	const output = disableTools.string?.(input) ?? input;
	assert.equal(output.includes("select:Read,Edit,Grep"), false);
	assert.equal(output.includes("select:Read,Edit,Bash"), true);
});

test("tools-off rewrites remote planning disabled-tool guidance", () => {
	const input =
		"Explore the codebase directly with Glob, Grep, and Read. Read the relevant code, understand how the pieces fit, look for existing functions and patterns you can reuse instead of proposing new ones, and shape an approach grounded in what's actually there.";
	const output = disableTools.string?.(input) ?? input;
	assert.equal(output.includes("Glob, Grep, and Read"), false);
	assert.equal(output.includes("available read-only tools"), true);
	assert.equal(
		output.includes("symbol, semantic, and structural search"),
		true,
	);
});

test("tools-off neutralizes disabled Grep tool prompt text", async () => {
	const input = [
		TOOL_FIXTURE,
		'const grepPrompt = "  - ALWAYS use ${Uc} for search tasks. NEVER invoke \\`grep\\` or \\`rg\\` as a ${ns} command. The ${Uc} tool has been optimized for correct permissions and access.";',
	].join("\n");
	const { output, ast } = await applyFullPatch(input);

	assert.equal(output.includes("ALWAYS use"), false);
	assert.equal(output.includes("NEVER invoke \\`grep\\`"), false);
	assert.equal(output.includes("Local policy disables this tool"), true);
	assert.equal(output.includes("Route code search by intent"), true);
	assert.equal(disableTools.verify(output, ast), true);
});

test("tools-off scrubs the PowerShell search bullets and leaves the Bash-builder shape for bash-prompt", () => {
	// Two shapes ship in the bundle: "- " bullets in the PowerShell prompt (scrubbed
	// here) and no-marker backtick array elements in the Bash prompt builder, which
	// the bash-prompt patch rewrites into modern code-search guidance. tools-off must
	// scrub only the "- " PowerShell shape; clobbering the Bash-builder shape would
	// strip the richer guidance bash-prompt injects.
	const input = [
		"- File search: Use ${p_} (NOT Get-ChildItem -Recurse)",
		"- Content search: Use ${K5} (NOT Select-String)",
		"`File search: Use ${p_} (NOT find or ls)`",
		"`Content search: Use ${K5} (NOT grep or rg)`",
	].join("\n");
	const output = disableTools.string?.(input) ?? input;
	// PowerShell "- " bullets scrub to neutral wording.
	assert.equal(
		output.includes(
			"- File search: Use available file-search tooling with focused scope",
		),
		true,
	);
	assert.equal(
		output.includes(
			"- Content search: Use available content-search tooling with focused scope",
		),
		true,
	);
	// No "- " PowerShell bullet still names a disabled tool.
	assert.equal(output.includes("- File search: Use ${"), false);
	assert.equal(output.includes("- Content search: Use ${"), false);
	// The Bash-builder backtick shape is left intact for bash-prompt to rewrite.
	assert.equal(
		output.includes("`File search: Use ${p_} (NOT find or ls)`"),
		true,
	);
	assert.equal(
		output.includes("`Content search: Use ${K5} (NOT grep or rg)`"),
		true,
	);
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

test("tools-off strips forbidden tools from JSON-style allowed_tools examples", async () => {
	const input = `
${TOOL_FIXTURE}
const docs = "**Common tool matchers:** \\\`Bash\\\`, \\\`Write\\\`, \\\`Edit\\\`, \\\`Read\\\`, \\\`Glob\\\`, \\\`Grep\\\`";
const remoteRoutineExample = {
  job_config: {
    ccr: {
      session_context: {
        "allowed_tools": ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
      },
    },
  },
};
`;
	const { output, ast } = await applyFullPatch(input);

	assert.equal(
		output.includes('"allowed_tools": ["Bash", "Read", "Write", "Edit"]'),
		true,
	);
	assert.equal(
		output.includes(
			'"allowed_tools": ["Bash", "Read", "Write", "Edit", "Glob", "Grep"]',
		),
		false,
	);
	assert.equal(disableTools.verify(output, ast), true);
});

test("tools-off rewrites actionable legacy command examples in bundled skills", async () => {
	const input = [
		TOOL_FIXTURE,
		'const runSkill = `d=$PWD; while :; do\n  grep -Hm1 \'^description:\' "$d"/.claude/skills/*/SKILL.md 2>/dev/null\n  [ -e "$d/.git" ] || [ "$d" = / ] && break\n  d=$(dirname "$d")\ndone`;',
		'const designSync = "after the sub-skill stages the scripts: \\`grep -r ASSUMPTION .ds-sync/*.mjs .ds-sync/lib/*.mjs\\` lists them.\\ngrep classes/tokens against the compiled stylesheets in the output dir.";',
		"const permissionSkill = \"These don't need an allowlist entry \\u2014 they never prompt. If you see any of these in the transcripts, skip them; don't suggest them to the user.\\nIf the user is in this repo and you're unsure whether a command is covered, grep these files rather than guessing.\";",
		'const sendUserFile = "When unsure of a path, verify with ls first; absolute paths avoid ambiguity about the working directory.";',
		`const prPrompt = \`gh pr create --title "Short, descriptive title" --body "$(cat <<'EOF'
## Summary
<1-3 bullet points>

## Test plan
[Bulleted markdown checklist of TODOs for testing the pull request...]
EOF
)"\`;`,
	].join("\n");
	const { output, ast } = await applyFullPatch(input);

	assert.equal(output.includes("grep -Hm1"), false);
	assert.equal(output.includes("2>/dev/null"), false);
	assert.equal(output.includes("grep -r ASSUMPTION"), false);
	assert.equal(output.includes("Grep classes/tokens"), false);
	assert.equal(output.includes("grep classes/tokens"), false);
	assert.equal(output.includes("grep these files rather than guessing"), false);
	assert.equal(output.includes("verify with ls first"), false);
	assert.equal(output.includes("--body \"$(cat <<'EOF'"), false);
	assert.equal(output.includes("fd -a SKILL.md"), true);
	assert.equal(output.includes("rg -n -m 1"), true);
	assert.equal(output.includes("rg -n 'ASSUMPTION'"), true);
	assert.equal(
		output.includes("\\`rg\\` against generated CSS/text artifacts"),
		true,
	);
	assert.equal(output.includes("permission-classification data only"), true);
	assert.equal(output.includes("\\`rg -n\\` rather than guessing"), true);
	assert.equal(output.includes("\\`fd\\` or \\`eza\\` first"), true);
	assert.equal(output.includes("pr_body=$(mktemp)"), true);
	assert.equal(output.includes('--body-file "$pr_body"'), true);
	assert.equal(disableTools.verify(output, ast), true);
});

// ---------------------------------------------------------------------------
// Variable-indirection tool resolution (the shape the live bundle uses)
// ---------------------------------------------------------------------------

test("tools-off disables tools whose name resolves through a variable binding", async () => {
	const input = `
var TOOL_GREP = "Grep";
var TOOL_GLOB = "Glob";
var TOOL_WS = "WebSearch";
var TOOL_WF = "WebFetch";
var TOOL_NB = "NotebookEdit";
const builtinTools = [
  { name: TOOL_GREP, description: "d", inputSchema: {}, prompt: "p", call() {} },
  { name: TOOL_GLOB, description: "d", inputSchema: {}, prompt: "p", call() {} },
  { name: TOOL_WS, description: "d", inputSchema: {}, prompt: "p", isEnabled() { return true; }, call() {} },
  { name: TOOL_WF, description: "d", inputSchema: {}, prompt: "p", isEnabled() { return true; }, call() {} },
  { name: TOOL_NB, description: "d", inputSchema: {}, prompt: "p", isEnabled() { return true; }, call() {} },
];
const skillConfig = { filePatternTools: ["Read", "Bash"] };
`;
	const stringPatched = disableTools.string?.(input) ?? input;
	const ast = parse(stringPatched);
	await runToolsOffViaPasses(ast);
	// verify() resolves names via the same var-binding path the live bundle needs.
	assert.equal(disableTools.verify(print(ast), ast), true);
});

test("tools-off appends isEnabled when absent and replaces a truthy isEnabled (var-indirection)", async () => {
	const input = `
var TOOL_GREP = "Grep";
var TOOL_WS = "WebSearch";
const builtinTools = [
  // No isEnabled -> mutator must APPEND a disabled one.
  { name: TOOL_GREP, description: "d", inputSchema: {}, prompt: "p", call() {} },
  // Live-gate truthy isEnabled -> mutator must REPLACE with return false.
  { name: TOOL_WS, description: "d", inputSchema: {}, prompt: "p", isEnabled() { return someGate() && otherGate(); }, call() {} },
];
`;
	const ast = parse(disableTools.string?.(input) ?? input);
	await runToolsOffViaPasses(ast);
	const out = print(ast);
	// Both tool objects must now expose a hard-false isEnabled and no truthy gate survives.
	assert.doesNotMatch(out, /isEnabled\(\)\s*\{\s*return someGate/);
	// Exactly two disabled isEnabled bodies (one appended, one replaced).
	const disabledCount = (
		out.match(/isEnabled\(\)\s*\{\s*return\s+(?:false|!1)\s*;?\s*\}/g) ?? []
	).length;
	assert.ok(
		disabledCount >= 2,
		`expected >=2 disabled isEnabled bodies, got ${disabledCount}`,
	);
});

test("tools-off strips disabled tools from inline comma-separated allowed-tools lines", () => {
	const input = [
		"allowed-tools: ${Z8z}, Read, Glob, Grep, LS, Task",
		"allowed-tools: Read, Grep, Bash(git:*)",
	].join("\n");
	const out = disableTools.string?.(input) ?? input;
	// Disabled tools gone from inline allowed-tools lines.
	assert.doesNotMatch(out, /allowed-tools:[^\n]*\bGlob\b/);
	assert.doesNotMatch(out, /allowed-tools:[^\n]*\bGrep\b/);
	// Surrounding tools and the interpolation are preserved.
	assert.equal(out.includes("allowed-tools: ${Z8z}, Read, LS, Task"), true);
	assert.equal(out.includes("allowed-tools: Read, Bash(git:*)"), true);
});

test("tools-off verify rejects a target tool left enabled (var-indirection, mutator skipped)", () => {
	// All five target tools are present; only Glob is left enabled. The other
	// four are already disabled so verify's tool loop reaches Glob and fails on
	// it. The string phase runs but the AST mutator does not, so Glob stays on.
	const input = `
var TOOL_GREP = "Grep";
var TOOL_GLOB = "Glob";
var TOOL_WS = "WebSearch";
var TOOL_WF = "WebFetch";
var TOOL_NB = "NotebookEdit";
const builtinTools = [
  { name: TOOL_GREP, description: "d", inputSchema: {}, prompt: "p", isEnabled() { return false; }, call() {} },
  { name: TOOL_GLOB, description: "d", inputSchema: {}, prompt: "p", isEnabled() { return true; }, call() {} },
  { name: TOOL_WS, description: "d", inputSchema: {}, prompt: "p", isEnabled() { return false; }, call() {} },
  { name: TOOL_WF, description: "d", inputSchema: {}, prompt: "p", isEnabled() { return false; }, call() {} },
  { name: TOOL_NB, description: "d", inputSchema: {}, prompt: "p", isEnabled() { return false; }, call() {} },
];
const skillConfig = { filePatternTools: ["Read", "Bash"] };
`;
	// Run only the string phase; do NOT run the AST mutator, so Glob stays enabled.
	const ast = parse(disableTools.string?.(input) ?? input);
	const result = disableTools.verify(print(ast), ast);
	assert.notEqual(result, true);
	// The per-object disablement check reports the enabled Glob registration.
	assert.match(
		String(result),
		/Glob (?:is not disabled|has an enabled registration)/,
	);
});

test("tools-off verify rejects a second still-enabled registration of an already-disabled tool", () => {
	// Glob is registered twice: one disabled, one still enabled. A name-keyed
	// check would pass (it saw a disabled Glob), but the live tool must be off
	// everywhere it is registered.
	const input = `
const builtinTools = [
  { name: "Grep", description: "d", inputSchema: {}, prompt: "p", isEnabled() { return false; }, call() {} },
  { name: "WebSearch", description: "d", inputSchema: {}, prompt: "p", isEnabled() { return false; }, call() {} },
  { name: "WebFetch", description: "d", inputSchema: {}, prompt: "p", isEnabled() { return false; }, call() {} },
  { name: "NotebookEdit", description: "d", inputSchema: {}, prompt: "p", isEnabled() { return false; }, call() {} },
  { name: "Glob", description: "d", inputSchema: {}, prompt: "p", isEnabled() { return false; }, call() {} },
  { name: "Glob", description: "d2", inputSchema: {}, prompt: "p", isEnabled() { return true; }, call() {} },
];
const skillConfig = { filePatternTools: ["Read", "Bash"] };
`;
	const ast = parse(disableTools.string?.(input) ?? input);
	const result = disableTools.verify(print(ast), ast);
	assert.notEqual(result, true);
	assert.match(String(result), /Glob has an enabled registration/);
});
