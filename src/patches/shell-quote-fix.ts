import * as t from "@babel/types";
import { traverse, type Visitor } from "../babel.js";
import type { Patch } from "../types.js";
import { getVerifyAst } from "./ast-helpers.js";

/**
 * Fixes the bundled shell-quote library's unconditional `!` escaping.
 *
 * shell-quote escapes `!` to `\!` in two code paths (double-quoted and bare-word).
 * This is intended for interactive zsh (history expansion), but Claude Code runs
 * commands via non-interactive `bash -c` / `zsh -c` where `!` has no special meaning.
 * The escaping corrupts any command containing `!`: JS negation (`!x`, `!!x`, `!==`),
 * shell tests (`[ ! -f ]`), and literal `!` in arguments.
 *
 * Upstream issues: #29210, #10153, #2941.
 *
 * Fix: remove `!` from the two escape regexes in shell-quote's quote() function.
 * - Double-quote path: /(["\\$`!])/g  ->  /(["\\$`])/g
 * - Bare-word path:    ([#!"$&'()*,:;<=>?@[\\\]^`{|}])  ->  ([#"$&'()*,:;<=>?@[\\\]^`{|}])
 */

const OLD_DQUOTE_PATTERN = '(["\\\\$`!])';
const NEW_DQUOTE_PATTERN = '(["\\\\$`])';
const OLD_BARE_PATTERN = "([A-Za-z]:)?([#!\"$&'()*,:;<=>?@[\\\\\\]^`{|}])";
const NEW_BARE_PATTERN = "([A-Za-z]:)?([#\"$&'()*,:;<=>?@[\\\\\\]^`{|}])";

function createShellQuoteFixMutator(): Visitor {
	return {
		RegExpLiteral(path) {
			if (path.node.pattern === OLD_DQUOTE_PATTERN) {
				path.node.pattern = NEW_DQUOTE_PATTERN;
				return;
			}
			if (path.node.pattern === OLD_BARE_PATTERN) {
				path.node.pattern = NEW_BARE_PATTERN;
			}
		},
	};
}

function verifyShellQuoteFix(code: string, ast?: t.File): true | string {
	const verifyAst = getVerifyAst(code, ast);
	if (!verifyAst) return "Unable to parse AST for shell-quote verification";

	let hasOldDquote = false;
	let hasOldBare = false;
	let newDquoteCount = 0;
	let newBareCount = 0;
	let newDquoteInReplace = 0;
	let newBareInReplace = 0;

	const isReplaceCallArg = (path: any): boolean => {
		const parent = path.parentPath;
		if (!parent?.isCallExpression()) return false;
		const callee = parent.node.callee;
		if (!t.isMemberExpression(callee)) return false;
		if (!t.isIdentifier(callee.property, { name: "replace" })) return false;
		return parent.node.arguments[0] === path.node;
	};

	traverse(verifyAst, {
		RegExpLiteral(path) {
			if (path.node.pattern === OLD_DQUOTE_PATTERN) hasOldDquote = true;
			if (path.node.pattern === OLD_BARE_PATTERN) hasOldBare = true;
			if (path.node.pattern === NEW_DQUOTE_PATTERN) {
				newDquoteCount++;
				if (isReplaceCallArg(path)) newDquoteInReplace++;
			}
			if (path.node.pattern === NEW_BARE_PATTERN) {
				newBareCount++;
				if (isReplaceCallArg(path)) newBareInReplace++;
			}
		},
	});

	if (hasOldDquote) return "shell-quote double-quote path still escapes !";
	if (hasOldBare) return "shell-quote bare-word path still escapes !";
	if (newDquoteCount === 0) return "shell-quote double-quote fix not found";
	if (newBareCount === 0) return "shell-quote bare-word fix not found";

	// Count assertions: the upstream shell-quote module has exactly one
	// instance of each pattern. More than one is suspicious (the patch
	// landed in multiple places, or coincidental RegExpLiterals elsewhere
	// match the same character classes).
	if (newDquoteCount !== 1) {
		return `Expected exactly one patched double-quote RegExpLiteral, found ${newDquoteCount}`;
	}
	if (newBareCount !== 1) {
		return `Expected exactly one patched bare-word RegExpLiteral, found ${newBareCount}`;
	}

	// Anchor at least one of the patched RegExpLiterals to a .replace()
	// callsite. If the shell-quote module gets refactored to no longer use
	// String.prototype.replace, neither pattern would be inside a .replace
	// argument and we should fail loudly rather than silently no-op.
	if (newDquoteInReplace === 0 && newBareInReplace === 0) {
		return "Patched shell-quote RegExpLiterals exist but neither is the first argument to a .replace() call";
	}

	return true;
}

export const shellQuoteFix: Patch = {
	tag: "shell-quote-fix",

	astPasses: () => [{ pass: "mutate", visitor: createShellQuoteFixMutator() }],

	verify: verifyShellQuoteFix,
};
