import assert from "node:assert/strict";
import { test } from "node:test";
import {
	formatVerificationFailures,
	runVerificationStages,
} from "./verify-patches.js";

test("stage reporting retains every applicable failure and continues later stages", () => {
	const visited: string[] = [];
	const report = runVerificationStages([
		{
			stage: "patch",
			label: "native",
			run: () => {
				visited.push("patch");
				throw new Error("two patch tags failed");
			},
		},
		{
			stage: "summary",
			label: "native",
			run: () => visited.push("summary"),
		},
		{
			stage: "evidence",
			label: "native",
			run: () => {
				visited.push("evidence");
				throw new Error("manifest persistence denied");
			},
		},
		{
			stage: "prompt-surface",
			label: "native-prompts",
			run: () => {
				visited.push("prompt-surface");
				throw new Error("surface mismatch");
			},
		},
		{
			stage: "prompt-drift",
			label: "native-prompts",
			run: () => visited.push("prompt-drift"),
		},
		{
			stage: "anchors",
			label: "cli",
			run: () => {
				visited.push("anchors");
				throw new Error("anchor mismatch");
			},
		},
	]);

	assert.deepEqual(visited, [
		"patch",
		"summary",
		"evidence",
		"prompt-surface",
		"prompt-drift",
		"anchors",
	]);
	assert.deepEqual(
		report
			.filter((outcome) => outcome.status === "failed")
			.map((outcome) => outcome.stage),
		["patch", "evidence", "prompt-surface", "anchors"],
	);
	assert.equal(
		formatVerificationFailures(report),
		[
			"Verification failed in 4 stages:",
			"  - [patch: native] two patch tags failed",
			"  - [evidence: native] manifest persistence denied",
			"  - [prompt-surface: native-prompts] surface mismatch",
			"  - [anchors: cli] anchor mismatch",
		].join("\n"),
	);
});

test("stage reporting records an inapplicable stage without running it", () => {
	let called = false;
	const report = runVerificationStages([
		{
			stage: "evidence",
			label: "native",
			skipReason: "summary unavailable",
			run: () => {
				called = true;
			},
		},
	]);

	assert.equal(called, false);
	assert.deepEqual(report, [
		{
			stage: "evidence",
			label: "native",
			status: "skipped",
			diagnostic: "summary unavailable",
		},
	]);
});

test("stage labels are bounded to a stable single-line diagnostic token", () => {
	const [outcome] = runVerificationStages([
		{
			stage: "patch",
			label: `Native target\n${"x".repeat(100)}`,
			run: () => {
				throw new Error("failed");
			},
		},
	]);

	assert.equal(outcome?.label, `native-target-${"x".repeat(50)}`);
	assert.doesNotMatch(outcome?.label ?? "", /\n/);
});
