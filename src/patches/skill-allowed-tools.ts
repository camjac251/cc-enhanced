import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch } from "../types.js";

/**
 * Remove Glob and Grep from skill allowed-tools lists.
 */

// Coupling: prompt-rewrite.ts also strips Glob/Grep from prompt text (general
// prompts), while this patch targets skill-specific allowed-tools headers and
// filePatternTools arrays.

export const skillAllowedTools: Patch = {
	tag: "skill-tools",

	string: (code) => {
		if (!code.includes("allowed-tools:")) return code;

		let result = code;
		const allowedToolsPattern =
			/(allowed-tools:[^"'\n]*)(, Glob| Glob,|, Grep| Grep,)/g;

		let prevResult = "";
		while (prevResult !== result) {
			prevResult = result;
			result = result.replace(allowedToolsPattern, "$1");
		}

		return result;
	},

	ast: (ast) => {
		traverse.default(ast, {
			ObjectProperty(path: any) {
				if (
					t.isIdentifier(path.node.key) &&
					path.node.key.name === "filePatternTools" &&
					t.isArrayExpression(path.node.value)
				) {
					const elements = path.node.value.elements;
					path.node.value.elements = elements.filter((el: any) => {
						if (t.isStringLiteral(el)) {
							return el.value !== "Glob" && el.value !== "Grep";
						}
						return true;
					});
				}
			},
		});
	},

	verify: (code, ast) => {
		if (!ast) return "Missing AST for skill-tools verification";

		let filePatternToolsCount = 0;
		let hasForbiddenTool = false;
		traverse.default(ast, {
			ObjectProperty(path) {
				if (!t.isIdentifier(path.node.key, { name: "filePatternTools" }))
					return;
				if (!t.isArrayExpression(path.node.value)) return;

				filePatternToolsCount++;
				for (const el of path.node.value.elements) {
					if (!t.isStringLiteral(el)) continue;
					if (el.value === "Glob" || el.value === "Grep") {
						hasForbiddenTool = true;
					}
				}
			},
		});
		if (filePatternToolsCount < 1) {
			return "No filePatternTools arrays found for skill-tools verification";
		}
		if (hasForbiddenTool) {
			return "Skill filePatternTools still includes Glob/Grep";
		}

		if (/allowed-tools:[^\n]*(Glob|Grep)/.test(code)) {
			return "Skill allowed-tools header still includes Glob/Grep";
		}
		return true;
	},
};
