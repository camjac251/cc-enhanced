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
			"Known symbol, definition, references, or symbol-safe edit: use Serena when available",
		reason: "Missing availability-aware Serena symbol policy",
	},
	{
		id: "prompt-policy-raw-lsp-fallback",
		needle: "otherwise use LSP or direct code search",
		reason: "Missing symbol-search fallback policy",
	},
	{
		id: "prompt-policy-chunkhound-conceptual",
		needle:
			"Conceptual or architecture question: use ChunkHound when available.",
		reason: "Missing availability-aware ChunkHound conceptual-search routing",
	},
	{
		id: "prompt-policy-probe-known",
		needle:
			"Known terms, phrases, or boolean/symbol-precise search: use Probe when available; otherwise use rg.",
		reason: "Missing availability-aware Probe search routing",
	},
	{
		id: "prompt-policy-ast-grep-structural",
		needle: "Syntax shape or structural rewrite: use the ast-grep CLI.",
		reason: "Missing ast-grep CLI structural-search routing",
	},
	{
		id: "prompt-policy-ast-grep-rewrite-preview",
		needle: "Preview rewrites before applying.",
		reason: "Missing ast-grep rewrite preview guidance",
	},
	{
		id: "prompt-policy-code-self-check",
		needle:
			"For code, choose by intent: direct Read or Edit for a known file and site",
		reason: "Missing capability-based code tool router",
	},
	{
		id: "prompt-policy-read-non-code-known-code-range",
		needle: "Read for known files or ranges",
		reason: "Missing direct Read routing",
	},
	{
		id: "prompt-policy-head-tail-cap",
		needle: "Preserve complete command output.",
		reason: "Missing complete-output invariant",
	},
	{
		id: "prompt-policy-producer-native-caps",
		needle: "Use a producer's native result bound",
		reason: "Missing producer-native result-bound preference",
	},
	{
		id: "prompt-policy-persisted-output",
		needle: "when Bash persists oversized output",
		reason: "Missing persisted Bash output guidance",
	},
	{
		id: "prompt-policy-saved-output-range",
		needle: "inspect the saved artifact with a bounded Read range",
		reason: "Missing bounded saved-output inspection guidance",
	},
];

export const FORBIDDEN_LEGACY_PROMPT_NEEDLES: readonly PromptPolicyNeedle[] = [
	{
		id: "removed-ast-grep-mcp",
		needle: "ast-grep MCP",
		reason: "Prompt still advertises the removed ast-grep MCP server",
	},
	{
		id: "legacy-bash-token-warning-posix",
		needle: "Pipe output through head, tail, or grep",
		reason: "Legacy POSIX oversized-output warning still present",
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
				"For code, choose by intent: direct Read or Edit for a known file and site",
			reason: "Explore surface missing capability-based code router",
		},
		{
			id: "explore-serena-lsp-policy",
			needle:
				"Known symbol, definition, references, or symbol-safe edit: use Serena when available",
			reason: "Explore surface missing availability-aware symbol policy",
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
