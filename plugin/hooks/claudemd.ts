import type { On, PromptContextBlock } from "claude-code";
import { STRONG_CLAUDEMD_DISCLAIMER } from "./policy.js";
import { rememberTranscriptMemory } from "./transcript.js";

/** This plugin's own context block, placed right after the instruction files. */
const CLAUDEMD_POLICY_BLOCK: PromptContextBlock = {
	name: "ccEnhancedInstructionPolicy",
	text: STRONG_CLAUDEMD_DISCLAIMER,
};

/**
 * Leaves the engine's `claudeMd` block and its instruction file list untouched,
 * so the engine keeps tracking which files it has sent, and adds the policy as
 * a separate block after it.
 */
export function registerClaudeMdMods(on: On): void {
	on("prompt.context", async ($, e, next) => {
		await rememberTranscriptMemory($, e);
		const result = await next(e);
		if (next.origin.plugin !== "engine" || next.origin.tier !== "core") {
			return result;
		}
		const index = result.blocks.findIndex(
			(block) => block.name === "claudeMd" && block.text !== "",
		);
		if (
			index < 0 ||
			result.blocks.some((block) => block.name === CLAUDEMD_POLICY_BLOCK.name)
		) {
			return result;
		}
		const blocks = [...result.blocks];
		blocks.splice(index + 1, 0, CLAUDEMD_POLICY_BLOCK);
		return { ...result, blocks };
	});
}
