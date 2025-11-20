import { PatchContext } from "../types.js";
import traverse from "@babel/traverse";
import * as t from "@babel/types";

const SANITIZED_GLOB_PROMPT = 
`- Fast file pattern matching tool that works with any codebase size
- Supports glob patterns such as "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time.`;

export function globPrompt(ast: any, ctx: PatchContext) {
  // @ts-ignore
  traverse.default(ast, {
    TemplateLiteral(path: any) {
      const node = path.node;
      const quasis = node.quasis;
      const raw = quasis.map((q: any) => q.value.raw).join("");
      
      if (raw.includes("Fast file pattern matching tool") && raw !== SANITIZED_GLOB_PROMPT) {
        path.replaceWith(t.templateLiteral([
          t.templateElement({ raw: SANITIZED_GLOB_PROMPT, cooked: SANITIZED_GLOB_PROMPT }, true)
        ], []));
        ctx.report.glob_prompt_standardized = true;
      }
    }
  });
}
