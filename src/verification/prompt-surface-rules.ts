import { MODERN_READ_CODE_FILE_CAVEAT } from "../patches/prompt-policy.js";
import { EXPLORE_PROMPT_POLICY_REQUIRED_NEEDLES } from "./prompt-policy-contract.js";

export interface PromptSurfaceNeedle {
	id: string;
	needle: string;
	reason: string;
}

export interface PromptSurfaceRule {
	file: string;
	presence?: "required" | "optional";
	allowSyntheticPlaceholders?: boolean;
	required?: PromptSurfaceNeedle[];
	forbidden?: PromptSurfaceNeedle[];
}

const REMOTE_PLANNING_REQUIRED_NEEDLES: PromptSurfaceNeedle[] = [
	{
		id: "remote-planning-readonly-tools",
		needle: "Explore the codebase directly with available read-only tools.",
		reason: "Remote planning surface missing generic read-only tool routing",
	},
	{
		id: "remote-planning-symbol-semantic-structural",
		needle: "Prefer symbol, semantic, and structural search when available",
		reason:
			"Remote planning surface missing symbol/semantic/structural search preference",
	},
];

const REMOTE_PLANNING_FORBIDDEN_NEEDLES: PromptSurfaceNeedle[] = [
	{
		id: "remote-planning-glob-grep-read",
		needle: "Explore the codebase directly with Glob, Grep, and Read.",
		reason: "Remote planning surface still references disabled Glob/Grep",
	},
];

const REMOTE_PLANNING_REMINDER_FILES = [
	"system/reminders/you-re-running-in-a-remote-planning-session-the-user-trigge.md",
	"system/reminders/you-re-running-in-a-remote-planning-session-the-user-trigge-2.md",
] as const;

export const PROMPT_SURFACE_RULES: readonly PromptSurfaceRule[] = [
	{
		file: "tools/builtin/read.md",
		presence: "optional",
		required: [
			{
				id: "read-range",
				needle:
					"Range parameter (for text files only, supported bat-style forms):",
				reason: "Read surface missing bat-style range guidance",
			},
			{
				id: "read-whitespace",
				needle: "`show_whitespace: true`",
				reason: "Read surface missing show_whitespace guidance",
			},
			{
				id: "read-code-tool-caveat",
				needle: MODERN_READ_CODE_FILE_CAVEAT,
				reason: "Read surface missing code-file tool-choice caveat",
			},
		],
		forbidden: [
			{
				id: "read-offset-limit",
				needle: "line offset and limit",
				reason: "Read surface still references offset/limit guidance",
			},
			{
				id: "read-cat-n",
				needle: "cat -n format",
				reason: "Read surface still references cat -n output",
			},
		],
	},
	{
		file: "tools/builtin/repl.md",
		presence: "optional",
		required: [
			{
				id: "repl-fd-example",
				needle: "fd -e ts src",
				reason: "REPL surface missing fd-based file discovery example",
			},
			{
				id: "repl-code-search-guidance",
				needle: "prefer MCP code-search tools or `sg`",
				reason: "REPL surface missing code-search routing guidance",
			},
		],
		forbidden: [
			{
				id: "repl-glob-example",
				needle: "await Glob(",
				reason: "REPL surface still demonstrates disabled Glob",
			},
			{
				id: "repl-tool-list-glob-grep",
				needle: "`Glob`, `Grep`",
				reason: "REPL surface still lists disabled Glob/Grep",
			},
			{
				id: "repl-filesystem-glob",
				needle: "For filesystem access use `Read`/`Write`/`Glob`",
				reason: "REPL surface still routes file discovery through Glob",
			},
		],
	},
	{
		file: "tools/builtin/toolsearch.md",
		presence: "optional",
		required: [
			{
				id: "toolsearch-bash-select-example",
				needle: '"select:Read,Edit,Bash"',
				reason: "ToolSearch surface missing enabled-tool select example",
			},
		],
		forbidden: [
			{
				id: "toolsearch-grep-select-example",
				needle: '"select:Read,Edit,Grep"',
				reason: "ToolSearch surface still demonstrates disabled Grep",
			},
		],
	},
	{
		file: "tools/builtin/edit.md",
		presence: "optional",
		required: [
			{
				id: "edit-regex-bash-guidance",
				needle:
					"For regex/pattern replacement, use Bash: `sd 'pattern' 'replacement' file.ts`",
				reason: "Edit surface missing regex replacement Bash guidance",
			},
		],
	},
	{
		file: "agents/explore.md",
		required: [
			{
				id: "explore-modern-bash",
				needle:
					"Use Bash ONLY for modern read-only operations (eza, git status, git log, git diff, fd, sg, rg, bat)",
				reason: "Explore surface missing modern read-only bash guidance",
			},
			...EXPLORE_PROMPT_POLICY_REQUIRED_NEEDLES,
			{
				id: "explore-sg-policy",
				needle:
					"Prefer fd for file discovery, eza for directory listings, bat ranges for file viewing, and rg only for non-code text/logs/config/comments",
				reason: "Explore surface missing sg/fd/bat policy guidance",
			},
		],
		forbidden: [
			{
				id: "explore-placeholder",
				needle: "${",
				reason:
					"Explore surface still contains unresolved placeholder interpolation",
			},
			{
				id: "explore-stray-command",
				needle: "npm view ",
				reason: "Explore surface still contains stray helper command text",
			},
			{
				id: "explore-legacy-grep-find-cat",
				needle:
					'Use Bash ONLY for read-only operations (ls, git status, git log, git diff, find${conditional(", grep" | "")}, cat, head, tail)',
				reason:
					"Explore surface still references legacy find/grep/cat guidance",
			},
			{
				id: "explore-legacy-grepping",
				needle:
					"spawn multiple parallel tool calls for grepping and reading files",
				reason: "Explore surface still uses legacy grepping wording",
			},
		],
	},
	{
		file: "agents/plan.md",
		forbidden: [
			{
				id: "plan-broken-helper-render",
				needle: "${conditional(",
				reason:
					"Plan surface still contains broken helper-rendered interpolation",
			},
		],
	},
	{
		file: "system/sections/using-your-tools.md",
		allowSyntheticPlaceholders: true,
		forbidden: [
			{
				id: "using-tools-glob",
				needle: "To search for files use Glob instead of find or ls",
				reason: "Using-your-tools surface still references Glob",
			},
			{
				id: "using-tools-grep",
				needle:
					"To search the content of files, use Grep instead of grep or rg",
				reason: "Using-your-tools surface still references Grep",
			},
		],
	},
	{
		file: "system/sections/session-specific-guidance.md",
		allowSyntheticPlaceholders: true,
		required: [
			{
				id: "session-code-search-routing",
				needle:
					"code-search routing (Serena, ChunkHound, Probe, ast-grep MCP/sg)",
				reason: "Session guidance missing modern code-search routing helper",
			},
			{
				id: "session-otherwise-routing",
				needle:
					"Otherwise choose by intent: Serena for known symbols, ChunkHound for conceptual search, Probe for known terms, ast-grep MCP/sg for structural patterns, and `rg` only for non-code text directly.",
				reason: "Session guidance missing modern exploration fallback",
			},
		],
		forbidden: [
			{
				id: "session-find-grep-helper",
				needle: "`find` or `grep` via the",
				reason:
					"Session guidance still routes fallback exploration through find/grep",
			},
			{
				id: "session-placeholder-fallback",
				needle: "Otherwise use ${",
				reason:
					"Session guidance still uses the old placeholder-based fallback",
			},
		],
	},
	{
		file: "system/sections/dream-memory-consolidation.md",
		allowSyntheticPlaceholders: true,
		required: [
			{
				id: "dream-memory-eza-team",
				needle: "Use `eza team/`",
				reason: "Dream memory consolidation still lacks eza team listing",
			},
			{
				id: "dream-memory-eza-team-subdir",
				needle: "Use `eza team/` if a `team/` subdirectory is present",
				reason:
					"Dream memory consolidation still lacks conditional eza team directory guidance",
			},
			{
				id: "dream-memory-eza",
				needle: "Use `eza` to list the memory directory",
				reason: "Dream memory consolidation still lacks eza directory listing",
			},
			{
				id: "dream-memory-fd-logs",
				needle: "Use `fd -t f . logs/` to list recent activity logs",
				reason: "Dream memory consolidation still lacks fd logs listing",
			},
			{
				id: "dream-memory-rg-transcripts",
				needle: "use `rg -m 50` on the JSONL transcripts",
				reason: "Dream memory consolidation still lacks rg transcript search",
			},
		],
		forbidden: [
			{
				id: "dream-memory-ls-team",
				needle: "`ls team/`",
				reason: "Dream memory consolidation still lists team memory with ls",
			},
			{
				id: "dream-memory-grep-narrowly",
				needle: "grep narrowly, don't read whole files",
				reason: "Dream memory consolidation still says to grep transcripts",
			},
			{
				id: "dream-memory-ls-directory",
				needle: "`ls` the memory directory",
				reason:
					"Dream memory consolidation still lists memory directory with ls",
			},
			{
				id: "dream-memory-ls-r-logs",
				needle: "`ls -R logs/`",
				reason:
					"Dream memory consolidation still recursively lists logs with ls",
			},
			{
				id: "dream-memory-grep-transcripts",
				needle: "grep the JSONL transcripts",
				reason:
					"Dream memory consolidation still routes transcript search through grep",
			},
			{
				id: "dream-memory-grep-tail",
				needle: "grep -rn",
				reason:
					"Dream memory consolidation still uses grep/tail transcript command",
			},
		],
	},
	{
		file: "system/sections/dream-memory-pruning.md",
		allowSyntheticPlaceholders: true,
		required: [
			{
				id: "dream-memory-fd-md",
				needle:
					"Use `fd -e md -t f .` against the memory directory shown above",
				reason: "Dream memory pruning still lacks fd markdown enumeration",
			},
		],
		forbidden: [
			{
				id: "dream-memory-find-md",
				needle: "find ${",
				reason:
					"Dream memory pruning still enumerates markdown files with find",
			},
		],
	},
	...REMOTE_PLANNING_REMINDER_FILES.map((file) => ({
		file,
		required: REMOTE_PLANNING_REQUIRED_NEEDLES,
		forbidden: REMOTE_PLANNING_FORBIDDEN_NEEDLES,
	})),
	{
		file: "agents/claude-code-guide.md",
		presence: "optional",
		required: [
			{
				id: "guide-mcp-doc-tools",
				needle:
					"Fetch the appropriate docs map URL using MCP doc tools (context7, docfork, or ref)",
				reason: "Guide surface missing MCP doc tools rewrite",
			},
			{
				id: "guide-perplexity-fallback",
				needle:
					"Use MCP search (perplexity) if official docs don't cover the topic",
				reason: "Guide surface missing MCP search fallback rewrite",
			},
		],
		forbidden: [
			{
				id: "guide-webfetch",
				needle: "Use WebFetch to fetch the appropriate docs map",
				reason: "Guide surface still references WebFetch",
			},
			{
				id: "guide-websearch",
				needle: "Use WebSearch if docs don't cover the topic",
				reason: "Guide surface still references WebSearch",
			},
		],
	},
];

export const EXTRA_PROMPT_DRIFT_SURFACES = [
	"tools/builtin/bash.md",
	"tools/builtin/powershell.md",
] as const;

export const PROMPT_SURFACE_REVIEW_PATHS = [
	...new Set([
		...EXTRA_PROMPT_DRIFT_SURFACES,
		...PROMPT_SURFACE_RULES.map((rule) => rule.file),
	]),
].sort();

export const PROMPT_SURFACE_DRIFT_PATHS = [
	...new Set(
		PROMPT_SURFACE_RULES.filter((rule) => rule.presence !== "optional").map(
			(rule) => rule.file,
		),
	),
].sort();
