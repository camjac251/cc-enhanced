import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch } from "../types.js";
import {
	getObjectKeyName,
	hasObjectKeyName,
	isFalseLike,
	resolveStringValue,
} from "./ast-helpers.js";

// Coupling: agents-off.ts blocks NotebookEdit from claude-code-guide agent;
// this patch disables NotebookEdit globally via isEnabled.

/**
 * Disable tools and clean up all prompt references to them.
 *
 * 1. AST: Disable Glob, Grep, WebSearch, WebFetch, NotebookEdit tools (isEnabled)
 * 2. AST: Strip disabled tools from skill filePatternTools arrays
 * 3. String: Clean up all prompt references to disabled tools (neutral wording)
 * 4. String: Strip disabled tools from skill allowed-tools headers and doc tables
 * 5. String: Replace WebFetch doc references with MCP alternatives
 * 6. String: Replace stale Glob/Grep/WebSearch agent prompt text
 * 7. String: Rename "Task tool" -> "Agent tool" in subagent descriptions
 */

const TARGET_TOOLS = new Set([
	"Grep",
	"Glob",
	"WebSearch",
	"WebFetch",
	"NotebookEdit",
]);

// Regex patterns for resilient matching (handles whitespace/minor changes)
const REGEX_REPLACEMENTS: Array<{ pattern: RegExp; replacement: string }> = [
	{
		// General Grep/Glob guidance (pre-2.1.71)
		pattern:
			/Use Grep or Glob when you need to search broadly\.?\s*Use Read when you know the specific file path\.?/gi,
		replacement:
			"Use available search tooling broadly, and use Read when you know the specific file path.",
	},
	{
		// GrepTool recommendation (pre-2.1.71)
		pattern: /or use the GrepTool to search for specific content\.?/gi,
		replacement:
			"or use available content-search tooling to search for specific content.",
	},
	{
		// Fallback for Read/Glob/Grep (pre-2.1.71)
		pattern:
			/any task that can be accomplished with direct Glob, Grep, or Read tool calls\.?/gi,
		replacement:
			"any task that can be accomplished with direct Read and available search tool calls.",
	},
	{
		// claude-code-guide: "using ${Read}, ${Glob}, and ${Grep}" -> "using Read" (pre-2.1.71)
		pattern:
			/Reference local project files \(CLAUDE\.md, \.claude\/ directory\) when relevant using \$\{[^}]+\}, \$\{[^}]+\}, and \$\{[^}]+\}/g,
		replacement:
			"Reference local project files (CLAUDE.md, .claude/ directory) when relevant using Read",
	},
	{
		// claude-code-guide: single-placeholder "using ${Read}" drift -> "using Read"
		pattern:
			/Reference local project files \(CLAUDE\.md, \.claude\/ directory\) when relevant using \$\{[^}]+\}/g,
		replacement:
			"Reference local project files (CLAUDE.md, .claude/ directory) when relevant using Read",
	},
	{
		// Agent tool prompt: "use the ${X} or ${Y} tool instead of the ${Z} tool" (pre-2.1.71)
		pattern:
			/use the \$\{([^}]+)\} or \$\{[^}]+\} tool instead of the \$\{([^}]+)\} tool/g,
		replacement: "use the ${$1} tool instead of the ${$2} tool",
	},
	{
		// Agent tool prompt: "use the ${X} tool or ${Y} instead of the ${Z} tool" (2.1.71+)
		pattern:
			/use the \$\{([^}]+)\} tool or \$\{[^}]+\} instead of the \$\{([^}]+)\} tool/g,
		replacement: "use the ${$1} tool instead of the ${$2} tool",
	},
	{
		// Agent tool prompt: Glob "class Foo" with "the ${X} tool instead" (pre-2.1.71)
		pattern:
			/- If you are searching for a specific class definition like (?:\\"|")class Foo(?:\\"|"), use the \$\{[^}]+\} tool instead, (?:to find the match more quickly|for faster access)/g,
		replacement:
			'- If you are searching for code patterns like "class Foo", use available code-search tooling for faster access',
	},
	{
		// Agent tool prompt: Glob "class Foo" with "${X} instead" (2.1.71+)
		pattern:
			/- If you are searching for a specific class definition like (?:\\"|")class Foo(?:\\"|"), use \$\{[^}]+\} instead, (?:to find the match more quickly|for faster access)/g,
		replacement:
			'- If you are searching for code patterns like "class Foo", use available code-search tooling for faster access',
	},
];

const TRIGGER_PHRASES = [
	"Use Grep or Glob",
	"use the GrepTool to search for specific content",
	"direct Glob, Grep, or Read",
	"Reference local project files (CLAUDE.md",
	'searching for a specific class definition like "class Foo"',
];

const FORBIDDEN_PROMPT_FRAGMENTS = [
	/Use Grep or Glob when you need to search broadly/i,
	/use the GrepTool to search for specific content/i,
	/direct Glob, Grep, or Read tool calls/i,
];

const CONDITIONAL_REWRITE_MARKERS: Array<{
	trigger: string;
	required: string;
}> = [
	{
		trigger:
			"Use Grep or Glob when you need to search broadly. Use Read when you know the specific file path.",
		required:
			"Use available search tooling broadly, and use Read when you know the specific file path.",
	},
	{
		trigger: "or use the GrepTool to search for specific content.",
		required:
			"or use available content-search tooling to search for specific content.",
	},
	{
		trigger:
			"any task that can be accomplished with direct Glob, Grep, or Read tool calls.",
		required:
			"any task that can be accomplished with direct Read and available search tool calls.",
	},
	{
		trigger:
			'- If you are searching for a specific class definition like "class Foo", use',
		required:
			'- If you are searching for code patterns like "class Foo", use available code-search tooling for faster access',
	},
];

// ---------------------------------------------------------------------------
// Neutral rewrites for agent/plan/guide/debug prompts
// ---------------------------------------------------------------------------

const VAR = "[A-Za-z0-9_$]+";

const PROMPT_REWRITE_REPLACEMENTS: Array<[RegExp, string]> = [
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

const PLAN_REWRITES: Array<{ pattern: RegExp; replacement: string }> = [
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

const DEBUG_CMD_REWRITES: Array<{ pattern: RegExp; replacement: string }> = [
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

const AGENT_TOOL_TEXT_REWRITES: Array<{
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

const GUIDE_REWRITES: Array<{ pattern: RegExp; replacement: string }> = [
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

const PROMPT_REWRITE_SOURCE_SIGNALS = [
	"for broad file pattern matching",
	"for searching file contents with regex",
];

const PROMPT_REWRITE_PATCHED_SIGNALS = [
	"available code/file search tooling for focused discovery",
	"available content-search tooling for targeted discovery",
];

// ---------------------------------------------------------------------------
// Skill allowed-tools and doc table cleanup
// ---------------------------------------------------------------------------

const FORBIDDEN_TOOL_ROW_PATTERN =
	/[ \t]*<tr>\s*<td>(Glob|Grep|WebSearch|WebFetch)<\/td>\s*<td>[\s\S]*?<\/td>\s*<\/tr>\n?/g;
const FORBIDDEN_TOOL_MARKDOWN_ROW_PATTERN =
	/^\|\s*(Glob|Grep|WebSearch|WebFetch)\s*\|.*\n?/gm;
const MCP_DOC_HINT_SHORT = "MCP doc tools (context7, perplexity, firecrawl)";

const SKILL_DOC_TEXT_REPLACEMENTS: Array<[RegExp, string]> = [
	[
		/\*\*Common tool matchers:\*\* `Bash`, `Write`, `Edit`, `Read`, `Glob`, `Grep`/g,
		"**Common tool matchers:** `Bash`, `Write`, `Edit`, `Read`, `Agent`",
	],
	[
		/\*\*Common tool matchers:\*\* \\`Bash\\`, \\`Write\\`, \\`Edit\\`, \\`Read\\`, \\`Glob\\`, \\`Grep\\`/g,
		"**Common tool matchers:** \\`Bash\\`, \\`Write\\`, \\`Edit\\`, \\`Read\\`, \\`Agent\\`",
	],
	[/## When to Use WebFetch/g, "## When to Fetch Live Documentation"],
	[
		/<h2>When to Use WebFetch<\/h2>/g,
		"<h2>When to Fetch Live Documentation</h2>",
	],
	[
		/Use WebFetch to get the latest documentation when:/g,
		`Use ${MCP_DOC_HINT_SHORT} to get the latest documentation when:`,
	],
	[
		/WebFetch URLs for fetching the latest official documentation\./g,
		`Live documentation URLs; fetch via ${MCP_DOC_HINT_SHORT} or curl.`,
	],
	[
		/WebFetch URLs for current Agent SDK docs\./g,
		`Live documentation URLs for current Agent SDK docs; fetch via ${MCP_DOC_HINT_SHORT} or curl.`,
	],
	[
		/Full docs via WebFetch in <code>shared\/live-sources\.md<\/code>\./g,
		`Full docs via ${MCP_DOC_HINT_SHORT} using URLs in <code>shared/live-sources.md</code>.`,
	],
	[
		/Full docs via WebFetch in \\`shared\/live-sources\.md\\`\./g,
		"Full docs via " +
			MCP_DOC_HINT_SHORT +
			" using URLs in \\`shared/live-sources.md\\`.",
	],
	[
		/For the latest information, WebFetch the Models Overview URL in <code>shared\/live-sources\.md<\/code>[^"<]*/g,
		`For the latest information, fetch the Models Overview URL in <code>shared/live-sources.md</code> via ${MCP_DOC_HINT_SHORT}.`,
	],
	[
		/For the latest information, WebFetch the Models Overview URL in \\`shared\/live-sources\.md\\`[^"\\]*/g,
		"For the latest information, fetch the Models Overview URL in \\`shared/live-sources.md\\` via " +
			MCP_DOC_HINT_SHORT +
			".",
	],
	[
		/For detailed tool use documentation, use WebFetch:/g,
		`For detailed tool use documentation, fetch the listed URL via ${MCP_DOC_HINT_SHORT}:`,
	],
	[
		/For full implementation examples, use WebFetch:/g,
		`For full implementation examples, fetch the listed URL via ${MCP_DOC_HINT_SHORT}:`,
	],
	[
		/For full documentation, use WebFetch:/g,
		`For full documentation, fetch the listed URL via ${MCP_DOC_HINT_SHORT}:`,
	],
	[/Latest docs via WebFetch:/g, `Latest docs via ${MCP_DOC_HINT_SHORT}:`],
	[
		/Live documentation URLs are in <code>shared\/live-sources\.md<\/code>\./g,
		`Live documentation URLs are in <code>shared/live-sources.md</code>; fetch via ${MCP_DOC_HINT_SHORT}.`,
	],
	[
		/Live documentation URLs are in \\`shared\/live-sources\.md\\`\./g,
		"Live documentation URLs are in \\`shared/live-sources.md\\`; fetch via " +
			MCP_DOC_HINT_SHORT +
			".",
	],
	[
		/This file contains WebFetch URLs for fetching current information/g,
		"This file contains live documentation URLs for fetching current information",
	],
	[
		/\.indexOf\("## When to Use WebFetch"\)/g,
		'.indexOf("## When to Fetch Live Documentation")',
	],
	[
		/If WebFetch fails \(network issues, URL changed\):/g,
		"If fetching fails (network issues, URL changed):",
	],
	[
		/\*\*Latest docs via WebFetch:\*\*/g,
		`**Latest docs via ${MCP_DOC_HINT_SHORT}:**`,
	],
];

function normalizeToolList(tools: string[], quote: `"` | "&quot;"): string {
	const kept = tools.filter((tool) => !FORBIDDEN_TOOLS.has(tool));
	if (kept.includes("Read") && !kept.includes("Bash")) {
		kept.splice(kept.indexOf("Read") + 1, 0, "Bash");
	}
	if (kept.length === 0) kept.push("Bash");
	return kept.map((tool) => `${quote}${tool}${quote}`).join(", ");
}

function extractTools(items: string, pattern: RegExp): string[] {
	return Array.from(items.matchAll(pattern) as Iterable<RegExpMatchArray>)
		.map((m) => m[1])
		.filter((tool): tool is string => Boolean(tool));
}

function normalizePlainAllowedToolsArrays(code: string): string {
	let result = code;
	for (const key of ["allowedTools", "allowed_tools", "tools"] as const) {
		result = result.replace(
			new RegExp(`(${key}\\s*[:=]\\s*)\\[([^\\]]+)\\]`, "g"),
			(match, prefix, items) => {
				const tools = extractTools(items, /"([^"]+)"/g);
				if (!tools.some((tool) => FORBIDDEN_TOOLS.has(tool))) return match;
				return `${prefix}[${normalizeToolList(tools, '"')}]`;
			},
		);
	}
	return result;
}

function normalizeEscapedAllowedToolsArrays(code: string): string {
	let result = code;
	for (const key of ["allowedTools", "allowed_tools"] as const) {
		result = result.replace(
			new RegExp(`(${key}\\s*[:=]\\s*)\\[([^\\]]+)\\]`, "g"),
			(match, prefix, items) => {
				const tools = extractTools(items, /&quot;([^&]+)&quot;/g);
				if (!tools.some((tool) => FORBIDDEN_TOOLS.has(tool))) return match;
				return `${prefix}[${normalizeToolList(tools, "&quot;")}]`;
			},
		);
	}
	return result;
}

function normalizeEscapedToolsArrays(code: string): string {
	return code.replace(
		/(\btools\b\s*[:=]\s*)\[([^\]]+)\]/g,
		(match, prefix, items) => {
			const tools = extractTools(items, /&quot;([^&]+)&quot;/g);
			if (!tools.some((tool) => FORBIDDEN_TOOLS.has(tool))) return match;
			return `${prefix}[${normalizeToolList(tools, "&quot;")}]`;
		},
	);
}

function stripForbiddenAllowedToolsBullets(code: string): string {
	return code.replace(/allowed-tools:\n(?:[ \t]*-\s*[^\n]+\n)+/g, (block) =>
		block.replace(/^[ \t]*-\s*(Glob|Grep|WebFetch|WebSearch)\s*\n/gm, ""),
	);
}

function hasForbiddenAllowedToolsBullets(code: string): boolean {
	const lines = code.split("\n");
	let inBlock = false;
	let blockIndent = 0;
	const forbiddenPat = /^(Glob|Grep|WebFetch|WebSearch)\b/;
	for (const line of lines) {
		const blockStart = line.match(/^([ \t]*)allowed-tools:\s*$/);
		if (blockStart) {
			inBlock = true;
			blockIndent = blockStart[1].length;
			continue;
		}
		if (!inBlock) continue;
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		const currentIndent = line.match(/^([ \t]*)/)?.[1].length ?? 0;
		if (currentIndent <= blockIndent) {
			inBlock = false;
			continue;
		}
		const bulletMatch = trimmed.match(/^-\s*(.+)$/);
		if (bulletMatch && forbiddenPat.test(bulletMatch[1])) return true;
	}
	return false;
}

const FORBIDDEN_TOOLS = new Set(["Glob", "Grep", "WebSearch", "WebFetch"]);

// ---------------------------------------------------------------------------
// Core tools-off logic
// ---------------------------------------------------------------------------

function isLikelyToolObject(obj: t.ObjectExpression): boolean {
	return obj.properties.some(
		(prop) =>
			(t.isObjectProperty(prop) || t.isObjectMethod(prop)) &&
			[
				"call",
				"description",
				"inputSchema",
				"userFacingName",
				"prompt",
			].includes(getObjectKeyName(prop.key) ?? ""),
	);
}

function disableIsEnabled(obj: t.ObjectExpression) {
	let patched = false;
	for (const prop of obj.properties) {
		if (t.isObjectMethod(prop) && hasObjectKeyName(prop, "isEnabled")) {
			prop.body = t.blockStatement([
				t.returnStatement(t.booleanLiteral(false)),
			]);
			patched = true;
		} else if (
			t.isObjectProperty(prop) &&
			hasObjectKeyName(prop, "isEnabled")
		) {
			prop.value = t.booleanLiteral(false);
			patched = true;
		}
	}
	if (!patched) {
		obj.properties.push(
			t.objectMethod(
				"method",
				t.identifier("isEnabled"),
				[],
				t.blockStatement([t.returnStatement(t.booleanLiteral(false))]),
			),
		);
	}
}

function isIsEnabledDisabled(
	prop: t.ObjectProperty | t.ObjectMethod | null | undefined,
): boolean {
	if (!prop) return false;

	if (t.isObjectProperty(prop)) return isFalseLike(prop.value);

	const firstStmt = prop.body.body[0];
	if (!firstStmt || !t.isReturnStatement(firstStmt)) return false;
	return isFalseLike(firstStmt.argument);
}

export const disableTools: Patch = {
	tag: "tools-off",

	string: (code) => {
		let result = code;

		// --- Core tools-off prompt cleanup ---
		const hasTrigger = TRIGGER_PHRASES.some((phrase) =>
			result.includes(phrase),
		);
		if (hasTrigger) {
			for (const { pattern, replacement } of REGEX_REPLACEMENTS) {
				result = result.replace(pattern, replacement);
			}
			result = result
				.split("to find the match more quickly")
				.join("for faster access");
		}

		// --- Neutral prompt rewrites (agent/plan/guide/debug) ---
		for (const [pattern, replacement] of PROMPT_REWRITE_REPLACEMENTS) {
			result = result.replace(pattern, replacement);
		}
		for (const { pattern, replacement } of PLAN_REWRITES) {
			result = result.replace(pattern, replacement);
		}
		for (const { pattern, replacement } of DEBUG_CMD_REWRITES) {
			result = result.replace(pattern, replacement);
		}
		for (const { pattern, replacement } of AGENT_TOOL_TEXT_REWRITES) {
			result = result.replace(pattern, replacement);
		}
		for (const { pattern, replacement } of GUIDE_REWRITES) {
			result = result.replace(pattern, replacement);
		}

		// --- Skill allowed-tools and doc table cleanup ---
		const hasSkillMarkers =
			result.includes("allowed-tools:") ||
			result.includes("allowedTools:") ||
			result.includes("allowed_tools") ||
			/\btools\b\s*[:=]\s*\[/.test(result) ||
			result.includes("**Common tool matchers:**") ||
			result.includes("When to Use WebFetch") ||
			result.includes("<h2>When to Use WebFetch</h2>") ||
			result.includes("<tr><td>Glob</td>") ||
			result.includes("<tr><td>Grep</td>");
		if (hasSkillMarkers) {
			const allowedToolsPattern =
				/(allowed-tools:[^"'\n]*)(, Glob| Glob,|, Grep| Grep,|, WebFetch| WebFetch,|, WebSearch| WebSearch,)/g;
			let prev = "";
			while (prev !== result) {
				prev = result;
				result = result.replace(allowedToolsPattern, "$1");
			}
			result = stripForbiddenAllowedToolsBullets(result);
			result = normalizePlainAllowedToolsArrays(result);
			result = normalizeEscapedAllowedToolsArrays(result);
			result = normalizeEscapedToolsArrays(result);
			// Skill doc text cleanup (HTML/markdown tables, WebFetch refs)
			result = result.replace(FORBIDDEN_TOOL_ROW_PATTERN, "");
			result = result.replace(FORBIDDEN_TOOL_MARKDOWN_ROW_PATTERN, "");
			for (const [pattern, replacement] of SKILL_DOC_TEXT_REPLACEMENTS) {
				result = result.replace(pattern, replacement);
			}
		}

		return result;
	},

	astPasses: () => [
		{
			pass: "mutate",
			visitor: createDisableToolsMutator(),
		},
		{
			pass: "mutate",
			visitor: createSkillAllowedToolsMutator(),
		},
	],

	verify: (code, ast) => {
		if (!ast) return "Missing AST for tools-off verification";

		const disabledTools = new Set<string>();
		traverse.default(ast, {
			ObjectExpression(path: any) {
				const nameProp = path.node.properties.find(
					(p: any) => t.isObjectProperty(p) && hasObjectKeyName(p, "name"),
				) as t.ObjectProperty | undefined;
				if (!nameProp) return;

				const toolName = resolveStringValue(path, nameProp.value as any);
				if (!toolName || !TARGET_TOOLS.has(toolName)) return;
				if (!isLikelyToolObject(path.node)) return;

				const isEnabledProp = path.node.properties.find(
					(p: any) =>
						(t.isObjectProperty(p) || t.isObjectMethod(p)) &&
						hasObjectKeyName(p, "isEnabled"),
				) as t.ObjectProperty | t.ObjectMethod | undefined;

				if (isIsEnabledDisabled(isEnabledProp)) {
					disabledTools.add(toolName);
				}
			},
		});
		for (const tool of TARGET_TOOLS) {
			if (!disabledTools.has(tool)) {
				return `Tool ${tool} is not disabled via isEnabled`;
			}
		}

		// Verify prompt cleanup — negative checks (old strings must be gone)
		for (const fragment of FORBIDDEN_PROMPT_FRAGMENTS) {
			if (fragment.test(code)) {
				return `Still contains disabled Grep/Glob guidance: ${fragment.source}`;
			}
		}

		for (const { trigger, required } of CONDITIONAL_REWRITE_MARKERS) {
			if (code.includes(trigger) && !code.includes(required)) {
				return `Legacy disabled-tool guidance remains without neutral rewrite: ${trigger}`;
			}
		}

		// --- Prompt rewrite verification ---
		const promptResult = verifyPromptRewrite(code);
		if (promptResult !== true) return promptResult;

		// --- Skill tools verification ---
		const skillResult = verifySkillTools(code, ast);
		if (skillResult !== true) return skillResult;

		return true;
	},
};

// ---------------------------------------------------------------------------
// Prompt rewrite verification
// ---------------------------------------------------------------------------

function verifyPromptRewrite(code: string): true | string {
	const hasAgentSectionSignal =
		PROMPT_REWRITE_SOURCE_SIGNALS.some((s) => code.includes(s)) ||
		PROMPT_REWRITE_PATCHED_SIGNALS.some((s) => code.includes(s));
	if (hasAgentSectionSignal) {
		if (!PROMPT_REWRITE_PATCHED_SIGNALS.every((s) => code.includes(s))) {
			return "Missing neutral replacements for agent search prompts";
		}
	}
	if (code.includes("Explore the codebase using Glob, Grep, and Read tools")) {
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
	if (PROMPT_REWRITE_SOURCE_SIGNALS.some((s) => code.includes(s))) {
		if (!PROMPT_REWRITE_PATCHED_SIGNALS.every((s) => code.includes(s))) {
			return "Agent search prompts still contain unreplaced source text";
		}
	}
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
}

// ---------------------------------------------------------------------------
// Skill tools verification
// ---------------------------------------------------------------------------

function verifySkillTools(code: string, ast: t.File): true | string {
	// AST: filePatternTools arrays
	let filePatternToolsCount = 0;
	let hasForbiddenTool = false;
	traverse.default(ast, {
		ObjectProperty(path) {
			if (getObjectKeyName(path.node.key) !== "filePatternTools") return;
			if (!t.isArrayExpression(path.node.value)) return;
			filePatternToolsCount++;
			for (const el of path.node.value.elements) {
				if (!t.isStringLiteral(el)) continue;
				if (FORBIDDEN_TOOLS.has(el.value)) hasForbiddenTool = true;
			}
		},
	});
	if (filePatternToolsCount < 1) {
		return "No filePatternTools arrays found for skill tools verification";
	}
	if (hasForbiddenTool) {
		return "Skill filePatternTools still includes Glob/Grep";
	}

	let stringChecksExercised = 0;
	if (
		/allowed-tools:[^\n]*(Glob|Grep|WebFetch|WebSearch)/.test(code) ||
		hasForbiddenAllowedToolsBullets(code)
	) {
		return "Skill allowed-tools sections still include disabled tools";
	}
	if (code.includes("allowed-tools:")) stringChecksExercised++;

	if (
		/(allowedTools|allowed_tools|\btools\b)\s*[:=]\s*\[[^\]]*"(Glob|Grep|WebFetch|WebSearch)"/.test(
			code,
		) ||
		/(allowedTools|allowed_tools)\s*[:=]\s*\[[^\]]*&quot;(Glob|Grep|WebFetch|WebSearch)&quot;/.test(
			code,
		) ||
		/\btools\b\s*[:=]\s*\[[^\]]*&quot;(Glob|Grep|WebFetch|WebSearch)&quot;/.test(
			code,
		)
	) {
		return "Skill allowedTools/tool examples still include disabled tools";
	}
	if (code.includes("allowedTools:") || code.includes("allowed_tools"))
		stringChecksExercised++;

	if (
		code.includes(
			"**Common tool matchers:** `Bash`, `Write`, `Edit`, `Read`, `Glob`, `Grep`",
		) ||
		code.includes(
			"**Common tool matchers:** \\`Bash\\`, \\`Write\\`, \\`Edit\\`, \\`Read\\`, \\`Glob\\`, \\`Grep\\`",
		)
	) {
		return "Hook matcher docs still reference disabled Glob/Grep tools";
	}
	if (code.includes("**Common tool matchers:**")) {
		const hasAgentMatcherLine =
			code.includes(
				"**Common tool matchers:** `Bash`, `Write`, `Edit`, `Read`, `Agent`",
			) ||
			code.includes(
				"**Common tool matchers:** \\`Bash\\`, \\`Write\\`, \\`Edit\\`, \\`Read\\`, \\`Agent\\`",
			);
		if (!hasAgentMatcherLine) {
			return "Hook matcher docs are missing Agent in common tool matchers line";
		}
		stringChecksExercised++;
	}

	if (
		code.includes("## When to Use WebFetch") ||
		code.includes("<h2>When to Use WebFetch</h2>")
	) {
		return "Skill docs still reference WebFetch-only guidance";
	}
	if (code.includes("This file contains WebFetch URLs")) {
		return "Live-sources skill doc still references WebFetch URLs";
	}
	if (code.includes("If WebFetch fails")) {
		return "Live-sources fallback guidance still references WebFetch";
	}
	if (code.includes("WebFetch the Models Overview URL")) {
		return "Model catalog still references WebFetch for Models Overview";
	}
	if (code.includes("**Latest docs via WebFetch:**")) {
		return "Skill reference docs still reference Latest docs via WebFetch";
	}
	if (code.includes('.indexOf("## When to Use WebFetch")')) {
		return "claude-api prompt builder still searches for old WebFetch heading";
	}
	if (
		/<tr>\s*<td>(Glob|Grep|WebSearch|WebFetch)<\/td>\s*<td>[\s\S]*?<\/td>\s*<\/tr>/.test(
			code,
		) ||
		/^\|\s*(Glob|Grep|WebSearch|WebFetch)\s*\|/m.test(code)
	) {
		return "Built-in tools table still lists disabled tools";
	}
	if (code.includes('name: "claude-api"')) {
		stringChecksExercised++;
		const apiSkillBlock = code.match(
			/name:\s*"claude-api"[\s\S]*?(?=\n\s*name:\s*"|$)/,
		);
		if (apiSkillBlock) {
			if (/"(Glob|Grep|WebFetch|WebSearch)"/.test(apiSkillBlock[0])) {
				return "claude-api skill still includes disabled tools in allowedTools";
			}
		}
	}

	const hasSkillStringMarkers =
		code.includes("allowed-tools:") ||
		code.includes("allowedTools:") ||
		code.includes("allowed_tools") ||
		code.includes("**Common tool matchers:**") ||
		code.includes("When to Use WebFetch") ||
		code.includes("<h2>When to Use WebFetch</h2>") ||
		code.includes("<tr><td>Glob</td>") ||
		code.includes("<tr><td>Grep</td>") ||
		code.includes('name: "claude-api"');
	if (hasSkillStringMarkers && stringChecksExercised < 2) {
		return `Skill tools verification exercised only ${stringChecksExercised} of 4 string check groups while skill markers are present`;
	}

	return true;
}

// ---------------------------------------------------------------------------
// AST mutators
// ---------------------------------------------------------------------------

function createSkillAllowedToolsMutator(): traverse.Visitor {
	return {
		ObjectProperty(path: any) {
			if (
				getObjectKeyName(path.node.key) === "filePatternTools" &&
				t.isArrayExpression(path.node.value)
			) {
				path.node.value.elements = path.node.value.elements.filter(
					(el: any) => {
						if (t.isStringLiteral(el)) return !FORBIDDEN_TOOLS.has(el.value);
						return true;
					},
				);
			}
		},
	};
}

function createDisableToolsMutator(): traverse.Visitor {
	return {
		ObjectExpression(path: any) {
			const nameProp = path.node.properties.find(
				(p: any) => t.isObjectProperty(p) && hasObjectKeyName(p, "name"),
			) as t.ObjectProperty | undefined;
			if (!nameProp) return;

			const toolName = resolveStringValue(path, nameProp.value as any);
			if (!toolName) return;
			if (!isLikelyToolObject(path.node)) return;

			if (TARGET_TOOLS.has(toolName)) {
				console.log(`Disabling tool: ${toolName}`);
				disableIsEnabled(path.node);
			}
		},
	};
}
