import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch } from "../types.js";
import { getObjectKeyName } from "./ast-helpers.js";

/**
 * Remove disabled search/web tools from skill allowed-tools lists and examples.
 */

// Coupling: prompt-rewrite.ts also strips Glob/Grep from prompt text (general
// prompts), while this patch targets skill-specific allowed-tools headers and
// filePatternTools arrays.

const FORBIDDEN_TOOLS = new Set(["Glob", "Grep", "WebFetch", "WebSearch"]);
const FORBIDDEN_TOOL_ROW_PATTERN =
	/[ \t]*<tr>\s*<td>(Glob|Grep|WebSearch|WebFetch)<\/td>\s*<td>[\s\S]*?<\/td>\s*<\/tr>\n?/g;
const FORBIDDEN_TOOL_MARKDOWN_ROW_PATTERN =
	/^\|\s*(Glob|Grep|WebSearch|WebFetch)\s*\|.*\n?/gm;
// MCP-aware replacement text for doc fetching guidance.
// context7/docfork for library docs, perplexity for current info, firecrawl for URL scraping.
// biome-ignore lint/correctness/noUnusedVariables: kept for longer-form replacement text
const MCP_DOC_HINT =
	"MCP tools (context7 for library docs, perplexity for current info, firecrawl to scrape URLs)";
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
		/For the latest information, WebFetch the Models Overview URL in <code>shared\/live-sources\.md<\/code>\./g,
		`For the latest information, fetch the Models Overview URL in <code>shared/live-sources.md</code> via ${MCP_DOC_HINT_SHORT}.`,
	],
	[
		/For the latest information, WebFetch the Models Overview URL in \\`shared\/live-sources\.md\\`\./g,
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
	// The claude-api prompt builder uses indexOf("## When to Use WebFetch") to
	// extract and append the section. Update the search string to match our new heading.
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
	if (kept.length === 0) {
		kept.push("Bash");
	}

	return kept.map((tool) => `${quote}${tool}${quote}`).join(", ");
}

function extractTools(items: string, pattern: RegExp): string[] {
	const matches = Array.from(items.matchAll(pattern)) as RegExpMatchArray[];
	return matches
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
	let inAllowedToolsBlock = false;
	let allowedToolsIndent = 0;
	const forbiddenPattern = /^(Glob|Grep|WebFetch|WebSearch)\b/;

	for (const line of lines) {
		const blockStart = line.match(/^([ \t]*)allowed-tools:\s*$/);
		if (blockStart) {
			inAllowedToolsBlock = true;
			allowedToolsIndent = blockStart[1].length;
			continue;
		}
		if (!inAllowedToolsBlock) continue;

		const trimmed = line.trim();
		if (trimmed.length === 0) continue;

		const currentIndent = line.match(/^([ \t]*)/)?.[1].length ?? 0;
		if (currentIndent <= allowedToolsIndent) {
			inAllowedToolsBlock = false;
			continue;
		}

		const bulletMatch = trimmed.match(/^-\s*(.+)$/);
		if (!bulletMatch) continue;
		if (forbiddenPattern.test(bulletMatch[1])) {
			return true;
		}
	}
	return false;
}

function normalizeSkillDocText(code: string): string {
	let result = code;
	result = result.replace(FORBIDDEN_TOOL_ROW_PATTERN, "");
	result = result.replace(FORBIDDEN_TOOL_MARKDOWN_ROW_PATTERN, "");
	for (const [pattern, replacement] of SKILL_DOC_TEXT_REPLACEMENTS) {
		result = result.replace(pattern, replacement);
	}
	return result;
}

function createSkillAllowedToolsMutator(): traverse.Visitor {
	return {
		ObjectProperty(path: any) {
			if (
				getObjectKeyName(path.node.key) === "filePatternTools" &&
				t.isArrayExpression(path.node.value)
			) {
				const elements = path.node.value.elements;
				path.node.value.elements = elements.filter((el: any) => {
					if (t.isStringLiteral(el)) {
						return !FORBIDDEN_TOOLS.has(el.value);
					}
					return true;
				});
			}
		},
	};
}

export const skillAllowedTools: Patch = {
	tag: "skill-tools",

	string: (code) => {
		const hasSkillMarkers =
			code.includes("allowed-tools:") ||
			code.includes("allowedTools:") ||
			code.includes("allowed_tools") ||
			/\btools\b\s*[:=]\s*\[/.test(code) ||
			code.includes("**Common tool matchers:**") ||
			code.includes("When to Use WebFetch") ||
			code.includes("<h2>When to Use WebFetch</h2>") ||
			code.includes("<tr><td>Glob</td>") ||
			code.includes("<tr><td>Grep</td>");
		if (!hasSkillMarkers) {
			return code;
		}

		let result = code;
		const allowedToolsPattern =
			/(allowed-tools:[^"'\n]*)(, Glob| Glob,|, Grep| Grep,|, WebFetch| WebFetch,|, WebSearch| WebSearch,)/g;

		let prevResult = "";
		while (prevResult !== result) {
			prevResult = result;
			result = result.replace(allowedToolsPattern, "$1");
		}

		result = stripForbiddenAllowedToolsBullets(result);
		result = normalizePlainAllowedToolsArrays(result);
		result = normalizeEscapedAllowedToolsArrays(result);
		result = normalizeEscapedToolsArrays(result);
		result = normalizeSkillDocText(result);

		return result;
	},

	astPasses: () => [
		{
			pass: "mutate",
			visitor: createSkillAllowedToolsMutator(),
		},
	],

	verify: (code, ast) => {
		if (!ast) return "Missing AST for skill-tools verification";

		let filePatternToolsCount = 0;
		let hasForbiddenTool = false;
		traverse.default(ast, {
			ObjectProperty(path) {
				if (getObjectKeyName(path.node.key) !== "filePatternTools") return;
				if (!t.isArrayExpression(path.node.value)) return;

				filePatternToolsCount++;
				for (const el of path.node.value.elements) {
					if (!t.isStringLiteral(el)) continue;
					if (FORBIDDEN_TOOLS.has(el.value)) {
						hasForbiddenTool = true;
					}
				}
			},
		});
		if (filePatternToolsCount < 1) {
			return "No filePatternTools arrays found for skill-tools verification";
		}
		if (hasForbiddenTool) {
			return "Skill filePatternTools still includes Glob/Grep";
		}

		// Track how many string-based checks actually fire to prevent vacuous passes
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
		}
		if (code.includes("**Common tool matchers:**")) stringChecksExercised++;

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
		// claude-api skill: allowedTools should be ["Read", "Bash"] after stripping
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
			return `skill-tools verification exercised only ${stringChecksExercised} of 4 string check groups while skill markers are present`;
		}

		return true;
	},
};
