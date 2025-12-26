import type { PatchContext } from "../types.js";

/**
 * Fix the Task tool description that incorrectly recommends using Glob
 * for class definitions. This is a critical fix because:
 * 1. Glob tool is disabled
 * 2. ast-grep is far better for structural code searches
 *
 * Uses fast string replacement instead of AST traversal.
 */

const STRING_REPLACEMENTS: Array<{ old: string; new: string }> = [
	// Fix the "use Glob for class definitions" anti-pattern
	{
		old: 'searching for a specific class definition like "class Foo"',
		new: 'searching for code patterns like "class Foo", use ast-grep -p \'class Foo\' src/',
	},
	// Soften the "find match more quickly" language since tools are different now
	{
		old: "to find the match more quickly",
		new: "for faster access",
	},
];

const TRIGGER_PHRASES = [
	"searching for a specific class definition",
	"to find the match more quickly",
];

export function taskToolPromptString(code: string, ctx: PatchContext): string {
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
		ctx.report.task_tool_prompt_fixed = true;
	}

	return result;
}
