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
	const dquoteReplaceFns = new Set<t.Node>();
	const bareReplaceFns = new Set<t.Node>();

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
				if (isReplaceCallArg(path)) {
					newDquoteInReplace++;
					const fn = path.getFunctionParent()?.node;
					if (fn) dquoteReplaceFns.add(fn);
				}
			}
			if (path.node.pattern === NEW_BARE_PATTERN) {
				newBareCount++;
				if (isReplaceCallArg(path)) {
					newBareInReplace++;
					const fn = path.getFunctionParent()?.node;
					if (fn) bareReplaceFns.add(fn);
				}
			}
		},
	});

	if (hasOldDquote) return "shell-quote double-quote path still escapes !";
	if (hasOldBare) return "shell-quote bare-word path still escapes !";
	if (newDquoteCount === 0 && newBareCount === 0) return true;
	if (newDquoteCount === 0) return "shell-quote double-quote fix not found";
	if (newBareCount === 0) return "shell-quote bare-word fix not found";

	// The OLD-absence checks above already guarantee no unpatched escape site
	// survives, so an extra RegExpLiteral matching the same character class
	// elsewhere in the bundle is not a defect. Require at least one of each
	// patched pattern rather than exactly one.
	if (newDquoteCount < 1) {
		return `Expected at least one patched double-quote RegExpLiteral, found ${newDquoteCount}`;
	}
	if (newBareCount < 1) {
		return `Expected at least one patched bare-word RegExpLiteral, found ${newBareCount}`;
	}

	// Per-pattern anchor: each patched pattern must independently be the first
	// argument to a .replace() call, so both fixes are proven wired into an
	// escape callsite. If the quoting helper is ever refactored away from
	// String.prototype.replace, fail loudly rather than silently no-op.
	if (newDquoteInReplace === 0) {
		return "Patched double-quote RegExpLiteral exists but is not the first argument to a .replace() call";
	}
	if (newBareInReplace === 0) {
		return "Patched bare-word RegExpLiteral exists but is not the first argument to a .replace() call";
	}

	// Locality: both patched escape callsites live in the same quoting helper
	// upstream. Require a shared enclosing function so a stray pattern in
	// unrelated code cannot stand in for the real escape site.
	const sharesEnclosingFn = [...dquoteReplaceFns].some((fn) =>
		bareReplaceFns.has(fn),
	);
	if (!sharesEnclosingFn) {
		return "Patched shell-quote RegExpLiterals are not anchored in a shared enclosing function";
	}

	return true;
}

export const shellQuoteFix: Patch = {
	tag: "shell-quote-fix",

	astPasses: () => [{ pass: "mutate", visitor: createShellQuoteFixMutator() }],

	verify: verifyShellQuoteFix,
};
