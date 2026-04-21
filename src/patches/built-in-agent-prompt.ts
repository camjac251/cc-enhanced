import type { Patch } from "../types.js";
import {
	buildModernReadonlyReplacement,
	MODERN_READONLY_OPS,
	MODERN_STDOUT_CAP,
	MODERN_TOOL_PREFERENCE,
} from "./modern-cli.js";

const EXPLORE_WHEN_TO_USE_SOURCE =
	'Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.';

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
		`- Use Read when you know the specific file path you need to read
- Use Bash ONLY for read-only operations (ls, git status, git log, git diff, find\${conditional(", grep" | "")}, cat, head, tail)
- NEVER use Bash for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification`,
		`- Use Read when you know the specific file path you need to read
- For multi-file architecture questions, prefer semantic codebase research and deep cross-file analysis when available before ad hoc searching
- For structural code patterns, prefer ast-grep or other syntax-aware code search over broad text matching
- Use broad text search primarily for logs, config, comments, or other non-code text
- Use Bash ONLY for modern read-only operations (eza, git status, git log, git diff, fd, sg, rg, bat)
- Prefer sg for structural code search, rg only for exact text/config/logs, fd over find, eza over ls, and bat over cat/head/tail
- NEVER use Bash for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification`,
	],
	[
		`- Adapt your search approach based on the thoroughness level specified by the caller`,
		`- Start broad, then narrow down to the highest-signal files, functions, and call paths`,
	],
	[
		`- Return file paths as absolute paths in your final response`,
		`- Support your conclusions with concrete file:line references and concise reasoning`,
	],
	[
		`- Communicate your final report directly as a regular message - do NOT attempt to create files`,
		`- Return absolute file paths in your final response and communicate findings directly as a regular message`,
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
- Start with semantic or focused structural search, then escalate to deeper codebase research only for multi-file architecture questions
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
	[
		`   - Use Bash ONLY for read-only operations (ls, git status, git log, git diff, find\${conditional(", grep" | "")}, cat, head, tail)
   - NEVER use Bash for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification`,
		`   - Use Bash ONLY for modern read-only operations (eza, git status, git log, git diff, fd, sg, rg, bat)
   - Prefer sg for structural code search, rg only for exact text/config/logs, fd over find, eza over ls, and bat over cat/head/tail
   - NEVER use Bash for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification`,
	],
	[
		`   - Use \${WD} ONLY for read-only operations (ls, git status, git log, git diff, find\${Yz() ? ", grep" : ""}, cat, head, tail)
   - NEVER use \${WD} for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification`,
		`   - Use \${WD} ONLY for modern read-only operations (eza, git status, git log, git diff, fd, sg, rg, bat)
   - Prefer sg for structural code search, rg only for exact text/config/logs, fd over find, eza over ls, and bat over cat/head/tail
   - NEVER use \${WD} for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification`,
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

const CORPUS_EXAMPLE_REPLACEMENTS: Array<[string, string]> = [
	[
		'grep -rn "<narrow term>" ${$}/ --include="*.jsonl" | tail -50',
		"rg -m 50 \"<narrow term>\" ${$}/ -g '*.jsonl'",
	],
	[
		"curl -si localhost:3000/api/thing | head -20",
		"curl -sI localhost:3000/api/thing",
	],
];

const EXPLORE_SOURCE_SIGNALS = [EXPLORE_PROMPT_SOURCE];

const EXPLORE_PATCHED_SIGNALS = [
	EXPLORE_PROMPT_REPLACEMENT,
	"Mapping entry points, dependencies, and data flow across multiple files",
	"Analysis methodology:",
	"Feature discovery: find entry points, core implementation files, feature boundaries, and relevant configuration.",
	"Start with semantic or focused structural search, then escalate to deeper codebase research only for multi-file architecture questions",
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
const PLACEHOLDER_FIND_EXPR = "find\\$\\{[^}]+\\}";
const PLACEHOLDER_INTERPOLATION_EXPR = "\\$\\{[^}]+\\}";
const LEGACY_READONLY_OPS_RE = new RegExp(
	`(^|\\n)([ \\t]*)- Use (${PLACEHOLDER_TOOL_EXPR}) ONLY for read-only operations \\(ls, git status, git log, git diff, ${PLACEHOLDER_FIND_EXPR}, cat, head, tail\\)\\n\\2- NEVER use (${PLACEHOLDER_TOOL_EXPR}) for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation\\/modification`,
	"g",
);
const EXPLORE_HELPER_GUIDELINES_RE = new RegExp(
	`Guidelines:\\n${PLACEHOLDER_INTERPOLATION_EXPR}\\n${PLACEHOLDER_INTERPOLATION_EXPR}\\n- Use ${PLACEHOLDER_INTERPOLATION_EXPR} when you know the specific file path you need to read\\n- Use (${PLACEHOLDER_TOOL_EXPR}) ONLY for read-only operations \\(ls, git status, git log, git diff, ${PLACEHOLDER_FIND_EXPR}, cat, head, tail\\)\\n- NEVER use (${PLACEHOLDER_TOOL_EXPR}) for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation\\/modification`,
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

export const builtInAgentPrompt: Patch = {
	tag: "built-in-agent-prompt",

	string: (code) => {
		let result = code;

		result = result.replaceAll(
			EXPLORE_WHEN_TO_USE_SOURCE,
			EXPLORE_WHEN_TO_USE_REPLACEMENT,
		);
		result = result.replaceAll(
			PLAN_WHEN_TO_USE_SOURCE,
			PLAN_WHEN_TO_USE_REPLACEMENT,
		);
		result = result.replaceAll(
			EXPLORE_PROMPT_SOURCE,
			EXPLORE_PROMPT_REPLACEMENT,
		);
		result = result.replaceAll(PLAN_PROMPT_SOURCE, PLAN_PROMPT_REPLACEMENT);
		result = result.replace(
			EXPLORE_HELPER_GUIDELINES_RE,
			(match, toolExprA: string, toolExprB: string) =>
				toolExprA === toolExprB
					? `Guidelines:\n${MODERN_READONLY_REPLACEMENT(toolExprA)}`
					: match,
		);
		result = result.replace(
			LEGACY_READONLY_OPS_RE,
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
			result = result.replaceAll(source, replacement);
		}
		for (const [source, replacement] of PLAN_SECTION_REPLACEMENTS) {
			result = result.replaceAll(source, replacement);
		}
		for (const [source, replacement] of CORPUS_EXAMPLE_REPLACEMENTS) {
			result = result.replaceAll(source, replacement);
		}

		return result;
	},

	verify: (code) => {
		const verifyExactReplacement = (
			source: string,
			replacement: string,
			label: string,
		): true | string => {
			const hasSource = code.includes(source);
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
		for (const [source, replacement] of CORPUS_EXAMPLE_REPLACEMENTS) {
			const hasSource = code.includes(source);
			const hasReplacement = code.includes(replacement);
			if (!hasSource && !hasReplacement) continue;
			if (hasSource) {
				return `Unpatched corpus example remains: ${source}`;
			}
			if (!hasReplacement) {
				return `Missing rewritten corpus example: ${replacement}`;
			}
		}
		const scopedPrompts = [exploreScope, planScope].filter(
			(scope): scope is string => scope != null,
		);
		const hasAnyBuiltInAgentPromptSignal = scopedPrompts.length > 0;
		if (!hasAnyBuiltInAgentPromptSignal) {
			return true;
		}
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
		if (
			scopedPrompts.some(
				(scope) =>
					!scope.includes(MODERN_READONLY_OPS) &&
					scope.includes(
						"ONLY for read-only operations (ls, git status, git log, git diff, find",
					) &&
					scope.includes("cat, head, tail"),
			)
		) {
			return "Legacy read-only bash guidance still present in built-in agent prompts";
		}

		if (
			!scopedPrompts.some(
				(scope) =>
					scope.includes(EXPLORE_PROMPT_REPLACEMENT) ||
					scope.includes(PLAN_PROMPT_REPLACEMENT),
			)
		) {
			return true;
		}

		return true;
	},
};
