// All patches export a Patch object with tag, string/ast, and verify

export { agentListingUi } from "./agent-listing-ui.js";
export { agentTools } from "./agents-off.js";
export { bashPrompt } from "./bash-prompt.js";
export { billingLabel } from "./billing-label.js";
export { builtInAgentPrompt } from "./built-in-agent-prompt.js";
export { cacheTailPolicy } from "./cache-tail-policy.js";
export { childNetworkEnv } from "./child-network-env.js";
export { claudeApiScope } from "./claude-api-scope.js";
export { claudeMdSystemPrompt } from "./claudemd-strong.js";
export { commandsOff } from "./commands-off.js";
export { configuredModelCatalog } from "./configured-model-catalog.js";
export { editTool } from "./edit-extended.js";
export { effortStack } from "./effort-stack.js";
export { featureFlags } from "./feature-flags.js";
export { fileLinkTargets } from "./file-link-targets.js";
export { imageLimits } from "./image-limits.js";
export { getLimitsChanged, limits } from "./limits.js";
export { lspFilenameSchema } from "./lsp-filename-schema.js";
export { lspMultiServer } from "./lsp-multi-server.js";
export { mcpServerName } from "./mcp-server-name.js";
export { memoryPromptSoften } from "./memory-prompt-soften.js";
export { modelAliases } from "./model-aliases.js";
export { modelContextMetadata } from "./model-context-metadata.js";
export { modelPickerSessionOnly } from "./model-picker-session-only.js";
export { disableAutoupdater } from "./no-autoupdate.js";
export { noCollapse } from "./no-collapse.js";
export { planCompactExecute } from "./plan-compact-execute.js";
export { planDiffUi } from "./plan-diff-ui.js";
export { promptDashStyle } from "./prompt-dash-style.js";
export { readWithBat } from "./read-bat.js";
export { sessionGuidance } from "./session-guidance.js";
export { sessionMemory } from "./session-mem.js";
export { signature } from "./signature.js";
export { skillActivationNotice } from "./skill-activation-notice.js";
export { skillGlobalPaths } from "./skill-global-paths.js";
export { skillListingUi } from "./skill-listing-ui.js";
export { skillPathsInvoke } from "./skill-paths-invoke.js";
export { subagentModelTag } from "./subagent-model-tag.js";
export { subagentSystemPrompt } from "./subagent-system-prompt.js";
export { systemPromptFile } from "./sys-prompt-file.js";
export { tabQueue } from "./tab-queue.js";
export { todo } from "./todo-use.js";
export { disableTools, disableToolsDesktop } from "./tools-off.js";
export { workflowSafety } from "./workflow-safety.js";

import type { Patch } from "../types.js";
// Re-export all patches as an array for easy iteration
import { agentListingUi } from "./agent-listing-ui.js";
import { agentTools } from "./agents-off.js";
import { bashPrompt } from "./bash-prompt.js";
import { billingLabel } from "./billing-label.js";
import { builtInAgentPrompt } from "./built-in-agent-prompt.js";
import { cacheTailPolicy } from "./cache-tail-policy.js";
import { childNetworkEnv } from "./child-network-env.js";
import { claudeApiScope } from "./claude-api-scope.js";
import { claudeMdSystemPrompt } from "./claudemd-strong.js";
import { commandsOff } from "./commands-off.js";
import { configuredModelCatalog } from "./configured-model-catalog.js";
import { editTool } from "./edit-extended.js";
import { effortStack } from "./effort-stack.js";
import { featureFlags } from "./feature-flags.js";
import { fileLinkTargets } from "./file-link-targets.js";
import { imageLimits } from "./image-limits.js";
import { limits } from "./limits.js";
import { lspFilenameSchema } from "./lsp-filename-schema.js";
import { lspMultiServer } from "./lsp-multi-server.js";
import { mcpServerName } from "./mcp-server-name.js";
import { memoryPromptSoften } from "./memory-prompt-soften.js";
import { modelAliases } from "./model-aliases.js";
import { modelContextMetadata } from "./model-context-metadata.js";
import { modelPickerSessionOnly } from "./model-picker-session-only.js";
import { disableAutoupdater } from "./no-autoupdate.js";
import { noCollapse } from "./no-collapse.js";
import { planCompactExecute } from "./plan-compact-execute.js";
import { planDiffUi } from "./plan-diff-ui.js";
import { promptDashStyle } from "./prompt-dash-style.js";
import { readWithBat } from "./read-bat.js";
import { sessionGuidance } from "./session-guidance.js";
import { sessionMemory } from "./session-mem.js";
import { signature } from "./signature.js";
import { skillActivationNotice } from "./skill-activation-notice.js";
import { skillGlobalPaths } from "./skill-global-paths.js";
import { skillListingUi } from "./skill-listing-ui.js";
import { skillPathsInvoke } from "./skill-paths-invoke.js";
import { subagentModelTag } from "./subagent-model-tag.js";
import { subagentSystemPrompt } from "./subagent-system-prompt.js";
import { systemPromptFile } from "./sys-prompt-file.js";
import { tabQueue } from "./tab-queue.js";
import { todo } from "./todo-use.js";
import { disableTools, disableToolsDesktop } from "./tools-off.js";
import { workflowSafety } from "./workflow-safety.js";

// Order matters: string patches run first, then AST, signature last.
export const registeredPatches: Patch[] = [
	// String-based patches (fast, run before AST parsing)
	bashPrompt,
	builtInAgentPrompt,
	claudeApiScope,
	claudeMdSystemPrompt,
	memoryPromptSoften,
	mcpServerName,
	sessionGuidance,
	todo,
	// AST-based patches
	cacheTailPolicy,
	childNetworkEnv,
	editTool,
	effortStack,
	featureFlags,
	fileLinkTargets,
	billingLabel,
	imageLimits,
	planDiffUi,
	planCompactExecute,
	disableTools,
	disableAutoupdater,
	readWithBat,
	agentTools,
	commandsOff,
	configuredModelCatalog,
	lspMultiServer,
	lspFilenameSchema,
	noCollapse,
	skillPathsInvoke,
	skillGlobalPaths,
	skillActivationNotice,
	skillListingUi,
	agentListingUi,
	subagentSystemPrompt,
	modelAliases,
	modelPickerSessionOnly,
	subagentModelTag,
	tabQueue,
	sessionMemory,
	modelContextMetadata,
	systemPromptFile,
	limits,
	promptDashStyle,
	workflowSafety,

	// Signature runs last
	signature,
];

export const profilePatchCatalog: Patch[] = registeredPatches.flatMap(
	(patch) =>
		patch.tag === disableTools.tag ? [patch, disableToolsDesktop] : [patch],
);

export const allPatches: Patch[] = [...registeredPatches];

// Safety: ensure no duplicate patch tags (would cause confusing overlaps)
for (const [label, catalog] of [
	["registered patch", registeredPatches],
	["profile patch", profilePatchCatalog],
] as const) {
	const seen = new Set<string>();
	for (const patch of catalog) {
		if (seen.has(patch.tag)) {
			throw new Error(`Duplicate ${label} tag detected: ${patch.tag}`);
		}
		seen.add(patch.tag);
	}
}
