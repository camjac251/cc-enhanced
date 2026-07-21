import * as t from "@babel/types";
import { traverse, type Visitor } from "../babel.js";
import type { Patch } from "../types.js";
import { getVerifyAst } from "./ast-helpers.js";

/**
 * Keeps shell-command argument quoting from corrupting `!`.
 *
 * A POSIX shell run non-interactively (`bash -c` / `zsh -c`) treats `!` as an
 * ordinary character, so an argument quoter must not backslash-escape it.
 * Escaping `!` to `\!` breaks any command that contains one: JS negation
 * (`!x`, `!==`), shell tests (`[ ! -f ]`), and a literal `!` in an argument.
 *
 * A quoter that wraps unsafe arguments in single quotes never needs to escape
 * `!` at all. The defect only appears when a quoter instead builds a
 * character class listing `!` and backslash-escapes each captured character.
 *
 * This pass targets that shape structurally: any `String.prototype.replace`
 * whose regex is a positive character class containing `!` and whose
 * replacement backslash-escapes the capture has the `!` removed from the class.
 * When no such construct exists, the pass is a no-op and `verify` confirms that
 * no `!`-escaping quoter is present.
 */

// A positive character class: opens with `[`, is not negated (`[^...]`), and
// its body may contain escaped members (`\]`, `\\`) up to the closing `]`.
const POSITIVE_CLASS_SOURCE = "\\[(?!\\^)(?:\\\\.|[^\\]])*\\]";

function positiveClasses(pattern: string): string[] {
	return pattern.match(new RegExp(POSITIVE_CLASS_SOURCE, "g")) ?? [];
}

// A backslash group-reference replacement (`\$1`, `$1\$2`, `\$&`) is the mark
// of an escaping `.replace()`, distinct from a plain substitution.
function isBackslashGroupReplacement(node: t.Node | undefined): boolean {
	return t.isStringLiteral(node) && /\\\$[&\d]/.test(node.value);
}

// True when a regex source lists `!` as a member of a positive character class,
// the shape a shell-argument quoter uses to escape `!`.
function patternEscapesBang(pattern: string): boolean {
	return positiveClasses(pattern).some((cls) => cls.includes("!"));
}

// Remove `!` from every positive character class in a regex source. Returns the
// rewritten source, or null when no class contained `!`.
function removeBangFromClasses(pattern: string): string | null {
	let changed = false;
	const rewritten = pattern.replace(
		new RegExp(POSITIVE_CLASS_SOURCE, "g"),
		(cls) => {
			if (!cls.includes("!")) return cls;
			changed = true;
			return cls.replace(/\\?!/g, "");
		},
	);
	return changed ? rewritten : null;
}

// True when `path` is the regex argument of a `.replace(regex, escape)` call
// whose replacement backslash-escapes the captured characters.
function isEscapeReplaceRegex(path: any): boolean {
	const parent = path.parentPath;
	if (!parent?.isCallExpression()) return false;
	const callee = parent.node.callee;
	if (!t.isMemberExpression(callee)) return false;
	if (!t.isIdentifier(callee.property, { name: "replace" })) return false;
	if (parent.node.arguments[0] !== path.node) return false;
	return isBackslashGroupReplacement(parent.node.arguments[1]);
}

function createShellQuoteFixMutator(): Visitor {
	return {
		RegExpLiteral(path) {
			if (!isEscapeReplaceRegex(path)) return;
			const rewritten = removeBangFromClasses(path.node.pattern);
			if (rewritten === null) return;
			path.node.pattern = rewritten;
		},
	};
}

function verifyShellQuoteFix(code: string, ast?: t.File): true | string {
	const verifyAst = getVerifyAst(code, ast);
	if (!verifyAst) return "Unable to parse AST for shell-quote verification";

	// Count escaping `.replace()` sites whose class still lists `!`. A quoter
	// that single-quotes its arguments produces zero of these, so any surviving
	// site means an `!`-escaping quoter is present and was not neutralized.
	let unneutralized = 0;
	traverse(verifyAst, {
		RegExpLiteral(path) {
			if (!isEscapeReplaceRegex(path)) return;
			if (patternEscapesBang(path.node.pattern)) unneutralized++;
		},
	});

	if (unneutralized > 0) {
		return "shell-command argument quoter still backslash-escapes ! instead of single-quoting it";
	}
	return true;
}

export const shellQuoteFix: Patch = {
	tag: "shell-quote-fix",

	astPasses: () => [{ pass: "mutate", visitor: createShellQuoteFixMutator() }],

	verify: verifyShellQuoteFix,
};
