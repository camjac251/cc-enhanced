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
const SKIP_HEADING = "## Examples of When NOT to Use the Todo List";
const NEXT_SECTION_HEADING = "## Task States and Management";
const EXPECTED_USE_FIRST_BULLET =
	"Reach for it when the user hands you multiple";
const EXPECTED_USE_SECOND_BULLET =
	"Keep items current as you work so the list reflects real progress.";
const EXPECTED_SKIP_FIRST_BULLET =
	"Skip it for quick, single-step tasks where tracking would add overhead.";
const EXPECTED_SKIP_SECOND_BULLET =
	"Clear stale entries so the list only mirrors the active work.";
const STALE_PROSE_SIGNALS = [
	"How do I print 'Hello World' in Python?",
	"What does the git status command do?",
	"Run npm install for me and tell me what happens",
];

export const todo: Patch = {
	tag: "todo-use",

	string: (code) => {
		if (!code.includes(TRIGGER)) return code;

		let result = code;

		const useRegex =
			/(## Examples of When to Use the Todo List\n)([\s\S]*?)(?=\n## Examples of When NOT to Use the Todo List)/;
		if (useRegex.test(result)) {
			result = result.replace(
				useRegex,
				TODO_USE_REPLACEMENT.replace(/\n$/, ""),
			);
		}

		// Anchor the lookahead on the next stable heading so quote chars inside
		// example dialogue can't terminate the captured block early.
		const skipRegex =
			/(## Examples of When NOT to Use the Todo List\n)([\s\S]*?)(?=\n## Task States and Management)/;
		if (skipRegex.test(result)) {
			result = result.replace(
				skipRegex,
				TODO_SKIP_REPLACEMENT.replace(/\n$/, ""),
			);
		}

		return result;
	},

	verify: (code) => {
		if (code.includes(TRIGGER)) {
			if (!code.includes(EXPECTED_USE_FIRST_BULLET)) {
				return "Missing condensed Todo use first bullet";
			}
			if (!code.includes(EXPECTED_USE_SECOND_BULLET)) {
				return "Missing condensed Todo use second bullet";
			}
			// Symmetric surviving-content guard for the USE section: the
			// condensed use bullets must live BETWEEN the use heading and the
			// skip heading, and no verbose <example> block may survive there.
			// Scanning the use slice (rather than the whole bundle) catches a
			// partial use-section rewrite without tripping on prose elsewhere.
			const useIndex = code.indexOf(TRIGGER);
			const skipAfterUseIndex = code.indexOf(SKIP_HEADING, useIndex);
			if (skipAfterUseIndex !== -1) {
				const useSectionBody = code.slice(useIndex, skipAfterUseIndex);
				if (!useSectionBody.includes(EXPECTED_USE_FIRST_BULLET)) {
					return "Condensed Todo use bullet not located inside the use section";
				}
				if (useSectionBody.includes("<example>")) {
					return "Stale <example> blocks survived in Todo use section";
				}
			}
		}
		if (code.includes(SKIP_HEADING)) {
			if (!code.includes(EXPECTED_SKIP_FIRST_BULLET)) {
				return "Missing condensed Todo NOT-to-use first bullet";
			}
			if (!code.includes(EXPECTED_SKIP_SECOND_BULLET)) {
				return "Missing condensed Todo NOT-to-use second bullet";
			}
			const skipIndex = code.indexOf(SKIP_HEADING);
			const nextHeadingIndex = code.indexOf(NEXT_SECTION_HEADING, skipIndex);
			if (nextHeadingIndex === -1) {
				return "Could not locate next section heading after NOT-to-use section";
			}
			// Scope the stale-prose and <example> scans to the skip-section
			// body slice. The signals (and any verbose example dialogue) the
			// patch removes only matter inside this section; scanning the whole
			// bundle would false-positive when the same phrasing appears in an
			// unrelated prompt surface.
			const sectionBody = code.slice(skipIndex, nextHeadingIndex);
			for (const stale of STALE_PROSE_SIGNALS) {
				if (sectionBody.includes(stale)) {
					return `Stale upstream prose survived in Todo NOT-to-use section: ${stale.slice(0, 40)}...`;
				}
			}
			if (sectionBody.includes("<example>")) {
				return "Stale <example> blocks survived in Todo NOT-to-use section";
			}
		}
		// The Task States heading co-locates with the example sections in the
		// Todo prompt. Its presence without either example heading means the
		// sections were reworded out from under the patch, so the heading-gated
		// checks above never ran.
		if (
			!code.includes(TRIGGER) &&
			!code.includes(SKIP_HEADING) &&
			code.includes(NEXT_SECTION_HEADING)
		) {
			return "Todo prompt present but example headings are missing (bundle drift)";
		}
		return true;
	},
};
