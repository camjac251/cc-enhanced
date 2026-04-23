/**
 * Shared constants for modern CLI tool guidance.
 *
 * Used by bash-prompt and built-in-agent-prompt to avoid duplicating
 * the same replacement text across patches.
 */

/** Short list of modern CLI tools for finding/searching/viewing. */
export const MODERN_FINDING_TOOLS = "`fd`, `rg`, `sg`, `eza`, and `bat`";

/** "ONLY for modern read-only operations ..." */
export const MODERN_READONLY_OPS =
	"ONLY for modern read-only operations (eza, git status, git log, git diff, fd, sg, rg, bat)";

/** Tool preference line shared by Bash, Explore, and Plan prompts. */
export const MODERN_TOOL_PREFERENCE =
	"Prefer sg for structural code search, rg only for exact text/config/logs, fd over find, eza over ls, and bat over cat/head/tail";

/** Stdout caps line: forbid pipe-to-head/tail in favor of tool-level limits. */
export const MODERN_STDOUT_CAP =
	"Cap stdout with max_output, output_tail: true, rg -m N, or fd --max-results; NEVER pipe to | head -N or | tail -N (streaming tail -f/-F through Monitor is fine)";

/** Prohibited operations line shared across prompts. */
export const PROHIBITED_BASH_OPS =
	"NEVER use %TOOL% for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification";

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
		"- For multi-file architecture questions, prefer semantic codebase research and deep cross-file analysis when available before ad hoc searching",
		"- For structural code patterns, prefer ast-grep or other syntax-aware code search over broad text matching",
		"- Use broad text search primarily for logs, config, comments, or other non-code text",
		`- Use ${normalized} ${MODERN_READONLY_OPS}`,
		`- ${MODERN_TOOL_PREFERENCE}`,
		`- ${MODERN_STDOUT_CAP}`,
		`- ${PROHIBITED_BASH_OPS.replace("%TOOL%", normalized)}`,
	]
		.map((line) => `${indent}${line}`)
		.join("\n");
}
