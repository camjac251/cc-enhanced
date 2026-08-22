import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { DEFAULT_NATIVE_BUCKET } from "../native-release.js";
import {
	inspectDesktopCodeArtifact,
	validateDesktopArtifactInspectionEvidence,
} from "./artifact-inspection.js";
import type { DesktopInventoryEvidence } from "./contract.js";

function createPeFixture(): Buffer {
	const binary = Buffer.alloc(512);
	binary.write("MZ", 0, "ascii");
	binary.writeUInt32LE(0x80, 0x3c);
	binary.write("PE\0\0", 0x80, "binary");
	binary.writeUInt16LE(0x8664, 0x80 + 4);
	binary.writeUInt16LE(0xf0, 0x80 + 4 + 16);
	const optional = 0x80 + 4 + 20;
	binary.writeUInt16LE(0x20b, optional);
	binary.writeUInt32LE(16, optional + 108);
	const securityDirectory = optional + 112 + 4 * 8;
	binary.writeUInt32LE(0x1c0, securityDirectory);
	binary.writeUInt32LE(0x40, securityDirectory + 4);
	return binary;
}

function inventory(binary: Buffer): DesktopInventoryEvidence {
	return {
		schemaVersion: 1,
		platform: "win32",
		desktop: {
			locatorId: "desktop:1.2.3",
			layout: "windows-squirrel",
			version: "1.2.3",
			packagedAgentSdk: { status: "resolved", version: "0.3.4" },
			declaredCodePin: { status: "unresolved", version: null },
			asarMemberCount: 12,
		},
		cachedCode: [
			{
				locatorId: "desktop-code:2.1.235",
				version: "2.1.235",
				platform: "win32-x64",
				binaryFormat: "pe",
				architecture: "x64",
				size: binary.length,
				sha256: createHash("sha256").update(binary).digest("hex"),
				signatureInspection: "not-inspected",
				patchReceiptInspection: "not-inspected",
			},
		],
		selectedCodeLocatorId: "desktop-code:2.1.235",
		selectedCodeReason: "highest-cached",
		createdAt: "2026-08-20T12:00:00.000Z",
	};
}

test("artifact inspection keeps every evidence class separate and path-free", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-artifact-"));
	const cacheRoot = path.join(tempDir, "private-user", "cache");
	const versionRoot = path.join(cacheRoot, "2.1.235");
	const binary = createPeFixture();
	let guardCalls = 0;
	try {
		await fs.mkdir(versionRoot, { recursive: true });
		await fs.writeFile(path.join(versionRoot, "claude.exe"), binary);
		const evidence = await inspectDesktopCodeArtifact({
			inventory: inventory(binary),
			cacheRoot,
			verifyProvenance: true,
			inspectPatchReceipt: true,
			fetchManifestEntry: async () => ({
				version: "2.1.235",
				platform: "win32-x64",
				binary: "claude.exe",
				size: binary.length,
				sha256: createHash("sha256").update(binary).digest("hex"),
				manifestUrl: `${DEFAULT_NATIVE_BUCKET}/2.1.235/manifest.json`,
				manifestSignature: "not-provided",
			}),
			extractBundle: () =>
				Buffer.from("2.1.235 (Claude Code; patched: read-bat, edit-extended)"),
			runHeavyOperation: async (work) => {
				guardCalls += 1;
				return await work();
			},
			inspectedAt: "2026-08-20T13:00:00.000Z",
		});

		assert.equal(guardCalls, 1);
		assert.equal(evidence.artifactBinding, "verified");
		assert.equal(evidence.selectionReason, "highest-cached");
		assert.equal(evidence.patchAuthorization, "not-authorized");
		assert.equal(evidence.provenance.status, "verified");
		assert.equal(evidence.provenance.manifestSignature, "not-provided");
		assert.deepEqual(evidence.platformSignature, {
			presence: "present",
			mechanism: "pe-certificate-table",
			validity: "not-run",
		});
		assert.deepEqual(evidence.patchReceipt, {
			status: "present",
			tags: ["read-bat", "edit-extended"],
		});
		assert.equal(evidence.versionExecution, "not-run");
		assert.equal(evidence.surfaceCompatibility, "not-evaluated");
		assert.doesNotMatch(JSON.stringify(evidence), /private-user|claude[.]exe/);
		validateDesktopArtifactInspectionEvidence(evidence);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("artifact inspection rejects cache bytes that do not rebind to evidence", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "desktop-artifact-mismatch-"),
	);
	const cacheRoot = path.join(tempDir, "cache");
	const versionRoot = path.join(cacheRoot, "2.1.235");
	const binary = createPeFixture();
	try {
		await fs.mkdir(versionRoot, { recursive: true });
		await fs.writeFile(path.join(versionRoot, "claude.exe"), binary);
		const changed = inventory(binary);
		changed.cachedCode[0] = {
			...changed.cachedCode[0],
			sha256: "b".repeat(64),
		};
		await assert.rejects(
			inspectDesktopCodeArtifact({ inventory: changed, cacheRoot }),
			/rebind|inventory evidence/i,
		);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("artifact evidence rejects invented validity and activation authority", () => {
	const invalid = {
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
		patchAuthorization: "authorized",
		artifactBinding: "verified",
		provenance: {
			status: "not-run",
			manifestUrl: null,
			manifestSha256: null,
			manifestSize: null,
			manifestSignature: "not-run",
		},
		platformSignature: {
			presence: "present",
			mechanism: "pe-certificate-table",
			validity: "pass",
		},
		patchReceipt: { status: "not-run", tags: [] },
		versionExecution: "not-run",
		surfaceCompatibility: "not-evaluated",
		inspectedAt: "2026-08-20T13:00:00.000Z",
	};
	assert.throws(
		() => validateDesktopArtifactInspectionEvidence(invalid as never),
		/authorization|validity/i,
	);
});

test("artifact evidence rejects unknown runtime union values", () => {
	const valid = {
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
			status: "not-run",
			manifestUrl: null,
			manifestSha256: null,
			manifestSize: null,
			manifestSignature: "not-run",
		},
		platformSignature: {
			presence: "absent",
			mechanism: "pe-certificate-table",
			validity: "not-run",
		},
		patchReceipt: { status: "not-run", tags: [] },
		versionExecution: "not-run",
		surfaceCompatibility: "not-evaluated",
		inspectedAt: "2026-08-20T13:00:00.000Z",
	};
	assert.throws(
		() =>
			validateDesktopArtifactInspectionEvidence({
				...valid,
				provenance: { ...valid.provenance, status: "invented" },
			} as never),
		/provenance/i,
	);
	assert.throws(
		() =>
			validateDesktopArtifactInspectionEvidence({
				...valid,
				patchReceipt: { status: "invented", tags: [] },
			} as never),
		/patch receipt/i,
	);
	assert.throws(
		() =>
			validateDesktopArtifactInspectionEvidence({
				...valid,
				nativePlatform: "unknown-x64",
			} as never),
		/platform/i,
	);
});
