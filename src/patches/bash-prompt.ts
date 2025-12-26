import type { PatchContext } from "../types.js";

const TRIGGER_PHRASE =
	"Executes a given bash command in a persistent shell session";

const REPLACEMENT_TEXT = `  - Tool Preferences (See /etc/claude-code/CLAUDE.md for full policy):
    - View files: Use \`bat\` or \`bat -r\` (via Bash) instead of cat/head/tail.
    - Find files: Use \`fd\` (via Bash) instead of find.
    - Search text: Use \`rg\` (via Bash) instead of grep.
    - Code search: Use \`ast-grep\` (via Bash) for structural search.
    - List: Use \`eza\` instead of ls.
    - Edit: Use \`Edit\` tool (supports diffs/ranges) or \`sd -F\`.
    - Communication: Output text directly (NOT echo/printf).`;

export function bashPromptString(code: string, ctx: PatchContext): string {
	if (!code.includes(TRIGGER_PHRASE)) return code;

	const pattern =
		/\s*-\s*Avoid using Bash with[\s\S]*?Communication: Output text directly \(NOT echo\/printf\)/;

	if (pattern.test(code)) {
		ctx.report.bash_prompt_condensed = true;
		// The original logic wrapped it in `...` but the regex matches the content inside.
		// We need to ensure we don't break the template literal.
		// The REPLACEMENT_TEXT above does NOT start with newline in the variable, but the patch code added one.
		// Let's match the original formatting.
		// CRITICAL: We MUST escape backticks because we are inserting into a TemplateLiteral string!
		const safeReplacement = `\n${REPLACEMENT_TEXT}`.replace(/`/g, "\\`");
		return code.replace(pattern, safeReplacement);
	}
	return code;
}
