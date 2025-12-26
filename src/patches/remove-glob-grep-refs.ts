import type { PatchContext } from "../types.js";

/**
 * Remove all remaining Glob/Grep tool references from prompts and error messages.
 * These tools are disabled, so references to them are confusing/misleading.
 *
 * Uses fast string replacement instead of AST traversal.
 */

const STRING_REPLACEMENTS: Array<{ old: string; new: string }> = [
	// Read tool error messages (lines 238588, 238613)
	{
		old: "use the GrepTool to search for specific content",
		new: "use rg via Bash to search, or bat -r to view specific line ranges",
	},
	// Clipped response guidance (line 304216)
	{
		old: "searched inside the file with Grep in order to find the line numbers",
		new: "searched with rg or ast-grep to find the relevant lines",
	},
	// Explore agent guidelines (line 364621)
	{
		old: "Use Grep or Glob when you need to search broadly. Use Read when you know the specific file path.",
		new: "Use ast-grep for code structure, rg for text patterns, fd for file finding. Use bat to view files.",
	},
	// Bash output summary (line 439199)
	{
		old: "You can use Read or Grep tools to search for specific information",
		new: "You can use rg or bat via Bash to search for specific information",
	},
];

const TRIGGER_PHRASES = [
	"use the GrepTool",
	"searched inside the file with Grep",
	"Use Grep or Glob",
	"Read or Grep tools",
];

export function removeGlobGrepRefsString(
	code: string,
	ctx: PatchContext,
): string {
	// Quick check if any trigger phrases exist
	const hasTrigger = TRIGGER_PHRASES.some((phrase) => code.includes(phrase));
	if (!hasTrigger) return code;

	let result = code;
	let changed = false;

	for (const replacement of STRING_REPLACEMENTS) {
		if (result.includes(replacement.old)) {
			result = result.split(replacement.old).join(replacement.new);
			changed = true;
		}
	}

	if (changed) {
		ctx.report.glob_grep_refs_removed = true;
	}

	return result;
}
