/**
 * Shared prompt policy for modern CLI and MCP-oriented tool guidance.
 *
 * Surface patches should import this module rather than duplicating policy
 * wording. Keep drift/contract tests separate so they can catch accidental
 * weakening of the policy text itself.
 */

/** Short list of modern CLI tools for finding/searching/viewing. */
export const MODERN_FINDING_TOOLS = "`fd`, `rg`, `ast-grep`, `eza`, and `bat`";

/** "ONLY for modern read-only operations ..." */
export const MODERN_READONLY_OPS =
	"ONLY for modern read-only operations (eza, git status, git log, git diff, fd, ast-grep run, ast-grep outline, rg, bat)";

/** Tool preference line shared by Bash, Explore, and Plan prompts. */
export const MODERN_TOOL_PREFERENCE =
	"Use fd for file discovery, eza for directory listings, Read for known files or ranges, bat -r for shell file ranges, rg for exact lexical text, and ast-grep run for structural code patterns and rewrites";

/** Interpolation-safe file routing for the Claude background-job agent. */
export const MODERN_BACKGROUND_AGENT_FILE_ROUTING =
	"Use fd for file discovery, eza for directory listings, Read for known files or ranges, and bat -r START:END for shell file ranges.";

/** Source-code tool-choice self-check shared by prompt surfaces. */
export const MODERN_CODE_TOOL_SELF_CHECK =
	"For code, choose by intent: direct Read or Edit for a known file and site; Serena or LSP for symbols when available; ChunkHound for unfamiliar concepts when available; Probe for known terms; rg for exact lexical text; ast-grep for syntax shapes and repeated structural rewrites";

/** Read-tool caveat shared by the Read prompt and exported-surface verifier. */
export const MODERN_READ_CODE_FILE_CAVEAT =
	"For broad or unfamiliar code, locate the relevant region with the available symbol, semantic, or search tools before reading large file ranges.";

export const MODERN_CODE_SEARCH_DECISION_TREE_LINES = [
	"For source code discovery, choose by intent:",
	"- Known symbol, definition, references, or symbol-safe edit: use Serena when available; otherwise use LSP or direct code search.",
	"- Conceptual or architecture question: use ChunkHound when available.",
	"- Known terms, phrases, or boolean/symbol-precise search: use Probe when available; otherwise use rg.",
	"- Exact lexical text, including code strings and comments: use rg.",
	"- Syntax shape or structural rewrite: use the ast-grep CLI. Preview rewrites before applying.",
] as const;

export const MODERN_CODE_SEARCH_DECISION_TREE =
	MODERN_CODE_SEARCH_DECISION_TREE_LINES.join("\n");

/** Source-code search routing shared by Bash, Explore, and Plan prompts. */
export const MODERN_CODE_SEARCH_POLICY = MODERN_CODE_SEARCH_DECISION_TREE;

/** Bash-specific code/text search fallback guidance. */
export const MODERN_BASH_SEARCH_GUIDANCE = MODERN_CODE_SEARCH_DECISION_TREE;

/** Stdout tool contract expressed without copyable truncation recipes. */
export const MODERN_STDOUT_CAP =
	"Keep command results available for inspection. When the task asks for a bounded result, use the producer's native limit; a limit applied after a pipe is a consumer cap even when the same flag is correct in producer position. Otherwise run normally; if Bash persists oversized output, inspect the saved artifact by range or semantic selection.";

/** Shared stdout-cap text export. */
export const MODERN_OUTPUT_LIMIT_WARNING = MODERN_STDOUT_CAP;

/** Background execution policy shared by Bash, Read, and subagent surfaces. */
export const BACKGROUND_TASK_POLICY_LINES = [
	"Choose execution mode by intent:",
	"- Immediate result: run Bash in the foreground with an appropriate timeout.",
	"- Streaming output or a condition watch: use Monitor.",
	"- Real concurrency: start Bash with run_in_background=true only when useful independent work will continue, then rely on the completion notification.",
	"- Background results: the tool result and the completion notification both carry the output file path. Read that file by explicit non-overlapping ranges rather than re-reading a tail you already have.",
	"- A subagent's output file is its full conversation transcript in JSONL, not a report. Use the result the completion notification delivers, and select entries with jq if you must open the transcript at all.",
] as const;

export const BACKGROUND_TASK_POLICY = BACKGROUND_TASK_POLICY_LINES.join("\n");

/** Compact background-output routing used inside file-output guidance. */
export const BACKGROUND_TASK_READ_GUIDANCE =
	"The background-task result and its completion notification both carry the output file path, so read that file by explicit non-overlapping ranges instead of rediscovering the path or re-reading a tail you already have. For an immediate result, run Bash in the foreground; for streaming output or a condition watch, use Monitor; for real concurrency, continue useful independent work and rely on the completion notification.";

/** Prohibited operations line shared across prompts. */
export const PROHIBITED_BASH_OPS =
	"NEVER use %TOOL% for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification";

/**
 * Compact code-search + temp-file routing for generic sub-agent prompts
 * (worker, workflow-subagent) that otherwise ship with no tool guidance.
 *
 * Uses bare tool names with no backticks and no `${` interpolation markers:
 * this text is spliced into bundle template literals, where a backtick would
 * terminate the literal and a `${` would start a runtime interpolation.
 */
export const MODERN_SUBAGENT_CODE_ROUTING = [
	"When the task involves code, route by intent: Serena or LSP for symbols when available; ChunkHound for unfamiliar concepts and architecture when available; Probe for known terms or boolean search; rg for exact lexical text, including code strings and comments; the ast-grep CLI for syntax shapes and structural rewrites.",
	"Use Read or Edit directly for a known file and site. Use bat -r START:END for shell file ranges, fd to find files, eza to list directories, and Write or Edit to change files. For GitHub URLs, file content, and metadata use gh api.",
	BACKGROUND_TASK_POLICY,
	MODERN_STDOUT_CAP,
	"Put temporary files in the session scratchpad or $TMPDIR, never /tmp, and never in the user's project even when a tool's own docs instruct it.",
].join("\n");

export const STRONG_CLAUDEMD_DISCLAIMER_LINES = [
	"Treat applicable CLAUDE.md instructions as requirements. Resolve conflicts by instruction priority, scope, and the user's current intent.",
	"Use gh api for GitHub URLs, file content, and metadata.",
	"Choose code tools by intent: Read or Edit for a known site; Serena or LSP for symbols when available; ChunkHound for unfamiliar concepts when available; Probe for known terms; rg for exact lexical text; ast-grep for syntax shapes and structural rewrites.",
	"Use file tools for writes. Preview repeated structural rewrites and non-code bulk replacements before applying them.",
] as const;

export const STRONG_CLAUDEMD_DISCLAIMER =
	STRONG_CLAUDEMD_DISCLAIMER_LINES.join("\n");

/**
 * Build the modern read-only operations replacement block for a given
 * Bash tool expression and optional indent.
 *
 * Used by built-in-agent-prompt for Explore/Plan agent prompt rewrites
 * and by the LEGACY_READONLY_OPS_RE fallback regex.
 */
export function buildModernReadonlyReplacement(
	toolExpr: string,
	indent = "",
): string {
	// Upstream sometimes wraps the tool name in a template placeholder
	// (${someBinding}). Carrying that through into the replacement leaves
	// an unresolved interpolation in the exported prompt surface. The
	// replacement is about the Bash tool regardless of upstream binding,
	// so normalize to the literal name.
	const normalized = /^\$\{[^}]+\}$/.test(toolExpr) ? "Bash" : toolExpr;
	return [
		"- Use Read for non-code files, or for code only after symbol/range lookup",
		`- ${MODERN_CODE_TOOL_SELF_CHECK}`,
		MODERN_CODE_SEARCH_POLICY,
		"- For multi-file architecture questions, prefer semantic codebase research and deep cross-file analysis when available before ad hoc searching",
		"- Use broad text search primarily for logs, config, comments, or other non-code text",
		`- Use ${normalized} ${MODERN_READONLY_OPS}`,
		`- ${MODERN_TOOL_PREFERENCE}`,
		`- ${MODERN_STDOUT_CAP}`,
		`- ${PROHIBITED_BASH_OPS.replace("%TOOL%", normalized)}`,
	]
		.flatMap((line) => line.split("\n"))
		.map((line) => `${indent}${line}`)
		.join("\n");
}
