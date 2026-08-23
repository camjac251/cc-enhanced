import assert from "node:assert/strict";
import { test } from "node:test";
import type { DesktopCandidateBuildOutput } from "../desktop/candidate.js";
import { createDesktopCandidateBuildResult } from "../desktop/status.js";
import {
	DESKTOP_LOCAL_CANDIDATE_TAGS,
	DESKTOP_LOCAL_EXCLUSIONS,
	DESKTOP_LOCAL_REQUIRED_PROBES,
} from "../profiles/desktop-local.js";
import { renderDesktopCandidateBuild } from "./desktop-candidate.js";

const cleanSha256 = "a".repeat(64);
const patchedSha256 = "d".repeat(64);
const createdAt = "2026-08-21T12:00:00.000Z";

function candidateOutput(): DesktopCandidateBuildOutput {
	const profile = {
		name: "desktop-local" as const,
		surface: "desktop-local" as const,
		selectedTags: [...DESKTOP_LOCAL_CANDIDATE_TAGS],
		exclusions: DESKTOP_LOCAL_EXCLUSIONS.map((exclusion) => ({ ...exclusion })),
		requiredProbes: [...DESKTOP_LOCAL_REQUIRED_PROBES],
	};
	return {
		candidatePath: "/repo/.cache/desktop-candidates/2.1.9/builds/candidate.exe",
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
			patcherRevision: "presentation-test",
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
	};
}

test("Desktop candidate presenter reports verified construction without implying activation", () => {
	const output = renderDesktopCandidateBuild(
		createDesktopCandidateBuildResult(candidateOutput()),
	).join("\n");

	assert.match(output, /Offline Patched Candidate/);
	assert.match(output, /constructed and verified/i);
	assert.match(output, /Selected patches:\s+30/);
	assert.match(output, /Excluded patches:\s+16/);
	assert.match(output, /Required live probes:\s+17/);
	assert.match(output, /candidate[.]exe/);
	assert.match(output, /Signing:\s+not-run/);
	assert.match(output, /Desktop launch:\s+not-run/);
	assert.match(output, /Profile promotion:\s+blocked/);
	assert.match(output, /Managed-artifact mutation.*not authorized or run/i);
});
