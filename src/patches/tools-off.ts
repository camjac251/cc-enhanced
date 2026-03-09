import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch } from "../types.js";
import {
	getObjectKeyName,
	hasObjectKeyName,
	isFalseLike,
	resolveStringValue,
} from "./ast-helpers.js";

// Coupling: prompt-rewrite.ts also rewrites Glob/Grep prompt references in
// different sections (agent bullets, plan mode, /debug). Same concern, disjoint targets.
// Coupling: agent-tools.ts blocks NotebookEdit from claude-code-guide agent;
// this patch disables NotebookEdit globally via isEnabled.

/**
 * Disable tools and clean up all prompt references to them.
 *
 * This patch:
 * 1. Disables Glob, Grep, WebSearch, WebFetch, NotebookEdit tools
 * 2. Removes/replaces all prompt references to disabled tools
 * 3. Replaces stale disabled-tool guidance with neutral wording
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
			/- If you are searching for a specific class definition like "class Foo", use the \$\{[^}]+\} tool instead, to find the match more quickly/g,
		replacement:
			'- If you are searching for code patterns like "class Foo", use available code-search tooling for faster access',
	},
	{
		// Agent tool prompt: Glob "class Foo" with "${X} instead" (2.1.71+)
		pattern:
			/- If you are searching for a specific class definition like "class Foo", use \$\{[^}]+\} instead, to find the match more quickly/g,
		replacement:
			'- If you are searching for code patterns like "class Foo", use available code-search tooling for faster access',
	},
];

const TRIGGER_PHRASES = [
	"Use Grep or Glob",
	"GrepTool",
	"direct Glob, Grep, or Read",
	"Reference local project files (CLAUDE.md",
	'searching for a specific class definition like "class Foo"',
];

const FORBIDDEN_PROMPT_FRAGMENTS = [
	/Use Grep or Glob when you need to search broadly/i,
	/use the GrepTool to search for specific content/i,
	/direct Glob, Grep, or Read tool calls/i,
];

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
		const hasTrigger = TRIGGER_PHRASES.some((phrase) => code.includes(phrase));
		if (!hasTrigger) return code;

		let result = code;

		// Apply regex replacements (version-independent)
		for (const { pattern, replacement } of REGEX_REPLACEMENTS) {
			result = result.replace(pattern, replacement);
		}

		// Also update general phrasing
		result = result
			.split("to find the match more quickly")
			.join("for faster access");

		return result;
	},

	astPasses: () => [
		{
			pass: "mutate",
			visitor: createDisableToolsMutator(),
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

		// Positive checks: neutral replacements must be present IF their source
		// text existed. When upstream already removed the source, the replacement
		// is never injected and the check is skipped.
		if (
			code.includes("Use Grep or Glob") &&
			!code.includes(
				"Use available search tooling broadly, and use Read when you know the specific file path.",
			)
		) {
			return "Missing neutral Grep/Glob replacement guidance";
		}
		if (!code.includes("use available code-search tooling for faster access")) {
			return "Missing neutral class-definition replacement";
		}

		return true;
	},
};

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
