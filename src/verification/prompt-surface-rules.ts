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
	allowLiteralTemplatePlaceholders?: boolean;
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
					"For structural code search or rewrites, use Bash: `sg -p 'old($A)' -r 'new($A)' src/` to preview",
				reason: "Edit surface missing structural sg rewrite guidance",
			},
			{
				id: "edit-sd-non-code-guidance",
				needle:
					"For non-code text replacement, use Bash: `sd 'pattern' 'replacement' file.md -p` to preview",
				reason: "Edit surface missing non-code sd replacement guardrail",
			},
		],
		forbidden: [
			{
				id: "edit-sd-code-file",
				needle: "sd 'pattern' 'replacement' file.ts",
				reason: "Edit surface still routes sd at a code file",
			},
		],
	},
	{
		file: "tools/builtin/designsync.md",
		presence: "optional",
		required: [
			{
				id: "designsync-required-ordering",
				needle: "Required ordering: list/read",
				reason: "DesignSync tool missing required method ordering guidance",
			},
			{
				id: "designsync-get-file-security",
				needle:
					"SECURITY: `get_file` returns content written by other org members.",
				reason: "DesignSync tool missing get_file security boundary",
			},
		],
		forbidden: [
			{
				id: "designsync-dynamic-prompt",
				needle: "(Dynamic prompt: not statically resolved from cli.js AST.)",
				reason: "DesignSync tool still exports a dynamic prompt marker",
			},
		],
	},
	{
		file: "skills/design-sync.md",
		presence: "optional",
		allowLiteralTemplatePlaceholders: true,
		required: [
			{
				id: "design-sync-tool-routing",
				needle: "You have a `DesignSync` tool",
				reason: "design-sync skill missing DesignSync tool routing",
			},
			{
				id: "design-sync-heading",
				needle: "# Sync a design system to claude.ai/design",
				reason: "design-sync skill missing full prompt heading",
			},
			{
				id: "design-sync-shape-handoff",
				needle:
					"Then `Read` `<skill-base-dir>/storybook/SKILL.md` or `<skill-base-dir>/non-storybook/SKILL.md`",
				reason: "design-sync skill missing shape-specific handoff guidance",
			},
			{
				id: "design-sync-ship-built-code",
				needle: "Core principle: ship what the customer already built",
				reason: "design-sync skill missing converter source-of-truth guidance",
			},
		],
		forbidden: [
			{
				id: "design-sync-dynamic-prompt",
				needle: "(Dynamic prompt: not statically resolved from cli.js AST.)",
				reason: "design-sync skill still exports a dynamic prompt marker",
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
					"Prefer fd for file discovery, eza for directory listings, bat ranges for file viewing, sg for structural code search/rewrites, and rg only for non-code text/logs/config/comments",
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
			{
				id: "explore-enhanced-find-via-bash",
				needle: "Use `find` via",
				reason:
					"Explore surface still routes enhanced-mode file discovery through find",
			},
			{
				id: "explore-enhanced-grep-via-bash",
				needle: "Use `grep` via",
				reason:
					"Explore surface still routes enhanced-mode content search through grep",
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
		file: "agents/worker.md",
		allowSyntheticPlaceholders: true,
		required: [
			{
				id: "worker-code-search-routing",
				needle:
					"route search by intent: Serena for symbols, definitions, and references",
				reason: "Worker agent missing modern code-search-by-intent routing",
			},
			{
				id: "worker-scratchpad-not-tmp",
				needle:
					"Put temporary files in the session scratchpad or $TMPDIR, never /tmp.",
				reason: "Worker agent missing scratchpad-over-/tmp temp-file guidance",
			},
		],
		forbidden: [
			{
				id: "worker-auto-commit",
				needle: "commit your changes when done",
				reason: "Worker agent should not commit unless the coordinator asks",
			},
		],
	},
	{
		file: "agents/workflow-subagent.md",
		allowSyntheticPlaceholders: true,
		required: [
			{
				id: "workflow-subagent-code-search-routing",
				needle:
					"route search by intent: Serena for symbols, definitions, and references",
				reason:
					"workflow-subagent missing modern code-search-by-intent routing",
			},
			{
				id: "workflow-subagent-rg-non-code-only",
				needle: "Use rg only for non-code text",
				reason: "workflow-subagent missing rg-only-for-non-code-text guidance",
			},
		],
	},
	{
		file: "agents/claude.md",
		allowSyntheticPlaceholders: true,
		required: [
			{
				id: "claude-investigation-routing",
				needle:
					"route search by intent (Serena, ChunkHound, Probe, ast-grep MCP or sg)",
				reason:
					"claude background-job agent missing modern investigation routing",
			},
		],
		forbidden: [
			{
				id: "claude-legacy-grep-sweeps",
				needle: "grep sweeps, log trawls, broad search",
				reason:
					"claude background-job agent still uses legacy grep-sweep wording",
			},
		],
	},
	{
		file: "tools/builtin/agent.md",
		allowSyntheticPlaceholders: true,
		required: [
			{
				id: "agent-tool-symbol-routing",
				needle: "Serena or Probe search_code (exact: true)",
				reason: "Agent tool missing Serena/Probe symbol-lookup routing",
			},
			{
				id: "agent-tool-explicit-fork",
				needle: 'pass `subagent_type: "fork"` to fork yourself',
				reason: "Agent tool missing explicit fork-selection guidance",
			},
		],
		forbidden: [
			{
				id: "agent-tool-grep-via-bash",
				needle: "`grep` via the Bash tool",
				reason:
					"Agent tool still routes a symbol lookup to grep via the Bash tool",
			},
			{
				id: "agent-tool-mangled-fork",
				needle: "any other type. Or omitting it. Starts",
				reason: "Agent tool still has malformed fork-selection wording",
			},
		],
	},
	{
		file: "system/sections/using-your-tools.md",
		allowSyntheticPlaceholders: true,
		forbidden: [
			{
				id: "using-tools-empty-dedicated-list",
				needle: "when one fits ()",
				reason:
					"Using-your-tools surface rendered an empty dedicated-tools list",
			},
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
					"Otherwise choose by intent: Serena for known symbols, ChunkHound for conceptual search, Probe for known terms, ast-grep MCP/sg for structural patterns and code rewrites, and `rg` only for non-code text directly.",
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
	{
		file: "system/sections/schedule-remote-agents.md",
		presence: "optional",
		allowSyntheticPlaceholders: true,
		forbidden: [
			{
				id: "schedule-remote-agents-disabled-allowed-tools",
				needle:
					'"allowed_tools": ["Bash", "Read", "Write", "Edit", "Glob", "Grep"]',
				reason:
					"Schedule remote agents surface still suggests disabled Glob/Grep tools in allowed_tools",
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
					"Fetch the appropriate docs map URL using MCP doc tools (context7 or ref)",
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
