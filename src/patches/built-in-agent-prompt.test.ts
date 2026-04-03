import assert from "node:assert/strict";
import { test } from "node:test";
import { builtInAgentPrompt } from "./built-in-agent-prompt.js";

const EXPLORE_FIXTURE = `
const whenToUse = 'Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.';
return \`You are a file search specialist for Claude Code, Anthropic's official CLI for Claude. You excel at thoroughly navigating and exploring codebases.

Your role is EXCLUSIVELY to search and analyze existing code. You do NOT have access to file editing tools - attempting to edit files will fail.

Your strengths:
- Rapidly finding files using glob patterns
- Searching code and text with powerful regex patterns
- Reading and analyzing file contents

- Use Read when you know the specific file path you need to read
- Use Bash ONLY for read-only operations (ls, git status, git log, git diff, find\${conditional(", grep" | "")}, cat, head, tail)
- NEVER use Bash for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification
- Adapt your search approach based on the thoroughness level specified by the caller
- Return file paths as absolute paths in your final response
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
   - Use \${WD} ONLY for read-only operations (ls, git status, git log, git diff, find\${Yz() ? ", grep" : ""}, cat, head, tail)
   - NEVER use \${WD} for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification

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
- Use \${FD} ONLY for read-only operations (ls, git status, git log, git diff, find\${H ? ", grep" : ""}, cat, head, tail)
- NEVER use \${FD} for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification

Complete the user's research request efficiently and report your findings clearly.\`;
`;

const PLAN_PLACEHOLDER_FIXTURE = `
return \`3. **Inspect the Existing Architecture**:
   - Find existing patterns and conventions using \${YO() ? \\\`find\\\`, \\\`grep\\\`, and \${Of} : \${eM}, \${T_}, and \${Of}}
   - Use \${FD} ONLY for read-only operations (ls, git status, git log, git diff, find\${YO() ? ", grep" : ""}, cat, head, tail)
   - NEVER use \${FD} for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification\`;
`;

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
	assert.equal(
		output.includes(
			"Start with semantic or focused structural search, then escalate to deeper codebase research only for multi-file architecture questions",
		),
		true,
	);
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
	assert.equal(
		output.includes(
			"prefer ast-grep or other syntax-aware code search over broad text matching",
		),
		true,
	);
	assert.equal(
		output.includes(
			"modern read-only operations (eza, git status, git log, git diff, fd, sg, rg, bat)",
		),
		true,
	);
	assert.equal(output.includes("Complete the user's research request"), true);
	assert.equal(builtInAgentPrompt.verify(output), true);
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
	assert.equal(builtInAgentPrompt.verify(output), true);
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
	assert.equal(
		output.includes(
			"Prefer sg for structural code search, rg only for exact text/config/logs, fd over find, eza over ls, and bat over cat/head/tail",
		),
		true,
	);
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
			"   - Use ${FD} ONLY for modern read-only operations (eza, git status, git log, git diff, fd, sg, rg, bat)",
		),
		true,
	);
	assert.equal(
		output.includes(
			"   - Prefer sg for structural code search, rg only for exact text/config/logs, fd over find, eza over ls, and bat over cat/head/tail",
		),
		true,
	);
	assert.equal(
		output.includes(
			"   - NEVER use ${FD} for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification",
		),
		true,
	);
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
	const output =
		builtInAgentPrompt.string?.(EXPLORE_FIXTURE) ?? EXPLORE_FIXTURE;
	const withUnrelatedLegacyText = `${output}\nconst unrelated = "Use Bash ONLY for read-only operations (ls, git status, git log, git diff, find${'${conditional(", grep" | "")}'} , cat, head, tail)";`;
	assert.equal(builtInAgentPrompt.verify(withUnrelatedLegacyText), true);
});

test("built-in-agent-prompt verify tolerates missing agent prompt section", () => {
	assert.equal(builtInAgentPrompt.verify("const noop = true;"), true);
});
