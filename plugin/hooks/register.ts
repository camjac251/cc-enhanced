import type { On } from "claude-code";
import { registerAgentRoutingMods } from "./agent-routing.js";
import { registerAgentVisibilityMods } from "./agent-visibility.js";
import { registerBatchEditMods, registerBatchEditTool } from "./batch-edit.js";
import { registerClaudeMdMods } from "./claudemd.js";
import { registerDisabledToolMods } from "./disabled-tools.js";
import { registerPromptMods } from "./prompts.js";
import { registerSkillScopeMods } from "./skill-scope.js";
import { registerSubagentPolicyMods } from "./subagent-policy.js";
import { registerTranscriptMods } from "./transcript.js";
import { registerViewMods, registerViewTool } from "./view.js";

export function register(on: On): void {
	on("session.start", async ($, e, next) => {
		const result = await next(e);
		await registerBatchEditTool($);
		await registerViewTool($);
		$.ui.invalidate("tool.describe");
		// Invalidation is fire-and-forget; finish a host round trip before resume.
		await $.clock.now();
		return result;
	});

	registerPromptMods(on);
	registerBatchEditMods(on);
	registerViewMods(on);
	registerSkillScopeMods(on);
	registerClaudeMdMods(on);
	registerAgentVisibilityMods(on);
	registerAgentRoutingMods(on);
	registerDisabledToolMods(on);
	registerTranscriptMods(on);
	registerSubagentPolicyMods(on);
}
