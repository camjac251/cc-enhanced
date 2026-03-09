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

### Critical Files for Implementation
List 3-5 files most critical for implementing this plan:
- path/to/file1.ts - [Brief reason: e.g., "Core logic to modify"]
- path/to/file2.ts - [Brief reason: e.g., "Interfaces to implement"]
- path/to/file3.ts - [Brief reason: e.g., "Pattern to follow"]\`;
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
			"Entry points: exact file:line references where the relevant functionality starts",
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
    assert.equal(output.includes("[Why it matters to the implementation]"), true);
	assert.equal(builtInAgentPrompt.verify(output), true);
});

test("built-in-agent-prompt verify rejects unpatched built-in prompt text", () => {
	const result = builtInAgentPrompt.verify(
		`${EXPLORE_FIXTURE}\n${PLAN_FIXTURE}`,
	);
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("Explore agent prompt"), true);
});

test("built-in-agent-prompt verify tolerates missing agent prompt section", () => {
	assert.equal(builtInAgentPrompt.verify("const noop = true;"), true);
});
