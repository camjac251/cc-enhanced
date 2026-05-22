/**
 * Shared prompt policy for modern CLI and MCP-oriented tool guidance.
 *
 * Surface patches should import this module rather than duplicating policy
 * wording. Keep drift/contract tests separate so they can catch accidental
 * weakening of the policy text itself.
 */

/** Short list of modern CLI tools for finding/searching/viewing. */
export const MODERN_FINDING_TOOLS = "`fd`, `rg`, `sg`, `eza`, and `bat`";

/** "ONLY for modern read-only operations ..." */
export const MODERN_READONLY_OPS =
	"ONLY for modern read-only operations (eza, git status, git log, git diff, fd, sg, rg, bat)";

/** Tool preference line shared by Bash, Explore, and Plan prompts. */
export const MODERN_TOOL_PREFERENCE =
	"Prefer fd for file discovery, eza for directory listings, bat ranges for file viewing, sg for structural code search/rewrites, and rg only for non-code text/logs/config/comments";

/** Source-code tool-choice self-check shared by prompt surfaces. */
export const MODERN_CODE_TOOL_SELF_CHECK =
	"Before using Read, Bash text search, sd, or generic edits on a code file, check whether Serena, raw LSP, ChunkHound, Probe, ast-grep MCP, or sg fits better; if yes, switch tools";

/** Read-tool caveat shared by the Read prompt and exported-surface verifier. */
export const MODERN_READ_CODE_FILE_CAVEAT =
	"For code files, prefer Serena, raw LSP, ChunkHound, Probe, ast-grep MCP, or sg before reading broad file content.";

export const MODERN_CODE_SEARCH_DECISION_TREE_LINES = [
	"For source code discovery, choose by intent:",
	"- Known symbol, definition, references, or symbol-safe edit: use Serena first; use raw LSP only when Serena is unavailable or a direct coordinate lookup is needed.",
	"- Conceptual or architecture question: use ChunkHound.",
	"- Known terms, phrases, or boolean/symbol-precise search: use Probe before rg.",
	"- Syntax or structural pattern, or code rewrite: use mcp__ast-grep__find_code MCP or sg CLI. For rewrites, preview with sg before applying.",
	"- Non-code text, logs, configs, comments, or exact prose: use rg.",
] as const;

export const MODERN_CODE_SEARCH_DECISION_TREE =
	MODERN_CODE_SEARCH_DECISION_TREE_LINES.join("\n");

/** Source-code search routing shared by Bash, Explore, and Plan prompts. */
export const MODERN_CODE_SEARCH_POLICY = MODERN_CODE_SEARCH_DECISION_TREE;

/** Bash-specific code/text search fallback guidance. */
export const MODERN_BASH_SEARCH_GUIDANCE = MODERN_CODE_SEARCH_DECISION_TREE;

/** Stdout caps line: prefer tool-level limits over shell pipeline truncation. */
export const MODERN_STDOUT_CAP =
	"Use producer-native caps first: rg -m N for non-code text, fd --max-results N for bounded file lists, and bat -r START:END for file slices. Use Bash tool caps (max_output, output_tail: true) when the command has no useful native cap or when you need a bounded inline preview. For eza directory listings, use plain eza with max_output only when you need eza metadata/layout; use fd --max-results N when entry-count bounds matter. Avoid head/tail pipelines for output capping; they discard everything past the cap, while producer-native flags preserve the full result up to the limit.";

/** Alias for the stdout-cap text, retained for surfaces that previously imported a distinct constant. */
export const MODERN_OUTPUT_LIMIT_WARNING = MODERN_STDOUT_CAP;

/** Prohibited operations line shared across prompts. */
export const PROHIBITED_BASH_OPS =
	"NEVER use %TOOL% for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification";

export const STRONG_CLAUDEMD_DISCLAIMER_LINES = [
	"The instructions above are MANDATORY when they apply to your current task. Follow them exactly as written.",
	"**ALWAYS** use gh api for GitHub URLs, not web fetching tools.",
	"**ALWAYS** choose code-search tools by intent: Serena first for known symbols/definitions/references/symbol-safe edits; ChunkHound for conceptual or architecture questions; Probe for known terms/phrases/boolean search; ast-grep MCP/sg for structural patterns and code rewrites; rg only for text/logs/config/comments.",
	"**NEVER** use cat/echo/printf for file writes - use Write or Edit tools.",
	"**NEVER** use grep/find/ls/sed for routine search/view/edit flows - use rg for non-code text, fd/eza for discovery/listing, sg for code rewrites, and sd only for non-code shell-native replacement.",
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
		"- Use Read when you know the specific file path you need to read",
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
