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

test("shell-quote-fix is idempotent", async () => {
	const once = await applyShellQuoteFix(FIXTURE);
	const twice = await applyShellQuoteFix(once);
	assert.equal(once, twice);
});
