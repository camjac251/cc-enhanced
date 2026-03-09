import type { Patch } from "../types.js";

// Coupling: disable-tools.ts also rewrites Glob/Grep prompt references.
// This patch keeps rewrites minimal and neutral so system prompt policy remains
// the single source of truth for tool selection guidance.

const VAR = "[A-Za-z0-9_$]+";

const AGENT_REPLACEMENTS: Array<[RegExp, string]> = [
	[
		new RegExp(`- Use \\$\\{${VAR}\\} for broad file pattern matching`, "g"),
		"- Use available code/file search tooling for focused discovery",
	],
	[
		new RegExp(
			`- Use \\$\\{${VAR}\\} for searching file contents with regex`,
			"g",
		),
		"- Use available content-search tooling for targeted discovery",
	],
	[
		new RegExp(`- File search: Use \\$\\{${VAR}\\} \\(NOT find or ls\\)`, "g"),
		"- File search: Use available file-search tooling with focused scope",
	],
	[
		new RegExp(
			`- Content search: Use \\$\\{${VAR}\\} \\(NOT grep or [^)]+\\)`,
			"g",
		),
		"- Content search: Use available content-search tooling with focused scope",
	],
	[
		new RegExp(
			`instead of using \\$\\{${VAR}\\} or \\$\\{${VAR}\\} directly`,
			"g",
		),
		"for comprehensive exploration",
	],
];

const PLAN_REPLACEMENTS: Array<{ pattern: RegExp; replacement: string }> = [
	{
		pattern:
			/Thoroughly explore the codebase using Glob, Grep, and Read tools/g,
		replacement:
			"Thoroughly explore the codebase using available search tooling and Read.",
	},
	{
		pattern: /Explore the codebase using Glob, Grep, and Read tools/g,
		replacement:
			"Explore the codebase using available search tooling and Read for focused viewing.",
	},
];

const USING_TOOLS_REPLACEMENTS: Array<{
	pattern: RegExp;
	replacement: string;
}> = [
	{
		pattern: /`To search for files use \$\{[^}]+\} instead of find or ls`/g,
		replacement:
			"`To search for files use available file-search tooling instead of find or ls`",
	},
	{
		pattern:
			/`To search the content of files, use \$\{[^}]+\} instead of grep or [^`]+`/g,
		replacement:
			"`To search the content of files use available content-search tooling instead of grep`",
	},
	{
		pattern:
			/`For simple, directed codebase searches \(e\.g\. for a specific file\/class\/function\) use the \$\{[^}]+\} or \$\{[^}]+\} directly\.`/g,
		replacement:
			"`For simple, directed codebase searches (e.g. for a specific file/class/function) use focused Bash search tooling and Read as needed.`",
	},
	{
		pattern: /This is slower than calling \$\{[^}]+\} or \$\{[^}]+\} directly/g,
		replacement: "This is slower than quick, targeted search queries via bash",
	},
];

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
			"For additional context, use Bash content search for [ERROR] and [WARN] lines across the full file.",
	},
];

const AGENT_TOOL_TEXT_REPLACEMENTS: Array<{
	pattern: RegExp;
	replacement: string;
}> = [
	{
		pattern:
			/Information about an available subagent that can be invoked via the Task tool\./g,
		replacement:
			"Information about an available subagent that can be invoked via the Agent tool.",
	},
];

// claude-code-guide approach section: replace WebFetch/WebSearch refs with MCP tools
const GUIDE_REPLACEMENTS: Array<{ pattern: RegExp; replacement: string }> = [
	{
		pattern: new RegExp(
			`2\\. Use \\$\\{${VAR}\\} to fetch the appropriate docs map`,
			"g",
		),
		replacement:
			"2. Fetch the appropriate docs map URL using MCP doc tools (context7, docfork, or ref)",
	},
	{
		pattern: new RegExp(
			`6\\. Use \\$\\{${VAR}\\} if docs don't cover the topic`,
			"g",
		),
		replacement:
			"6. Use MCP search (perplexity) if official docs don't cover the topic",
	},
];

const AGENT_SOURCE_SIGNALS = [
	"for broad file pattern matching",
	"for searching file contents with regex",
];

const AGENT_PATCHED_SIGNALS = [
	"available code/file search tooling for focused discovery",
	"available content-search tooling for targeted discovery",
];

const USING_TOOLS_SOURCE_SIGNALS = [
	"To search for files use",
	"To search the content of files, use",
];

const USING_TOOLS_PATCHED_SIGNALS = [
	"available file-search tooling instead of find or ls",
	"available content-search tooling instead of grep",
];

export const promptRewrite: Patch = {
	tag: "prompt-rewrite",

	string: (code) => {
		let result = code;

		for (const [pattern, replacement] of AGENT_REPLACEMENTS) {
			result = result.replace(pattern, replacement);
		}
		for (const { pattern, replacement } of PLAN_REPLACEMENTS) {
			result = result.replace(pattern, replacement);
		}
		for (const { pattern, replacement } of USING_TOOLS_REPLACEMENTS) {
			result = result.replace(pattern, replacement);
		}
		for (const { pattern, replacement } of DEBUG_COMMAND_REPLACEMENTS) {
			result = result.replace(pattern, replacement);
		}
		for (const { pattern, replacement } of AGENT_TOOL_TEXT_REPLACEMENTS) {
			result = result.replace(pattern, replacement);
		}
		for (const { pattern, replacement } of GUIDE_REPLACEMENTS) {
			result = result.replace(pattern, replacement);
		}

		return result;
	},

	verify: (code) => {
		const hasAgentSectionSignal =
			AGENT_SOURCE_SIGNALS.some((signal) => code.includes(signal)) ||
			AGENT_PATCHED_SIGNALS.some((signal) => code.includes(signal));
		if (hasAgentSectionSignal) {
			if (
				!code.includes(
					"available code/file search tooling for focused discovery",
				) ||
				!code.includes(
					"available content-search tooling for targeted discovery",
				)
			) {
				return "Missing neutral replacements for agent search prompts";
			}
		}

		if (
			code.includes("Explore the codebase using Glob, Grep, and Read tools")
		) {
			return "Plan mode prompt still references Glob/Grep";
		}
		if (
			code.includes(
				"Thoroughly explore the codebase using Glob, Grep, and Read tools",
			)
		) {
			return "Plan mode prompt still references Glob/Grep in thorough exploration guidance";
		}

		if (code.includes('name: "debug"')) {
			if (code.includes('allowedTools: ["Read", "Grep", "Glob"]')) {
				return "Debug command still references disabled Grep/Glob tools";
			}
			if (!code.includes('allowedTools: ["Read", "Bash"]')) {
				return "Debug command missing Read+Bash allowedTools";
			}
		}

		if (
			code.includes(
				"Information about an available subagent that can be invoked via the Task tool.",
			)
		) {
			return "Legacy Task-tool subagent description still present";
		}

		// USING_TOOLS_REPLACEMENTS: source signals should be absent after patching
		const hasUsingToolsSection = USING_TOOLS_SOURCE_SIGNALS.some((signal) =>
			code.includes(signal),
		);
		if (hasUsingToolsSection) {
			if (
				!USING_TOOLS_PATCHED_SIGNALS.every((signal) => code.includes(signal))
			) {
				return "Missing neutral replacements for using-tools search prompts";
			}
		}

		// AGENT_REPLACEMENTS: source signals should be absent after patching
		if (AGENT_SOURCE_SIGNALS.some((signal) => code.includes(signal))) {
			if (!AGENT_PATCHED_SIGNALS.every((signal) => code.includes(signal))) {
				return "Agent search prompts still contain unreplaced source text";
			}
		}

		// GUIDE_REPLACEMENTS: WebFetch/WebSearch references in guide approach
		if (code.includes("You are the Claude guide agent")) {
			if (code.includes("to fetch the appropriate docs map")) {
				if (!code.includes("MCP doc tools (context7, docfork, or ref)")) {
					return "Guide approach still references WebFetch for docs map";
				}
			}
			if (code.includes("if official docs don't cover the topic")) {
				if (!code.includes("MCP search (perplexity)")) {
					return "Guide approach still references WebSearch as fallback";
				}
			}
		}

		return true;
	},
};
