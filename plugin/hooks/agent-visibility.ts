import type { On } from "claude-code";

export function registerAgentVisibilityMods(on: On): void {
	for (const agent of ["statusline-setup", "claude-code-guide"] as const) {
		on("agent.offer", { agent }, (_$, e, next) =>
			e.source === "built-in" &&
			e.provider.plugin === "engine" &&
			e.provider.tier === "core"
				? { isOffered: false }
				: next(e),
		);
	}
}
