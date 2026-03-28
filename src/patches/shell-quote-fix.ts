import type { Patch } from "../types.js";

/**
 * Fixes the bundled shell-quote library's unconditional `!` escaping.
 *
 * shell-quote escapes `!` to `\!` in two code paths (double-quoted and bare-word).
 * This is intended for interactive zsh (history expansion), but Claude Code runs
 * commands via non-interactive `bash -c` / `zsh -c` where `!` has no special meaning.
 * The escaping corrupts any command containing `!`: JS negation (`!x`, `!!x`, `!==`),
 * shell tests (`[ ! -f ]`), and literal `!` in arguments.
 *
 * Upstream issues: #29210, #10153, #2941 (unfixed as of 2.1.75).
 *
 * Fix: remove `!` from the two escape regexes in shell-quote's quote() function.
 * - Double-quote path: /(["\\$`!])/g  ->  /(["\\$`])/g
 * - Bare-word path:    ([#!"$&'()*,:;<=>?@[\\\]^`{|}])  ->  ([#"$&'()*,:;<=>?@[\\\]^`{|}])
 */

// Double-quote escaping path: remove ! from the character class
// Original: .replace(/(["\\$`!])/g, "\\$1")
// Fixed:    .replace(/(["\\$`])/g, "\\$1")
// biome-ignore lint/style/useTemplate: backtick in string literal can't be in template
const OLD_DQUOTE_REGEX = String.raw`/(["\\$` + "`!])/g";
// biome-ignore lint/style/useTemplate: backtick in string literal can't be in template
const NEW_DQUOTE_REGEX = String.raw`/(["\\$` + "`])/g";

// Bare-word escaping path: remove ! from the character class
// Original regex has ! between # and "
// biome-ignore lint/style/useTemplate: backtick in string literal can't be in template
const OLD_BARE_CLASS =
	String.raw`([#!"$&'()*,:;<=>?@[\\` + String.raw`\]^` + "`{|}])";
// biome-ignore lint/style/useTemplate: backtick in string literal can't be in template
const NEW_BARE_CLASS =
	String.raw`([#"$&'()*,:;<=>?@[\\` + String.raw`\]^` + "`{|}])";

export const shellQuoteFix: Patch = {
	tag: "shell-quote-fix",

	string: (code) => {
		let result = code;
		// Use function replacers: replacement strings contain $& and $`
		// which String.replace interprets as match/pre-match substitutions
		result = result.replace(OLD_DQUOTE_REGEX, () => NEW_DQUOTE_REGEX);
		result = result.replace(OLD_BARE_CLASS, () => NEW_BARE_CLASS);
		return result;
	},

	verify: (code) => {
		// The old patterns should not exist
		if (code.includes(OLD_DQUOTE_REGEX)) {
			return "shell-quote double-quote path still escapes !";
		}
		if (code.includes(OLD_BARE_CLASS)) {
			return "shell-quote bare-word path still escapes !";
		}

		// The new patterns should exist
		if (!code.includes(NEW_DQUOTE_REGEX)) {
			return "shell-quote double-quote fix not found";
		}
		if (!code.includes(NEW_BARE_CLASS)) {
			return "shell-quote bare-word fix not found";
		}

		return true;
	},
};
