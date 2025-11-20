import { PatchContext } from "../types.js";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import { print, parse } from "../loader.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function editTool(ast: any, ctx: PatchContext) {
    let toolVarName: string | null = null;
    let schemaObject: any = null;
    
    // @ts-ignore
    traverse.default(ast, {
        StringLiteral(path: any) {
             if (path.node.value === "A tool for editing files") {
                 // Found description.
                 let p = path.parentPath;
                 while (p) {
                     if (t.isVariableDeclarator(p.node)) {
                         if (t.isIdentifier(p.node.id)) {
                             toolVarName = p.node.id.name;
                         }
                         break;
                     }
                     if (t.isAssignmentExpression(p.node)) {
                          if (t.isIdentifier(p.node.left)) {
                              toolVarName = p.node.left.name;
                          }
                          break;
                     }
                     p = p.parentPath;
                 }
             }
        },
        ObjectProperty(path: any) {
             if (t.isIdentifier(path.node.key) && path.node.key.name === "replace_all") {
                 // Verify this looks like a schema definition (CallExpression) and not a literal value
                 if (t.isCallExpression(path.node.value) || t.isMemberExpression(path.node.value)) {
                     schemaObject = path.parentPath.node;
                 }
             }
        }
    });

    if (toolVarName) {
        const templatePath = path.join(__dirname, "../templates/edit_hook.js");
        
        if (fs.existsSync(templatePath)) {
            let hookCode = fs.readFileSync(templatePath, "utf-8");
            if (toolVarName) {
                hookCode = hookCode.replace(/__CLAUDE_EDIT_TOOL__/g, toolVarName);
            }
            
            try {
                 const hookAst = parse(hookCode);
                 if (ast.program && ast.program.body) {
                    ast.program.body.push(...hookAst.program.body);
                 }
            } catch (e) {
                 ctx.report.edit_hook_injection_failed = true;
                 console.error("Failed to parse/inject edit hook", e);
            }
        } else {
            console.error("Template not found:", templatePath);
            ctx.report.edit_hook_injection_failed = true;
        }
    } else {
         ctx.report.edit_hook_injection_failed = true;
    }

    if (schemaObject && t.isObjectExpression(schemaObject)) {
        const schemaExtensionCode = `
        ({
            line_number: _.number().int().min(1).optional().describe("Optional 1-based line number to anchor inserts."),
            line_position: _.enum(["before", "after"]).default("before").optional().describe("Insert relative to the target line (before by default)."),
            start_line: _.number().int().min(1).optional().describe("Starting line number (inclusive) for range replacements."),
            end_line: _.number().int().min(1).optional().describe("Optional ending line number (inclusive) for range replacements."),
            edits: _.array(_.strictObject({
                old_string: _.string().describe("The text to replace").optional(),
                new_string: _.string().describe("The text to insert or replace the region with"),
                replace_all: _.boolean().default(false).optional().describe("Replace all occurrences when old_string is provided"),
                line_number: _.number().int().min(1).optional(),
                line_position: _.enum(["before", "after"]).default("before").optional(),
                start_line: _.number().int().min(1).optional(),
                end_line: _.number().int().min(1).optional()
            })).min(1).optional().describe("Apply multiple edits in a single tool invocation.")
        })
        `;
        
        try {
             const replaceAllProp = schemaObject.properties.find((p: any) => t.isIdentifier(p.key) && p.key.name === "replace_all");
             if (replaceAllProp) {
                 let zodVar = "_";
                 let curr = (replaceAllProp as any).value;
                 // Walk up the chain to find the root object (zod instance)
                 while(curr) {
                     if (t.isCallExpression(curr)) {
                         curr = curr.callee;
                     } else if (t.isMemberExpression(curr)) {
                         curr = curr.object;
                     } else if (t.isIdentifier(curr)) {
                         zodVar = curr.name;
                         break;
                     } else {
                         break;
                     }
                 }
                 
                 const adaptedCode = schemaExtensionCode.replace(/_/g, zodVar);
                 const extAst = parse(adaptedCode).program.body[0].expression;
                 
                 schemaObject.properties.push(...extAst.properties);
                 
                 const oldStringProp = schemaObject.properties.find((p: any) => t.isIdentifier(p.key) && p.key.name === "old_string");
                 if (oldStringProp) {
                      const code = print((oldStringProp as any).value);
                      if (!code.includes("optional()")) {
                           const newVal = parse(`(${code}).optional()`).program.body[0].expression;
                           (oldStringProp as any).value = newVal;
                      }
                 }
                 
                 const newStringProp = schemaObject.properties.find((p: any) => t.isIdentifier(p.key) && p.key.name === "new_string");
                 if (newStringProp) {
                      const code = print((newStringProp as any).value);
                      if (!code.includes("optional()")) {
                           const newVal = parse(`(${code}).optional()`).program.body[0].expression;
                           (newStringProp as any).value = newVal;
                      }
                 }
                 
                 ctx.report.edit_tool_extended = true;
             }
        } catch (e) {
             console.error("Failed to extend edit schema", e);
        }
    }
}