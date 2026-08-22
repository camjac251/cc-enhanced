import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	NATIVE_ARTIFACT_PLATFORMS,
	type NativeArtifactPlatform,
} from "../targets/contract.js";
import type {
	NativeArtifactMatrixReport,
	NativeArtifactMatrixRow,
} from "./native-evidence.js";
import {
	finalizeNativeHostArtifact,
	parsePatchedVersionOutput,
	validateNativeHostReceipt,
} from "./native-host-evidence.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function sha256(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

function formatFor(platform: NativeArtifactPlatform): "elf" | "macho" | "pe" {
	if (platform.startsWith("linux-")) return "elf";
	if (platform.startsWith("darwin-")) return "macho";
	return "pe";
}

function matrixRow(
	platform: NativeArtifactPlatform,
	patchedSha256: string,
): NativeArtifactMatrixRow {
	const signingRequired = !platform.startsWith("linux-");
	return {
		platform,
		receipt: {
			schemaVersion: 1,
			targetId: `standalone-cli:${platform}:2.1.238`,
			upstreamVersion: "2.1.238",
			upstreamPlatform: platform,
			upstreamChecksum: SHA_A,
			upstreamManifestChecksumVerified: true,
			upstreamManifestSignature: "not-provided",
			cleanSha256: SHA_A,
			patchedSha256,
			profile: "cli-full",
			selectedTags: ["read-bat", "edit-extended", "signature"],
			patcherRevision: "fixture-revision",
			binaryFormat: formatFor(platform),
			structuralVerification: "pass",
			signingPolicy: signingRequired ? "unconfigured" : "not-required",
			signingVerification: signingRequired ? "not-run" : "not-required",
			hostExecution: "not-run",
			createdAt: "2026-08-20T00:00:00.000Z",
		},
		checks: {
			manifestEntry: "pass",
			cleanChecksum: "pass",
			binaryFormat: "pass",
			fullProfile: "pass",
			fixedLayout: "pass",
			outsideRange: "pass",
			reextraction: "pass",
			signing: signingRequired ? "not-run" : "not-required",
			hostExecution: "not-run",
		},
	};
}

function matrixFor(
	platform: NativeArtifactPlatform,
	patchedSha256: string,
): NativeArtifactMatrixReport {
	return {
		schemaVersion: 1,
		version: "2.1.238",
		profile: "cli-full",
		status: "pass",
		generatedAt: "2026-08-20T00:00:00.000Z",
		rows: NATIVE_ARTIFACT_PLATFORMS.map((candidate) =>
			matrixRow(candidate, candidate === platform ? patchedSha256 : SHA_B),
		),
	};
}

test("patched version parsing preserves exact ordered runtime tags", () => {
	assert.deepEqual(
		parsePatchedVersionOutput(
			"2.1.238 (Claude Code; patched: read-bat, edit-extended)\n",
		),
		{
			version: "2.1.238",
			tags: ["read-bat", "edit-extended"],
		},
	);
	assert.throws(
		() => parsePatchedVersionOutput("2.1.238 (Claude Code)"),
		/patch signature/i,
	);
});

test("host finalization stages a copy and emits no local path data", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-host-pass-"));
	const inputPath = path.join(tempDir, "candidate");
	const stagedPath = path.join(tempDir, "staged");
	const content = Buffer.from("synthetic native candidate", "utf8");
	try {
		await fs.writeFile(inputPath, content);
		const receipt = await finalizeNativeHostArtifact({
			matrix: matrixFor("linux-x64", sha256(content)),
			platform: "linux-x64",
			hostPlatform: "linux-x64",
			artifactPath: inputPath,
			stagedOutputPath: stagedPath,
			policy: { kind: "not-required" },
			extractBundle: () => Buffer.from("(Claude Code; patched:", "utf8"),
			runVersion: async () =>
				"2.1.238 (Claude Code; patched: read-bat, edit-extended)\n",
			createdAt: "2026-08-20T12:00:00.000Z",
		});

		validateNativeHostReceipt(receipt);
		assert.equal(receipt.platform, "linux-x64");
		assert.equal(receipt.structuralPatchedSha256, sha256(content));
		assert.equal(receipt.finalizedSha256, sha256(content));
		assert.equal(receipt.signingPolicy, "not-required");
		assert.equal(receipt.signingVerification, "not-required");
		assert.equal(receipt.reextraction, "pass");
		assert.equal(receipt.hostExecution, "pass");
		assert.deepEqual(receipt.runtimeTags, ["read-bat", "edit-extended"]);
		assert.equal(JSON.stringify(receipt).includes(tempDir), false);
		assert.deepEqual(await fs.readFile(stagedPath), content);
		assert.deepEqual(await fs.readFile(inputPath), content);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("host finalization fails before staging on hash or host mismatch", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "native-host-reject-"),
	);
	const inputPath = path.join(tempDir, "candidate");
	const stagedPath = path.join(tempDir, "staged");
	try {
		await fs.writeFile(inputPath, "candidate", "utf8");
		await assert.rejects(
			finalizeNativeHostArtifact({
				matrix: matrixFor("linux-x64", SHA_B),
				platform: "linux-x64",
				hostPlatform: "linux-x64",
				artifactPath: inputPath,
				stagedOutputPath: stagedPath,
				policy: { kind: "not-required" },
			}),
			/does not match structural receipt/i,
		);
		await assert.rejects(fs.stat(stagedPath));

		await assert.rejects(
			finalizeNativeHostArtifact({
				matrix: matrixFor("linux-x64", sha256(Buffer.from("candidate"))),
				platform: "linux-x64",
				hostPlatform: "linux-arm64",
				artifactPath: inputPath,
				stagedOutputPath: stagedPath,
				policy: { kind: "not-required" },
			}),
			/matching host platform/i,
		);
		await assert.rejects(fs.stat(stagedPath));

		await assert.rejects(
			finalizeNativeHostArtifact({
				matrix: matrixFor("linux-x64", sha256(Buffer.from("candidate"))),
				expectedProfile: "remote-control",
				platform: "linux-x64",
				hostPlatform: "linux-x64",
				artifactPath: inputPath,
				stagedOutputPath: stagedPath,
				policy: { kind: "not-required" },
			}),
			/expected profile remote-control/i,
		);
		await assert.rejects(fs.stat(stagedPath));
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("a failed runtime roster removes only the new staged copy", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "native-host-roster-"),
	);
	const inputPath = path.join(tempDir, "candidate");
	const stagedPath = path.join(tempDir, "staged");
	const content = Buffer.from("candidate", "utf8");
	try {
		await fs.writeFile(inputPath, content);
		await assert.rejects(
			finalizeNativeHostArtifact({
				matrix: matrixFor("linux-x64", sha256(content)),
				platform: "linux-x64",
				hostPlatform: "linux-x64",
				artifactPath: inputPath,
				stagedOutputPath: stagedPath,
				policy: { kind: "not-required" },
				extractBundle: () => Buffer.from("(Claude Code; patched:", "utf8"),
				runVersion: async () => "2.1.238 (Claude Code; patched: read-bat)\n",
			}),
			/runtime patch roster/i,
		);
		await assert.rejects(fs.stat(stagedPath));
		assert.deepEqual(await fs.readFile(inputPath), content);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("host receipt validation binds signing policy to the platform", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "native-host-policy-"),
	);
	const inputPath = path.join(tempDir, "candidate");
	const stagedPath = path.join(tempDir, "staged");
	const content = Buffer.from("candidate", "utf8");
	try {
		await fs.writeFile(inputPath, content);
		const receipt = await finalizeNativeHostArtifact({
			matrix: matrixFor("linux-x64", sha256(content)),
			platform: "linux-x64",
			hostPlatform: "linux-x64",
			artifactPath: inputPath,
			stagedOutputPath: stagedPath,
			policy: { kind: "not-required" },
			extractBundle: () => Buffer.from("(Claude Code; patched:", "utf8"),
			runVersion: async () =>
				"2.1.238 (Claude Code; patched: read-bat, edit-extended)\n",
		});
		assert.throws(
			() =>
				validateNativeHostReceipt({
					...receipt,
					platform: "darwin-x64",
					targetId: "standalone-cli:darwin-x64:2.1.238",
				}),
			/macOS signing evidence is incomplete/i,
		);
		assert.throws(
			() =>
				validateNativeHostReceipt({
					...receipt,
					platform: "linux-forged" as NativeArtifactPlatform,
					targetId: "standalone-cli:linux-forged:2.1.238",
				}),
			/unsupported native artifact platform/i,
		);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("host receipt validation binds warnings exactly to signing policy", () => {
	const baseReceipt = {
		schemaVersion: 1 as const,
		targetId: "standalone-cli:darwin-x64:2.1.238",
		upstreamVersion: "2.1.238",
		platform: "darwin-x64" as const,
		profile: "cli-full",
		structuralPatchedSha256: SHA_A,
		finalizedSha256: SHA_B,
		signingPolicy: "macos-adhoc" as const,
		signingVerification: "pass" as const,
		reextraction: "pass" as const,
		hostExecution: "pass" as const,
		runtimeVersion: "2.1.238",
		runtimeTags: ["read-bat", "edit-extended"],
		warningCodes: ["macos-adhoc-identity"],
		createdAt: "2026-08-20T12:00:00.000Z",
	};

	validateNativeHostReceipt(baseReceipt);
	assert.throws(
		() => validateNativeHostReceipt({ ...baseReceipt, warningCodes: [] }),
		/warning/i,
	);
	assert.throws(
		() =>
			validateNativeHostReceipt({
				...baseReceipt,
				signingPolicy: "macos-identity",
				warningCodes: ["macos-adhoc-identity"],
			}),
		/warning/i,
	);
});
