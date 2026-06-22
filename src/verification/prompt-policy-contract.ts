export interface PromptPolicyNeedle {
	id: string;
	needle: string;
	reason: string;
}

export interface PromptPolicyContractFailure {
	id: string;
	reason: string;
}

export interface PromptPolicyContractResult {
	ok: boolean;
	checksRun: number;
	failures: PromptPolicyContractFailure[];
}

export const REQUIRED_PROMPT_POLICY_NEEDLES: readonly PromptPolicyNeedle[] = [
	{
		id: "prompt-policy-serena-first",
		needle:
			"Known symbol, definition, references, or symbol-safe edit: use Serena first",
		reason: "Missing Serena-first symbol policy",
	},
	{
		id: "prompt-policy-raw-lsp-fallback",
		needle:
			"raw LSP only when Serena is unavailable or a direct coordinate lookup is needed",
		reason: "Missing raw-LSP fallback policy",
	},
	{
		id: "prompt-policy-chunkhound-conceptual",
		needle: "Conceptual or architecture question: use ChunkHound.",
		reason: "Missing ChunkHound conceptual-search routing",
	},
	{
		id: "prompt-policy-probe-known",
		needle:
			"Known terms, phrases, or boolean/symbol-precise search: use Probe before rg.",
		reason: "Missing Probe known-symbol/boolean-search routing",
	},
	{
		id: "prompt-policy-ast-grep-structural",
		needle:
			"Syntax or structural pattern, or code rewrite: use mcp__ast-grep__find_code MCP or sg CLI.",
		reason: "Missing ast-grep MCP/sg structural-search routing",
	},
	{
		id: "prompt-policy-sg-rewrite-preview",
		needle: "For rewrites, preview with sg before applying.",
		reason: "Missing ast-grep rewrite preview guidance",
	},
	{
		id: "prompt-policy-code-self-check",
		needle:
			"Before using Read, Bash text search, sd, or generic edits on a code file",
		reason: "Missing code-file tool-choice self-check",
	},
	{
		id: "prompt-policy-read-non-code-known-code-range",
		needle: "Read for non-code files and known code ranges after symbol lookup",
		reason: "Missing Read/code-file routing distinction",
	},
	{
		id: "prompt-policy-head-tail-cap",
		needle: "Never cap output with a head/tail pipe",
		reason: "Missing head/tail pipeline cap guidance",
	},
	{
		id: "prompt-policy-producer-native-caps",
		needle: "Cap at the producer instead",
		reason: "Missing producer-native output-cap preference",
	},
	{
		id: "prompt-policy-bash-tool-caps",
		needle: "Use Bash tool caps",
		reason: "Missing Bash tool-level output-cap guidance",
	},
	{
		id: "prompt-policy-eza-entry-count-bounds",
		needle: "use fd --max-results N when entry-count bounds matter",
		reason: "Missing eza versus fd bounded-list guidance",
	},
];

export const FORBIDDEN_LEGACY_PROMPT_NEEDLES: readonly PromptPolicyNeedle[] = [
	{
		id: "legacy-bash-token-warning-posix",
		needle: "Pipe output through head, tail, or grep",
		reason: "Legacy POSIX oversized-output warning still present",
	},
	{
		id: "copyable-pipe-head",
		needle: "`| head",
		reason: "Prompt still contains copyable pipe-head syntax",
	},
	{
		id: "copyable-pipe-tail",
		needle: "`| tail",
		reason: "Prompt still contains copyable pipe-tail syntax",
	},
	{
		id: "legacy-bash-token-warning-powershell",
		needle: "Pipe output through Select-Object -First/-Last",
		reason: "Legacy PowerShell oversized-output warning still present",
	},
	{
		id: "legacy-bash-content-search-grep-tool",
		needle: "Content search: Use Grep (NOT grep or rg)",
		reason: "Legacy Grep tool content-search guidance still present",
	},
	{
		id: "legacy-using-tools-grep-tool",
		needle: "To search the content of files, use Grep instead of grep or rg",
		reason: "Legacy Using-your-tools Grep guidance still present",
	},
	{
		id: "legacy-grep-tool-always-use",
		needle: "ALWAYS use Grep for search tasks",
		reason: "Disabled Grep tool prompt still directs search to Grep",
	},
	{
		id: "legacy-read-known-file-paths",
		needle: "Read for known file paths",
		reason: "Prompt still omits code-file routing before Read",
	},
	{
		id: "legacy-read-ranges-known-files",
		needle: "Read ranges for known files",
		reason: "Prompt still omits non-code or known-code-range Read scope",
	},
	{
		id: "legacy-subagent-read-known-file-paths",
		needle: "Use Read for known file paths when available",
		reason: "Subagent prompt still omits code-file routing before Read",
	},
	{
		id: "legacy-skill-grep-description",
		needle: "grep -Hm1 '^description:'",
		reason: "Bundled skill prompt still uses grep to discover skills",
	},
	{
		id: "legacy-design-sync-grep-recursive",
		needle: "grep -r ASSUMPTION",
		reason: "Design-sync skill prompt still uses grep recursively",
	},
	{
		id: "legacy-design-sync-grep-verb",
		needle: "Grep classes/tokens",
		reason: "Design-sync skill prompt still uses Grep as an instruction",
	},
	{
		id: "legacy-design-sync-grep-verb-lower",
		needle: "grep classes/tokens",
		reason: "Design-sync skill prompt still uses grep as an instruction",
	},
	{
		id: "legacy-permission-skill-grep-these",
		needle: "grep these files rather than guessing",
		reason: "Permission skill prompt still tells the model to grep files",
	},
	{
		id: "legacy-pr-body-cat-heredoc",
		needle: "--body \"$(cat <<'EOF'",
		reason: "Bash PR example still uses cat heredoc in command substitution",
	},
	{
		id: "legacy-pr-body-etc-heredoc-line",
		needle: "tee \"$pr_body\" >/dev/null <<'EOF'",
		reason: "Bash PR example still shares an exact /etc policy line",
	},
	{
		id: "legacy-bash-read-or-bat",
		needle: "Read files: Use Read or `bat` for shell-native viewing",
		reason: "Bash prompt still gives overly broad Read/bat guidance",
	},
	{
		id: "legacy-memory-readonly-list",
		needle: "ls, find, grep, cat, stat, wc, head, tail, and similar",
		reason: "Legacy memory read-only shell list still present",
	},
	{
		id: "legacy-repl-glob-example",
		needle: "const { filenames } = await Glob({ pattern: 'src/**/*.ts' })",
		reason: "Legacy REPL prompt still demonstrates disabled Glob",
	},
	{
		id: "legacy-toolsearch-grep-select",
		needle: '"select:Read,Edit,Grep" — fetch these exact tools by name',
		reason: "Legacy ToolSearch prompt still demonstrates disabled Grep",
	},
	{
		id: "legacy-remote-planning-glob-grep",
		needle: "Explore the codebase directly with Glob, Grep, and Read.",
		reason: "Legacy remote planning prompt still references disabled Glob/Grep",
	},
	{
		id: "legacy-agent-readonly-list",
		needle:
			"Use Bash ONLY for read-only operations (ls, git status, git log, git diff, find",
		reason: "Legacy agent read-only Bash list still present",
	},
	{
		id: "legacy-sd-code-file-example",
		needle: "sd 'pattern' 'replacement' file.ts",
		reason:
			"Edit prompt still routes regex replacement through sd on code files",
	},
];

export const EXPLORE_PROMPT_POLICY_REQUIRED_NEEDLES: readonly PromptPolicyNeedle[] =
	[
		{
			id: "explore-code-tool-self-check",
			needle:
				"Before using Read, Bash text search, sd, or generic edits on a code file",
			reason: "Explore surface missing code-file tool self-check",
		},
		{
			id: "explore-serena-lsp-policy",
			needle:
				"Known symbol, definition, references, or symbol-safe edit: use Serena first",
			reason: "Explore surface missing Serena-first/raw-LSP-fallback policy",
		},
	];

export function verifyPromptPolicyContract(
	content: string,
	required: readonly PromptPolicyNeedle[] = REQUIRED_PROMPT_POLICY_NEEDLES,
	forbidden: readonly PromptPolicyNeedle[] = FORBIDDEN_LEGACY_PROMPT_NEEDLES,
): PromptPolicyContractResult {
	const failures: PromptPolicyContractFailure[] = [];

	for (const rule of required) {
		if (!content.includes(rule.needle)) {
			failures.push({ id: rule.id, reason: rule.reason });
		}
	}

	for (const rule of forbidden) {
		if (content.includes(rule.needle)) {
			failures.push({ id: rule.id, reason: rule.reason });
		}
	}

	return {
		ok: failures.length === 0,
		checksRun: required.length + forbidden.length,
		failures,
	};
}
