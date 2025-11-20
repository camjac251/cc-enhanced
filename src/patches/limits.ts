import { PatchContext } from "../types.js";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import { parse, print } from "../loader.js";

const NEW_LINES_CAP = 5000;
const NEW_LINE_CHARS = 5000;
const NEW_BYTE_CEILING = 1048576;
const NEW_TOKEN_BUDGET = 50000;

export function bumpLimits(ast: any, ctx: PatchContext) {
  // @ts-ignore
  traverse.default(ast, {
    VariableDeclarator(path: any) {
        const node = path.node;
        if (t.isLiteral(node.init)) {
            const val = (node.init as any).value;
            if (val === 262144) {
                node.init = t.numericLiteral(NEW_BYTE_CEILING);
                if (t.isIdentifier(node.id)) {
                    ctx.report.byte_ceiling_bumped = [node.id.name, String(NEW_BYTE_CEILING)];
                }
            } else if (val === 25000 || val === 2.5e4) {
                 node.init = t.numericLiteral(NEW_TOKEN_BUDGET);
                 if (t.isIdentifier(node.id)) {
                    ctx.report.token_budget_bumped = [node.id.name, String(NEW_TOKEN_BUDGET)];
                 }
            }
        }
    },
    
    TemplateLiteral(path: any) {
        const code = print(path.node);
        if (code.includes("Reads a file from the local filesystem.")) {
             const quasis = path.node.quasis;
             const exprs = path.node.expressions;
             
             for (let i = 0; i < quasis.length; i++) {
                 const q = quasis[i].value.raw;
                 if (q.includes("reads up to ")) {
                     if (i < exprs.length && t.isIdentifier(exprs[i])) {
                         const linesVarName = (exprs[i] as any).name;
                         updateVarValue(ast, linesVarName, NEW_LINES_CAP, ctx, "lines_cap_bumped");
                     }
                 }
                 if (q.includes("longer than ")) {
                     if (i < exprs.length && t.isIdentifier(exprs[i])) {
                         const charsVarName = (exprs[i] as any).name;
                         updateVarValue(ast, charsVarName, NEW_LINE_CHARS, ctx, "line_chars_bumped");
                     }
                 }
             }
        }
    }
  });
}

function updateVarValue(ast: any, varName: string, newValue: number, ctx: PatchContext, reportKey: keyof PatchContext['report']) {
    // @ts-ignore
    traverse.default(ast, {
        VariableDeclarator(path: any) {
            if (t.isIdentifier(path.node.id) && path.node.id.name === varName) {
                path.node.init = t.numericLiteral(newValue);
                (ctx.report as any)[reportKey] = [varName, String(newValue)];
                path.stop();
            }
        },
        AssignmentExpression(path: any) {
             if (t.isIdentifier(path.node.left) && path.node.left.name === varName) {
                 path.node.right = t.numericLiteral(newValue);
                 (ctx.report as any)[reportKey] = [varName, String(newValue)];
                 // Don't stop here, assignment might happen multiple times? usually init is once.
             }
        }
    });
}