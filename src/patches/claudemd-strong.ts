import type { Patch } from "../types.js";

/**
 * Fix the weak disclaimer in CLAUDE.md system-reminder wrapper.
 *
 * Problem: CLAUDE.md says "MUST follow" but wrapper says "may or may not be relevant"
 * Solution: Replace with strong disclaimer that reinforces the preamble.
 */

const WEAK_DISCLAIMER =
	"IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.";

const STRONG_DISCLAIMER = [
	"The instructions above are MANDATORY when they apply to your current task. Follow them exactly as written.",
	"Always use gh api for GitHub URLs, not web fetching tools.",
	"Always use bat to view files, not cat/head/tail.",
	"Always use sg for code search, rg only for text/logs/config. Prefer sg over rg.",
	"Never use cat/echo/printf for file writes - use Write or Edit tools.",
	"Use ast-grep for code pattern matching (functions, classes, imports)",
].join("\n");

export const claudeMdSystemPrompt: Patch = {
	tag: "claudemd-strong",

	string: (code) => {
		if (!code.includes(WEAK_DISCLAIMER)) return code;
		return code.split(WEAK_DISCLAIMER).join(STRONG_DISCLAIMER);
	},

	verify: (code) => {
		if (code.includes(WEAK_DISCLAIMER)) {
			return "Weak CLAUDE.md disclaimer still present (replacement failed)";
		}
		return true;
	},
};
