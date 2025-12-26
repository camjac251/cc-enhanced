import type { PatchContext } from "../types.js";

/**
 * Patch agent prompts to use ast-grep/rg instead of disabled Glob/Grep tools.
 *
 * Targets:
 * - Explore agent prompt: Replace Glob/Grep recommendations with ast-grep/rg
 * - Plan agent prompt: Same
 * - Main system prompt examples: Update to not reference Glob/Grep
 */

// Replacement patterns for Explore/Plan agent prompts
// NOTE: These are inside template literals, so we CAN'T use backticks in replacements!
const AGENT_REPLACEMENTS: Array<[RegExp, string]> = [
	// Explore agent guidelines - replace Glob with ast-grep
	[
		/- Use \$\{qV\} for broad file pattern matching/g,
		"- Use ast-grep (sg) for code pattern matching (functions, classes, imports)",
	],
	// Explore agent guidelines - replace Grep with rg
	[
		/- Use \$\{OX\} for searching file contents with regex/g,
		"- Use rg for text search in non-code files (configs, docs, logs)",
	],
	// Plan agent similar patterns
	[
		/Find existing patterns and conventions using \$\{qV\}, \$\{OX\}, and \$\{T3\}/g,
		"Find existing patterns and conventions using ast-grep, rg, and bat",
	],
	// Bash avoidance prompt - update tool recommendations
	[
		/- File search: Use \$\{qV\} \(NOT find or ls\)/g,
		"- Code search: Use ast-grep for code structure, fd for finding files",
	],
	[
		/- Content search: Use \$\{OX\} \(NOT grep or rg\)/g,
		"- Text search: Use rg for text content (rg IS the preferred tool)",
	],
];

// Main system prompt example - remove Glob/Grep references
const MAIN_PROMPT_REPLACEMENTS: Array<[RegExp, string]> = [
	// Example that says "instead of using ${qV} or ${OX} directly"
	[
		/instead of using \$\{qV\} or \$\{OX\} directly/g,
		"for comprehensive exploration",
	],
];

export function patchAgentPromptsString(
	code: string,
	ctx: PatchContext,
): string {
	let result = code;
	let changed = false;

	// Apply agent prompt replacements
	for (const [pattern, replacement] of AGENT_REPLACEMENTS) {
		const newResult = result.replace(pattern, replacement);
		if (newResult !== result) {
			changed = true;
			result = newResult;
		}
	}

	// Apply main prompt replacements
	for (const [pattern, replacement] of MAIN_PROMPT_REPLACEMENTS) {
		const newResult = result.replace(pattern, replacement);
		if (newResult !== result) {
			changed = true;
			result = newResult;
		}
	}

	if (changed) {
		ctx.report.agent_prompts_patched = true;
		console.log("Patched agent prompts to use ast-grep/rg instead of Glob/Grep");
	}

	return result;
}
