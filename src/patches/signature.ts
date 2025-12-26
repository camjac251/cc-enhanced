import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { PatchContext } from "../types.js";

function collectTags(rep: PatchContext["report"]): string[] {
	const tags: string[] = [];
	if (rep.bash_prompt_condensed) tags.push("bash-prompt");
	if (rep.tool_policy_softened) tags.push("tool-policy");
	if (rep.context_usage_hint_added) tags.push("context-hud");
	if (rep.todo_examples_trimmed) tags.push("todo-use");
	if (rep.todo_skip_examples_trimmed) tags.push("todo-skip");
	if (rep.read_tool_prompt_normalized) tags.push("read-prompt");
	if (rep.write_prompt_relaxed) tags.push("write-prompt");
	if (rep.write_guard_relaxed) tags.push("write-guard");
	if (rep.edit_prompt_relaxed) tags.push("edit-prompt");
	if (rep.edit_tool_extended) tags.push("edit-extended");
	if (rep.tools_disabled) tags.push("tools-off");
	if (rep.file_read_restricted) tags.push("read-media-only");
	if (rep.write_result_trimmed) tags.push("write-result-trim");
	if (rep.lines_cap_bumped) tags.push("lines-cap");
	if (rep.line_chars_bumped) tags.push("line-chars");
	if (rep.byte_ceiling_bumped) tags.push("byte-ceiling");
	if (rep.token_budget_bumped) tags.push("token-budget");
	if (rep.agents_disabled || rep.agents_filtered) tags.push("agents-off");
	if (rep.claude_guide_blocklist) tags.push("guide-blocklist");
	if (rep.context_management_patched) tags.push("ctx-mgmt");
	return tags;
}

export function injectSignature(ast: any, ctx: PatchContext) {
	const tags = collectTags(ctx.report);
	if (tags.length === 0) return;

	const signature = `patched: ${tags.join(", ")}`;

	traverse.default(ast, {
		StringLiteral(path: any) {
			const val = path.node.value;
			if (val.includes("(Claude Code)") && !val.includes("patched:")) {
				path.node.value = val.replace(
					"(Claude Code)",
					`(Claude Code; ${signature})`,
				);
			}
			if (val === "Claude Code v") {
				path.node.value = "Claude Code (patched) v";
			}
			if (val === "v" && t.isCallExpression(path.parentPath.node)) {
				const args = path.parentPath.node.arguments;
				const idx = args.indexOf(path.node);
				if (idx !== -1 && idx + 1 < args.length) {
					args.splice(idx + 2, 0, t.stringLiteral(` • ${signature}`));
				}
			}
		},
		TemplateLiteral(path: any) {
			for (const quasi of path.node.quasis) {
				if (
					quasi.value.raw.includes("(Claude Code)") &&
					!quasi.value.raw.includes("patched:")
				) {
					const newSignature = `(Claude Code; ${signature})`;
					quasi.value.raw = quasi.value.raw.replace(
						"(Claude Code)",
						newSignature,
					);
					if (quasi.value.cooked) {
						quasi.value.cooked = quasi.value.cooked.replace(
							"(Claude Code)",
							newSignature,
						);
					}
				}
			}

			if (
				path.node.quasis.length > 0 &&
				path.node.quasis[0].value.raw === "Claude Code v"
			) {
				const lastQuasi = path.node.quasis[path.node.quasis.length - 1];
				if (!lastQuasi.value.raw.includes("patched:")) {
					const suffix = ` • ${signature}`;
					lastQuasi.value.raw += suffix;
					if (lastQuasi.value.cooked) {
						lastQuasi.value.cooked += suffix;
					}
				}
			}

			// Fix for banner where "Claude Code" and version are separate expressions
			// Example: ` ${sQ("claude", S)("Claude Code")} ${sQ("inactive", S)(`v${$}`)} `
			const exprs = path.node.expressions;
			if (exprs.length >= 2) {
				let claudeCodeIndex = -1;
				let versionIndex = -1;

				for (let i = 0; i < exprs.length; i++) {
					const expr = exprs[i];
					// Check for "Claude Code" call: func(...)("Claude Code")
					if (
						t.isCallExpression(expr) &&
						expr.arguments.length > 0 &&
						t.isStringLiteral(expr.arguments[0]) &&
						expr.arguments[0].value === "Claude Code"
					) {
						claudeCodeIndex = i;
						continue;
					}

					// Check for version call: func(...)(`v${...}`)
					if (
						t.isCallExpression(expr) &&
						expr.arguments.length > 0 &&
						t.isTemplateLiteral(expr.arguments[0])
					) {
						const tpl = expr.arguments[0];
						if (tpl.quasis.length > 0 && tpl.quasis[0].value.raw === "v") {
							versionIndex = i;
						}
					}
				}

				if (
					claudeCodeIndex !== -1 &&
					versionIndex !== -1 &&
					versionIndex > claudeCodeIndex
				) {
					const versionTpl = exprs[versionIndex].arguments[0];
					const lastQuasi = versionTpl.quasis[versionTpl.quasis.length - 1];
					if (!lastQuasi.value.raw.includes("patched:")) {
						const suffix = ` • ${signature}`;
						lastQuasi.value.raw += suffix;
						if (lastQuasi.value.cooked) lastQuasi.value.cooked += suffix;
					}
				}
			}
		},
	});
}
