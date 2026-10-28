import type { On } from "claude-code";

export const CLAUDE_API_TRIGGER =
	"TRIGGER: building, debugging, or migrating an application that directly uses the Claude API or Anthropic SDK, including that application's API requests, streaming, tool use, caching, model IDs, and API pricing or limits.";
export const CLAUDE_API_SKIP =
	"SKIP: Claude Code or CLI usage and configuration, transcripts, hooks, skills, MCP setup, model routing, and general LLM questions. A mention of Claude, Anthropic, or a model name alone is not a trigger. Skip applications using another provider.";

/** Match only the bundled entry's adjacent stock trigger/skip lines. */
export function narrowClaudeApiSkillListing(text: string): string {
	return text.replace(
		/(^|\n)(- claude-api: Reference for the Claude API \/ Anthropic SDK[^\r\n]*)(\r?\n)TRIGGER — read BEFORE opening the target file;[^\r\n]*\r?\nSKIP only when another provider is being worked on \(overrides all triggers\):[^\r\n]*/g,
		(_match, boundary: string, heading: string, newline: string) =>
			`${boundary}${heading}${newline}${CLAUDE_API_TRIGGER}${newline}${CLAUDE_API_SKIP}`,
	);
}

export function registerSkillScopeMods(on: On): void {
	on("prompt.attachment", { type: "skill_listing" }, async (_$, e, next) => {
		const result = await next(e);
		if (e.origin.kind !== "engine" || result.text === null) return result;
		const text = narrowClaudeApiSkillListing(result.text);
		return text === result.text ? result : { ...result, text };
	});
}
