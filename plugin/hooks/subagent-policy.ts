import type { EngineInterface, On } from "claude-code";

/**
 * Set by the cc-enhanced shell wrapper, only on an interactive launch where it
 * is appending a system prompt file and the caller supplied no subagent append
 * of its own. The append-subagent flag reaches subagents only in print mode, so
 * the wrapper hands the file to this hook instead. Without the marker (no
 * wrapper, CC_ENHANCED_DISABLE=1, print mode, or an explicit caller append)
 * this hook adds nothing.
 */

type PolicyApi = {
	env: Pick<EngineInterface["env"], "get">;
	fs: Pick<EngineInterface["fs"], "read">;
};

/** The wrapper's prompt text for a starting subagent, or undefined. */
export async function subagentPolicy(
	$: PolicyApi,
	agentType: string,
): Promise<string | undefined> {
	// Forks reuse their parent's prompt instead of starting a fresh system prompt.
	if (agentType === "fork") return undefined;
	if ((await $.env.get("CC_ENHANCED_DISABLE")) === "1") return undefined;
	const file = await $.env.get("CC_ENHANCED_SUBAGENT_PROMPT_FILE");
	if (!file) return undefined;
	let text: string;
	try {
		text = await $.fs.read(file);
	} catch {
		return undefined;
	}
	return text.trim().length > 0 ? text : undefined;
}

export function registerSubagentPolicyMods(on: On): void {
	on("classic.SubagentStart", async ($, e, next) => {
		const result = await next(e);
		const text = await subagentPolicy($, e.agent_type);
		if (text === undefined) return result;
		return {
			...result,
			additionalContext: [...(result.additionalContext ?? []), text],
		};
	});
}
