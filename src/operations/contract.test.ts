import assert from "node:assert/strict";
import { test } from "node:test";
import type { ArtifactReceipt } from "../targets/contract.js";
import {
	createOperationResult,
	OPERATION_RESULT_SCHEMA_VERSION,
} from "./contract.js";

test("operation results expose one versioned GUI and CLI contract", () => {
	const data = { current: null };
	const result = createOperationResult({
		operation: "status",
		ok: true,
		data,
	});

	assert.equal(OPERATION_RESULT_SCHEMA_VERSION, 1);
	assert.deepEqual(result, {
		schemaVersion: 1,
		operation: "status",
		ok: true,
		target: null,
		profile: null,
		artifact: null,
		checks: [],
		warnings: [],
		data,
	});
});

test("Desktop status uses the shared operation envelope", () => {
	const result = createOperationResult({
		operation: "desktop-status",
		ok: true,
		data: { platform: "win32" },
	});

	assert.equal(result.operation, "desktop-status");
	assert.equal(result.schemaVersion, 1);
});

test("Desktop comparison uses the shared operation envelope", () => {
	const result = createOperationResult({
		operation: "desktop-compare",
		ok: false,
		data: { status: "changed" },
	});

	assert.equal(result.operation, "desktop-compare");
	assert.equal(result.schemaVersion, 1);
});

test("Desktop artifact inspection uses the shared operation envelope", () => {
	const result = createOperationResult({
		operation: "desktop-inspect",
		ok: true,
		data: { patchAuthorization: "not-authorized" },
	});

	assert.equal(result.operation, "desktop-inspect");
	assert.equal(result.schemaVersion, 1);
});

test("Desktop SDK contract audit uses the shared operation envelope", () => {
	const result = createOperationResult({
		operation: "desktop-sdk-contract",
		ok: true,
		data: { bundledRuntimeIdentity: "not-proven" },
	});

	assert.equal(result.operation, "desktop-sdk-contract");
	assert.equal(result.schemaVersion, 1);
});

test("Desktop permission probe plan uses the shared operation envelope", () => {
	const result = createOperationResult({
		operation: "desktop-permission-probe-plan",
		ok: true,
		data: { execution: "not-run" },
	});

	assert.equal(result.operation, "desktop-permission-probe-plan");
	assert.equal(result.schemaVersion, 1);
});

test("Desktop permission preflight uses the shared operation envelope", () => {
	const result = createOperationResult({
		operation: "desktop-permission-preflight",
		ok: false,
		data: { readyForStockBaseline: false },
	});

	assert.equal(result.operation, "desktop-permission-preflight");
	assert.equal(result.schemaVersion, 1);
});

test("profile support uses the shared operation envelope", () => {
	const result = createOperationResult({
		operation: "profile-support",
		ok: false,
		data: { readiness: "blocked" },
	});

	assert.equal(result.operation, "profile-support");
	assert.equal(result.schemaVersion, 1);
});

test("Remote Control readiness and launch use the shared operation envelope", () => {
	const readiness = createOperationResult({
		operation: "remote-control-readiness",
		ok: false,
		data: { readyForProbeLaunch: false },
	});
	const launch = createOperationResult({
		operation: "remote-control-launch",
		ok: true,
		data: { status: "exited" },
	});

	assert.equal(readiness.schemaVersion, 1);
	assert.equal(readiness.operation, "remote-control-readiness");
	assert.equal(launch.schemaVersion, 1);
	assert.equal(launch.operation, "remote-control-launch");
});

test("operation results carry a structural artifact receipt unchanged", () => {
	const artifact: ArtifactReceipt = {
		schemaVersion: 1,
		targetId: "standalone-cli:linux-x64:2.1.999",
		upstreamVersion: "2.1.999",
		upstreamPlatform: "linux-x64",
		upstreamChecksum: "a".repeat(64),
		upstreamManifestChecksumVerified: true,
		upstreamManifestSignature: "not-provided",
		cleanSha256: "a".repeat(64),
		patchedSha256: "b".repeat(64),
		profile: "cli-full",
		selectedTags: ["signature"],
		patcherRevision: "revision-123",
		binaryFormat: "elf",
		structuralVerification: "pass",
		signingPolicy: "not-required",
		signingVerification: "not-required",
		hostExecution: "not-run",
		createdAt: "2026-08-20T12:00:00.000Z",
	};
	const result = createOperationResult({
		operation: "native-build",
		ok: true,
		artifact,
		data: { output: "candidate" },
	});

	assert.equal(result.artifact, artifact);
});
