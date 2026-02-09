import type { Patch } from "../types.js";

// Coupling: targets the same Bash tool prompt as bash-output-tail.ts but in a
// different section (CLI tool recommendations vs disk persistence/tail guidance).

const TRIGGER_PHRASE = "Executes a given bash command with optional timeout";

const REPLACEMENT_TEXT = `  - ALWAYS use modern CLI tools, NEVER legacy commands:
    - \`bat\` not cat, \`eza\` not ls, \`fd\` not find, \`rg\` not grep, \`dust\` not du, \`procs\` not ps
    - \`xh\` not curl, \`sd\` not sed, \`choose\` not awk, \`sg\` for AST-aware code search
    - NEVER use \`rg -A/-B\` to capture function/class bodies — use \`sg\` for exact AST node boundaries
  - File operations:
    - View: \`Read\` tool or \`bat\` via Bash. Read is preferred (uses bat internally)
    - List: \`eza -la path\`, \`eza -T path\` for tree view (always include path)
    - Find: \`fd pattern path\`, \`fd --max-results N\` to limit. \`fselect\` for complex queries (size/date)
    - Text search: \`rg pattern path\`, \`rg -m N\` to limit, \`rg -l\` files only, \`rg -t ts\` (includes .tsx)
    - Code search (exact AST nodes, not arbitrary line ranges):
      - \`sg -p 'function $NAME($$$) { $$$BODY }' src/\`
      - \`sg -p 'class $NAME { $$$BODY }' src/\`
      - \`sg -p 'import { $$$IMPORTS } from "$MOD"' src/\`
      - \`sg -p '$OBJ.$METHOD($$$ARGS)' src/\`
      - Rewrite: \`sg -p 'old($$$)' -r 'new($$$)' -U src/\`
    - sg debug: \`--debug-query=ast\` for tree, \`--debug-query=pattern\` for pattern parse
    - Edit: \`Edit\` tool or \`sd -F 'old' 'new' file\`. \`sponge\` for in-place: \`sort f | sponge f\`
    - Write: \`Write\` tool for new files. Never use cat/echo/printf for file writes.
  - Prefer native options over piping:
    - \`rg -m 10\`, \`fd --max-results 10\`, \`bat -r -30:\`, \`jq '.items[:5]'\`
    - Piping OK when no native option (e.g., \`pytest | tail\`, \`| wc -l\`)
    - For line ranges from pipes: \`cmd | sed -n '20,40p'\` (not head/tail chains)
  - Data processing:
    - JSON: \`jq\` for queries, \`gron\` to flatten for grep, \`gron -u\` to unflatten
    - YAML: \`yq\` (same syntax as jq), \`dasel\` for JSON/YAML/TOML/XML uniformly
    - CSV: \`mlr\` (miller) or \`qsv\` for stats, select, sort, join
    - HTML: \`htmlq\` (like jq for HTML), e.g., \`htmlq 'a' --attribute href\`
  - HTTP requests:
    - \`xh GET url\` for simple requests, \`xh POST url key=value\` for JSON
    - \`hurl file.hurl\` for HTTP test sequences with assertions
  - Git operations:
    - Use \`gh api\` for GitHub URLs, not web fetching
    - \`delta\` or \`difft\` for syntax-aware diffs
    - patchutils: \`git diff | filterdiff -i '*/file.py' | git apply --cached\`
    - \`grepdiff 'pattern'\` for hunks matching pattern, \`git-sizer\` for repo analysis
    - \`git-filter-repo\` for history rewriting (secrets, large files)
  - Code quality:
    - \`tokei\` for code stats, \`semgrep\` for security scanning
    - \`biome\` for JS/TS, \`oxlint\` for fast JS, \`ruff\` for Python
    - \`hadolint\` for Dockerfiles, \`taplo\` for TOML
  - Utilities:
    - \`hyperfine 'cmd1' 'cmd2'\` for benchmarking
    - \`entr\` for file watching: \`fd .rs | entr cargo test\`
    - \`watchexec -e rs -- cargo test\` for more complex watching
    - \`fzf --filter="pattern"\` for non-interactive fuzzy filtering
    - \`comby 'pattern :[hole]' 'new'\` when sg metavars don't work
    - \`sad 'old' 'new' src/\` to preview, \`--commit\` to apply
    - \`grex\` to generate regex from examples
    - \`glow file.md\` to render markdown, \`numbat\` for unit calculations
  - Use absolute paths, quote paths with spaces, \`fd -0 | xargs -0\` for bulk ops
  - Heredocs for multiline: \`bash <<'EOF' ... EOF\` to avoid escaping issues`;

export const bashPrompt: Patch = {
	tag: "bash-prompt",

	string: (code) => {
		if (!code.includes(TRIGGER_PHRASE)) return code;

		const pattern =
			/\s*-\s*Avoid using Bash with[\s\S]*?Communication: Output text directly \(NOT echo\/printf\)/;

		if (pattern.test(code)) {
			const safeReplacement = `\n${REPLACEMENT_TEXT}`.replace(/`/g, "\\`");
			return code.replace(pattern, safeReplacement);
		}
		return code;
	},

	verify: (code) => {
		if (!code.includes("ALWAYS use modern CLI tools")) {
			return "Missing modern CLI tools statement";
		}
		if (code.includes("Avoid using Bash with the `find`")) {
			return "Old 'Avoid using Bash with' text still present";
		}
		if (
			!code.includes("bat") ||
			!code.includes("eza") ||
			!code.includes("fd")
		) {
			return "Missing core modern tools (bat/eza/fd)";
		}
		if (!code.includes("xh") || !code.includes("rg")) {
			return "Missing modern replacements (xh/rg)";
		}
		return true;
	},
};
