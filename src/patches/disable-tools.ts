import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch } from "../types.js";
import { isFalseLike, resolveStringValue } from "./ast-helpers.js";

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
 * 3. Updates recommendations to use ast-grep/rg instead
 */

const TARGET_TOOLS = new Set([
	"Grep",
	"Glob",
	"WebSearch",
	"WebFetch",
	"NotebookEdit",
]);

// String replacements for prompt cleanup
const STRING_REPLACEMENTS: Array<{ old: string; new: string }> = [
	{
		old: "searched inside the file with Grep in order to find the line numbers",
		new: "searched with rg or ast-grep to find the relevant lines",
	},
	{
		old: "Use Grep or Glob when you need to search broadly. Use Read when you know the specific file path.",
		new: "Use ast-grep for code structure, rg for text patterns, fd for file finding.",
	},
	{
		old: "You can use Read or Grep tools to search for specific information",
		new: "You can use rg to search for specific information",
	},
	{
		// Plan mode prompt
		old: "Use Read, Glob, and Grep tools to understand the codebase.",
		new: "Use Read, ast-grep, and rg to understand the codebase.",
	},
];

// Regex patterns for version-independent matching (minified var names change)
const REGEX_REPLACEMENTS: Array<{ pattern: RegExp; replacement: string }> = [
	{
		// claude-code-guide: "using ${Read}, ${Glob}, and ${Grep}" -> "using Read"
		pattern:
			/Reference local project files \(CLAUDE\.md, \.claude\/ directory\) when relevant using \$\{[^}]+\}, \$\{[^}]+\}, and \$\{[^}]+\}/g,
		replacement:
			"Reference local project files (CLAUDE.md, .claude/ directory) when relevant using Read",
	},
	{
		// Task tool: "use the ${Read} or ${Glob} tool instead" -> "use the ${Read} tool instead"
		pattern:
			/use the \$\{([^}]+)\} or \$\{[^}]+\} tool instead of the \$\{([^}]+)\} tool/g,
		replacement: "use the ${$1} tool instead of the ${$2} tool",
	},
	{
		// Task tool: Glob recommendation -> ast-grep
		pattern:
			/- If you are searching for a specific class definition like "class Foo", use the \$\{[^}]+\} tool instead, to find the match more quickly/g,
		replacement:
			'- If you are searching for code patterns like "class Foo", use ast-grep for faster access',
	},
];

const TRIGGER_PHRASES = [
	"searched inside the file with Grep",
	"Use Grep or Glob",
	"Read or Grep tools",
	"Reference local project files (CLAUDE.md",
	"Use Read, Glob, and Grep",
	'searching for a specific class definition like "class Foo"',
];

function disableIsEnabled(obj: t.ObjectExpression) {
	let patched = false;
	for (const prop of obj.properties) {
		if (
			t.isObjectMethod(prop) &&
			t.isIdentifier(prop.key, { name: "isEnabled" })
		) {
			prop.body = t.blockStatement([
				t.returnStatement(t.booleanLiteral(false)),
			]);
			patched = true;
		} else if (
			t.isObjectProperty(prop) &&
			t.isIdentifier(prop.key, { name: "isEnabled" })
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
	if (prop.params.length !== 0) return false;

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

		// Apply string replacements
		for (const replacement of STRING_REPLACEMENTS) {
			if (result.includes(replacement.old)) {
				result = result.split(replacement.old).join(replacement.new);
			}
		}

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

	ast: (ast) => {
		traverse.default(ast, {
			ObjectExpression(path: any) {
				const nameProp = path.node.properties.find(
					(p: any) =>
						t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "name" }),
				) as t.ObjectProperty | undefined;
				if (!nameProp) return;

				const toolName = resolveStringValue(path, nameProp.value as any);
				if (!toolName) return;

				if (TARGET_TOOLS.has(toolName)) {
					console.log(`Disabling tool: ${toolName}`);
					disableIsEnabled(path.node);
				}
			},
		});
	},

	verify: (code, ast) => {
		if (!ast) return "Missing AST for tools-off verification";

		const disabledTools = new Set<string>();
		traverse.default(ast, {
			ObjectExpression(path: any) {
				const nameProp = path.node.properties.find(
					(p: any) =>
						t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "name" }),
				) as t.ObjectProperty | undefined;
				if (!nameProp) return;

				const toolName = resolveStringValue(path, nameProp.value as any);
				if (!toolName || !TARGET_TOOLS.has(toolName)) return;

				const isEnabledProp = path.node.properties.find(
					(p: any) =>
						(t.isObjectProperty(p) || t.isObjectMethod(p)) &&
						t.isIdentifier(p.key, { name: "isEnabled" }),
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
		if (code.includes("Use Grep or Glob")) {
			return "Still contains 'Use Grep or Glob' reference";
		}
		if (code.includes("Use Read, Glob, and Grep")) {
			return "Still contains 'Use Read, Glob, and Grep' reference";
		}

		// Verify prompt cleanup — positive checks (our replacements must be present)
		if (!code.includes("ast-grep")) {
			return "Missing ast-grep reference in prompts";
		}
		if (!code.includes("rg or ast-grep to find the relevant lines")) {
			return "Missing 'rg or ast-grep' prompt replacement";
		}

		return true;
	},
};
