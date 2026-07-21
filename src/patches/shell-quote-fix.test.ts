import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { shellQuoteFix } from "./shell-quote-fix.js";

async function applyShellQuoteFix(source: string): Promise<string> {
	const ast = parse(source);
	const passes = (await shellQuoteFix.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: shellQuoteFix.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
	const output = print(ast);
	assert.equal(shellQuoteFix.verify(output, ast), true);
	return output;
}

// Regex sources for the double-quote and bare-word escape paths a quoter uses
// when it builds character classes instead of single-quoting arguments.
const DQUOTE_ESCAPE_RE = '/(["\\\\$`!])/g';
const BARE_ESCAPE_RE = "/([A-Za-z]:)?([#!\"$&'()*,:;<=>?@[\\\\\\]^`{|}])/g";
const DQUOTE_FIXED_RE = '/(["\\\\$`])/g';
const BARE_FIXED_RE = "/([A-Za-z]:)?([#\"$&'()*,:;<=>?@[\\\\\\]^`{|}])/g";

// A quoter that escapes `!` through backslash-escaping character classes.
const BANG_ESCAPING_QUOTER = `
function quote(s) {
  return s
    .replace(${DQUOTE_ESCAPE_RE}, "\\\\$1")
    .replace(${BARE_ESCAPE_RE}, "$1\\\\$2");
}
`;

// The live shape: unsafe arguments are wrapped in single quotes, where `!` is
// literal, so no character class escapes it.
const SAFE_CHAR_RE = "/^[A-Za-z0-9_./:@+,-][A-Za-z0-9_./:=@+,-]*$/";
const SINGLE_QUOTE_QUOTER = `
function quote(list) {
  return list
    .map((t) => {
      if (t === "") return "''";
      if (${SAFE_CHAR_RE}.test(t)) return t;
      return "'" + t.replace(/'/g, "X") + "'";
    })
    .join(" ");
}
`;

test("shell-quote-fix removes ! from a backslash-escaping quoter", async () => {
	const output = await applyShellQuoteFix(BANG_ESCAPING_QUOTER);

	assert.equal(output.includes(DQUOTE_ESCAPE_RE), false);
	assert.equal(output.includes(BARE_ESCAPE_RE), false);
	assert.equal(output.includes(DQUOTE_FIXED_RE), true);
	assert.equal(output.includes(BARE_FIXED_RE), true);
});

test("shell-quote-fix leaves a single-quote quoter untouched", async () => {
	const output = await applyShellQuoteFix(SINGLE_QUOTE_QUOTER);

	assert.equal(output.includes(SAFE_CHAR_RE), true);
	assert.equal(output.includes('t.replace(/\'/g, "X")'), true);
});

test("shell-quote-fix verify accepts a single-quote quoter", () => {
	const ast = parse(SINGLE_QUOTE_QUOTER);
	assert.equal(shellQuoteFix.verify(print(ast), ast), true);
});

test("shell-quote-fix verify flags an unneutralized !-escaping quoter", () => {
	// verify alone, without running the mutator, must fail when the escaping
	// shape is present so a reintroduced quoter cannot pass silently.
	const ast = parse(BANG_ESCAPING_QUOTER);
	const result = shellQuoteFix.verify(BANG_ESCAPING_QUOTER, ast);
	assert.equal(typeof result, "string");
	assert.match(result as string, /backslash-escapes !/);
});

test("shell-quote-fix ignores a backslash-escaper without ! in its class", async () => {
	// A regex-metacharacter escaper uses a backslash replacement but no `!`, so
	// it is neither mutated nor flagged.
	const REGEX_ESCAPER = `
function escapeRe(s) {
  return s.replace(/[.*+?()]/g, "\\\\$&");
}
`;
	const output = await applyShellQuoteFix(REGEX_ESCAPER);
	assert.equal(output.includes('/[.*+?()]/g, "\\\\$&"'), true);
	assert.equal(shellQuoteFix.verify(output, parse(output)), true);
});

test("shell-quote-fix ignores a positive !-class used for testing, not escaping", () => {
	// Many benign classes list `!` (URI, email, punctuation). Only escaping
	// `.replace()` calls are the defect shape; a `.test()` must not be flagged.
	const BANG_CLASS_TEST = `
function needsQuoting(s) {
  return /[a-z0-9!$&'()*+,;=:@]/.test(s);
}
`;
	const ast = parse(BANG_CLASS_TEST);
	assert.equal(shellQuoteFix.verify(print(ast), ast), true);
});

test("shell-quote-fix is idempotent", async () => {
	const once = await applyShellQuoteFix(BANG_ESCAPING_QUOTER);
	const twice = await applyShellQuoteFix(once);
	assert.equal(once, twice);
});

test("shell-quote-fix preserves the replacement arguments", async () => {
	const output = await applyShellQuoteFix(BANG_ESCAPING_QUOTER);
	assert.equal(output.includes('"\\\\$1"'), true);
	assert.equal(output.includes('"$1\\\\$2"'), true);
});
