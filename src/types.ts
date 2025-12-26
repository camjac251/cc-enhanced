export interface LocationResult {
	start: number;
	end: number;
	identifiers?: string[];
}

export interface PatchReport {
	tool_policy_softened: boolean;
	context_usage_hint_added: boolean;
	todo_examples_trimmed: boolean;
	todo_skip_examples_trimmed: boolean;
	insights_softened: boolean;
	co_creation_prompt_softened: boolean;
	read_tool_prompt_normalized: boolean;
	write_prompt_relaxed: boolean;
	write_guard_relaxed: boolean;
	edit_prompt_relaxed: boolean;
	edit_tool_extended: boolean;
	edit_hook_injection_failed: boolean;
	bash_prompt_condensed: boolean;
	tools_disabled: boolean;
	file_read_restricted: boolean;
	write_result_trimmed: boolean;
	lines_cap_bumped: [string, string] | null;
	line_chars_bumped: [string, string] | null;
	byte_ceiling_bumped: [string, string] | null;
	token_budget_bumped: [string, string] | null;
	context_size_patched: boolean;
	// New Glob/Grep removal patches
	glob_grep_refs_removed: boolean;
	allowed_tools_prompt_removed: boolean;
	task_tool_prompt_fixed: boolean;
	skill_allowed_tools_fixed: boolean;
	file_pattern_tools_fixed: boolean;
	// Agent configuration patches
	agents_disabled: boolean;
	agents_filtered: boolean;
	claude_guide_blocklist: boolean;
	agent_prompts_patched: boolean;
	context_management_patched: boolean;
	locations: Record<string, LocationResult[]>;
	detected_variables: Record<string, string>;
}

export const initialReport: PatchReport = {
	tool_policy_softened: false,
	context_usage_hint_added: false,
	todo_examples_trimmed: false,
	todo_skip_examples_trimmed: false,
	insights_softened: false,
	co_creation_prompt_softened: false,
	read_tool_prompt_normalized: false,
	write_prompt_relaxed: false,
	write_guard_relaxed: false,
	edit_prompt_relaxed: false,
	edit_tool_extended: false,
	edit_hook_injection_failed: false,
	bash_prompt_condensed: false,
	tools_disabled: false,
	file_read_restricted: false,
	write_result_trimmed: false,
	lines_cap_bumped: null,
	line_chars_bumped: null,
	byte_ceiling_bumped: null,
	token_budget_bumped: null,
	context_size_patched: false,
	// New Glob/Grep removal patches
	glob_grep_refs_removed: false,
	allowed_tools_prompt_removed: false,
	task_tool_prompt_fixed: false,
	skill_allowed_tools_fixed: false,
	file_pattern_tools_fixed: false,
	// Agent configuration patches
	agents_disabled: false,
	agents_filtered: false,
	claude_guide_blocklist: false,
	agent_prompts_patched: false,
	context_management_patched: false,
	locations: {},
	detected_variables: {},
};

export interface PatchContext {
	report: PatchReport;
	filePath: string;
}

export type PatchRule = (
	ast: any,
	context: PatchContext,
) => Promise<void> | void;
export type StringPatchRule = (code: string, context: PatchContext) => string;
