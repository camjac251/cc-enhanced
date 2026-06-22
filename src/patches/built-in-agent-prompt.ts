import type { Patch } from "../types.js";
import {
	buildModernReadonlyReplacement,
	MODERN_CODE_SEARCH_POLICY,
	MODERN_CODE_TOOL_SELF_CHECK,
	MODERN_READONLY_OPS,
	MODERN_STDOUT_CAP,
	MODERN_SUBAGENT_CODE_ROUTING,
	MODERN_TOOL_PREFERENCE,
	PROHIBITED_BASH_OPS,
} from "./prompt-policy.js";

const EXPLORE_WHEN_TO_USE_SOURCE =
	'Fast read-only search agent for locating code. Use it to find files by pattern (eg. "src/components/**/*.tsx"), grep for symbols or keywords (eg. "API endpoints"), or answer "where is X defined / which files reference Y." Do NOT use it for code review, design-doc auditing, cross-file consistency checks, or open-ended analysis — it reads excerpts rather than whole files and will miss content past its read window. When calling, specify search breadth: "quick" for a single targeted lookup, "medium" for moderate exploration, or "very thorough" to search across multiple locations and naming conventions.';

const EXPLORE_WHEN_TO_USE_REPLACEMENT =
	"Deep codebase research agent for tracing execution paths, finding existing implementations, and building context before planning or coding. Use this when the task spans multiple files, the architecture is unclear, or you need evidence-backed answers about how the codebase works.";

const PLAN_WHEN_TO_USE_SOURCE =
	"Software architect agent for designing implementation plans. Use this when you need to plan the implementation strategy for a task. Returns step-by-step plans, identifies critical files, and considers architectural trade-offs.";

const PLAN_WHEN_TO_USE_REPLACEMENT =
	"Architecture and planning agent for turning exploration results into concrete implementation blueprints. Use this when you need a step-by-step build plan, critical files, sequencing, and trade-off analysis before editing code.";

const EXPLORE_PROMPT_SOURCE =
	"You are a file search specialist for Claude Code, Anthropic's official CLI for Claude. You excel at thoroughly navigating and exploring codebases.";

const EXPLORE_PROMPT_REPLACEMENT =
	"You are a deep codebase researcher for Claude Code. Your job is to investigate code structure, trace execution paths, and surface the highest-signal files, call chains, and patterns quickly.";

const PLAN_PROMPT_SOURCE =
	"You are a software architect and planning specialist for Claude Code. Your role is to explore the codebase and design implementation plans.";

const PLAN_PROMPT_REPLACEMENT =
	"You are a senior software architect for Claude Code. Your role is to turn codebase research into a concrete implementation blueprint that fits the existing architecture.";

const GENERAL_STRENGTHS_AND_GUIDELINES_SOURCE = `Your strengths:
- Searching for code, configurations, and patterns across large codebases
- Analyzing multiple files to understand system architecture
- Investigating complex questions that require exploring many files
- Performing multi-step research tasks

Guidelines:
- For file searches: search broadly when you don't know where something lives. Use Read when you know the specific file path.
- For analysis: Start broad and narrow down. Use multiple search strategies if the first doesn't yield results.
- Be thorough: Check multiple locations, consider different naming conventions, look for related files.
- NEVER create files unless they're absolutely necessary for achieving your goal. ALWAYS prefer editing an existing file to creating a new one.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested.`;

const GENERAL_STRENGTHS_AND_GUIDELINES_REPLACEMENT = `Your strengths:
- Tracing execution paths and dependencies across many files
- Investigating architecture and surfacing patterns the user can build on
- Executing multi-step research and bounded implementation tasks
- Choosing the right code-search tool by intent rather than running broad text searches by default

Guidelines:
- ${MODERN_CODE_TOOL_SELF_CHECK}
${MODERN_CODE_SEARCH_POLICY}
- For analysis: start broad to map the area, then narrow to the highest-signal files. Use multiple search strategies if the first does not yield results.
- Be thorough: check multiple locations, consider different naming conventions, look for related files.
- Use Bash ${MODERN_READONLY_OPS}
- ${MODERN_TOOL_PREFERENCE}
- ${MODERN_STDOUT_CAP}
- ${PROHIBITED_BASH_OPS.replace("%TOOL%", "Bash")}
- NEVER create files unless they're absolutely necessary for achieving your goal. ALWAYS prefer editing an existing file to creating a new one.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested.`;

const EXPLORE_SECTION_REPLACEMENTS: Array<[string, string]> = [
	[
		`Your role is EXCLUSIVELY to search and analyze existing code. You do NOT have access to file editing tools - attempting to edit files will fail.`,
		`Your role is EXCLUSIVELY to inspect existing code and explain what you found. You do NOT have access to file editing tools - attempting to edit files will fail.`,
	],
	[
		`Your strengths:
- Rapidly finding files using glob patterns
- Searching code and text with powerful regex patterns
- Reading and analyzing file contents`,
		`Your strengths:
- Mapping entry points, dependencies, and data flow across multiple files
- Finding similar implementations and project conventions
- Tracing how functionality works end-to-end before code changes are made
- Narrowing broad search results down to the highest-signal files`,
	],
	[
		`- Adapt your search approach based on the thoroughness level specified by the caller`,
		`- Start broad, then narrow down to the highest-signal files, functions, and call paths`,
	],
	[
		`- Communicate your final report directly as a regular message - do NOT attempt to create files`,
		`- Return absolute file paths in your final response, support conclusions with file:line references, and communicate findings directly as a regular message`,
	],
	[
		`NOTE: You are meant to be a fast agent that returns output as quickly as possible. In order to achieve this you must:
- Make efficient use of the tools that you have at your disposal: be smart about how you search for files and implementations
- Wherever possible you should try to spawn multiple parallel tool calls for grepping and reading files`,
		`Workflow:
1. Start broad enough to understand the relevant subsystem or entry point.
2. Trace the key execution path through the most relevant files.
3. Identify existing patterns, helpers, or analogous implementations worth reusing.
4. Summarize only the findings that materially help the caller decide what to do next.

Analysis methodology:
1. Feature discovery: find entry points, core implementation files, feature boundaries, and relevant configuration.
2. Code flow tracing: follow call chains, data transformations, dependencies, and side effects.
3. Architecture analysis: identify abstractions, design patterns, and cross-cutting concerns.
4. Implementation details: note edge cases, performance considerations, and technical debt.

Efficiency rules:
- ${MODERN_CODE_SEARCH_POLICY}
- Make efficient use of the tools that you have at your disposal: search broadly only when needed, then read selectively
- Wherever possible you should try to spawn multiple parallel tool calls for searching and reading files`,
	],
	[
		`Complete the user's search request efficiently and report your findings clearly.`,
		`Required output:
- Entry points: exact file:line references where the relevant functionality starts
- Core components: the most important files, functions, or modules and their roles
- Data flow: how data or control moves through the system
- Dependencies: important internal and external integrations
- Architecture insights: patterns, abstractions, and notable constraints
- Essential files list: the top files to read next

Support conclusions with concrete file:line references and concise reasoning.

Research-to-action gate:
- Before recommending code changes, answer: "What specific defect or gap does this address?"
- If there is no concrete defect, implementation need, or decision to unblock, present findings as informational rather than prescriptive.

Specialist handoffs:
- Security-sensitive findings, trust-boundary questions, or auth concerns -> recommend security-reviewer
- Frontend/UI behavior, accessibility, or design-system questions -> recommend ui-specialist
- External library/framework/API documentation questions -> recommend docs-researcher
- When the caller needs a concrete implementation blueprint -> recommend Plan or code-architect

Complete the user's research request efficiently and report your findings clearly.`,
	],
];

const PLAN_SECTION_REPLACEMENTS: Array<[string, string]> = [
	[
		`Your role is EXCLUSIVELY to explore the codebase and design implementation plans. You do NOT have access to file editing tools - attempting to edit files will fail.`,
		`Your role is EXCLUSIVELY to explore the codebase and design an implementation blueprint. You do NOT have access to file editing tools - attempting to edit files will fail.`,
	],
	[
		`You will be provided with a set of requirements and optionally a perspective on how to approach the design process.`,
		`You will be provided with a set of requirements and possibly exploration findings from other agents. Use them to produce a concrete build plan that fits the existing codebase.`,
	],
	[
		`1. **Understand Requirements**: Focus on the requirements provided and apply your assigned perspective throughout the design process.`,
		`1. **Understand Requirements**:
   - Restate the user's goal in implementation terms
   - Identify the key constraints, risks, and unknowns
   - Extract any CLAUDE.md guidance or local conventions that materially constrain the design`,
	],
	[`2. **Explore Thoroughly**:`, `2. **Inspect the Existing Architecture**:`],
	[
		`   - Understand the current architecture`,
		`   - Understand module boundaries, entry points, integration seams, and existing abstraction layers`,
	],
	[
		`   - Identify similar features as reference`,
		`   - Identify similar features, reusable helpers, and reference implementations`,
	],
	[
		`   - Trace through relevant code paths`,
		`   - Trace the relevant code paths deeply enough to avoid speculative design and cite the key files that justify the design`,
	],
	[`3. **Design Solution**:`, `3. **Design the Implementation Blueprint**:`],
	[
		`   - Create implementation approach based on your assigned perspective`,
		`   - Make decisive choices: choose a concrete approach rather than listing too many alternatives`,
	],
	[
		`   - Consider trade-offs and architectural decisions`,
		`   - Cover interfaces, dependencies, sequencing, verification, and likely edge cases
   - Use this decision priority ladder when trade-offs are close: Testability > Readability > Consistency > Simplicity > Reversibility`,
	],
	[
		`   - Follow existing patterns where appropriate`,
		`   - Follow existing patterns where appropriate and call out deliberate deviations`,
	],
	[`4. **Detail the Plan**:`, `4. **Deliver an Actionable Plan**:`],
	[
		`   - Provide step-by-step implementation strategy`,
		`   - Provide step-by-step implementation phases`,
	],
	[
		`   - Anticipate potential challenges`,
		`   - Highlight critical files, reusable utilities, testing expectations, and likely challenges`,
	],
	[
		`## Required Output

End your response with:`,
		`## Required Output

Deliver a concrete implementation blueprint with:
- Patterns found: existing patterns, conventions, and similar features with file references
- Architecture decision: the chosen approach with rationale and key trade-offs
- Component design: files, responsibilities, interfaces, and dependencies
- Implementation map: what changes belong in which files or modules
- Data flow: entry points through transformations to outputs
- Build sequence: phased implementation checklist
- Critical details: testing, error handling, state management, performance, security, and migration concerns

Make confident choices rather than presenting too many options. Be specific about file paths, responsibilities, and sequencing.

If the user is asking for an architecture assessment rather than a build plan, switch to review mode and return an architecture overview, issues by severity, recommendations, and risk assessment.
If the work is frontend-heavy, call out when a dedicated UI specialist should shape the design details.
If the plan introduces security-sensitive trust boundaries or auth changes, call out when a dedicated security reviewer should validate it.
If external API or library behavior is uncertain, call out when a docs researcher should verify assumptions before implementation.
If testing strategy is non-trivial or risk-heavy, call out when a dedicated test engineer should shape the verification plan.

End your response with:`,
	],
];

const GENERAL_PURPOSE_SECTION_REPLACEMENTS: Array<[string, string]> = [
	[
		GENERAL_STRENGTHS_AND_GUIDELINES_SOURCE,
		GENERAL_STRENGTHS_AND_GUIDELINES_REPLACEMENT,
	],
];

const CORPUS_EXAMPLE_REPLACEMENTS: Array<[string, string]> = [
	[
		"curl -si localhost:3000/api/thing | head -20",
		"curl -sI localhost:3000/api/thing",
	],
	["grep CI logs for retry markers", "search CI logs for retry markers"],
	["grep test logs for retries", "search test logs for retries"],
];

const EXPLORE_ENHANCED_SEARCH_GUIDANCE_REPLACEMENTS: Array<[RegExp, string]> = [
	[
		/- Use \\?`find\\?` via \$\{[A-Za-z0-9_$]+\} for broad file pattern matching/g,
		"- Use available code/file search tooling for focused discovery",
	],
	[
		/- Use \\?`grep\\?` via \$\{[A-Za-z0-9_$]+\} for searching file contents with regex/g,
		"- Use available content-search tooling for targeted discovery",
	],
];

// Modern-tooling routing for the built-in sub-agent and orchestration prompt
// surfaces the Explore/Plan/general-purpose rewrites above do not cover. Each
// anchor below is a verbatim, minified-name-free literal in the bundle.
const WORKER_AGENT_OPENER =
	"You are a worker agent executing a task assigned by the coordinator.";

const WORKFLOW_SUBAGENT_OPENER =
	"You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.";

const SUBAGENT_ROUTING_ANCHORS = [
	WORKER_AGENT_OPENER,
	WORKFLOW_SUBAGENT_OPENER,
] as const;

const WORKER_AGENT_AUTO_COMMIT_SOURCE =
	"- If you changed any files, commit your changes when done. Use a clear, descriptive commit message. Only stage files you actually changed \\u2014 never use \\`git add .\\` or \\`git add -A\\`. Report the commit hash in your summary.";

const WORKER_AGENT_AUTO_COMMIT_REPLACEMENT =
	"- If you changed files, report the changed paths and verification results. Do not commit unless the coordinator explicitly asked you to commit.";

const CLAUDE_NOISY_INVESTIGATION_SOURCE =
	"For noisy investigation (grep sweeps, log trawls, broad search), spawn a subagent and keep only the findings here.";

const CLAUDE_NOISY_INVESTIGATION_REPLACEMENT =
	"For noisy investigation (broad code search or log trawls), spawn a subagent and keep only the findings here. The subagent should route search by intent (Serena, ChunkHound, Probe, ast-grep MCP or sg) and use rg only for logs and other non-code text.";

const AGENT_TOOL_SYMBOL_LOOKUP_SOURCE = "`grep` via the Bash tool";

const AGENT_TOOL_SYMBOL_LOOKUP_REPLACEMENT =
	"Serena or Probe search_code (exact: true)";

const AGENT_TOOL_FORK_SELECTION_RE =
	/When using the (\$\{[^}]+\}) tool, specify a subagent_type to select an agent: \\`"fork"\\` forks yourself \(the fork inherits your full conversation context and always runs on your model \\u2014 a \\`model\\` override is ignored\); any other type \\u2014 or omitting it \\u2014 starts a fresh agent \(general-purpose by default\)\./g;

const AGENT_TOOL_FORK_SELECTION_PATCHED_RE =
	/When using the \$\{[^}]+\} tool, pass \\`subagent_type: "fork"\\` to fork yourself\. A fork inherits your full conversation context, always runs on your model, and ignores any \\`model\\` override\. Pass any other subagent_type, or omit subagent_type, to start a fresh agent \(general-purpose by default\)\./;

function agentToolForkSelectionReplacement(toolExpr: string): string {
	return [
		`When using the ${toolExpr} tool, pass `,
		'\\`subagent_type: "fork"\\`',
		" to fork yourself. A fork inherits your full conversation context, always runs on your model, and ignores any ",
		"\\`model\\`",
		" override. Pass any other subagent_type, or omit subagent_type, to start a fresh agent (general-purpose by default).",
	].join("");
}

function subagentRoutingInjection(anchor: string): string {
	return `${anchor}\n\n${MODERN_SUBAGENT_CODE_ROUTING}`;
}

function countOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count += 1;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

const GENERAL_SOURCE_SIGNALS = [
	"Your strengths:\n- Searching for code, configurations, and patterns across large codebases",
];

const GENERAL_PATCHED_SIGNALS = [
	"Your strengths:\n- Tracing execution paths and dependencies across many files",
	"Choosing the right code-search tool by intent rather than running broad text searches by default",
	MODERN_CODE_SEARCH_POLICY,
	"For analysis: start broad to map the area, then narrow to the highest-signal files.",
	`Use Bash ${MODERN_READONLY_OPS}`,
];

const GENERAL_SCOPE_END_SIGNALS = [
	"Only create documentation files if explicitly requested.",
];

const EXPLORE_SOURCE_SIGNALS = [EXPLORE_PROMPT_SOURCE];

const EXPLORE_PATCHED_SIGNALS = [
	EXPLORE_PROMPT_REPLACEMENT,
	"Mapping entry points, dependencies, and data flow across multiple files",
	"Analysis methodology:",
	"Feature discovery: find entry points, core implementation files, feature boundaries, and relevant configuration.",
	MODERN_CODE_SEARCH_POLICY,
	"Entry points: exact file:line references where the relevant functionality starts",
	'Before recommending code changes, answer: "What specific defect or gap does this address?"',
	"Security-sensitive findings, trust-boundary questions, or auth concerns -> recommend security-reviewer",
	"Complete the user's research request efficiently and report your findings clearly.",
];

const PLAN_SOURCE_SIGNALS = [PLAN_PROMPT_SOURCE];

const PLAN_PATCHED_SIGNALS = [
	PLAN_PROMPT_REPLACEMENT,
	"Design the Implementation Blueprint",
	"Testability > Readability > Consistency > Simplicity > Reversibility",
];

const PLAN_OPTIONAL_SOURCE_SIGNALS = [
	`## Required Output

End your response with:`,
];

const PLAN_OPTIONAL_PATCHED_SIGNALS = [
	"Deliver a concrete implementation blueprint with:",
	"Architecture decision: the chosen approach with rationale and key trade-offs",
	"state management",
	"switch to review mode and return an architecture overview, issues by severity, recommendations, and risk assessment",
	"security reviewer should validate it",
	"docs researcher should verify assumptions before implementation",
	"test engineer should shape the verification plan",
];

const PLACEHOLDER_TOOL_EXPR = "\\$\\{[^}]+\\}|Bash";
const PLACEHOLDER_INTERPOLATION_EXPR = "\\$\\{[^}]+\\}";
// Matches the cross-platform read-only ops block that wraps the POSIX and
// PowerShell lists in an outer ternary. The POSIX branch is a backtick
// template literal containing a nested `find${...}` interpolation.
//
// Shape:
//   - Use ${TOOL} ONLY for read-only operations (${COND ? `ls, git status,
//     git log, git diff, find${INNER ? ", grep" : ""}, cat, head, tail`
//     : "Get-ChildItem, ... Select-Object -First/-Last"})
//   - NEVER use ${TOOL} for: ${COND ? "mkdir, touch, ..." :
//     "New-Item, Remove-Item, ..."}, or any file creation/modification
const CROSS_PLATFORM_READONLY_OPS_RE = new RegExp(
	`(^|\\n)([ \\t]*)- Use (${PLACEHOLDER_TOOL_EXPR}) ONLY for read-only operations \\(\\$\\{[^?]+\\? \`ls, git status, git log, git diff, find\\$\\{[^}]+\\}, cat, head, tail\` : "Get-ChildItem[^"]*"\\}\\)\\n\\2- NEVER use (${PLACEHOLDER_TOOL_EXPR}) for: \\$\\{[^?]+\\? "mkdir[^"]*" : "New-Item[^"]*"\\}, or any file creation\\/modification`,
	"g",
);
// Matches the Explore-agent Guidelines block where two placeholder search
// guidance interpolations sit above the Read line and the read-only block.
const EXPLORE_HELPER_GUIDELINES_RE = new RegExp(
	`Guidelines:\\n${PLACEHOLDER_INTERPOLATION_EXPR}\\n${PLACEHOLDER_INTERPOLATION_EXPR}\\n- Use ${PLACEHOLDER_INTERPOLATION_EXPR} when you know the specific file path you need to read\\n- Use (${PLACEHOLDER_TOOL_EXPR}) ONLY for read-only operations \\(\\$\\{[^?]+\\? \`ls, git status, git log, git diff, find\\$\\{[^}]+\\}, cat, head, tail\` : "Get-ChildItem[^"]*"\\}\\)\\n- NEVER use (${PLACEHOLDER_TOOL_EXPR}) for: \\$\\{[^?]+\\? "mkdir[^"]*" : "New-Item[^"]*"\\}, or any file creation\\/modification`,
	"g",
);
const PLAN_HELPER_FIND_LINE_RE =
	/^[ \t]*- Find existing patterns and conventions using \$\{.+\}$/gm;

// Re-export shared builder so callers in this file don't need a second import
const MODERN_READONLY_REPLACEMENT = buildModernReadonlyReplacement;

function findFirstSignalIndex(code: string, signals: string[]): number {
	for (const signal of signals) {
		const index = code.indexOf(signal);
		if (index !== -1) return index;
	}
	return -1;
}

function extractPromptSlice(
	code: string,
	startSignals: string[],
	endSignals: string[],
	fallbackLength = 8000,
): string | null {
	const startIndex = findFirstSignalIndex(code, startSignals);
	if (startIndex === -1) return null;

	let endIndex = -1;
	for (const signal of endSignals) {
		const candidateIndex = code.indexOf(signal, startIndex);
		if (candidateIndex === -1) continue;
		const candidateEnd = candidateIndex + signal.length;
		if (candidateEnd > endIndex) endIndex = candidateEnd;
	}

	if (endIndex === -1) {
		endIndex = Math.min(code.length, startIndex + fallbackLength);
	}

	return code.slice(startIndex, endIndex);
}

const EXPLORE_SCOPE_END_SIGNALS = [
	"Complete the user's research request efficiently and report your findings clearly.",
	"Complete the user's search request efficiently and report your findings clearly.",
];

const PLAN_SCOPE_END_SIGNALS = [
	"REMEMBER: You can ONLY explore and plan. You CANNOT and MUST NOT write, edit, or modify any files. You do NOT have access to file editing tools.",
	"[Why it matters to the implementation]",
];

// The Biome-formatted bundle stores every non-ASCII character in a string literal
// as a \uXXXX escape; it contains no raw non-ASCII bytes. A source needle authored
// with a literal non-ASCII character (e.g. an em dash) therefore never matches the
// bundle text, and the rewrite silently no-ops while verify() sees neither the
// source nor the replacement and passes. Normalize needles to the escaped form
// before matching so they line up with the bundle's representation.
function escapeNonAscii(text: string): string {
	return text.replace(
		/[^\x00-\x7F]/g,
		(ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

export const builtInAgentPrompt: Patch = {
	tag: "built-in-agent-prompt",

	string: (code) => {
		let result = code;

		result = result.replaceAll(
			escapeNonAscii(EXPLORE_WHEN_TO_USE_SOURCE),
			EXPLORE_WHEN_TO_USE_REPLACEMENT,
		);
		result = result.replaceAll(
			escapeNonAscii(PLAN_WHEN_TO_USE_SOURCE),
			PLAN_WHEN_TO_USE_REPLACEMENT,
		);
		result = result.replaceAll(
			escapeNonAscii(EXPLORE_PROMPT_SOURCE),
			EXPLORE_PROMPT_REPLACEMENT,
		);
		result = result.replaceAll(
			escapeNonAscii(PLAN_PROMPT_SOURCE),
			PLAN_PROMPT_REPLACEMENT,
		);
		result = result.replace(
			EXPLORE_HELPER_GUIDELINES_RE,
			(match, toolExprA: string, toolExprB: string) =>
				toolExprA === toolExprB
					? `Guidelines:\n${MODERN_READONLY_REPLACEMENT(toolExprA)}`
					: match,
		);
		result = result.replace(
			CROSS_PLATFORM_READONLY_OPS_RE,
			(
				match,
				prefix: string,
				indent: string,
				toolExprA: string,
				toolExprB: string,
			) =>
				toolExprA === toolExprB
					? `${prefix}${MODERN_READONLY_REPLACEMENT(toolExprA, indent)}`
					: match,
		);
		result = result.replaceAll(
			PLAN_HELPER_FIND_LINE_RE,
			"   - Use syntax-aware code search and focused reads to locate relevant implementations",
		);

		for (const [source, replacement] of EXPLORE_SECTION_REPLACEMENTS) {
			result = result.replaceAll(escapeNonAscii(source), replacement);
		}
		for (const [source, replacement] of PLAN_SECTION_REPLACEMENTS) {
			result = result.replaceAll(escapeNonAscii(source), replacement);
		}
		for (const [source, replacement] of GENERAL_PURPOSE_SECTION_REPLACEMENTS) {
			result = result.replaceAll(escapeNonAscii(source), replacement);
		}
		for (const [source, replacement] of CORPUS_EXAMPLE_REPLACEMENTS) {
			result = result.replaceAll(escapeNonAscii(source), replacement);
		}
		// Transcript-search corpus example. The path token (${...}) is a minified
		// name that changes between releases, so match it generically and re-emit
		// the captured token rather than hardcoding it.
		result = result.replace(
			/grep -rn "<narrow term>" (\$\{[^}]+\})\/ --include="\*\.jsonl" \| tail -50/g,
			(_match, token: string) =>
				`rg -m 50 "<narrow term>" ${token}/ -g '*.jsonl'`,
		);
		for (const [
			pattern,
			replacement,
		] of EXPLORE_ENHANCED_SEARCH_GUIDANCE_REPLACEMENTS) {
			result = result.replace(pattern, replacement);
		}

		result = result.replaceAll(
			escapeNonAscii(AGENT_TOOL_SYMBOL_LOOKUP_SOURCE),
			AGENT_TOOL_SYMBOL_LOOKUP_REPLACEMENT,
		);
		result = result.replace(
			AGENT_TOOL_FORK_SELECTION_RE,
			(_match, toolExpr: string) => agentToolForkSelectionReplacement(toolExpr),
		);
		result = result.replaceAll(
			escapeNonAscii(CLAUDE_NOISY_INVESTIGATION_SOURCE),
			CLAUDE_NOISY_INVESTIGATION_REPLACEMENT,
		);
		result = result.replaceAll(
			escapeNonAscii(WORKER_AGENT_AUTO_COMMIT_SOURCE),
			WORKER_AGENT_AUTO_COMMIT_REPLACEMENT,
		);
		for (const anchor of SUBAGENT_ROUTING_ANCHORS) {
			const injected = subagentRoutingInjection(anchor);
			if (!result.includes(injected)) {
				result = result.replaceAll(escapeNonAscii(anchor), injected);
			}
		}

		return result;
	},

	verify: (code) => {
		const verifyExactReplacement = (
			source: string,
			replacement: string,
			label: string,
		): true | string => {
			const hasSource = code.includes(escapeNonAscii(source));
			const hasReplacement = code.includes(replacement);
			if (!hasSource && !hasReplacement) return true;
			if (!hasReplacement) {
				return `Missing rewritten ${label} signal: ${replacement}`;
			}
			if (hasSource) {
				return `Unpatched ${label} source text remains: ${source}`;
			}
			return true;
		};

		const verifySection = (
			scope: string | null,
			sourceSignals: string[],
			patchedSignals: string[],
			label: string,
		): true | string => {
			if (scope == null) return true;

			const hasSourceSignals = sourceSignals.some((signal) =>
				scope.includes(signal),
			);
			const hasPatchedSignals = patchedSignals.some((signal) =>
				scope.includes(signal),
			);
			if (!hasSourceSignals && !hasPatchedSignals) return true;

			for (const signal of patchedSignals) {
				if (!scope.includes(signal)) {
					return `Missing rewritten ${label} signal: ${signal}`;
				}
			}

			for (const signal of sourceSignals) {
				if (scope.includes(signal)) {
					return `Unpatched ${label} source text remains: ${signal}`;
				}
			}

			return true;
		};

		const exploreWhenToUseResult = verifyExactReplacement(
			EXPLORE_WHEN_TO_USE_SOURCE,
			EXPLORE_WHEN_TO_USE_REPLACEMENT,
			"Explore agent whenToUse",
		);
		if (exploreWhenToUseResult !== true) return exploreWhenToUseResult;

		const planWhenToUseResult = verifyExactReplacement(
			PLAN_WHEN_TO_USE_SOURCE,
			PLAN_WHEN_TO_USE_REPLACEMENT,
			"Plan agent whenToUse",
		);
		if (planWhenToUseResult !== true) return planWhenToUseResult;

		for (const [source, replacement] of CORPUS_EXAMPLE_REPLACEMENTS) {
			const hasSource = code.includes(escapeNonAscii(source));
			const hasReplacement = code.includes(replacement);
			if (!hasSource && !hasReplacement) continue;
			if (hasSource) {
				return `Unpatched corpus example remains: ${source}`;
			}
			if (!hasReplacement) {
				return `Missing rewritten corpus example: ${replacement}`;
			}
		}
		// Token-independent transcript-search guard. The grep corpus example
		// interpolates a minified path token that changes between releases, so a
		// surviving "| tail -50" means the rewrite no-oped regardless of which
		// token the bundle used. Catch the behavior, not the exact source string.
		if (code.includes("| tail -50")) {
			return "Unpatched transcript-search corpus example remains (| tail -50 survived)";
		}

		const exploreScope = extractPromptSlice(
			code,
			[EXPLORE_PROMPT_SOURCE, EXPLORE_PROMPT_REPLACEMENT],
			EXPLORE_SCOPE_END_SIGNALS,
		);
		const planScope = extractPromptSlice(
			code,
			[PLAN_PROMPT_SOURCE, PLAN_PROMPT_REPLACEMENT],
			PLAN_SCOPE_END_SIGNALS,
		);
		const generalScope = extractPromptSlice(
			code,
			[
				...GENERAL_SOURCE_SIGNALS,
				"Your strengths:\n- Tracing execution paths and dependencies across many files",
			],
			GENERAL_SCOPE_END_SIGNALS,
		);
		if (exploreScope == null) {
			return "Unable to extract Explore built-in agent prompt scope";
		}
		if (planScope == null) {
			return "Unable to extract Plan built-in agent prompt scope";
		}
		if (generalScope == null) {
			return "Unable to extract general-purpose built-in agent prompt scope";
		}

		const exploreResult = verifySection(
			exploreScope,
			EXPLORE_SOURCE_SIGNALS,
			EXPLORE_PATCHED_SIGNALS,
			"Explore agent prompt",
		);
		if (exploreResult !== true) return exploreResult;

		const planResult = verifySection(
			planScope,
			PLAN_SOURCE_SIGNALS,
			PLAN_PATCHED_SIGNALS,
			"Plan agent prompt",
		);
		if (planResult !== true) return planResult;

		const planOptionalResult = verifySection(
			planScope,
			PLAN_OPTIONAL_SOURCE_SIGNALS,
			PLAN_OPTIONAL_PATCHED_SIGNALS,
			"Plan agent prompt required-output section",
		);
		if (planOptionalResult !== true) return planOptionalResult;

		const generalResult = verifySection(
			generalScope,
			GENERAL_SOURCE_SIGNALS,
			GENERAL_PATCHED_SIGNALS,
			"general-purpose agent prompt",
		);
		if (generalResult !== true) return generalResult;
		const scopedPrompts = [exploreScope, planScope, generalScope];
		if (!scopedPrompts.some((scope) => scope.includes(MODERN_READONLY_OPS))) {
			return "Missing modern read-only operations guidance in built-in agent prompts";
		}
		if (
			!scopedPrompts.some((scope) => scope.includes(MODERN_TOOL_PREFERENCE))
		) {
			return "Missing sg/fd/bat guidance in built-in agent prompts";
		}
		if (!scopedPrompts.some((scope) => scope.includes(MODERN_STDOUT_CAP))) {
			return "Missing stdout-cap (max_output/output_tail) guidance in built-in agent prompts";
		}
		// Legacy-leftover guard. Any one of the legacy fragments surviving in
		// a built-in agent scope without the modern replacement is a failure
		// signal. The audit flagged the previous "both fragments must coexist"
		// requirement as easily defeated by partial upstream rewording; check
		// fragments independently instead.
		const LEGACY_READONLY_FRAGMENTS = [
			"ONLY for read-only operations (ls, git status, git log, git diff, find",
			"For read-only operations (ls, git status, git log, git diff, find",
			"cat, head, tail",
		];
		for (const scope of scopedPrompts) {
			if (scope.includes(MODERN_READONLY_OPS)) continue;
			for (const fragment of LEGACY_READONLY_FRAGMENTS) {
				if (scope.includes(fragment)) {
					return `Legacy read-only bash guidance fragment still present in built-in agent prompt: ${fragment.slice(0, 48)}`;
				}
			}
		}
		for (const fragment of ["Use `find` via", "Use `grep` via"]) {
			if (code.includes(fragment)) {
				return `Legacy enhanced search guidance still present in built-in agent prompt: ${fragment}`;
			}
		}

		// Final assertion: at least one of the three scopes (explore, plan,
		// general) must carry the patched modern prompt opener. The previous
		// block returned `true` from both branches and was a no-op; this
		// catches the case where the upstream surface still renders but our
		// string-phase rewrite missed every scope.
		const hasAnyPatchedOpener = scopedPrompts.some(
			(scope) =>
				scope.includes(EXPLORE_PROMPT_REPLACEMENT) ||
				scope.includes(PLAN_PROMPT_REPLACEMENT) ||
				scope.includes(
					"Your strengths:\n- Tracing execution paths and dependencies across many files",
				),
		);
		if (!hasAnyPatchedOpener) {
			return "Built-in agent prompt replacements never landed in any extracted scope";
		}

		const agentToolResult = verifyExactReplacement(
			AGENT_TOOL_SYMBOL_LOOKUP_SOURCE,
			AGENT_TOOL_SYMBOL_LOOKUP_REPLACEMENT,
			"Agent tool symbol-lookup routing",
		);
		if (agentToolResult !== true) return agentToolResult;
		if (new RegExp(AGENT_TOOL_FORK_SELECTION_RE.source).test(code)) {
			return "Unpatched Agent tool fork-selection wording remains";
		}
		if (
			code.includes('subagent_type: "fork"') &&
			code.includes("always runs on your model") &&
			!AGENT_TOOL_FORK_SELECTION_PATCHED_RE.test(code)
		) {
			return "Missing rewritten Agent tool fork-selection wording";
		}

		const claudeNoisyResult = verifyExactReplacement(
			CLAUDE_NOISY_INVESTIGATION_SOURCE,
			CLAUDE_NOISY_INVESTIGATION_REPLACEMENT,
			"claude background-job investigation routing",
		);
		if (claudeNoisyResult !== true) return claudeNoisyResult;
		const workerCommitResult = verifyExactReplacement(
			WORKER_AGENT_AUTO_COMMIT_SOURCE,
			WORKER_AGENT_AUTO_COMMIT_REPLACEMENT,
			"worker no-auto-commit guidance",
		);
		if (workerCommitResult !== true) return workerCommitResult;

		for (const anchor of SUBAGENT_ROUTING_ANCHORS) {
			const anchorCount = countOccurrences(code, anchor);
			if (anchorCount === 0) continue;
			const injectedCount = countOccurrences(
				code,
				subagentRoutingInjection(anchor),
			);
			if (injectedCount !== anchorCount) {
				return `Sub-agent prompt missing modern-tooling routing: ${anchorCount - injectedCount} of ${anchorCount} occurrence(s) of "${anchor.slice(0, 32)}" not patched`;
			}
		}

		return true;
	},
};
