import type { On } from "claude-code";
import { STRONG_CLAUDEMD_DISCLAIMER } from "./policy.js";
import { rememberTranscriptMemory } from "./transcript.js";

const STOCK_CLAUDEMD_DISCLAIMER =
	"Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.";

/** Only the engine's leading wrapper changes; instruction file text stays exact. */
export function strengthenClaudeMdWrapper(text: string): string {
	const prefix = `${STOCK_CLAUDEMD_DISCLAIMER}\n\n`;
	return text.startsWith(prefix)
		? `${STRONG_CLAUDEMD_DISCLAIMER}\n\n${text.slice(prefix.length)}`
		: text;
}

export function registerClaudeMdMods(on: On): void {
	on("prompt.context", async ($, e, next) => {
		await rememberTranscriptMemory($, e);
		const result = await next(e);
		if (next.origin.plugin !== "engine" || next.origin.tier !== "core") {
			return result;
		}
		let changed = false;
		const blocks = result.blocks.map((block) => {
			if (block.name !== "claudeMd") return block;
			const text = strengthenClaudeMdWrapper(block.text);
			if (text === block.text) return block;
			changed = true;
			return { ...block, text };
		});
		return changed ? { ...result, blocks } : result;
	});
}
