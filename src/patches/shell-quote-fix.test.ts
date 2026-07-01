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

const OLD_DQUOTE_SOURCE = '/(["\\\\$`!])/g';
const NEW_DQUOTE_SOURCE = '/(["\\\\$`])/g';
const OLD_BARE_SOURCE = "/([A-Za-z]:)?([#!\"$&'()*,:;<=>?@[\\\\\\]^`{|}])/g";
const NEW_BARE_SOURCE = "/([A-Za-z]:)?([#\"$&'()*,:;<=>?@[\\\\\\]^`{|}])/g";

const FIXTURE = `
function quote(s) {
  s.replace(${OLD_DQUOTE_SOURCE}, "\\\\$1");
  s.replace(${OLD_BARE_SOURCE}, "\\\\$1");
}
`;

test("shell-quote-fix removes ! from both escape paths", async () => {
	const output = await applyShellQuoteFix(FIXTURE);

	assert.equal(output.includes(OLD_DQUOTE_SOURCE), false);
	assert.equal(output.includes(OLD_BARE_SOURCE), false);
	assert.equal(output.includes(NEW_DQUOTE_SOURCE), true);
	assert.equal(output.includes(NEW_BARE_SOURCE), true);
});

test("shell-quote-fix verify rejects unpatched input", () => {
	const ast = parse(FIXTURE);
	const result = shellQuoteFix.verify(FIXTURE, ast);
	assert.equal(typeof result, "string");
});

test("shell-quote-fix accepts bundles where the old helper is absent", () => {
	const LATEST_SHAPE = `
function quoteForWin32CreateProcess(args) {
  return args.map((arg) => arg.includes(" ") ? JSON.stringify(arg) : arg).join(" ");
}
`;
	const ast = parse(LATEST_SHAPE);
	assert.equal(shellQuoteFix.verify(print(ast), ast), true);
});

test("shell-quote-fix is idempotent", async () => {
	const once = await applyShellQuoteFix(FIXTURE);
	const twice = await applyShellQuoteFix(once);
	assert.equal(once, twice);
});

test("shell-quote-fix verify rejects patched patterns outside a .replace() call", () => {
	const NO_REPLACE = `
function quote(s) {
  const a = ${NEW_DQUOTE_SOURCE};
  const b = ${NEW_BARE_SOURCE};
  return a.test(s) || b.test(s);
}
`;
	const ast = parse(NO_REPLACE);
	const result = shellQuoteFix.verify(print(ast), ast);
	assert.equal(typeof result, "string");
	assert.match(
		result as string,
		/is not the first argument to a \.replace\(\) call/,
	);
});

test("shell-quote-fix verify requires the patched regex to be the first .replace() argument", () => {
	const SECOND_ARG = `
function quote(s) {
  s.replace("x", ${NEW_DQUOTE_SOURCE});
  s.replace("y", ${NEW_BARE_SOURCE});
}
`;
	const ast = parse(SECOND_ARG);
	const result = shellQuoteFix.verify(print(ast), ast);
	assert.equal(typeof result, "string");
	assert.match(
		result as string,
		/is not the first argument to a \.replace\(\) call/,
	);
});

test("shell-quote-fix verify requires both patched callsites in a shared enclosing function", () => {
	const SPLIT_FNS = `
function quoteDouble(s) {
  return s.replace(${NEW_DQUOTE_SOURCE}, "\\\\$1");
}
function quoteBare(s) {
  return s.replace(${NEW_BARE_SOURCE}, "$1\\\\$2");
}
`;
	const ast = parse(SPLIT_FNS);
	const result = shellQuoteFix.verify(print(ast), ast);
	assert.equal(typeof result, "string");
	assert.match(result as string, /shared enclosing function/);
});

test("shell-quote-fix converts both escape patterns in one function, not just one", async () => {
	const output = await applyShellQuoteFix(FIXTURE);

	assert.equal(
		output.split(NEW_DQUOTE_SOURCE).length - 1,
		1,
		"exactly one patched double-quote pattern",
	);
	assert.equal(
		output.split(NEW_BARE_SOURCE).length - 1,
		1,
		"exactly one patched bare-word pattern",
	);
	assert.equal(output.includes(OLD_DQUOTE_SOURCE), false);
	assert.equal(output.includes(OLD_BARE_SOURCE), false);
});

test("shell-quote-fix preserves the .replace() replacement arguments", async () => {
	const output = await applyShellQuoteFix(FIXTURE);
	assert.equal(
		output.includes('"\\\\$1"'),
		true,
		"replacement argument retained",
	);
});

test("shell-quote-fix verify accepts extra coincidental matched literals", () => {
	// A second RegExpLiteral matching the same character class elsewhere is
	// not a defect: the OLD-absence checks already guarantee no unpatched
	// escape site survives, and the real quoting helper still anchors both
	// fixes in a shared function.
	const EXTRA = `
function quote(s) {
  s.replace(${NEW_DQUOTE_SOURCE}, "\\\\$1");
  s.replace(${NEW_BARE_SOURCE}, "$1\\\\$2");
}
function unrelated(x) {
  const decoy = ${NEW_DQUOTE_SOURCE};
  return decoy.test(x);
}
`;
	const ast = parse(EXTRA);
	assert.equal(shellQuoteFix.verify(print(ast), ast), true);
});
