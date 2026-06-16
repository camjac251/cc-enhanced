import assert from "node:assert/strict";
import { test } from "node:test";
import { builtInAgentPrompt } from "./built-in-agent-prompt.js";
import {
	MODERN_CODE_SEARCH_DECISION_TREE_LINES,
	MODERN_CODE_SEARCH_POLICY,
	MODERN_STDOUT_CAP,
	MODERN_SUBAGENT_CODE_ROUTING,
	MODERN_TOOL_PREFERENCE,
} from "./prompt-policy.js";

// EXPLORE_FIXTURE stores the whenToUse em dash as a unicode escape (U+2014), the
// way the Biome-formatted cli.js does (it has no raw non-ASCII). Keep it escaped:
// a raw em dash here would no longer match the patch needle and would mask the no-op.
const EXPLORE_FIXTURE = `
const whenToUse = 'Fast read-only search agent for locating code. Use it to find files by pattern (eg. "src/components/**/*.tsx"), grep for symbols or keywords (eg. "API endpoints"), or answer "where is X defined / which files reference Y." Do NOT use it for code review, design-doc auditing, cross-file consistency checks, or open-ended analysis \\u2014 it reads excerpts rather than whole files and will miss content past its read window. When calling, specify search breadth: "quick" for a single targeted lookup, "medium" for moderate exploration, or "very thorough" to search across multiple locations and naming conventions.';
return \`You are a file search specialist for Claude Code, Anthropic's official CLI for Claude. You excel at thoroughly navigating and exploring codebases.

Your role is EXCLUSIVELY to search and analyze existing code. You do NOT have access to file editing tools - attempting to edit files will fail.

Your strengths:
- Rapidly finding files using glob patterns
- Searching code and text with powerful regex patterns
- Reading and analyzing file contents

- Use Read when you know the specific file path you need to read
- Use \${$} ONLY for read-only operations (\${H ? \`ls, git status, git log, git diff, find\${q ? ", grep" : ""}, cat, head, tail\` : "Get-ChildItem, git status, git log, git diff, Get-Content, Select-Object -First/-Last"})
- NEVER use \${$} for: \${H ? "mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install" : "New-Item, Remove-Item, Copy-Item, Move-Item, git add, git commit, npm install, pip install"}, or any file creation/modification
- Adapt your search approach based on the thoroughness level specified by the caller
- Communicate your final report directly as a regular message - do NOT attempt to create files

NOTE: You are meant to be a fast agent that returns output as quickly as possible. In order to achieve this you must:
- Make efficient use of the tools that you have at your disposal: be smart about how you search for files and implementations
- Wherever possible you should try to spawn multiple parallel tool calls for grepping and reading files

Complete the user's search request efficiently and report your findings clearly.\`;
`;

const PLAN_FIXTURE = `
const whenToUse = "Software architect agent for designing implementation plans. Use this when you need to plan the implementation strategy for a task. Returns step-by-step plans, identifies critical files, and considers architectural trade-offs.";
return \`You are a software architect and planning specialist for Claude Code. Your role is to explore the codebase and design implementation plans.

Your role is EXCLUSIVELY to explore the codebase and design implementation plans. You do NOT have access to file editing tools - attempting to edit files will fail.

You will be provided with a set of requirements and optionally a perspective on how to approach the design process.

1. **Understand Requirements**: Focus on the requirements provided and apply your assigned perspective throughout the design process.

2. **Explore Thoroughly**:
   - Read any files provided to you in the initial prompt
   - Find existing patterns and conventions using \${Yz() ? \\\`find\\\`, \\\`grep\\\`, and \${pD} : \${fM}, \${vK}, and \${pD}}
   - Understand the current architecture
   - Identify similar features as reference
   - Trace through relevant code paths
   - Use \${WD} ONLY for read-only operations (\${Yz() ? \`ls, git status, git log, git diff, find\${Yz() ? ", grep" : ""}, cat, head, tail\` : "Get-ChildItem, git status, git log, git diff, Get-Content, Select-Object -First/-Last"})
   - NEVER use \${WD} for: \${Yz() ? "mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install" : "New-Item, Remove-Item, Copy-Item, Move-Item, git add, git commit, npm install, pip install"}, or any file creation/modification

3. **Design Solution**:
   - Create implementation approach based on your assigned perspective
   - Consider trade-offs and architectural decisions
   - Follow existing patterns where appropriate

4. **Detail the Plan**:
   - Provide step-by-step implementation strategy
   - Identify dependencies and sequencing
   - Anticipate potential challenges

## Required Output

End your response with:

### Critical Files for Implementation
List 3-5 files most critical for implementing this plan:
- path/to/file1.ts - [Brief reason: e.g., "Core logic to modify"]
- path/to/file2.ts - [Brief reason: e.g., "Interfaces to implement"]
- path/to/file3.ts - [Brief reason: e.g., "Pattern to follow"]\`;
`;

const EXPLORE_PLACEHOLDER_FIXTURE = `
return \`You are a deep codebase researcher for Claude Code. Your job is to investigate code structure, trace execution paths, and surface the highest-signal files, call chains, and patterns quickly.

- Guidelines:
\${value_22}
\${value_23}
- Use \${Of} when you know the specific file path you need to read
- Use \${FD} ONLY for read-only operations (\${H ? \`ls, git status, git log, git diff, find\${q ? ", grep" : ""}, cat, head, tail\` : "Get-ChildItem, git status, git log, git diff, Get-Content, Select-Object -First/-Last"})
- NEVER use \${FD} for: \${H ? "mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install" : "New-Item, Remove-Item, Copy-Item, Move-Item, git add, git commit, npm install, pip install"}, or any file creation/modification

Complete the user's research request efficiently and report your findings clearly.\`;
`;

const PLAN_PLACEHOLDER_FIXTURE = `
return \`3. **Inspect the Existing Architecture**:
   - Find existing patterns and conventions using \${YO() ? \\\`find\\\`, \\\`grep\\\`, and \${Of} : \${eM}, \${T_}, and \${Of}}
   - Use \${FD} ONLY for read-only operations (\${YO() ? \`ls, git status, git log, git diff, find\${YO() ? ", grep" : ""}, cat, head, tail\` : "Get-ChildItem, git status, git log, git diff, Get-Content, Select-Object -First/-Last"})
   - NEVER use \${FD} for: \${YO() ? "mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install" : "New-Item, Remove-Item, Copy-Item, Move-Item, git add, git commit, npm install, pip install"}, or any file creation/modification\`;
`;

const GENERAL_FIXTURE = `
function Zc1() {
	return \`\${"You are an agent for Claude Code, Anthropic's official CLI for Claude. Given the user's message, you should use the tools available to complete the task. Complete the task fully\\u2014don't gold-plate, but don't leave it half-done."} When you complete the task, respond with a concise report covering what was done and any key findings \\u2014 the caller will relay this to the user, so it only needs the essentials.

\${\`Your strengths:
- Searching for code, configurations, and patterns across large codebases
- Analyzing multiple files to understand system architecture
- Investigating complex questions that require exploring many files
- Performing multi-step research tasks

Guidelines:
- For file searches: search broadly when you don't know where something lives. Use Read when you know the specific file path.
- For analysis: Start broad and narrow down. Use multiple search strategies if the first doesn't yield results.
- Be thorough: Check multiple locations, consider different naming conventions, look for related files.
- NEVER create files unless they're absolutely necessary for achieving your goal. ALWAYS prefer editing an existing file to creating a new one.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested.\`}\`;
}
`;

function patchedCombinedAgentFixture(): string {
	return [
		builtInAgentPrompt.string?.(EXPLORE_FIXTURE) ?? EXPLORE_FIXTURE,
		builtInAgentPrompt.string?.(PLAN_FIXTURE) ?? PLAN_FIXTURE,
		builtInAgentPrompt.string?.(GENERAL_FIXTURE) ?? GENERAL_FIXTURE,
	].join("\n");
}

test("built-in-agent-prompt rewrites Explore prompt and whenToUse", () => {
	const output =
		builtInAgentPrompt.string?.(EXPLORE_FIXTURE) ?? EXPLORE_FIXTURE;
	assert.equal(output.includes("Deep codebase research agent"), true);
	assert.equal(
		output.includes(
			"Mapping entry points, dependencies, and data flow across multiple files",
		),
		true,
	);
	assert.equal(output.includes("Analysis methodology:"), true);
	assert.equal(
		output.includes(
			"Feature discovery: find entry points, core implementation files, feature boundaries, and relevant configuration.",
		),
		true,
	);
	assert.equal(output.includes(MODERN_CODE_SEARCH_POLICY), true);
	assert.equal(
		output.includes(
			"Entry points: exact file:line references where the relevant functionality starts",
		),
		true,
	);
	assert.equal(
		output.includes(
			'Before recommending code changes, answer: "What specific defect or gap does this address?"',
		),
		true,
	);
	assert.equal(
		output.includes(
			"Security-sensitive findings, trust-boundary questions, or auth concerns -> recommend security-reviewer",
		),
		true,
	);
	for (const line of MODERN_CODE_SEARCH_DECISION_TREE_LINES) {
		assert.equal(output.includes(line), true);
	}
	assert.equal(
		output.includes(
			"Before using Read, Bash text search, sd, or generic edits on a code file",
		),
		true,
	);
	assert.equal(
		output.includes(
			"modern read-only operations (eza, git status, git log, git diff, fd, sg, rg, bat)",
		),
		true,
	);
	assert.equal(output.includes(MODERN_STDOUT_CAP), true);
	assert.equal(output.includes("Complete the user's research request"), true);
	assert.equal(builtInAgentPrompt.verify(patchedCombinedAgentFixture()), true);
});

test("built-in-agent-prompt rewrites the Explore whenToUse despite the bundle's escaped em dash", () => {
	// EXPLORE_FIXTURE carries the whenToUse em dash as a unicode escape (U+2014); a
	// literal-character needle silently no-ops against it. Asserting the whenToUse
	// replacement landed locks this surface against the recurring escaped-dash drift.
	const output =
		builtInAgentPrompt.string?.(EXPLORE_FIXTURE) ?? EXPLORE_FIXTURE;
	assert.equal(output.includes("Deep codebase research agent"), true);
});

test("built-in-agent-prompt rewrites Plan prompt and whenToUse", () => {
	const output = builtInAgentPrompt.string?.(PLAN_FIXTURE) ?? PLAN_FIXTURE;
	assert.equal(output.includes("Architecture and planning agent"), true);
	assert.equal(output.includes("Design the Implementation Blueprint"), true);
	assert.equal(
		output.includes(
			"Make decisive choices: choose a concrete approach rather than listing too many alternatives",
		),
		true,
	);
	assert.equal(
		output.includes(
			"Highlight critical files, reusable utilities, testing expectations, and likely challenges",
		),
		true,
	);
	assert.equal(
		output.includes(
			"Testability > Readability > Consistency > Simplicity > Reversibility",
		),
		true,
	);
	assert.equal(output.includes("state management"), true);
	assert.equal(
		output.includes(
			"Extract any CLAUDE.md guidance or local conventions that materially constrain the design",
		),
		true,
	);
	assert.equal(
		output.includes(
			"modern read-only operations (eza, git status, git log, git diff, fd, sg, rg, bat)",
		),
		true,
	);
	assert.equal(output.includes(MODERN_STDOUT_CAP), true);
	assert.equal(
		output.includes("Deliver a concrete implementation blueprint with:"),
		true,
	);
	assert.equal(output.includes("security reviewer should validate it"), true);
	assert.equal(
		output.includes(
			"docs researcher should verify assumptions before implementation",
		),
		true,
	);
	assert.equal(
		output.includes(
			"switch to review mode and return an architecture overview, issues by severity, recommendations, and risk assessment",
		),
		true,
	);
	assert.equal(
		output.includes("test engineer should shape the verification plan"),
		true,
	);
	assert.equal(builtInAgentPrompt.verify(patchedCombinedAgentFixture()), true);
});

test("built-in-agent-prompt rewrites general-purpose strengths and guidelines", () => {
	const output =
		builtInAgentPrompt.string?.(GENERAL_FIXTURE) ?? GENERAL_FIXTURE;
	assert.equal(
		output.includes(
			"- Searching for code, configurations, and patterns across large codebases",
		),
		false,
	);
	assert.equal(
		output.includes(
			"- For file searches: search broadly when you don't know where something lives",
		),
		false,
	);
	assert.equal(
		output.includes(
			"- Tracing execution paths and dependencies across many files",
		),
		true,
	);
	assert.equal(
		output.includes(
			"- Choosing the right code-search tool by intent rather than running broad text searches by default",
		),
		true,
	);
	assert.equal(output.includes(MODERN_CODE_SEARCH_POLICY), true);
	for (const line of MODERN_CODE_SEARCH_DECISION_TREE_LINES) {
		assert.equal(output.includes(line), true);
	}
	assert.equal(
		output.includes(
			"- Use Bash ONLY for modern read-only operations (eza, git status, git log, git diff, fd, sg, rg, bat)",
		),
		true,
	);
	assert.equal(output.includes(MODERN_TOOL_PREFERENCE), true);
	assert.equal(output.includes(MODERN_STDOUT_CAP), true);
	assert.equal(
		output.includes("- NEVER use Bash for: mkdir, touch, rm, cp, mv, git add"),
		true,
	);
	assert.equal(
		output.includes(
			"- NEVER create files unless they're absolutely necessary for achieving your goal.",
		),
		true,
	);
	assert.equal(
		output.includes(
			"- NEVER proactively create documentation files (*.md) or README files.",
		),
		true,
	);
	assert.equal(builtInAgentPrompt.verify(patchedCombinedAgentFixture()), true);
});

test("built-in-agent-prompt rewrites placeholder-backed read-only bash guidance", () => {
	const output =
		builtInAgentPrompt.string?.(EXPLORE_PLACEHOLDER_FIXTURE) ??
		EXPLORE_PLACEHOLDER_FIXTURE;
	assert.equal(output.includes("${value_22}"), false);
	assert.equal(output.includes("${value_23}"), false);
	assert.equal(
		output.includes(
			"ONLY for modern read-only operations (eza, git status, git log, git diff, fd, sg, rg, bat)",
		),
		true,
	);
	assert.equal(output.includes(MODERN_TOOL_PREFERENCE), true);
	assert.equal(
		output.includes(
			"- Use Read when you know the specific file path you need to read",
		),
		true,
	);
	assert.equal(output.includes("cat, head, tail"), false);
});

test("built-in-agent-prompt rewrites indented helper-backed plan bash guidance", () => {
	const output =
		builtInAgentPrompt.string?.(PLAN_PLACEHOLDER_FIXTURE) ??
		PLAN_PLACEHOLDER_FIXTURE;
	assert.equal(
		output.includes(
			"   - Use Bash ONLY for modern read-only operations (eza, git status, git log, git diff, fd, sg, rg, bat)",
		),
		true,
	);
	assert.equal(output.includes(`   - ${MODERN_TOOL_PREFERENCE}`), true);
	assert.equal(
		output.includes(
			"   - NEVER use Bash for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification",
		),
		true,
	);
	assert.equal(output.includes("${FD}"), false);
	assert.equal(output.includes("${YO()"), false);
	assert.equal(output.includes("cat, head, tail"), false);
});

test("built-in-agent-prompt verify rejects unpatched built-in prompt text", () => {
	const result = builtInAgentPrompt.verify(
		`${EXPLORE_FIXTURE}\n${PLAN_FIXTURE}`,
	);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("Explore agent") ||
			String(result).includes("Plan agent"),
		true,
	);
});

test("built-in-agent-prompt verify ignores unrelated legacy guidance elsewhere in bundle", () => {
	const output = patchedCombinedAgentFixture();
	const withUnrelatedLegacyText = `${output}\nconst unrelated = "Use Bash ONLY for read-only operations (ls, git status, git log, git diff, find${'${conditional(", grep" | "")}'} , cat, head, tail)";`;
	assert.equal(builtInAgentPrompt.verify(withUnrelatedLegacyText), true);
});

test("built-in-agent-prompt verify rejects missing agent prompt sections", () => {
	const result = builtInAgentPrompt.verify("const noop = true;");
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("Unable to extract Explore"), true);
});

const CORPUS_EXAMPLE_FIXTURE = `
return \`3. **Transcript search** - grep the JSONL transcripts for narrow terms:
   \\\`grep -rn "<narrow term>" \${$}/ --include="*.jsonl" | tail -50\\\`

## Verifying a server change

\\\`\\\`\\\`bash
curl -si localhost:3000/api/thing | head -20
\\\`\\\`\\\`
\`;
`;

test("built-in-agent-prompt rewrites upstream corpus head/tail examples", () => {
	const output =
		builtInAgentPrompt.string?.(CORPUS_EXAMPLE_FIXTURE) ??
		CORPUS_EXAMPLE_FIXTURE;
	assert.equal(output.includes("| tail -50"), false);
	assert.equal(output.includes("| head -20"), false);
	assert.equal(
		output.includes(`rg -m 50 "<narrow term>" \${$}/ -g '*.jsonl'`),
		true,
	);
	assert.equal(output.includes("curl -sI localhost:3000/api/thing"), true);
});

test("built-in-agent-prompt verify flags partial corpus rewrite", () => {
	const halfBaked = `\`curl -si localhost:3000/api/thing | head -20\``;
	const result = builtInAgentPrompt.verify(halfBaked);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("Unpatched corpus example") ||
			String(result).includes("Missing rewritten corpus example"),
		true,
	);
});

const WORKER_AGENT_FIXTURE =
	"return `You are a worker agent executing a task assigned by the coordinator. Report the commit hash.`;";

const WORKFLOW_SUBAGENT_FIXTURE =
	"g0_ = `You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task. Return verbatim.`; l0_ = `You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task. Call the tool.`;";

const AGENT_TOOL_LOOKUP_FIXTURE =
	"If the target is already known, use the direct tool: Read for a known path, `grep` via the Bash tool for a specific symbol or string.";

const AGENT_TOOL_FORK_SELECTION_FIXTURE =
	'return `${flag ? `When using the ${toolName} tool, specify a subagent_type to select an agent: \\`"fork"\\` forks yourself (the fork inherits your full conversation context and always runs on your model \\u2014 a \\`model\\` override is ignored); any other type \\u2014 or omitting it \\u2014 starts a fresh agent (general-purpose by default).` : `When using the ${toolName} tool, specify a subagent_type parameter to select which agent type to use. If omitted, the general-purpose agent is used.`}`;';

const CLAUDE_NOISY_FIXTURE =
	"For noisy investigation (grep sweeps, log trawls, broad search), spawn a subagent and keep only the findings here.";

const WORKFLOW_GREP_EXAMPLE_FIXTURE =
	"const flaky = await agent('grep CI logs for retry markers', {schema: FLAKY_SCHEMA}); { title: 'Scan', detail: 'grep test logs for retries' }";

function patchedSubagentSurfaces(): string {
	return [
		patchedCombinedAgentFixture(),
		builtInAgentPrompt.string?.(WORKER_AGENT_FIXTURE) ?? WORKER_AGENT_FIXTURE,
		builtInAgentPrompt.string?.(WORKFLOW_SUBAGENT_FIXTURE) ??
			WORKFLOW_SUBAGENT_FIXTURE,
		builtInAgentPrompt.string?.(AGENT_TOOL_LOOKUP_FIXTURE) ??
			AGENT_TOOL_LOOKUP_FIXTURE,
		builtInAgentPrompt.string?.(CLAUDE_NOISY_FIXTURE) ?? CLAUDE_NOISY_FIXTURE,
	].join("\n");
}

test("built-in-agent-prompt routes the Agent tool symbol lookup to Serena and Probe", () => {
	const output =
		builtInAgentPrompt.string?.(AGENT_TOOL_LOOKUP_FIXTURE) ??
		AGENT_TOOL_LOOKUP_FIXTURE;
	assert.equal(output.includes("`grep` via the Bash tool"), false);
	assert.equal(
		output.includes(
			"Serena or Probe search_code (exact: true) for a specific symbol or string",
		),
		true,
	);
});

test("built-in-agent-prompt rewrites the Agent tool fork-selection wording", () => {
	const output =
		builtInAgentPrompt.string?.(AGENT_TOOL_FORK_SELECTION_FIXTURE) ??
		AGENT_TOOL_FORK_SELECTION_FIXTURE;
	assert.equal(
		output.includes("any other type. Or omitting it. Starts"),
		false,
	);
	assert.equal(
		output.includes(
			'When using the ${toolName} tool, pass \\`subagent_type: "fork"\\` to fork yourself.',
		),
		true,
	);
	assert.equal(
		output.includes(
			"Pass any other subagent_type, or omit subagent_type, to start a fresh agent",
		),
		true,
	);
});

test("built-in-agent-prompt injects modern routing into the worker agent prompt", () => {
	const output =
		builtInAgentPrompt.string?.(WORKER_AGENT_FIXTURE) ?? WORKER_AGENT_FIXTURE;
	assert.equal(output.split(MODERN_SUBAGENT_CODE_ROUTING).length - 1, 1);
	assert.equal(
		output.includes(
			"You are a worker agent executing a task assigned by the coordinator.",
		),
		true,
	);
});

test("built-in-agent-prompt injects modern routing into both workflow-subagent variants", () => {
	const output =
		builtInAgentPrompt.string?.(WORKFLOW_SUBAGENT_FIXTURE) ??
		WORKFLOW_SUBAGENT_FIXTURE;
	assert.equal(output.split(MODERN_SUBAGENT_CODE_ROUTING).length - 1, 2);
});

test("built-in-agent-prompt modernizes the claude background-job investigation line", () => {
	const output =
		builtInAgentPrompt.string?.(CLAUDE_NOISY_FIXTURE) ?? CLAUDE_NOISY_FIXTURE;
	assert.equal(output.includes("grep sweeps, log trawls, broad search"), false);
	assert.equal(
		output.includes(
			"route search by intent (Serena, ChunkHound, Probe, ast-grep MCP or sg)",
		),
		true,
	);
});

test("built-in-agent-prompt softens the Workflow grep example to search", () => {
	const output =
		builtInAgentPrompt.string?.(WORKFLOW_GREP_EXAMPLE_FIXTURE) ??
		WORKFLOW_GREP_EXAMPLE_FIXTURE;
	assert.equal(output.includes("grep CI logs for retry markers"), false);
	assert.equal(output.includes("grep test logs for retries"), false);
	assert.equal(output.includes("search CI logs for retry markers"), true);
	assert.equal(output.includes("search test logs for retries"), true);
});

test("built-in-agent-prompt verify passes with patched sub-agent surfaces", () => {
	assert.equal(builtInAgentPrompt.verify(patchedSubagentSurfaces()), true);
});

test("built-in-agent-prompt verify flags an unpatched worker prompt", () => {
	const broken = `${patchedSubagentSurfaces()}\n${WORKER_AGENT_FIXTURE}`;
	const result = builtInAgentPrompt.verify(broken);
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("missing modern-tooling routing"), true);
});

test("built-in-agent-prompt verify flags an unpatched Agent tool grep reference", () => {
	const broken = `${patchedSubagentSurfaces()}\n${AGENT_TOOL_LOOKUP_FIXTURE}`;
	const result = builtInAgentPrompt.verify(broken);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("Agent tool symbol-lookup routing"),
		true,
	);
});

test("built-in-agent-prompt verify flags malformed Agent tool fork-selection wording", () => {
	const broken = `${patchedSubagentSurfaces()}\n${AGENT_TOOL_FORK_SELECTION_FIXTURE}`;
	const result = builtInAgentPrompt.verify(broken);
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("fork-selection wording"), true);
});

test("built-in-agent-prompt rewrites overlapping explore-guidelines and standalone read-only blocks in one pass", () => {
	// The Explore Guidelines block subsumes a generic read-only block, so
	// correctness depends on the explore-helper rewrite running before the
	// cross-platform rewrite. A combined fixture proves both are fully
	// modernized in one pass, catching a future statement-reorder or a regex
	// that stops matching after the other consumed its overlap.
	const combined = `${EXPLORE_PLACEHOLDER_FIXTURE}\n${PLAN_PLACEHOLDER_FIXTURE}`;
	const output = builtInAgentPrompt.string?.(combined) ?? combined;
	assert.equal(output.includes("cat, head, tail"), false);
	assert.equal(output.includes("ONLY for read-only operations ("), false);
	assert.equal(output.includes("${value_22}"), false);
	assert.equal(output.includes("${value_23}"), false);
	assert.equal(output.includes("${FD}"), false);
	assert.equal(output.includes("${YO()"), false);
	assert.equal(
		output.split(
			"ONLY for modern read-only operations (eza, git status, git log, git diff, fd, sg, rg, bat)",
		).length -
			1 >=
			2,
		true,
	);
});

test("built-in-agent-prompt leaves no residual legacy read-only block when several are present", () => {
	const twoBlocks = `${EXPLORE_FIXTURE}\n${PLAN_FIXTURE}`;
	const output = builtInAgentPrompt.string?.(twoBlocks) ?? twoBlocks;
	assert.equal(
		output.includes(
			"ONLY for read-only operations (ls, git status, git log, git diff, find",
		),
		false,
	);
	assert.equal(output.includes("cat, head, tail"), false);
});

test("built-in-agent-prompt rewrites escaped-backtick enhanced search guidance", () => {
	// The bundle stores these lines with escaped backticks, which is what the
	// regex alternation targets, not the un-escaped literal that the dead
	// verify guard checks. A fixture in the escaped form proves the rewrite
	// still lands, and fails loudly if the regex is simplified to assume
	// un-escaped backticks.
	const fixture =
		"Guidelines:\n- Use \\`find\\` via ${aq} for broad file pattern matching\n- Use \\`grep\\` via ${aq} for searching file contents with regex\n";
	const output = builtInAgentPrompt.string?.(fixture) ?? fixture;
	assert.equal(output.includes("Use \\`find\\` via"), false);
	assert.equal(output.includes("Use \\`grep\\` via"), false);
	assert.equal(
		output.includes(
			"- Use available code/file search tooling for focused discovery",
		),
		true,
	);
	assert.equal(
		output.includes(
			"- Use available content-search tooling for targeted discovery",
		),
		true,
	);
});

test("built-in-agent-prompt fork-selection rewrite is escaped-dash specific", () => {
	// The Biome-formatted bundle stores every non-ASCII character escaped, so
	// the rewrite must match the escaped-dash form and no-op on the raw form
	// the bundle never produces. This documents the escapeNonAscii dependency
	// and prevents a future "simplify the regex" change from accepting a form
	// the bundle never emits.
	const escaped = AGENT_TOOL_FORK_SELECTION_FIXTURE;
	const escapedOut = builtInAgentPrompt.string?.(escaped) ?? escaped;
	assert.equal(
		escapedOut.includes('pass \\`subagent_type: "fork"\\` to fork yourself.'),
		true,
	);
	const raw = AGENT_TOOL_FORK_SELECTION_FIXTURE.replaceAll("\\u2014", "—");
	const rawOut = builtInAgentPrompt.string?.(raw) ?? raw;
	assert.equal(
		rawOut.includes("specify a subagent_type to select an agent"),
		true,
	);
});
