import type { PatchContext } from "../types.js";

/**
 * Remove the "You can use the following tools without requiring user approval"
 * line from the system prompt.
 *
 * This is purely informational for the model - runtime permission checking
 * still works. Removing it saves tokens and reduces prompt clutter.
 */

const TRIGGER = "You can use the following tools without requiring user approval";

export function removeAllowedToolsPrompt(code: string, ctx: PatchContext): string {
	if (!code.includes(TRIGGER)) return code;

	// The function kY7(A) generates this text. Make it return empty string.
	// Pattern: return `\nYou can use the following tools...`
	// Replace with: return ""
	const pattern =
		/return\s*`\s*\nYou can use the following tools without requiring user approval[^`]*`\s*;/;

	const result = code.replace(pattern, 'return "";');

	if (result !== code) {
		ctx.report.allowed_tools_prompt_removed = true;
		console.log("Removed allowed tools prompt from system prompt");
	}

	return result;
}
