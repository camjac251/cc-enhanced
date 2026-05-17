import assert from "node:assert/strict";
import { test } from "node:test";
import {
	containsForbiddenPromptDashStyle,
	countForbiddenPromptDashStyle,
	findForbiddenPromptDashStyle,
} from "./prompt-dash-style.js";

test("containsForbiddenPromptDashStyle detects en and em dash punctuation", () => {
	assert.equal(containsForbiddenPromptDashStyle("Use 1–3 retries."), true);
	assert.equal(containsForbiddenPromptDashStyle("Stop — ask first."), true);
	assert.equal(containsForbiddenPromptDashStyle("Use 1-3 retries."), false);
	assert.equal(
		containsForbiddenPromptDashStyle("ordinary prompt prose"),
		false,
	);
});

test("countForbiddenPromptDashStyle counts dash kinds separately", () => {
	assert.deepEqual(countForbiddenPromptDashStyle("alpha–beta — gamma"), {
		enDash: 1,
		emDash: 1,
		total: 2,
	});
});

test("findForbiddenPromptDashStyle reports the first dash style match", () => {
	assert.deepEqual(findForbiddenPromptDashStyle("alpha–beta — gamma"), {
		character: "–",
		index: 5,
		label: "en dash",
	});
	assert.deepEqual(findForbiddenPromptDashStyle("alpha-beta"), null);
});
