import type { Patch } from "../types.js";

/**
 * Condense verbose Todo tool usage examples to shorter guidance.
 * Converted to string patch - simpler and preserves template expressions.
 */

const TODO_USE_REPLACEMENT = `## Examples of When to Use the Todo List
- Reach for it when the user hands you multiple related tasks or explicitly asks for tracking.
- Keep items current as you work so the list reflects real progress.
`;

const TODO_SKIP_REPLACEMENT = `## Examples of When NOT to Use the Todo List
- Skip it for quick, single-step tasks where tracking would add overhead.
- Clear stale entries so the list only mirrors the active work.
`;

const TRIGGER = "## Examples of When to Use the Todo List";
const EXPECTED_USE_LINE = "Reach for it when the user hands you multiple";
const EXPECTED_SKIP_LINE =
	"Skip it for quick, single-step tasks where tracking would add overhead.";

export const todo: Patch = {
	tag: "todo-use",

	string: (code) => {
		if (!code.includes(TRIGGER)) return code;

		let result = code;

		// Replace the "When to Use" section
		const useRegex =
			/(## Examples of When to Use the Todo List\n)([\s\S]*?)(?=\n## Examples of When NOT to Use the Todo List)/;
		if (useRegex.test(result)) {
			result = result.replace(
				useRegex,
				TODO_USE_REPLACEMENT.replace(/\n$/, ""),
			);
		}

		// Replace the "When NOT to Use" section.
		// Lookahead: next heading OR end of the string literal (quote/backtick).
		const skipRegex =
			/(## Examples of When NOT to Use the Todo List\n)([\s\S]*?)(?=\n## |["'`]|$)/;
		if (skipRegex.test(result)) {
			result = result.replace(
				skipRegex,
				TODO_SKIP_REPLACEMENT.replace(/\n$/, ""),
			);
		}

		return result;
	},

	verify: (code) => {
		if (code.includes(TRIGGER) && !code.includes(EXPECTED_USE_LINE)) {
			return "Missing condensed Todo examples";
		}
		if (
			code.includes("## Examples of When NOT to Use the Todo List") &&
			!code.includes(EXPECTED_SKIP_LINE)
		) {
			return "Missing condensed Todo NOT-to-use examples";
		}
		// If Todo tool exists but neither section was found/checked, flag as drift
		if (
			!code.includes(TRIGGER) &&
			(code.includes('"TodoWrite"') || code.includes('"Todo"'))
		) {
			// Tool exists but the expected prompt section is missing.
			return "Todo tool found but expected prompt section missing (bundle drift)";
		}
		return true;
	},
};
