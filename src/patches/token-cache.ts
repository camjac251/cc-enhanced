import { PatchContext } from "../types.js";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import { parse } from "../loader.js";

export function tokenCache(ast: any, ctx: PatchContext) {
  let tokenDeclared = false;

  // @ts-ignore
  traverse.default(ast, {
    VariableDeclarator(path: any) {
      const node = path.node;
      if (t.isIdentifier(node.id) && node.id.name === "latestTokenSnapshot") {
        tokenDeclared = true;
        path.stop();
      }
    }
  });

  if (!tokenDeclared) {
    if (ast.program && Array.isArray(ast.program.body)) {
        const decl = t.variableDeclaration("var", [
            t.variableDeclarator(
                t.identifier("latestTokenSnapshot"),
                t.arrayExpression([t.numericLiteral(0), t.numericLiteral(0)])
            )
        ]);
        ast.program.body.unshift(decl);
        ctx.report.token_usage_snapshot_enabled = true;
    }
  }

  // @ts-ignore
  traverse.default(ast, {
    FunctionDeclaration(path: any) {
      const node = path.node;
      const name = node.id?.name;
      
      if (name === "SI") {
         const siBodyCode = [
         "{",
            "let B=A.length-1;while(B>=0){let Q=A[B],Z=Q?Id1(Q):void 0;if(Z){let G=Xd1(Z),Y=typeof G===\"bigint\"?Number(G):G,W=sQ1(),J=typeof W===\"bigint\"?Number(W):J;latestTokenSnapshot=[Y,J];return Y}B--}",
            "let K=latestTokenSnapshot[0];return typeof K===\"bigint\"?Number(K):K;",
         "}"
         ].join("\n");
         
         try {
             const newBody = parse("function x()" + siBodyCode).program.body[0].body;
             node.body = newBody;
             ctx.report.token_usage_snapshot_enabled = true;
         } catch (e) {
             console.error("Failed to parse SI body", e);
         }
      }
    },
    
    SwitchCase(path: any) {
        const node = path.node;
        if (t.isLiteral(node.test) && (node.test as any).value === "token_usage") {
            const code = [
            "let D=typeof A.used===\"bigint\"?Number(A.used):A.used;",
            "let E=typeof A.total===\"bigint\"?Number(A.total):A.total;",
            "latestTokenSnapshot=[D,E];",
            "return[uA({content:vm(`Token usage: ${D}/${E}; ${E-D} remaining`),isMeta:!0})];"
            ].join("\n");
            
            try {
                const wrapper = parse("function x(){" + code + "}");
                const newStmts = wrapper.program.body[0].body.body;
                node.consequent = newStmts;
                ctx.report.token_usage_snapshot_enabled = true;
            } catch(e) {
                 console.error("Failed to parse token_usage case", e);
            }
        }
    }
  });
}