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
			"Known terms, phrases, or boolean/symbol-precise search: use Probe.",
		reason: "Missing Probe known-symbol/boolean-search routing",
	},
	{
		id: "prompt-policy-ast-grep-structural",
		needle:
			"Syntax or structural pattern: use mcp__ast-grep__find_code MCP or sg CLI.",
		reason: "Missing ast-grep MCP/sg structural-search routing",
	},
	{
		id: "prompt-policy-code-self-check",
		needle:
			"Before using Read, Bash text search, or generic edits on a code file",
		reason: "Missing code-file tool-choice self-check",
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
];

export const EXPLORE_PROMPT_POLICY_REQUIRED_NEEDLES: readonly PromptPolicyNeedle[] =
	[
		{
			id: "explore-code-tool-self-check",
			needle:
				"Before using Read, Bash text search, or generic edits on a code file",
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
