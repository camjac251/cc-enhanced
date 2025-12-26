import * as fs from "node:fs/promises";
import generator from "@babel/generator";
import * as parser from "@babel/parser";

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
	return generator.default(ast, {
		retainLines: true,
		compact: false,
	}).code;
}
