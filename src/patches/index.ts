// All patches export a Patch object with tag, string/ast, and verify

export { agentTools } from "./agents-off.js";
export { bashPrompt } from "./bash-prompt.js";
export { bashOutputTail } from "./bash-tail.js";
export { builtInAgentPrompt } from "./built-in-agent-prompt.js";
export { cacheTailPolicy } from "./cache-tail-policy.js";
export { claudeMdSystemPrompt } from "./claudemd-strong.js";
export { editTool } from "./edit-extended.js";
export { effortMax } from "./effort-max.js";
export { featureFlags } from "./flag-bypass.js";
export { getLimitsChanged, limits } from "./limits.js";
export { mcpServerName } from "./mcp-server-name.js";
export { memoryWriteUi } from "./memory-write-ui.js";

export { disableAutoupdater } from "./no-autoupdate.js";
export { noCollapse } from "./no-collapse.js";
export { planDiffUi } from "./plan-diff-ui.js";
export { promptRewrite } from "./prompt-rewrite.js";
export { readWithBat } from "./read-bat.js";
export { sessionMemory } from "./session-mem.js";
export { signature } from "./signature.js";
export { skillAllowedTools } from "./skill-tools.js";
export { subagentModelTag } from "./subagent-model-tag.js";
export { systemPromptFile } from "./sys-prompt-file.js";
export { taskOutputTool } from "./taskout-ext.js";
export { todo } from "./todo-use.js";
export { disableTools } from "./tools-off.js";
export { shrinkWriteResult } from "./write-result-trim.js";

import type { Patch } from "../types.js";
// Re-export all patches as an array for easy iteration
import { agentTools } from "./agents-off.js";
import { bashPrompt } from "./bash-prompt.js";
import { bashOutputTail } from "./bash-tail.js";
import { builtInAgentPrompt } from "./built-in-agent-prompt.js";
import { cacheTailPolicy } from "./cache-tail-policy.js";
import { claudeMdSystemPrompt } from "./claudemd-strong.js";
import { editTool } from "./edit-extended.js";
import { effortMax } from "./effort-max.js";
import { featureFlags } from "./flag-bypass.js";
import { limits } from "./limits.js";
import { mcpServerName } from "./mcp-server-name.js";
import { memoryWriteUi } from "./memory-write-ui.js";

import { disableAutoupdater } from "./no-autoupdate.js";
import { noCollapse } from "./no-collapse.js";
import { planDiffUi } from "./plan-diff-ui.js";
import { promptRewrite } from "./prompt-rewrite.js";
import { readWithBat } from "./read-bat.js";
import { sessionMemory } from "./session-mem.js";
import { signature } from "./signature.js";
import { skillAllowedTools } from "./skill-tools.js";
import { subagentModelTag } from "./subagent-model-tag.js";
import { systemPromptFile } from "./sys-prompt-file.js";
import { taskOutputTool } from "./taskout-ext.js";
import { todo } from "./todo-use.js";
import { disableTools } from "./tools-off.js";
import { shrinkWriteResult } from "./write-result-trim.js";

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
	builtInAgentPrompt,
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
	effortMax,
	planDiffUi,
	disableTools,
	disableAutoupdater,
	readWithBat,
	shrinkWriteResult,
	memoryWriteUi,
	agentTools,
	noCollapse,
	subagentModelTag,
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
