import type { On } from "claude-code";

export function registerAgentVisibilityMods(on: On): void {
	for (const agent of ["statusline-setup", "claude-code-guide"] as const) {
		// A resume offer carries the agent's id: keep the type out of the listing
		// while its existing agents can still resume.
		on("agent.offer", { agent }, (_$, e, next) =>
			e.agentId === undefined &&
			e.source === "built-in" &&
			e.provider.plugin === "engine" &&
			e.provider.tier === "core"
				? { isOffered: false }
				: next(e),
		);
	}
}
