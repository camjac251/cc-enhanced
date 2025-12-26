import traverse from "@babel/traverse";
import { parse, print } from "../loader.js";
import type { PatchContext } from "../types.js";

const POLICY_PATTERNS = [
	/- When doing file search, prefer to use the \${[A-Za-z0-9_$]+} tool in order to reduce context usage\./,
	/- You should proactively use the \${[A-Za-z0-9_$]+} tool with specialized agents when the task at hand matches the agent's description\./,
	/- Use specialized tools instead of bash commands when possible[\s\S]*?Output all communication directly in your response text instead\./,
	/- VERY IMPORTANT: When exploring the codebase to gather context[\s\S]*?instead of running search commands directly\./,
	/Use specialized tools instead of bash commands when possible[\s\S]*?bash echo/,
];

const TRIGGER_PHRASES = [
	"When doing file search, prefer to use the",
	"should proactively use the",
	"Use specialized tools instead of bash commands",
	"VERY IMPORTANT: When exploring the codebase",
	"Thoroughly explore the codebase using Glob, Grep, and Read tools",
	"use the Read tool with the provided path to access full session memory",
	"Find existing patterns and conventions",
	// Additional Glob/Grep related triggers
	"Use Glob or Grep",
	"use Glob for",
	"use Grep for",
	"the Glob tool",
	"the Grep tool",
];

export function toolPolicy(ast: any, ctx: PatchContext) {
	traverse.default(ast, {
		TemplateLiteral(path: any) {
			// Optimization: Check if any quasi contains our target phrases before printing
			// This avoids expensive printing for thousands of unrelated template literals
			const hasTrigger = path.node.quasis.some((q: any) => {
				return TRIGGER_PHRASES.some((phrase) => q.value.raw.includes(phrase));
			});

			const hasExample = path.node.quasis.some((q: any) =>
				q.value.raw.includes("<example>"),
			);

			if (!hasTrigger && !hasExample) return;

			let code = print(path.node);
			let changed = false;

			// Replace references to using the Read tool for code exploration/memory access.
			if (
				code.includes(
					"Thoroughly explore the codebase using Glob, Grep, and Read tools",
				)
			) {
				code = code.replace(
					"Thoroughly explore the codebase using Glob, Grep, and Read tools",
					"Thoroughly explore the codebase using ast-grep for code search and bat for viewing; avoid Read except for PDFs/images.",
				);
				changed = true;
			}

			if (
				code.includes(
					"use the Read tool with the provided path to access full session memory",
				)
			) {
				code = code.replace(
					"use the Read tool with the provided path to access full session memory",
					"open the referenced path directly (use bat for code); reserve Read for PDFs/images",
				);
				changed = true;
			}

			// Patch Bash tool list in Plan/Explore mode
			if (
				code.includes(
					"(ls, git status, git log, git diff, find, cat, head, tail)",
				)
			) {
				code = code.replace(
					"(ls, git status, git log, git diff, find, cat, head, tail)",
					"(ls, git status, git log, git diff, fd, bat)",
				);
				changed = true;
			}

			for (const pattern of POLICY_PATTERNS) {
				if (pattern.test(code)) {
					code = code.replace(pattern, ""); // Replace with empty string or newline as appropriate. Original was \n.
					// Actually, the original code replaced with "\\n". Let's stick to that to be safe,
					// or just empty string if we want to remove it.
					// The goal is "softening", so removing the policy is what we want.
					// Wait, the original code said `code.replace(pattern, "\\n")`.
					// If we look at the context, these are bullet points. Replacing with \n maintains line structure.
					code = code.replace(pattern, "\\n");
					changed = true;
				}
			}

			const exampleRegex = /<example>\nuser: Where[\s\S]*?<\/example>\n?/g;
			if (exampleRegex.test(code)) {
				code = code.replace(exampleRegex, "");
				changed = true;
			}

			// Patch Explore/Plan agent prompt which uses variables like ${GD}, ${PY}, ${T5}
			const explorePattern =
				/Find existing patterns and conventions using \$\{[^}]+\}, \$\{[^}]+\}, and \$\{[^}]+\}/;
			if (explorePattern.test(code)) {
				code = code.replace(
					explorePattern,
					"Find existing patterns and conventions using ast-grep (code) and bat (viewing). Use fd for file finding. Avoid using the Read tool except for images/PDFs",
				);
				changed = true;
			}

			if (changed) {
				try {
					const wrapped = `(${code})`;
					const newAst = parse(wrapped);
					const newExpression = newAst.program.body[0].expression;
					path.replaceWith(newExpression);
					path.skip(); // Important: don't re-traverse the node we just added
					ctx.report.tool_policy_softened = true;
				} catch (e) {
					console.error("Failed to parse patched tool policy:", e);
				}
			}
		},
	});
}
