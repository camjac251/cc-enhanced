// All patches export a Patch object with tag, string/ast, and verify

export { agentTools } from "./agent-tools.js";
export { bashOutputTail } from "./bash-output-tail.js";
export { bashPrompt } from "./bash-prompt.js";
export { cacheTailPolicy } from "./cache-tail-policy.js";
export { claudeMdSystemPrompt } from "./claudemd-system-prompt.js";

export { disableAutoupdater } from "./disable-autoupdater.js";
export { disableTools } from "./disable-tools.js";
export { editTool } from "./edit-tool.js";
export { featureFlags } from "./feature-flags.js";
export { getLimitsChanged, limits } from "./limits.js";
export { mcpServerName } from "./mcp-server-name.js";
export { mcpTimeout } from "./mcp-timeout.js";
export { memoryWriteUi } from "./memory-write-ui.js";
export { noCollapse } from "./no-collapse.js";
export { outputTokens } from "./output-tokens.js";
export { promptRewrite } from "./prompt-rewrite.js";
export { readWithBat } from "./read-with-bat.js";
export { sessionMemory } from "./session-memory.js";
export { shrinkWriteResult } from "./shrink-write-result.js";
export { signature } from "./signature.js";
export { skillAllowedTools } from "./skill-allowed-tools.js";
export { systemPromptFile } from "./system-prompt-file.js";
export { taskOutputTool } from "./task-output-tool.js";
export { todo } from "./todo.js";

import type { Patch } from "../types.js";
// Re-export all patches as an array for easy iteration
import { agentTools } from "./agent-tools.js";
import { bashOutputTail } from "./bash-output-tail.js";
import { bashPrompt } from "./bash-prompt.js";
import { cacheTailPolicy } from "./cache-tail-policy.js";
import { claudeMdSystemPrompt } from "./claudemd-system-prompt.js";

import { disableAutoupdater } from "./disable-autoupdater.js";
import { disableTools } from "./disable-tools.js";
import { editTool } from "./edit-tool.js";
import { featureFlags } from "./feature-flags.js";
import { limits } from "./limits.js";
import { mcpServerName } from "./mcp-server-name.js";
import { mcpTimeout } from "./mcp-timeout.js";
import { memoryWriteUi } from "./memory-write-ui.js";
import { noCollapse } from "./no-collapse.js";
import { outputTokens } from "./output-tokens.js";
import { promptRewrite } from "./prompt-rewrite.js";
import { readWithBat } from "./read-with-bat.js";
import { sessionMemory } from "./session-memory.js";
import { shrinkWriteResult } from "./shrink-write-result.js";
import { signature } from "./signature.js";
import { skillAllowedTools } from "./skill-allowed-tools.js";
import { systemPromptFile } from "./system-prompt-file.js";
import { taskOutputTool } from "./task-output-tool.js";
import { todo } from "./todo.js";

function parsePatchTagList(value: string | undefined): Set<string> | null {
	if (!value) return null;
	const tags = value
		.split(",")
		.map((tag) => tag.trim())
		.filter(Boolean);
	return tags.length > 0 ? new Set(tags) : null;
}

// Order matters: string patches run first, then AST, signature last.
const basePatches: Patch[] = [
	// String-based patches (fast, run before AST parsing)

	bashPrompt,
	bashOutputTail,
	promptRewrite,
	taskOutputTool,
	claudeMdSystemPrompt,
	mcpServerName,
	skillAllowedTools,
	todo,
	// AST-based patches
	cacheTailPolicy,
	editTool,
	outputTokens,
	disableTools,
	disableAutoupdater,
	readWithBat,
	shrinkWriteResult,
	memoryWriteUi,
	mcpTimeout,
	agentTools,
	noCollapse,
	sessionMemory,
	systemPromptFile,
	featureFlags,
	limits,

	// Signature runs last
	signature,
];

const includeTags = parsePatchTagList(process.env.CLAUDE_PATCHER_INCLUDE_TAGS);
const excludeTags = parsePatchTagList(process.env.CLAUDE_PATCHER_EXCLUDE_TAGS);

export const allPatches: Patch[] = basePatches.filter((patch) => {
	if (includeTags && !includeTags.has(patch.tag)) return false;
	if (excludeTags?.has(patch.tag)) return false;
	return true;
});

// Safety: ensure no duplicate patch tags (would cause confusing overlaps)
{
	const seen = new Set<string>();
	for (const patch of allPatches) {
		if (seen.has(patch.tag)) {
			throw new Error(`Duplicate patch tag detected: ${patch.tag}`);
		}
		seen.add(patch.tag);
	}
}
