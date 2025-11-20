import { PatchContext } from "../types.js";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import { print, parse } from "../loader.js";

const WRITE_REPLACEMENT = "- For existing files, review the current contents before overwriting to avoid accidental loss.";
const EDIT_REPLACEMENT = "- Preview the relevant content before editing so replacements stay precise. ";

export function readWritePrompts(ast: any, ctx: PatchContext) {
  // @ts-ignore
  traverse.default(ast, {
    TemplateLiteral(path: any) {
        let code = print(path.node);
        let changed = false;

        const imagePromptLine = "- This tool allows Claude Code to read images (eg PNG, JPG, etc). When reading an image file the contents are presented visually as Claude Code is a multimodal LLM.";
        if (code.includes(imagePromptLine)) {
            code = code.replace(imagePromptLine, "");
            ctx.report.read_tool_prompt_normalized = true;
            changed = true;
        }

        const writeVariants = [
            "- If this is an existing file, you MUST use the ${x8} tool first to read the file's contents. This tool will fail if you did not read the file first.",
            "- If this is an existing file, you MUST use the ${G7} tool first to read the file's contents. This tool will fail if you did not read the file first."
        ];
        const writeRegex = /- If this is an existing file, you MUST use the \${[A-Za-z0-9_\$]+} tool first to read the file's contents\. This tool will fail if you did not read the file first\./;

        for (const v of writeVariants) {
            if (code.includes(v)) {
                code = code.replace(v, WRITE_REPLACEMENT);
                ctx.report.write_prompt_relaxed = true;
                changed = true;
            }
        }
        if (writeRegex.test(code)) {
             code = code.replace(writeRegex, WRITE_REPLACEMENT);
             ctx.report.write_prompt_relaxed = true;
             changed = true;
        }

        const editVariants = [
            "- You must use your `${x8}` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file. ",
            "- You must use your `${G7}` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file. ",
             "- You must use your `${x8}` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file. ".replace(/`/g, "\\`"),
        ];
         const editRegex = /- You must use your \?`?\${[A-Za-z0-9_\$]+}\?`? tool at least once in the conversation before editing\. This tool will error if you attempt an edit without reading the file\. ?/;

         for (const v of editVariants) {
            if (code.includes(v)) {
                code = code.replace(v, EDIT_REPLACEMENT);
                ctx.report.edit_prompt_relaxed = true;
                changed = true;
            }
         }
         if (editRegex.test(code)) {
             code = code.replace(editRegex, EDIT_REPLACEMENT);
             ctx.report.edit_prompt_relaxed = true;
             changed = true;
         }

        if (changed) {
             try {
                 const newExpr = parse("(" + code + ")").program.body[0].expression;
                 path.replaceWith(newExpr);
             } catch(e) {
                 console.error("Failed to parse patched read/write prompt", e);
             }
        }
    },

    IfStatement(path: any) {
        const node = path.node;
        const code = print(node);
        
        if (code.includes("File has not been read yet. Read it first before writing to it.")) {
            path.remove(); 
            ctx.report.write_guard_relaxed = true;
            return;
        }
        
        if (code.includes("File has been modified since read, either by the user or by a linter.")) {
            path.remove();
            ctx.report.write_guard_relaxed = true;
            return;
        }
        
        if (code.includes("File has been unexpectedly modified. Read it again before attempting to write it.")) {
             node.consequent = t.blockStatement([]);
             ctx.report.write_guard_relaxed = true;
             return;
        }
    }
  });
}