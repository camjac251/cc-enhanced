import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	computeSourceTreeFingerprint,
	selectPatchTelemetryLevel,
} from "./manager.js";

test("patch telemetry is deep only when explicitly requested", () => {
	assert.equal(selectPatchTelemetryLevel({}), "none");
	assert.equal(
		selectPatchTelemetryLevel({ summaryPath: "/tmp/summary.json" }),
		"none",
	);
	assert.equal(
		selectPatchTelemetryLevel({
			summaryPath: "/tmp/summary.json",
			structuralEvidence: true,
		}),
		"deep",
	);
});

test("source fingerprint changes when a patch helper changes", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-fingerprint-"));
	try {
		fs.mkdirSync(path.join(root, "patches"));
		fs.writeFileSync(
			path.join(root, "patches", "feature.ts"),
			"export const patch = () => helper();\n",
		);
		const helperPath = path.join(root, "patches", "helper.ts");
		fs.writeFileSync(helperPath, "export const helper = () => false;\n");
		const before = computeSourceTreeFingerprint(root);

		fs.writeFileSync(helperPath, "export const helper = () => true;\n");
		const after = computeSourceTreeFingerprint(root);

		assert.notEqual(after, before);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("source fingerprint ignores tests that do not affect runtime output", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-fingerprint-"));
	try {
		fs.writeFileSync(
			path.join(root, "patch.ts"),
			"export const patch = true;\n",
		);
		const testPath = path.join(root, "patch.test.ts");
		fs.writeFileSync(testPath, "test('one', () => {});\n");
		const before = computeSourceTreeFingerprint(root);

		fs.writeFileSync(testPath, "test('two', () => {});\n");
		const after = computeSourceTreeFingerprint(root);

		assert.equal(after, before);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
