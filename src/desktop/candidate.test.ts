import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { NativeBuildResult } from "../operations/contract.js";
import { createPatchSurfaceReadiness } from "../profiles/readiness.js";
import type { ArtifactReceipt } from "../targets/contract.js";
import {
	buildDesktopCandidate,
	type DesktopCandidateContext,
	validateDesktopCandidateEvidence,
} from "./candidate.js";

function sha256(contents: Buffer): string {
	return createHash("sha256").update(contents).digest("hex");
}

function syntheticContext(clean: Buffer): DesktopCandidateContext {
	return {
		target: {
			desktopLocatorId: "desktop:1.2.3",
			desktopVersion: "1.2.3",
			packagedAgentSdkVersion: "0.3.4",
			codeLocatorId: "desktop-code:2.1.999",
			codeVersion: "2.1.999",
			platform: "win32",
			nativePlatform: "win32-x64",
			binaryFormat: "pe",
			architecture: "x64",
			size: clean.length,
			sha256: sha256(clean),
			inventorySelectionReason: "highest-cached",
		},
		profileSupport: createPatchSurfaceReadiness("desktop-local"),
		bindings: {
			inventoryFileSha256: "1".repeat(64),
			artifactFileSha256: "2".repeat(64),
			sdkContractFileSha256: "3".repeat(64),
			probePlanFileSha256: "4".repeat(64),
			profileSupportFileSha256: "5".repeat(64),
			stockPreflightFileSha256: "6".repeat(64),
			stockBaselineFileSha256: "7".repeat(64),
			canonicalChain: {
				inventorySha256: "8".repeat(64),
				artifactSha256: "9".repeat(64),
				sdkContractSha256: "a".repeat(64),
				probePlanSha256: "b".repeat(64),
				profileSupportSha256: "c".repeat(64),
			},
		},
	};
}

function artifactReceipt(options: {
	clean: Buffer;
	patched: Buffer;
	selectedTags: string[];
}): ArtifactReceipt {
	return {
		schemaVersion: 1,
		targetId: "standalone-cli:win32-x64:2.1.999",
		upstreamVersion: "2.1.999",
		upstreamPlatform: "win32-x64",
		upstreamChecksum: sha256(options.clean),
		upstreamManifestChecksumVerified: true,
		upstreamManifestSignature: "not-provided",
		cleanSha256: sha256(options.clean),
		patchedSha256: sha256(options.patched),
		profile: "desktop-local",
		selectedTags: options.selectedTags,
		patcherRevision: "synthetic-test",
		binaryFormat: "pe",
		structuralVerification: "pass",
		signingPolicy: "unconfigured",
		signingVerification: "not-run",
		hostExecution: "not-run",
		createdAt: "2026-08-21T12:00:00.000Z",
	};
}

test("Desktop candidate build verifies a distinct path-free offline copy", async () => {
	const candidateRoot = await fs.mkdtemp(
		path.join(os.tmpdir(), "desktop-candidate-"),
	);
	const clean = Buffer.from("clean-data", "utf8");
	const patched = Buffer.from("patch-data", "utf8");
	const sourcePath = path.join(candidateRoot, "2.1.999", "claude.exe");
	const candidatePath = path.join(
		candidateRoot,
		"2.1.999",
		"builds",
		"candidate.exe",
	);
	try {
		await fs.mkdir(path.dirname(candidatePath), { recursive: true });
		await fs.writeFile(sourcePath, clean);
		await fs.writeFile(candidatePath, patched);
		const context = syntheticContext(clean);
		const output = await buildDesktopCandidate({
			context,
			candidateRoot,
			buildNative: async (request): Promise<NativeBuildResult> => {
				assert.equal(request.version, "2.1.999");
				assert.equal(request.platform, "win32-x64");
				assert.equal(request.patchSelection.patches.length, 30);
				assert.equal(
					request.patchSelection.patches.some(
						({ tag }) => tag === "effort-stack",
					),
					false,
				);
				return {
					fetchResult: {
						spec: "2.1.999",
						version: "2.1.999",
						platform: "win32-x64",
						checksum: sha256(clean),
						bucketUrl: "https://example.invalid/releases",
						manifestUrl:
							"https://example.invalid/releases/2.1.999/manifest.json",
						binaryUrl:
							"https://example.invalid/releases/2.1.999/win32-x64/claude.exe",
						manifestPath: path.join(candidateRoot, "manifest.json"),
						binaryPath: sourcePath,
						fromCache: false,
					},
					patchOutputPath: candidatePath,
					artifactReceipt: artifactReceipt({
						clean,
						patched,
						selectedTags: request.patchSelection.receipt.selectedTags,
					}),
					dryRun: false,
				};
			},
		});

		assert.equal(output.candidatePath, await fs.realpath(candidatePath));
		assert.equal(output.profile.name, "desktop-local");
		assert.equal(
			output.artifactReceipt.targetId,
			"desktop-local:win32-x64:2.1.999",
		);
		assert.equal(output.evidence.profile.selectedTags.length, 30);
		assert.equal(output.evidence.profile.exclusions.length, 16);
		assert.deepEqual(
			output.evidence.profile.exclusions.find(
				({ tag }) => tag === "effort-stack",
			),
			{ tag: "effort-stack", reason: "unsupported-runtime" },
		);
		assert.equal(output.evidence.profile.requiredProbes.length, 17);
		assert.equal(output.evidence.boundaries.profilePromotion, "blocked");
		assert.equal(output.evidence.candidate.desktopLaunch, "not-run");
		assert.equal(
			JSON.stringify(output.evidence).includes(candidateRoot),
			false,
		);
		validateDesktopCandidateEvidence(output.evidence, context);
	} finally {
		await fs.rm(candidateRoot, { recursive: true, force: true });
	}
});

test("Desktop candidate build rejects an output outside its candidate root", async () => {
	const candidateRoot = await fs.mkdtemp(
		path.join(os.tmpdir(), "desktop-candidate-root-"),
	);
	const outsideRoot = await fs.mkdtemp(
		path.join(os.tmpdir(), "desktop-candidate-outside-"),
	);
	const clean = Buffer.from("clean-data", "utf8");
	const patched = Buffer.from("patch-data", "utf8");
	const sourcePath = path.join(candidateRoot, "claude.exe");
	const candidatePath = path.join(outsideRoot, "candidate.exe");
	try {
		await fs.writeFile(sourcePath, clean);
		await fs.writeFile(candidatePath, patched);
		const context = syntheticContext(clean);
		await assert.rejects(
			buildDesktopCandidate({
				context,
				candidateRoot,
				buildNative: async (request) => ({
					fetchResult: {
						spec: "2.1.999",
						version: "2.1.999",
						platform: "win32-x64",
						checksum: sha256(clean),
						bucketUrl: "https://example.invalid/releases",
						manifestUrl:
							"https://example.invalid/releases/2.1.999/manifest.json",
						binaryUrl:
							"https://example.invalid/releases/2.1.999/win32-x64/claude.exe",
						manifestPath: path.join(candidateRoot, "manifest.json"),
						binaryPath: sourcePath,
						fromCache: true,
					},
					patchOutputPath: candidatePath,
					artifactReceipt: artifactReceipt({
						clean,
						patched,
						selectedTags: request.patchSelection.receipt.selectedTags,
					}),
					dryRun: false,
				}),
			}),
			/distinct inside the candidate root/i,
		);
	} finally {
		await Promise.all([
			fs.rm(candidateRoot, { recursive: true, force: true }),
			fs.rm(outsideRoot, { recursive: true, force: true }),
		]);
	}
});

test("Desktop candidate evidence rejects invented activation authority", async () => {
	const candidateRoot = await fs.mkdtemp(
		path.join(os.tmpdir(), "desktop-candidate-evidence-"),
	);
	const clean = Buffer.from("clean-data", "utf8");
	const patched = Buffer.from("patch-data", "utf8");
	const sourcePath = path.join(candidateRoot, "claude.exe");
	const candidatePath = path.join(candidateRoot, "candidate.exe");
	try {
		await fs.writeFile(sourcePath, clean);
		await fs.writeFile(candidatePath, patched);
		const context = syntheticContext(clean);
		const output = await buildDesktopCandidate({
			context,
			candidateRoot,
			buildNative: async (request) => ({
				fetchResult: {
					spec: "2.1.999",
					version: "2.1.999",
					platform: "win32-x64",
					checksum: sha256(clean),
					bucketUrl: "https://example.invalid/releases",
					manifestUrl: "https://example.invalid/releases/2.1.999/manifest.json",
					binaryUrl:
						"https://example.invalid/releases/2.1.999/win32-x64/claude.exe",
					manifestPath: path.join(candidateRoot, "manifest.json"),
					binaryPath: sourcePath,
					fromCache: true,
				},
				patchOutputPath: candidatePath,
				artifactReceipt: artifactReceipt({
					clean,
					patched,
					selectedTags: request.patchSelection.receipt.selectedTags,
				}),
				dryRun: false,
			}),
		});
		const invalid = structuredClone(output.evidence) as unknown as {
			boundaries: { activation: string };
		};
		invalid.boundaries.activation = "authorized";
		assert.throws(
			() => validateDesktopCandidateEvidence(invalid),
			/safety boundaries|activation/i,
		);
	} finally {
		await fs.rm(candidateRoot, { recursive: true, force: true });
	}
});
