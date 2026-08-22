import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { DesktopCandidateBuildOutput } from "../src/desktop/candidate.js";
import {
	DESKTOP_LOCAL_CANDIDATE_TAGS,
	DESKTOP_LOCAL_EXCLUSIONS,
	DESKTOP_LOCAL_REQUIRED_PROBES,
} from "../src/profiles/desktop-local.js";
import {
	runDesktopCandidateCommand,
	writeDesktopCandidateEvidence,
} from "./desktop-candidate.js";

const scriptPath = path.join(process.cwd(), "scripts", "desktop-candidate.ts");
const cleanSha256 = "a".repeat(64);
const patchedSha256 = "d".repeat(64);
const createdAt = "2026-08-21T12:00:00.000Z";

function candidateOutput(candidatePath = "/repo/.cache/candidate.exe") {
	const profile = {
		name: "desktop-local" as const,
		surface: "desktop-local" as const,
		selectedTags: [...DESKTOP_LOCAL_CANDIDATE_TAGS],
		exclusions: DESKTOP_LOCAL_EXCLUSIONS.map((exclusion) => ({ ...exclusion })),
		requiredProbes: [...DESKTOP_LOCAL_REQUIRED_PROBES],
	};
	return {
		candidatePath,
		fromCache: false,
		profile,
		artifactReceipt: {
			schemaVersion: 1,
			targetId: "desktop-local:win32-x64:2.1.9",
			upstreamVersion: "2.1.9",
			upstreamPlatform: "win32-x64",
			upstreamChecksum: cleanSha256,
			upstreamManifestChecksumVerified: true,
			upstreamManifestSignature: "not-provided",
			cleanSha256,
			patchedSha256,
			profile: "desktop-local",
			selectedTags: [...DESKTOP_LOCAL_CANDIDATE_TAGS],
			patcherRevision: "command-test",
			binaryFormat: "pe",
			structuralVerification: "pass",
			signingPolicy: "unconfigured",
			signingVerification: "not-run",
			hostExecution: "not-run",
			createdAt,
		},
		evidence: {
			schemaVersion: 1,
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
			target: {
				desktopLocatorId: "desktop:1.2.3",
				desktopVersion: "1.2.3",
				packagedAgentSdkVersion: "0.3.4",
				codeLocatorId: "desktop-code:2.1.9",
				codeVersion: "2.1.9",
				platform: "win32",
				nativePlatform: "win32-x64",
				binaryFormat: "pe",
				architecture: "x64",
				size: 96,
				sha256: cleanSha256,
				inventorySelectionReason: "highest-cached",
			},
			profile: {
				...profile,
				supportReadiness: "blocked",
				selectable: false,
				supportedClaims: 0,
			},
			candidate: {
				locatorId: `desktop-candidate:1.2.3:2.1.9:win32-x64:${patchedSha256.slice(0, 12)}`,
				source: "official-release-copy",
				cleanSha256,
				patchedSha256,
				size: 96,
				binaryFormat: "pe",
				patchVerification: "pass",
				structuralVerification: "pass",
				patchReceipt: "verified",
				signingPolicy: "unconfigured",
				signingVerification: "not-run",
				hostExecution: "not-run",
				desktopLaunch: "not-run",
				surfaceCompatibility: "not-evaluated",
			},
			boundaries: {
				separateCandidateCopy: true,
				managedArtifactMutation: "not-authorized",
				signing: "not-authorized",
				activation: "not-authorized",
				desktopLaunch: "not-authorized",
				profilePromotion: "blocked",
				remoteControl: "closed",
				selfHosted: "closed",
			},
			createdAt,
		},
	} satisfies DesktopCandidateBuildOutput;
}

test("Desktop candidate CLI requires the complete evidence chain", () => {
	const result = spawnSync(process.execPath, [scriptPath, "--evidence"], {
		cwd: process.cwd(),
		encoding: "utf8",
		env: process.env,
	});
	assert.notEqual(result.status, 0);
	assert.match(
		result.stderr,
		/inventory|artifact|sdk-contract|probe-plan|stock-baseline/i,
	);
});

test("Desktop candidate CLI rejects a non-repository construction root before reading evidence", () => {
	const result = spawnSync(
		process.execPath,
		[
			scriptPath,
			"--inventory",
			"unread.json",
			"--artifact",
			"unread.json",
			"--sdk-contract",
			"unread.json",
			"--probe-plan",
			"unread.json",
			"--profile-support",
			"unread.json",
			"--stock-preflight",
			"unread.json",
			"--stock-baseline",
			"unread.json",
			"--candidate-root",
			path.join(os.tmpdir(), "desktop-candidates-outside-repository"),
		],
		{ cwd: process.cwd(), encoding: "utf8", env: process.env },
	);
	assert.notEqual(result.status, 0);
	assert.match(
		result.stderr,
		/Candidate root must be .cache[/\\]desktop-candidates/,
	);
	assert.doesNotMatch(result.stderr, /ENOENT|unread[.]json/);
});

test("Desktop candidate command renders path-free evidence and shared result formats", async () => {
	const data = candidateOutput();
	const context = {
		target: data.evidence.target,
		profileSupport: {} as never,
		bindings: data.evidence.bindings,
	};
	const privatePaths = {
		inventoryPath: "/private-user/inventory.json",
		artifactPath: "/private-user/artifact.json",
		sdkContractPath: "/private-user/sdk.json",
		probePlanPath: "/private-user/plan.json",
		profileSupportPath: "/private-user/profile.json",
		stockPreflightPath: "/private-user/preflight.json",
		stockBaselinePath: "/private-user/baseline.json",
	};
	const evidenceOutput =
		"/repo/.cache/desktop-candidates/evidence/desktop-candidate.json";
	const written: Array<{ path: string; evidence: unknown }> = [];
	const dependencies = {
		readContext: async () => context,
		buildCandidate: async () => data,
		buildNative: async () => {
			throw new Error("stub buildNative must not be reached");
		},
		writeEvidence: async (outputPath: string, evidence: unknown) => {
			written.push({ path: outputPath, evidence });
		},
	};
	const evidenceResult = await runDesktopCandidateCommand(
		{
			paths: privatePaths,
			candidateRoot: "/repo/.cache/desktop-candidates",
			evidenceOutput,
			format: "evidence",
		},
		dependencies,
	);
	const jsonResult = await runDesktopCandidateCommand(
		{
			paths: privatePaths,
			candidateRoot: "/repo/.cache/desktop-candidates",
			format: "json",
		},
		dependencies,
	);
	const humanResult = await runDesktopCandidateCommand(
		{
			paths: privatePaths,
			candidateRoot: "/repo/.cache/desktop-candidates",
			format: "human",
		},
		dependencies,
	);

	assert.equal(evidenceResult.exitCode, 0);
	assert.deepEqual(JSON.parse(evidenceResult.output), data.evidence);
	assert.equal(
		JSON.parse(jsonResult.output).operation,
		"desktop-candidate-build",
	);
	assert.match(humanResult.output, /Offline Patched Candidate/);
	assert.match(humanResult.output, /not authorized or run/i);
	assert.equal(JSON.stringify(data.evidence).includes("private-user"), false);
	assert.deepEqual(written, [
		{ path: evidenceOutput, evidence: data.evidence },
	]);
});

test("Desktop candidate evidence writer atomically replaces a regular receipt", async () => {
	const temporaryRoot = await fs.mkdtemp(
		path.join(os.tmpdir(), "desktop-candidate-evidence-"),
	);
	const outputPath = path.join(temporaryRoot, "candidate.json");
	try {
		await fs.writeFile(outputPath, "{}\n", "utf8");
		const evidence = candidateOutput().evidence;
		await writeDesktopCandidateEvidence(outputPath, evidence);
		assert.deepEqual(
			JSON.parse(await fs.readFile(outputPath, "utf8")),
			evidence,
		);
		assert.deepEqual((await fs.readdir(temporaryRoot)).sort(), [
			"candidate.json",
		]);
	} finally {
		await fs.rm(temporaryRoot, { recursive: true, force: true });
	}
});
