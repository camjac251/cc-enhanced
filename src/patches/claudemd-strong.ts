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
	"Never use grep/find/ls/sed - use rg/fd/eza/sd instead.",
].join("\n");

export const STRONG_DISCLAIMER_INVARIANTS = [
	{
		id: "mandatory-follow",
		pattern:
			/The instructions above[^.\n]*MANDATORY[^.\n]*apply[^.\n]*current task[\s\S]{0,120}?Follow them exactly as written\./i,
	},
	{
		id: "gh-api",
		pattern: /Always use gh api for GitHub URLs[^.\n]*\./i,
	},
	{
		id: "bat-view",
		pattern: /Always use bat to view files[^.\n]*\./i,
	},
	{
		id: "sg-over-rg",
		pattern:
			/Always use sg for code search[^.\n]*rg only for text\/logs\/config[^.\n]*\./i,
	},
	{
		id: "write-tools",
		pattern: /Never use cat\/echo\/printf for file writes[^.\n]*\./i,
	},
	{
		id: "legacy-tools",
		pattern: /Never use grep\/find\/ls\/sed[^.\n]*rg\/fd\/eza\/sd[^.\n]*\./i,
	},
] as const;

export function hasStrongClaudeMdDisclaimer(code: string): boolean {
	return STRONG_DISCLAIMER_INVARIANTS.every(({ pattern }) =>
		pattern.test(code),
	);
}

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
		if (!hasStrongClaudeMdDisclaimer(code)) {
			return "Strong CLAUDE.md disclaimer invariants are missing";
		}
		return true;
	},
};
