import assert from "node:assert/strict";
import { test } from "node:test";
import { shellQuoteFix } from "./shell-quote-fix.js";

// Build a fixture containing the two old shell-quote escape patterns.
// Uses the same String.raw + concat trick as the patch itself.
// biome-ignore lint/style/useTemplate: backtick in string literal can't be in template
const OLD_DQUOTE =
	String.raw`s.replace(/(["\\$` + "`!])/g" + String.raw`, '\\$1')`;
const OLD_BARE =
	String.raw`s.replace(([#!"$&'()*,:;<=>?@[\\` +
	String.raw`\]^` +
	"`{|}])" +
	String.raw`/g, '\\$1')`;

const FIXTURE = `function quote(s) { ${OLD_DQUOTE}; ${OLD_BARE}; }`;

test("shell-quote-fix removes ! from both escape paths", () => {
	const output = shellQuoteFix.string?.(FIXTURE) ?? FIXTURE;
	assert.notEqual(output, FIXTURE, "Patch should have changed the code");
	// ! should be gone from both character classes
	assert.equal(output.includes("!])/g"), false);
	assert.equal(output.includes('#!"'), false);
});

test("shell-quote-fix verify passes on patched output", () => {
	const output = shellQuoteFix.string?.(FIXTURE) ?? FIXTURE;
	assert.equal(shellQuoteFix.verify(output), true);
});

test("shell-quote-fix verify rejects unpatched input", () => {
	const result = shellQuoteFix.verify(FIXTURE);
	assert.equal(typeof result, "string");
});

test("shell-quote-fix is idempotent", () => {
	const once = shellQuoteFix.string?.(FIXTURE) ?? FIXTURE;
	const twice = shellQuoteFix.string?.(once) ?? once;
	assert.equal(once, twice);
});
