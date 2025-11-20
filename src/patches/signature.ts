import { PatchContext } from "../types.js";
import traverse from "@babel/traverse";
import * as t from "@babel/types";

function collectTags(rep: PatchContext['report']): string[] {
    const tags: string[] = [];
    if (rep.glob_prompt_standardized) tags.push("glob-prompt");
    if (rep.ripgrep_prompt_standardized) tags.push("ripgrep-prompt");
    if (rep.tool_policy_softened) tags.push("tool-policy");
    if (rep.context_usage_hint_added) tags.push("context-hud");
    if (rep.todo_examples_trimmed) tags.push("todo-use");
    if (rep.todo_skip_examples_trimmed) tags.push("todo-skip");
    if (rep.token_usage_snapshot_enabled) tags.push("token-cache");
    if (rep.read_tool_prompt_normalized) tags.push("read-prompt");
    if (rep.write_prompt_relaxed) tags.push("write-prompt");
    if (rep.write_guard_relaxed) tags.push("write-guard");
    if (rep.edit_prompt_relaxed) tags.push("edit-prompt");
    if (rep.edit_tool_extended) tags.push("edit-extended");
    if (rep.lines_cap_bumped) tags.push("lines-cap");
    if (rep.line_chars_bumped) tags.push("line-chars");
    if (rep.byte_ceiling_bumped) tags.push("byte-ceiling");
    if (rep.token_budget_bumped) tags.push("token-budget");
    return tags;
}

export function injectSignature(ast: any, ctx: PatchContext) {
    const tags = collectTags(ctx.report);
    if (tags.length === 0) return;
    
    const signature = `patched: ${tags.join(", ")}`;
    
    // @ts-ignore
    traverse.default(ast, {
        StringLiteral(path: any) {
            const val = path.node.value;
            if (val.includes("(Claude Code)") && !val.includes("patched:")) {
                path.node.value = val.replace("(Claude Code)", `(Claude Code; ${signature})`);
            }
            if (val === "v" && t.isCallExpression(path.parentPath.node)) {
                const args = path.parentPath.node.arguments;
                const idx = args.indexOf(path.node);
                if (idx !== -1 && idx + 1 < args.length) {
                    args.splice(idx + 2, 0, t.stringLiteral(` • ${signature}`));
                    path.stop(); // Assuming only one header
                }
            }
        }
    });
}