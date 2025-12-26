import * as fs from "node:fs";
import * as path from "node:path";
import type { PatchContext } from "../types.js";

const EXTENDED_INTERFACE = `export interface FileEditInput {
  /**
   * The absolute path to the file to modify
   */
  file_path: string;
  /**
   * The text to replace (optional for inserts/diffs)
   */
  old_string?: string;
  /**
   * The text to replace it with (optional for diffs)
   */
  new_string?: string;
  /**
   * Replace all occurences of old_string (default false)
   */
  replace_all?: boolean;
  /**
   * Line insert: 1-based line number for the insertion point
   */
  line_number?: number | string;
  /**
   * Line insert position: before (default) or after
   */
  line_position?: "before" | "after";
  /**
   * Range replace: start line (1-based)
   */
  start_line?: number | string;
  /**
   * Range replace: end line (inclusive; defaults to start_line)
   */
  end_line?: number | string;
  /**
   * Unified Diff: apply a patch using standard unified diff format (@@ ... @@)
   */
  diff?: string;
  /**
   * Apply multiple edits in a single tool invocation.
   */
  edits?: Array<{
      old_string?: string;
      new_string?: string;
      replace_all?: boolean;
      line_number?: number | string;
      line_position?: "before" | "after";
      start_line?: number | string;
      end_line?: number | string;
      diff?: string;
  }>;
}`;

export function patchDefinitions(_ast: any, ctx: PatchContext) {
	// This patch operates on the file system directly as it targets a .d.ts file
	// which is not the AST passed to this function (cli.js).
	// We assume ctx.filePath points to cli.js, so we find sdk-tools.d.ts relative to it.

	const packageDir = path.dirname(ctx.filePath);
	const dtsPath = path.join(packageDir, "sdk-tools.d.ts");

	if (fs.existsSync(dtsPath)) {
		try {
			const content = fs.readFileSync(dtsPath, "utf-8");

			// Regex to match the original FileEditInput interface
			// It starts with export interface FileEditInput { and ends with }
			// We need to be careful to match the full block.

			const regex = /export interface FileEditInput \{[\s\S]*?\n\}/;

			if (regex.test(content)) {
				const newContent = content.replace(regex, EXTENDED_INTERFACE);
				if (newContent !== content) {
					fs.writeFileSync(dtsPath, newContent, "utf-8");
					// We don't have a specific report key for this, reusing edit_tool_extended?
					// Or just log it?
				}
			}
		} catch (e) {
			console.error("Failed to patch sdk-tools.d.ts", e);
		}
	}
}
