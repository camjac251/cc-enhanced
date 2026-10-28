import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CLAUDE_API_SKIP,
	CLAUDE_API_TRIGGER,
	narrowClaudeApiSkillListing,
} from "../../plugin/hooks/skill-scope.js";

const ENTRY = [
	"- claude-api: Reference for the Claude API / Anthropic SDK — model ids, pricing, params.",
	'TRIGGER — read BEFORE opening the target file; don\'t skip because it "looks like a one-liner" — whenever: the prompt names Claude/Anthropic in any form.',
	"SKIP only when another provider is being worked on (overrides all triggers): OpenAI/GPT/Gemini.",
].join("\n");

test("narrows only Claude API stock trigger and skip, preserving surrounding entries", () => {
	const before = "Available skills:\n- other: Claude API notes\n";
	const after =
		"\n- another: TRIGGER — Claude Code\nSKIP nothing.\n</system-reminder>";
	const result = narrowClaudeApiSkillListing(before + ENTRY + after);
	assert.equal(
		result,
		`${before}${ENTRY.split("\n")[0]}\n${CLAUDE_API_TRIGGER}\n${CLAUDE_API_SKIP}${after}`,
	);
	assert.equal(narrowClaudeApiSkillListing(result), result);
});

test("preserves CRLF in the skill listing", () => {
	assert.equal(
		narrowClaudeApiSkillListing(ENTRY.replaceAll("\n", "\r\n")),
		`${ENTRY.split("\n")[0]}\r\n${CLAUDE_API_TRIGGER}\r\n${CLAUDE_API_SKIP}`,
	);
});

test("does not rewrite other names, custom descriptions, quoted entries, or partial stock prose", () => {
	for (const text of [
		ENTRY.replace("- claude-api:", "- another:"),
		ENTRY.replace(
			"Reference for the Claude API / Anthropic SDK",
			"Custom skill description",
		),
		`A user quoted ${ENTRY}`,
		ENTRY.split("\n").slice(0, 2).join("\n"),
	]) {
		assert.equal(narrowClaudeApiSkillListing(text), text);
	}
});
