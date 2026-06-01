import * as t from "@babel/types";
import { traverse } from "../babel.js";
import type { Patch } from "../types.js";
import { getObjectKeyName, getVerifyAst } from "./ast-helpers.js";
import {
	STRONG_CLAUDEMD_DISCLAIMER,
	STRONG_CLAUDEMD_DISCLAIMER_LINES,
} from "./prompt-policy.js";

/**
 * Fix the weak disclaimer in CLAUDE.md system-reminder wrapper.
 *
 * Problem: CLAUDE.md says "MUST follow" but wrapper says "may or may not be relevant"
 * Solution: Replace with strong disclaimer that reinforces the preamble.
 */

const WEAK_DISCLAIMER =
	"IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.";
const SLIM_SUBAGENT_CLAUDEMD_FLAG = "tengu_slim_subagent_claudemd";

function nodeContains(
	node: t.Node | null | undefined,
	predicate: (value: t.Node) => boolean,
): boolean {
	if (!node) return false;
	if (predicate(node)) return true;

	let found = false;
	traverse(
		node,
		{
			enter(path) {
				if (predicate(path.node)) {
					found = true;
					path.stop();
				}
			},
			noScope: true,
		},
		undefined,
		undefined,
	);
	return found;
}

function isOmitClaudeMdMember(node: t.Node): boolean {
	if (!t.isMemberExpression(node)) return false;
	return (
		getObjectKeyName(node.property as t.Expression | t.Identifier) ===
		"omitClaudeMd"
	);
}

function isSlimSubagentClaudeMdFlag(node: t.Node): boolean {
	return t.isStringLiteral(node) && node.value === SLIM_SUBAGENT_CLAUDEMD_FLAG;
}

function isSlimSubagentClaudeMdOmitGate(node: t.Node): boolean {
	return (
		t.isExpression(node) &&
		nodeContains(node, isOmitClaudeMdMember) &&
		nodeContains(node, isSlimSubagentClaudeMdFlag)
	);
}

function hasSlimSubagentClaudeMdOmitGate(ast: t.File | t.Program): boolean {
	const root = t.isFile(ast) ? ast : t.file(ast);
	let found = false;
	traverse(root, {
		VariableDeclarator(path) {
			if (!path.node.init) return;
			if (!isSlimSubagentClaudeMdOmitGate(path.node.init)) return;
			found = true;
			path.stop();
		},
	});
	return found;
}

export const STRONG_DISCLAIMER_LINES = STRONG_CLAUDEMD_DISCLAIMER_LINES;

export function hasStrongClaudeMdDisclaimer(code: string): boolean {
	return STRONG_CLAUDEMD_DISCLAIMER_LINES.every((line) => code.includes(line));
}

export const claudeMdSystemPrompt: Patch = {
	tag: "claudemd-strong",

	string: (code) => {
		if (!code.includes(WEAK_DISCLAIMER)) return code;
		return code.split(WEAK_DISCLAIMER).join(STRONG_CLAUDEMD_DISCLAIMER);
	},

	astPasses: () => [
		{
			pass: "mutate",
			visitor: {
				VariableDeclarator(path) {
					if (!path.node.init) return;
					if (!isSlimSubagentClaudeMdOmitGate(path.node.init)) return;
					path.node.init = t.booleanLiteral(false);
				},
			},
		},
	],

	verify: (code, ast) => {
		if (code.includes(WEAK_DISCLAIMER)) {
			return "Weak CLAUDE.md disclaimer still present (replacement failed)";
		}
		if (!hasStrongClaudeMdDisclaimer(code)) {
			return "Strong CLAUDE.md disclaimer lines are missing";
		}
		const verifyAst = getVerifyAst(code, ast);
		if (verifyAst && hasSlimSubagentClaudeMdOmitGate(verifyAst)) {
			return "Slim subagent CLAUDE.md omission gate is still present";
		}
		return true;
	},
};
