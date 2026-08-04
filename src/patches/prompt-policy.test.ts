import assert from "node:assert/strict";
import { test } from "node:test";
import {
	BACKGROUND_TASK_POLICY,
	MODERN_CODE_SEARCH_DECISION_TREE,
	MODERN_STDOUT_CAP,
	MODERN_SUBAGENT_CODE_ROUTING,
} from "./prompt-policy.js";

test("stdout policy defines an inspectable-result contract without teaching truncation recipes", () => {
	assert.equal(
		MODERN_STDOUT_CAP,
		"Keep command results available for inspection. When the task asks for a bounded result, use the producer's native limit. Otherwise run normally; if Bash persists oversized output, inspect the saved artifact by range or semantic selection.",
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
	assert.equal(
		MODERN_CODE_SEARCH_DECISION_TREE.includes("when available"),
		true,
	);
});

test("subagent routing includes the background task policy exactly once", () => {
	assert.equal(
		MODERN_SUBAGENT_CODE_ROUTING.split(BACKGROUND_TASK_POLICY).length - 1,
		1,
	);
});
