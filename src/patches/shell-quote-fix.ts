import type * as t from "@babel/types";
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

	let hasNewDquote = false;
	let hasNewBare = false;
	let hasOldDquote = false;
	let hasOldBare = false;

	traverse(verifyAst, {
		RegExpLiteral(path) {
			if (path.node.pattern === OLD_DQUOTE_PATTERN) hasOldDquote = true;
			if (path.node.pattern === OLD_BARE_PATTERN) hasOldBare = true;
			if (path.node.pattern === NEW_DQUOTE_PATTERN) hasNewDquote = true;
			if (path.node.pattern === NEW_BARE_PATTERN) hasNewBare = true;
		},
	});

	if (hasOldDquote) return "shell-quote double-quote path still escapes !";
	if (hasOldBare) return "shell-quote bare-word path still escapes !";
	if (!hasNewDquote) return "shell-quote double-quote fix not found";
	if (!hasNewBare) return "shell-quote bare-word fix not found";

	return true;
}

export const shellQuoteFix: Patch = {
	tag: "shell-quote-fix",

	astPasses: () => [{ pass: "mutate", visitor: createShellQuoteFixMutator() }],

	verify: verifyShellQuoteFix,
};
