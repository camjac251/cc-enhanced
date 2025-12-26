import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { PatchContext } from "../types.js";

/**
 * Remove Glob and Grep from skill allowed-tools lists.
 * These tools are disabled, so they shouldn't be listed as allowed.
 *
 * Uses string replacement for allowed-tools lists in template literals,
 * and AST for the filePatternTools array.
 */

// String-based replacement for allowed-tools in skill definitions
export function skillAllowedToolsString(
	code: string,
	ctx: PatchContext,
): string {
	if (!code.includes("allowed-tools:")) return code;

	let result = code;
	let changed = false;

	// Remove Glob and Grep from allowed-tools lists ONLY
	// Match the specific pattern: "allowed-tools: ..., Glob, Grep, ..." or similar
	// Be careful not to affect other occurrences like "using Glob, Grep, and Read tools"
	const allowedToolsPattern = /(allowed-tools:[^"'\n]*)(, Glob| Glob,|, Grep| Grep,)/g;

	// Keep replacing until no more matches (handles multiple Glob/Grep in same line)
	let prevResult = "";
	while (prevResult !== result) {
		prevResult = result;
		result = result.replace(allowedToolsPattern, "$1");
	}

	if (result !== code) {
		changed = true;
		ctx.report.skill_allowed_tools_fixed = true;
	}

	return result;
}

// AST-based removal of Glob from filePatternTools array
export function skillAllowedTools(ast: any, ctx: PatchContext) {
	traverse.default(ast, {
		// Handle the filePatternTools array (line 268626)
		// filePatternTools: ["Read", "Write", "Edit", "Glob", "NotebookRead", "NotebookEdit"]
		ObjectProperty(path: any) {
			if (
				t.isIdentifier(path.node.key) &&
				path.node.key.name === "filePatternTools" &&
				t.isArrayExpression(path.node.value)
			) {
				const elements = path.node.value.elements;
				const originalLength = elements.length;

				// Filter out "Glob" and "Grep"
				path.node.value.elements = elements.filter((el: any) => {
					if (t.isStringLiteral(el)) {
						return el.value !== "Glob" && el.value !== "Grep";
					}
					return true;
				});

				if (path.node.value.elements.length < originalLength) {
					ctx.report.file_pattern_tools_fixed = true;
				}
			}
		},
	});
}
