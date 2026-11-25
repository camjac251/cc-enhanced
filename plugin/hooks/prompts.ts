import type { On } from "claude-code";
import { CODE_MODE_GUIDANCE } from "./policy.js";
import {
	transformPromptAttachment,
	transformPromptSection,
	transformToolDescription,
} from "./prompt-transforms.js";

const CODE_MODE_SECTION = "cc-enhanced:code-mode";

export function registerPromptMods(on: On): void {
	// Code Mode moves tool calls into scripts, where tool descriptions may not
	// carry this plugin's routing; a session section does, only when offered.
	on("prompt.compose", async (_$, e, next) => {
		const result = await next(e);
		if (
			!e.tools.includes("REPL") ||
			result.sections.some(({ id }) => id === CODE_MODE_SECTION)
		) {
			return result;
		}
		return {
			...result,
			sections: [
				...result.sections,
				{ id: CODE_MODE_SECTION, text: CODE_MODE_GUIDANCE, scope: "session" },
			],
		};
	});

	on("prompt.attachment", { type: "auto_mode" }, async (_$, e, next) => {
		const result = await next(e);
		if (e.origin.kind !== "engine" || result.text === null) return result;
		const text = transformPromptAttachment(e.type, result.text);
		return text === result.text ? result : { ...result, text };
	});

	on("prompt.section", { name: "session_guidance" }, async (_$, e, next) => {
		const result = await next(e);
		if (result.text === null) return result;
		const text = transformPromptSection(e.name, result.text);
		return text === result.text ? result : { ...result, text };
	});

	for (const tool of ["TodoWrite", "Bash", "Agent"] as const) {
		on("tool.describe", { tool }, async (_$, e, next) => {
			const result = await next(e);
			if (e.provider.plugin !== "engine" || e.provider.tier !== "core") {
				return result;
			}
			const description = transformToolDescription(e.tool, result.description);
			return description === result.description
				? result
				: { ...result, description };
		});
	}
}
