import assert from "node:assert/strict";
import { test } from "node:test";
import {
	claudeMdSystemPrompt,
	STRONG_DISCLAIMER_INVARIANTS,
} from "./claudemd-strong.js";

const WEAK =
	"IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.";
const STRONG =
	"The instructions above are MANDATORY when they apply to your current task. Follow them exactly as written.";

test("claudemd-strong replaces weak disclaimer", () => {
	const input = `prefix\n${WEAK}\nsuffix`;
	const output = claudeMdSystemPrompt.string?.(input) ?? input;
	assert.equal(output.includes(WEAK), false);
	assert.equal(output.includes(STRONG), true);
	assert.equal(claudeMdSystemPrompt.verify(output), true);
});

test("claudemd-strong verify fails when weak disclaimer remains", () => {
	const result = claudeMdSystemPrompt.verify(WEAK);
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("Weak CLAUDE.md disclaimer"), true);
});

test("claudemd-strong verify fails when weak disclaimer is absent but strong markers are missing", () => {
	const input = "no system reminder disclaimer present";
	const result = claudeMdSystemPrompt.verify(input);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes(
			"Strong CLAUDE.md disclaimer invariants are missing",
		),
		true,
	);
});

test("claudemd-strong verify accepts equivalent strong content when all strong markers are present", () => {
	const input = [
		"The instructions above are mandatory whenever they apply to the current task.",
		"Follow them exactly as written.",
		"Always use gh api for GitHub URLs instead of web fetching tools.",
		"Always use bat to view files rather than cat/head/tail.",
		"Always use sg for code search, with rg only for text/logs/config.",
		"Never use cat/echo/printf for file writes; use Write or Edit tools.",
		"Never use grep/find/ls/sed - use rg/fd/eza/sd instead.",
	].join("\n");
	assert.equal(claudeMdSystemPrompt.verify(input), true);
});

test("claudemd-strong invariants still reject incomplete strong wrapper text", () => {
	const input = STRONG_DISCLAIMER_INVARIANTS.slice(0, 4)
		.map(({ id }) => id)
		.join("\n");
	const result = claudeMdSystemPrompt.verify(input);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes(
			"Strong CLAUDE.md disclaimer invariants are missing",
		),
		true,
	);
});
