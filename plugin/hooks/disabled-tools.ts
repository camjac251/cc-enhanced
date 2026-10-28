import type { On } from "claude-code";

export const DISABLED_TOOL_ROUTING =
	"Disabled by cc-enhanced. Use fd, rg, ast-grep, or bat through Bash; use mcp__cc-enhanced__view for text ranges.";

export function registerDisabledToolMods(on: On): void {
	const matcher = { tool: /^(?:Glob|Grep|WebSearch|WebFetch|NotebookEdit)$/ };
	on("tool.call", matcher, () => ({ deny: DISABLED_TOOL_ROUTING }));
	on("tool.check", matcher, () => ({
		decision: "deny",
		reason: DISABLED_TOOL_ROUTING,
	}));
	on("tool.describe", matcher, async (_$, e, next) => {
		const result = await next(e);
		return e.provider.plugin === "engine" && e.provider.tier === "core"
			? { ...result, description: DISABLED_TOOL_ROUTING, isDeferred: true }
			: result;
	});
}
