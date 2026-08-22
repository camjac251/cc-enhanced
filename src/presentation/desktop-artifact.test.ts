import assert from "node:assert/strict";
import { test } from "node:test";
import type { DesktopArtifactInspectionEvidence } from "../desktop/artifact-inspection.js";
import { createDesktopArtifactInspectionResult } from "../desktop/status.js";
import { DEFAULT_NATIVE_BUCKET } from "../native-release.js";
import { renderDesktopArtifactInspection } from "./desktop-artifact.js";

test("human artifact output names evidence boundaries without paths", () => {
	const evidence: DesktopArtifactInspectionEvidence = {
		schemaVersion: 1,
		platform: "win32",
		locatorId: "desktop-code:2.1.235",
		version: "2.1.235",
		nativePlatform: "win32-x64",
		binaryFormat: "pe",
		architecture: "x64",
		size: 512,
		sha256: "a".repeat(64),
		selectionReason: "highest-cached",
		patchAuthorization: "not-authorized",
		artifactBinding: "verified",
		provenance: {
			status: "verified",
			manifestUrl: `${DEFAULT_NATIVE_BUCKET}/2.1.235/manifest.json`,
			manifestSha256: "a".repeat(64),
			manifestSize: 512,
			manifestSignature: "not-provided",
		},
		platformSignature: {
			presence: "present",
			mechanism: "pe-certificate-table",
			validity: "not-run",
		},
		patchReceipt: { status: "absent", tags: [] },
		versionExecution: "not-run",
		surfaceCompatibility: "not-evaluated",
		inspectedAt: "2026-08-20T13:00:00.000Z",
	};
	const lines = renderDesktopArtifactInspection(
		createDesktopArtifactInspectionResult(evidence),
	);
	assert.match(lines.join("\n"), /provenance.*verified/i);
	assert.match(lines.join("\n"), /signature presence.*present/i);
	assert.match(lines.join("\n"), /signature validity.*not-run/i);
	assert.match(lines.join("\n"), /patch receipt.*absent/i);
	assert.match(lines.join("\n"), /activation.*not-authorized/i);
	assert.doesNotMatch(lines.join("\n"), /Users|AppData|private-user/);
});
