import assert from "node:assert/strict";
import { test } from "node:test";
import {
	claudeMdSystemPrompt,
	STRONG_DISCLAIMER_LINES,
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
		String(result).includes("Strong CLAUDE.md disclaimer lines are missing"),
		true,
	);
});

test("claudemd-strong verify accepts the exact shared strong disclaimer lines", () => {
	const input = STRONG_DISCLAIMER_LINES.join("\n");
	assert.equal(claudeMdSystemPrompt.verify(input), true);
});

test("claudemd-strong line checks reject incomplete strong wrapper text", () => {
	const input = STRONG_DISCLAIMER_LINES.slice(0, 5).join("\n");
	const result = claudeMdSystemPrompt.verify(input);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("Strong CLAUDE.md disclaimer lines are missing"),
		true,
	);
});
