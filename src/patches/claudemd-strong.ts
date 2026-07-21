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

function isNegatedUserContextMember(node: t.Node): boolean {
	if (!t.isUnaryExpression(node) || node.operator !== "!") return false;
	const arg = node.argument;
	if (!t.isOptionalMemberExpression(arg) && !t.isMemberExpression(arg)) {
		return false;
	}
	return (
		getObjectKeyName(arg.property as t.Expression | t.Identifier) ===
		"userContext"
	);
}

// The omission gate is an expression combining an omitClaudeMd member access
// with a negated userContext member access. Matching on VariableDeclarator
// inits only keeps object-literal properties named omitClaudeMd from being
// treated as gates.
function isSubagentClaudeMdOmitGate(node: t.Node): boolean {
	return (
		t.isExpression(node) &&
		nodeContains(node, isOmitClaudeMdMember) &&
		nodeContains(node, isNegatedUserContextMember)
	);
}

function countSubagentClaudeMdOmitGates(ast: t.File | t.Program): number {
	const root = t.isFile(ast) ? ast : t.file(ast);
	let count = 0;
	traverse(root, {
		VariableDeclarator(path) {
			if (!path.node.init) return;
			if (!isSubagentClaudeMdOmitGate(path.node.init)) return;
			count++;
		},
		noScope: true,
	});
	return count;
}

let gatesNeutralized = 0;

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

	astPasses: () => {
		gatesNeutralized = 0;
		return [
			{
				pass: "mutate",
				visitor: {
					VariableDeclarator(path) {
						if (!path.node.init) return;
						if (!isSubagentClaudeMdOmitGate(path.node.init)) return;
						path.node.init = t.booleanLiteral(false);
						gatesNeutralized++;
					},
				},
			},
		];
	},

	verify: (code, ast) => {
		if (code.includes(WEAK_DISCLAIMER)) {
			return "Weak CLAUDE.md disclaimer still present (replacement failed)";
		}
		if (!hasStrongClaudeMdDisclaimer(code)) {
			return "Strong CLAUDE.md disclaimer lines are missing";
		}
		const verifyAst = getVerifyAst(code, ast);
		if (verifyAst) {
			// Count every surviving gate rather than stopping at the first, so a
			// partial rewrite (one of several gates left live) is reported
			// precisely. The mutator neutralizes all matches, so any surviving
			// gate is a defect.
			const survivingGates = countSubagentClaudeMdOmitGates(verifyAst);
			if (survivingGates > 0) {
				return `Subagent CLAUDE.md omission gate is still present (${survivingGates} surviving)`;
			}
			// A run that neutralizes nothing means the gate moved or the matcher
			// went stale; either way the omission behavior would ship live.
			if (gatesNeutralized === 0) {
				return "No subagent CLAUDE.md omission gate was found to neutralize";
			}
		}
		return true;
	},
};
