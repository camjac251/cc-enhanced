export interface LocationResult {
  start: number;
  end: number;
  identifiers?: string[];
}

export interface PatchReport {
  glob_prompt_standardized: boolean;
  ripgrep_prompt_standardized: boolean;
  tool_policy_softened: boolean;
  context_usage_hint_added: boolean;
  todo_examples_trimmed: boolean;
  todo_skip_examples_trimmed: boolean;
  insights_softened: boolean;
  co_creation_prompt_softened: boolean;
  token_usage_snapshot_enabled: boolean;
  read_tool_prompt_normalized: boolean;
  write_prompt_relaxed: boolean;
  write_guard_relaxed: boolean;
  edit_prompt_relaxed: boolean;
  edit_tool_extended: boolean;
  edit_hook_injection_failed: boolean;
  lines_cap_bumped: [string, string] | null;
  line_chars_bumped: [string, string] | null;
  byte_ceiling_bumped: [string, string] | null;
  token_budget_bumped: [string, string] | null;
  locations: Record<string, LocationResult[]>;
  detected_variables: Record<string, string>;
}

export const initialReport: PatchReport = {
  glob_prompt_standardized: false,
  ripgrep_prompt_standardized: false,
  tool_policy_softened: false,
  context_usage_hint_added: false,
  todo_examples_trimmed: false,
  todo_skip_examples_trimmed: false,
  insights_softened: false,
  co_creation_prompt_softened: false,
  token_usage_snapshot_enabled: false,
  read_tool_prompt_normalized: false,
  write_prompt_relaxed: false,
  write_guard_relaxed: false,
  edit_prompt_relaxed: false,
  edit_tool_extended: false,
  edit_hook_injection_failed: false,
  lines_cap_bumped: null,
  line_chars_bumped: null,
  byte_ceiling_bumped: null,
  token_budget_bumped: null,
  locations: {},
  detected_variables: {},
};

import { File } from "@babel/types";

export interface PatchContext {
  report: PatchReport;
  filePath: string;
}

export type PatchRule = (ast: any, context: PatchContext) => Promise<void> | void;
