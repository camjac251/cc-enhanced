import { PatchContext } from "../types.js";
import traverse from "@babel/traverse";
import { parse, print } from "../loader.js";

const POLICY_PATTERNS = [
  /- When doing file search, prefer to use the \${[A-Za-z0-9_\$]+} tool in order to reduce context usage\./,
  /- You should proactively use the \${[A-Za-z0-9_\$]+} tool with specialized agents when the task at hand matches the agent's description\./,
  /- Use specialized tools instead of bash commands when possible[\s\S]*?Output all communication directly in your response text instead\./,
  /- VERY IMPORTANT: When exploring the codebase to gather context[\s\S]*?instead of running search commands directly\./,
];

export function toolPolicy(ast: any, ctx: PatchContext) {
  // @ts-ignore
  traverse.default(ast, {
    TemplateLiteral(path: any) {
      let code = print(path.node);
      let changed = false;

      for (const pattern of POLICY_PATTERNS) {
        // We need to match the *source string* inside the template literal (unescaped).
        // But `code` is the printed code, which might be `\`-escaped.
        // Simple replace might not work if regex matches across lines or tokens.
        
        // Let's try to match on the printed code.
        if (pattern.test(code)) {
            code = code.replace(pattern, "\\n");
            changed = true;
        }
      }

      const exampleRegex = /<example>\nuser: Where[\s\S]*?<\/example>\n?/g;
      if (exampleRegex.test(code)) {
        code = code.replace(exampleRegex, "");
        changed = true;
      }

      if (changed) {
        try {
            const wrapped = `(${code})`;
            const newAst = parse(wrapped);
            const newExpression = newAst.program.body[0].expression;
            path.replaceWith(newExpression);
            ctx.report.tool_policy_softened = true;
        } catch (e) {
            console.error("Failed to parse patched tool policy:", e);
        }
      }
    }
  });
}
