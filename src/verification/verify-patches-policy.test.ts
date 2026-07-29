import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	assertCleanSummary,
	assertVerificationTarget,
	fullPatchEnvironment,
	persistEvidenceAndAssertCleanSummary,
	resolveConfiguredTarget,
	selectMatrixVersions,
	structuralEvidenceCliArgs,
	writePatchEvidence,
} from "../../scripts/verify-patches.js";
import type { PatchEvidenceManifest } from "../types.js";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
	} else {
		process.env[name] = value;
	}
}

test("matrix verification requires an explicit version by default", () => {
	const selectedVersion = process.env.SELECTED_VERSION;
	const matrixScope = process.env.VERIFY_PATCHES_MATRIX_SCOPE;
	try {
		delete process.env.SELECTED_VERSION;
		delete process.env.VERIFY_PATCHES_MATRIX_SCOPE;
		assert.throws(() => selectMatrixVersions(), /SELECTED_VERSION/);
	} finally {
		restoreEnv("SELECTED_VERSION", selectedVersion);
		restoreEnv("VERIFY_PATCHES_MATRIX_SCOPE", matrixScope);
	}
});

test("matrix verification accepts an explicit selected version", () => {
	const selectedVersion = process.env.SELECTED_VERSION;
	const matrixScope = process.env.VERIFY_PATCHES_MATRIX_SCOPE;
	try {
		process.env.SELECTED_VERSION = "2.1.999";
		delete process.env.VERIFY_PATCHES_MATRIX_SCOPE;
		assert.deepEqual(selectMatrixVersions(), ["2.1.999"]);
	} finally {
		restoreEnv("SELECTED_VERSION", selectedVersion);
		restoreEnv("VERIFY_PATCHES_MATRIX_SCOPE", matrixScope);
	}
});

test("matrix verification rejects non-version paths", () => {
	const selectedVersion = process.env.SELECTED_VERSION;
	const matrixScope = process.env.VERIFY_PATCHES_MATRIX_SCOPE;
	try {
		process.env.SELECTED_VERSION = "../outside";
		delete process.env.VERIFY_PATCHES_MATRIX_SCOPE;
		assert.throws(() => selectMatrixVersions(), /semantic version/i);
	} finally {
		restoreEnv("SELECTED_VERSION", selectedVersion);
		restoreEnv("VERIFY_PATCHES_MATRIX_SCOPE", matrixScope);
	}
});

test("default verification rejects a missing native target", () => {
	assert.throws(
		() => assertVerificationTarget(undefined, false),
		/real native target/i,
	);
});

test("health-only verification can explicitly allow a missing target", () => {
	assert.doesNotThrow(() => assertVerificationTarget(undefined, true));
});

test("explicitly configured targets must exist", () => {
	assert.throws(
		() =>
			resolveConfiguredTarget(
				"NATIVE_TARGET",
				"/tmp/cc-enhanced-explicitly-missing-native",
			),
		/NATIVE_TARGET target not found/,
	);
	assert.throws(
		() =>
			resolveConfiguredTarget(
				"CLI_TARGET",
				"/tmp/cc-enhanced-explicitly-missing-cli",
			),
		/CLI_TARGET target not found/,
	);
	assert.throws(
		() =>
			resolveConfiguredTarget(
				"CC_POST_UPDATE_PROMOTED",
				"/tmp/cc-enhanced-explicitly-missing-promoted",
			),
		/CC_POST_UPDATE_PROMOTED target not found/,
	);
});

test("explicitly configured targets resolve to existing files", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "verify-target-"));
	const target = path.join(tempDir, "target");
	try {
		await fs.writeFile(target, "synthetic", "utf8");
		assert.equal(resolveConfiguredTarget("NATIVE_TARGET", target), target);
		assert.equal(
			resolveConfiguredTarget("NATIVE_TARGET", undefined),
			undefined,
		);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("full patch environment removes caller patch filters", () => {
	const result = fullPatchEnvironment({
		PATH: "/usr/bin",
		CLAUDE_PATCHER_INCLUDE_TAGS: "one",
		CLAUDE_PATCHER_EXCLUDE_TAGS: "two",
	});
	assert.deepEqual(result, { PATH: "/usr/bin" });
});

test("deep structural evidence is requested only for persisted manifests", () => {
	assert.deepEqual(structuralEvidenceCliArgs(undefined), []);
	assert.deepEqual(structuralEvidenceCliArgs("/tmp/evidence.json"), [
		"--structural-evidence",
	]);
});

test("summary validation rejects an incomplete applied patch roster", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "verify-roster-"));
	const summaryPath = path.join(tempDir, "summary.json");
	try {
		await fs.writeFile(
			summaryPath,
			JSON.stringify({
				result: {
					failedTags: [],
					appliedTags: ["first", "signature"],
					verifications: [],
				},
			}),
			"utf8",
		);

		assert.throws(
			() =>
				assertCleanSummary(summaryPath, "synthetic", [
					"first",
					"second",
					"signature",
				]),
			/patch roster/i,
		);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("summary validation rejects duplicate and unexpected patch tags", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "verify-roster-"));
	const summaryPath = path.join(tempDir, "summary.json");
	try {
		await fs.writeFile(
			summaryPath,
			JSON.stringify({
				result: {
					failedTags: [],
					appliedTags: ["first", "first", "unexpected"],
					verifications: [],
				},
			}),
			"utf8",
		);

		assert.throws(
			() => assertCleanSummary(summaryPath, "synthetic", ["first", "second"]),
			/duplicates=true/,
		);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("summary validation accepts one copy of every expected patch tag", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "verify-roster-"));
	const summaryPath = path.join(tempDir, "summary.json");
	try {
		await fs.writeFile(
			summaryPath,
			JSON.stringify({
				result: {
					failedTags: [],
					appliedTags: ["second", "first"],
					verifications: [],
				},
			}),
			"utf8",
		);

		assert.doesNotThrow(() =>
			assertCleanSummary(summaryPath, "synthetic", ["first", "second"]),
		);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("verification can persist a sanitized direct evidence manifest", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "verify-evidence-"));
	const summaryPath = path.join(tempDir, "summary.json");
	const evidencePath = path.join(tempDir, "evidence", "manifest.json");
	const evidence: PatchEvidenceManifest = {
		schemaVersion: 1,
		sourceSha256: "a".repeat(64),
		outputSha256: "b".repeat(64),
		patches: [
			{
				tag: "first",
				passed: true,
				coverage: "verification",
				handlerCalls: { discover: 0, mutate: 0, finalize: 0 },
				overlaps: [],
			},
		],
	};
	try {
		await fs.writeFile(
			summaryPath,
			JSON.stringify({ result: { evidence, privateReportField: "discarded" } }),
			"utf8",
		);

		writePatchEvidence(summaryPath, evidencePath);

		assert.deepEqual(
			JSON.parse(await fs.readFile(evidencePath, "utf8")),
			evidence,
		);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("failed verification persists evidence before returning failure", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "verify-failed-evidence-"),
	);
	const summaryPath = path.join(tempDir, "summary.json");
	const evidencePath = path.join(tempDir, "evidence", "manifest.json");
	const evidence: PatchEvidenceManifest = {
		schemaVersion: 1,
		sourceSha256: "a".repeat(64),
		outputSha256: "b".repeat(64),
		patches: [
			{
				tag: "first",
				passed: false,
				coverage: "semantic",
				handlerCalls: { discover: 0, mutate: 1, finalize: 0 },
				witness: { targetCount: 0, requiredCount: 1 },
				overlaps: [],
			},
		],
	};
	try {
		await fs.writeFile(
			summaryPath,
			JSON.stringify({
				error: "Patch verification failed: first",
				result: {
					failedTags: ["first"],
					appliedTags: [],
					verifications: [
						{ tag: "first", passed: false, reason: "missing target" },
					],
					evidence,
				},
			}),
			"utf8",
		);

		assert.throws(
			() =>
				persistEvidenceAndAssertCleanSummary(
					summaryPath,
					"synthetic",
					["first"],
					evidencePath,
				),
			/reported an error/i,
		);
		assert.deepEqual(
			JSON.parse(await fs.readFile(evidencePath, "utf8")),
			evidence,
		);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});
