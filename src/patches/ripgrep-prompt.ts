import { PatchContext } from "../types.js";
import traverse from "@babel/traverse";
import * as t from "@babel/types";

const SANITIZED_RIPGREP_BODY = 
`A powerful search tool built on ripgrep.

  Usage:
  - Accepts standard ripgrep pattern syntax (regex or plain text).
  - Filter files with the "glob" parameter (e.g., "*.js") or the "type" parameter (e.g., "js", "py").
  - Output modes: "content" (matching lines), "files_with_matches" (file paths), and "count" (match totals).
  - Multiline matching is disabled by default; enable it with multiline: true when needed.
`;

export function ripgrepPrompt(ast: any, ctx: PatchContext) {
  // @ts-ignore
  traverse.default(ast, {
    TemplateLiteral(path: any) {
      const node = path.node;
      const quasis = node.quasis;
      const raw = quasis.map((q: any) => q.value.raw).join("");
      
      if (raw.includes("A powerful search tool built on ripgrep") && !raw.includes("- Multiline matching is disabled by default")) {
        path.replaceWith(t.templateLiteral([
          t.templateElement({ raw: SANITIZED_RIPGREP_BODY, cooked: SANITIZED_RIPGREP_BODY }, true)
        ], []));
        ctx.report.ripgrep_prompt_standardized = true;
      }
    }
  });
}