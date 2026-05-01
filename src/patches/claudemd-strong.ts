import type { Patch } from "../types.js";
import {
	STRONG_CLAUDEMD_DISCLAIMER,
	STRONG_CLAUDEMD_DISCLAIMER_LINES,
} from "./prompt-policy.js";

/**
 * Fix the weak disclaimer in CLAUDE.md system-reminder wrapper.
 *
 * Problem: CLAUDE.md says "MUST follow" but wrapper says "may or may not be relevant"
 * Solution: Replace with strong disclaimer that reinforces the preamble.
 */

const WEAK_DISCLAIMER =
	"IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.";

export const STRONG_DISCLAIMER_LINES = STRONG_CLAUDEMD_DISCLAIMER_LINES;

export function hasStrongClaudeMdDisclaimer(code: string): boolean {
	return STRONG_CLAUDEMD_DISCLAIMER_LINES.every((line) => code.includes(line));
}

export const claudeMdSystemPrompt: Patch = {
	tag: "claudemd-strong",

	string: (code) => {
		if (!code.includes(WEAK_DISCLAIMER)) return code;
		return code.split(WEAK_DISCLAIMER).join(STRONG_CLAUDEMD_DISCLAIMER);
	},

	verify: (code) => {
		if (code.includes(WEAK_DISCLAIMER)) {
			return "Weak CLAUDE.md disclaimer still present (replacement failed)";
		}
		if (!hasStrongClaudeMdDisclaimer(code)) {
			return "Strong CLAUDE.md disclaimer lines are missing";
		}
		return true;
	},
};
