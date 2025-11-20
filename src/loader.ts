import * as fs from "fs/promises";
import * as parser from "@babel/parser";
import generator from "@babel/generator";

export async function loadFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf-8");
}

export function parse(code: string): any {
  return parser.parse(code, {
    sourceType: "module",
    plugins: [], // Pure JS for performance
    tokens: false, // Don't need tokens for simple regeneration
  });
}

export function print(ast: any): string {
  // @ts-ignore
  return generator.default(ast, {
    retainLines: true,
    compact: false,
  }).code;
}
