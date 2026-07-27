import assert from "node:assert/strict";
import { test } from "node:test";
import {
	MODERN_CODE_SEARCH_DECISION_TREE,
	MODERN_STDOUT_CAP,
	MODERN_SUBAGENT_CODE_ROUTING,
} from "./prompt-policy.js";

test("stdout policy states the invariant without teaching truncation recipes", () => {
	assert.equal(
		MODERN_STDOUT_CAP,
		"Preserve complete command output. Use a producer's native result bound only when the task calls for a bounded result. Otherwise run the command normally; when Bash persists oversized output, inspect the saved artifact with a bounded Read range.",
	);
	for (const recipe of ["head", "tail", "sed", "awk", "rg -m", "fd --"]) {
		assert.equal(MODERN_STDOUT_CAP.includes(recipe), false);
	}
});

test("subagent routing reuses the stdout invariant and names only available-aware code tools", () => {
	assert.equal(
		MODERN_SUBAGENT_CODE_ROUTING.split(MODERN_STDOUT_CAP).length - 1,
		1,
	);
	assert.equal(MODERN_SUBAGENT_CODE_ROUTING.includes("ast-grep MCP"), false);
	assert.equal(
		MODERN_CODE_SEARCH_DECISION_TREE.includes("when available"),
		true,
	);
});
