/** Shared guidance used by the live prompt transforms and CLAUDE.md hook. */

/** Tool preferences used by Bash description transforms. */
export const MODERN_TOOL_PREFERENCE =
	"Use fd for file discovery, eza for directory listings, Read for known files or ranges, bat -r for shell file ranges, rg for exact lexical text, and ast-grep run for structural code patterns and rewrites";

/**
 * Replacement for the upstream auto-mode and bypass-mode "bash-first" nudge
 * that tells the model to read with cat/sed and search with grep/find. Keeps
 * the shell-first stance but names the tools that beat the built-ins. Parts
 * interleave with the Bash, Read, Edit, Write, Bash tool-name expressions
 * captured from the upstream template, in that order.
 */
export const MODERN_DEDICATED_TOOLS_NUDGE_PARTS = [
	"Work through ",
	" wherever the shell has the better tool: fd for file discovery, eza for directory listings, bat -r for ranged reads, rg for exact lexical text, ast-grep run for syntax shapes and repeated rewrites (preview, then -U), comby for malformed or mixed syntax, sd for non-code text, and jq or yq for structured data. Keep ",
	" for files you need whole in context, ",
	" for a single known site, and ",
	" for new files; route everything else through ",
	". For source code, choose by intent: Serena or LSP for symbols when available, ChunkHound for unfamiliar concepts when available, Probe for known terms, rg for exact lexical text, and the ast-grep CLI for syntax shapes.",
] as const;

export const MODERN_CODE_SEARCH_DECISION_TREE_LINES = [
	"For source code discovery, choose by intent:",
	"- Known symbol, definition, references, or symbol-safe edit: use Serena when available; otherwise use LSP or direct code search.",
	"- Conceptual or architecture question: use ChunkHound when available.",
	"- Known terms, phrases, or boolean/symbol-precise search: use Probe when available; otherwise use rg.",
	"- Exact lexical text, including code strings and comments: use rg.",
	"- Syntax shape or structural rewrite: use the ast-grep CLI. Preview rewrites before applying.",
] as const;

export const MODERN_CODE_SEARCH_DECISION_TREE =
	/* @__PURE__ */ MODERN_CODE_SEARCH_DECISION_TREE_LINES.join("\n");

/** Source-code routing used by the compact Bash description transform. */
export const MODERN_CODE_SEARCH_POLICY = MODERN_CODE_SEARCH_DECISION_TREE;

/** Bash-specific code/text search fallback guidance. */
export const MODERN_BASH_SEARCH_GUIDANCE = MODERN_CODE_SEARCH_DECISION_TREE;

export const STRONG_CLAUDEMD_DISCLAIMER_LINES = [
	"Treat applicable CLAUDE.md instructions as requirements. Resolve conflicts by instruction priority, scope, and the user's current intent.",
	"Use gh api for GitHub URLs, file content, and metadata.",
	"Choose code tools by intent: Read or Edit for a known site; Serena or LSP for symbols when available; ChunkHound for unfamiliar concepts when available; Probe for known terms; rg for exact lexical text; ast-grep for syntax shapes and structural rewrites.",
	"Use file tools for writes. Preview repeated structural rewrites and non-code bulk replacements before applying them.",
] as const;

export const STRONG_CLAUDEMD_DISCLAIMER =
	/* @__PURE__ */ STRONG_CLAUDEMD_DISCLAIMER_LINES.join("\n");
