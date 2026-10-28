import assert from "node:assert/strict";
import { test } from "node:test";
import { strengthenClaudeMdWrapper } from "../../plugin/hooks/claudemd.js";
import { STRONG_CLAUDEMD_DISCLAIMER } from "../../plugin/hooks/policy.js";

const STOCK =
	"Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.";

test("replaces only the leading wrapper and leaves every instruction byte alone", () => {
	const files = `Contents of /work/CLAUDE.md:\n\nUser text: $& \ufeff CRLF\r\n${STOCK}\n`;
	const result = strengthenClaudeMdWrapper(`${STOCK}\n\n${files}`);
	assert.equal(result, `${STRONG_CLAUDEMD_DISCLAIMER}\n\n${files}`);
	assert.equal(strengthenClaudeMdWrapper(result), result);
});

test("leaves empty, unknown, and embedded wrappers alone", () => {
	for (const text of [
		"",
		"Custom framing\n\nInstructions",
		`Quoted: ${STOCK}\n\ntext`,
		STOCK,
	]) {
		assert.equal(strengthenClaudeMdWrapper(text), text);
	}
});
