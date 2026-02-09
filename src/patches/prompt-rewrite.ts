import type { Patch } from "../types.js";

// Coupling: disable-tools.ts also rewrites Glob/Grep prompt references (different
// sections, same concern). Its verify checks code.includes("ast-grep") which could
// pass even if only prompt-rewrite injected it.
// Coupling: skill-allowed-tools.ts also strips Glob/Grep from prompt sections
// (skill headers vs general prompts).

/**
 * Rewrite prompt text to reference ast-grep/rg/fd instead of disabled Glob/Grep.
 *
 * Covers agent-specific bullet points, system prompt policy sections,
 * "Using your tools" guidance, plan mode prompts, and /debug command config.
 *
 * Uses generic variable patterns [A-Za-z0-9_$]+ to handle minified names
 * that change between versions (e.g., qV→UI, OX→xX).
 */

// Variable pattern for minified names (letters, digits, underscore, $)
const VAR = "[A-Za-z0-9_$]+";

// --- Agent prompt replacements (agent-specific bullet points) ---

const AGENT_REPLACEMENTS: Array<[RegExp, string]> = [
	[
		new RegExp(`- Use \\$\\{${VAR}\\} for broad file pattern matching`, "g"),
		"- Use ast-grep for code pattern matching (functions, classes, imports)",
	],
	[
		new RegExp(
			`- Use \\$\\{${VAR}\\} for searching file contents with regex`,
			"g",
		),
		"- Use rg for text search in non-code files (configs, docs, logs)",
	],
	[
		new RegExp(`- File search: Use \\$\\{${VAR}\\} \\(NOT find or ls\\)`, "g"),
		"- Code search: Use ast-grep for code structure, fd for finding files",
	],
	[
		new RegExp(
			`- Content search: Use \\$\\{${VAR}\\} \\(NOT grep or rg\\)`,
			"g",
		),
		"- Text search: Use rg for text content (rg IS the preferred tool)",
	],
	[
		new RegExp(
			`instead of using \\$\\{${VAR}\\} or \\$\\{${VAR}\\} directly`,
			"g",
		),
		"for comprehensive exploration",
	],
];

// --- Tool policy replacements (system prompt policy sections) ---

const POLICY_TRIGGER_PHRASES = [
	"When doing file search, prefer to use the",
	"should proactively use the",
	"Use specialized tools instead of bash commands",
	"VERY IMPORTANT: When exploring the codebase",
	"Thoroughly explore the codebase using Glob, Grep, and Read tools",
	"Find existing patterns and conventions",
];

const POLICY_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
	{
		pattern:
			/- When doing file search, prefer to use the \$\{[A-Za-z0-9_$]+\} tool in order to reduce context usage\./g,
		replacement: "",
	},
	{
		pattern:
			/- You should proactively use the \$\{[A-Za-z0-9_$]+\} tool with specialized agents when the task at hand matches the agent's description\./g,
		replacement: "",
	},
	{
		pattern:
			/- Use specialized tools instead of bash commands when possible[\s\S]*?Output all communication directly in your response text instead\./g,
		replacement: "",
	},
	{
		pattern:
			/- VERY IMPORTANT: When exploring the codebase to gather context[\s\S]*?instead of running search commands directly\./g,
		replacement: "",
	},
	{
		pattern:
			/- Use specialized tools instead of bash commands when possible[\s\S]*?bash echo/g,
		replacement: "",
	},
];

// --- "Using your tools" section updates (2.1.31+) ---

const USING_TOOLS_REPLACEMENTS: Array<{
	pattern: RegExp;
	replacement: string;
}> = [
	{
		pattern: /`To search for files use \$\{[^}]+\} instead of find or ls`/g,
		replacement:
			"`To search for files use fd (via bash) instead of find or ls`",
	},
	{
		pattern:
			/`To search the content of files, use \$\{[^}]+\} instead of grep or rg`/g,
		replacement:
			"`To search the content of files use rg (text) or sg (code) instead of grep`",
	},
	{
		pattern:
			/`For simple, directed codebase searches \(e\.g\. for a specific file\/class\/function\) use the \$\{[^}]+\} or \$\{[^}]+\} directly\.`/g,
		replacement:
			"`For simple, directed codebase searches (e.g. for a specific file/class/function) use bash with fd (file names), sg (code structure — functions, classes, imports), and rg (text — strings, errors, config), with tight output limits.`",
	},
	{
		pattern: /This is slower than calling \$\{[^}]+\} or \$\{[^}]+\} directly/g,
		replacement: "This is slower than a quick fd/sg/rg query via bash",
	},
];

// --- Debug command updates ---

const DEBUG_COMMAND_REPLACEMENTS: Array<{
	pattern: RegExp;
	replacement: string;
}> = [
	{
		pattern: /allowedTools:\s*\["Read",\s*"Grep",\s*"Glob"\],/g,
		replacement: 'allowedTools: ["Read", "Bash"],',
	},
	{
		pattern:
			/For additional context, grep for \[ERROR\] and \[WARN\] lines across the full file\./g,
		replacement:
			"For additional context, use Bash with rg '\\\\[ERROR\\\\]|\\\\[WARN\\\\]' <debug_log_path> across the full file.",
	},
];

export const promptRewrite: Patch = {
	tag: "prompt-rewrite",

	string: (code) => {
		let result = code;

		// Agent prompt replacements (always run — regex is a no-op if absent)
		for (const [pattern, replacement] of AGENT_REPLACEMENTS) {
			result = result.replace(pattern, replacement);
		}

		// Tool policy replacements (guarded by trigger phrases)
		const hasTrigger = POLICY_TRIGGER_PHRASES.some((phrase) =>
			result.includes(phrase),
		);
		if (hasTrigger) {
			result = result.replace(
				/Thoroughly explore the codebase using Glob, Grep, and Read tools/g,
				"Thoroughly explore the codebase using ast-grep for code search and Read for viewing.",
			);
			result = result.replace(
				/Explore the codebase using Glob, Grep, and Read tools/g,
				"Explore the codebase using bash with fd (files) and sg/rg (search), and Read for focused viewing.",
			);
			result = result.replace(
				/\(ls, git status, git log, git diff, find, cat, head, tail\)/g,
				"(ls, git status, git log, git diff, fd, bat)",
			);

			for (const { pattern, replacement } of POLICY_PATTERNS) {
				result = result.replace(pattern, replacement);
			}

			result = result.replace(
				/<example>\nuser: Where[\s\S]*?<\/example>\n?/g,
				"",
			);
			result = result.replace(/^[ \t]*-[ \t]*$/gm, "");

			result = result.replace(
				/Find existing patterns and conventions using \$\{[^}]+\}, \$\{[^}]+\}, and \$\{[^}]+\}/g,
				"Find existing patterns and conventions using ast-grep (code) and Read (viewing). Use fd for file finding",
			);

			for (const { pattern, replacement } of USING_TOOLS_REPLACEMENTS) {
				result = result.replace(pattern, replacement);
			}

			for (const { pattern, replacement } of DEBUG_COMMAND_REPLACEMENTS) {
				result = result.replace(pattern, replacement);
			}
		}

		return result;
	},

	verify: (code) => {
		// Agent prompt checks
		if (
			!code.includes("ast-grep for code pattern matching") &&
			!code.includes("rg for text search in non-code files")
		) {
			return "Missing ast-grep/rg replacements for agent prompts";
		}

		// Tool policy checks (guarded — transform is conditional on trigger phrases)
		const hasTrigger = POLICY_TRIGGER_PHRASES.some((phrase) =>
			code.includes(phrase),
		);

		if (!code.includes("ast-grep for code search and Read for viewing")) {
			// Trigger phrases present but replacement missing → patch failed
			if (hasTrigger) {
				return "Missing tool policy update for Read tool";
			}
			// Neither trigger phrases nor replacement → upstream removed section, OK
		}
		if (
			code.includes("Explore the codebase using Glob, Grep, and Read tools")
		) {
			return "Plan mode prompt still references Glob/Grep";
		}
		if (/^[ \t]*-[ \t]*$/m.test(code)) {
			return "Prompt rewrite contains an empty bullet line";
		}

		// Debug command checks (guarded — only run when trigger section exists)
		if (code.includes('name: "debug"')) {
			if (code.includes('allowedTools: ["Read", "Grep", "Glob"]')) {
				return "Debug command still references disabled Grep/Glob tools";
			}
			if (!code.includes('allowedTools: ["Read", "Bash"]') && hasTrigger) {
				return "Debug command missing Read+Bash allowedTools";
			}
		}

		// 2.1.31+ file/content search guidance (guarded)
		if (code.includes("To search for files use")) {
			if (
				!code.includes("To search for files use fd (via bash)") &&
				hasTrigger
			) {
				return "Missing tool policy update for file search";
			}
		}
		if (code.includes("To search the content of files")) {
			if (
				!code.includes(
					"To search the content of files use rg (text) or sg (code)",
				) &&
				hasTrigger
			) {
				return "Missing tool policy update for content search";
			}
		}

		return true;
	},
};
