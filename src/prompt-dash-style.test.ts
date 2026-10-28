import assert from "node:assert/strict";
import { test } from "node:test";
import { countForbiddenPromptDashStyle } from "./prompt-dash-style.js";

test("countForbiddenPromptDashStyle counts dash kinds separately", () => {
	assert.deepEqual(countForbiddenPromptDashStyle("alpha–beta — gamma"), {
		enDash: 1,
		emDash: 1,
		total: 2,
	});
});

test("countForbiddenPromptDashStyle ignores ASCII hyphens and ordinary prose", () => {
	for (const text of ["", "Use 1-3 retries.", "ordinary prompt prose"]) {
		assert.deepEqual(countForbiddenPromptDashStyle(text), {
			enDash: 0,
			emDash: 0,
			total: 0,
		});
	}
});
