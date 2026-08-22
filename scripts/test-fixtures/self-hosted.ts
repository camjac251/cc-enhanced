import { createHash } from "node:crypto";
import {
	createStructuralArtifactReceipt,
	type NativeArtifactMatrixReport,
	type NativeArtifactMatrixRow,
} from "../../src/artifacts/native-evidence.js";
import type { NativeHostReceipt } from "../../src/artifacts/native-host-evidence.js";
import type { PatchProfileReceipt } from "../../src/profiles/contract.js";
import {
	SELF_HOSTED_RUNNER_CANDIDATE_TAGS,
	SELF_HOSTED_RUNNER_EXCLUSIONS,
	SELF_HOSTED_RUNNER_REQUIRED_PROBES,
} from "../../src/profiles/self-hosted-runner.js";
import type { SelfHostedImageReceipt } from "../../src/self-hosted/image.js";
import {
	createSelfHostedWrapperScript,
	type SelfHostedWrapperReceipt,
} from "../../src/self-hosted/wrapper.js";
import type { NativeArtifactPlatform } from "../../src/targets/contract.js";

const VERSION = "9.9.9";
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const CLEAN_SHA256 = "a".repeat(64);
const PATCHED_SHA256 = "b".repeat(64);
const SELF_HOSTED_PLATFORMS = [
	"linux-x64",
	"linux-arm64",
	"linux-x64-musl",
	"linux-arm64-musl",
	"darwin-x64",
	"darwin-arm64",
] as const satisfies readonly NativeArtifactPlatform[];
const RUNTIME_TAGS = SELF_HOSTED_RUNNER_CANDIDATE_TAGS.filter(
	(tag) => tag !== "signature",
);

const profile: PatchProfileReceipt = {
	name: "self-hosted-runner",
	surface: "self-hosted-runner",
	selectedTags: [...SELF_HOSTED_RUNNER_CANDIDATE_TAGS],
	exclusions: SELF_HOSTED_RUNNER_EXCLUSIONS.map((entry) => ({ ...entry })),
	requiredProbes: [...SELF_HOSTED_RUNNER_REQUIRED_PROBES],
};

function matrixRow(
	platform: NativeArtifactPlatform,
	patchedSha256: string,
): NativeArtifactMatrixRow {
	const receipt = createStructuralArtifactReceipt({
		version: VERSION,
		platform,
		upstreamChecksum: CLEAN_SHA256,
		cleanSha256: CLEAN_SHA256,
		patchedSha256,
		profile,
		patcherRevision: "synthetic-test",
		createdAt: CREATED_AT,
	});
	return {
		platform,
		receipt,
		checks: {
			manifestEntry: "pass",
			cleanChecksum: "pass",
			binaryFormat: "pass",
			fullProfile: "pass",
			fixedLayout: "pass",
			outsideRange: "pass",
			reextraction: "pass",
			signing: receipt.signingVerification,
			hostExecution: "not-run",
		},
	};
}

export function createSyntheticSelfHostedMatrix(
	linuxPatchedSha256 = PATCHED_SHA256,
): NativeArtifactMatrixReport {
	return {
		schemaVersion: 1,
		version: VERSION,
		profile: "self-hosted-runner",
		status: "pass",
		generatedAt: CREATED_AT,
		platforms: [...SELF_HOSTED_PLATFORMS],
		rows: SELF_HOSTED_PLATFORMS.map((platform) =>
			matrixRow(
				platform,
				platform === "linux-x64" ? linuxPatchedSha256 : PATCHED_SHA256,
			),
		),
	};
}

export function createSyntheticSelfHostedHost(
	matrix = createSyntheticSelfHostedMatrix(),
): NativeHostReceipt {
	const row = matrix.rows.find(({ platform }) => platform === "linux-x64");
	if (!row) throw new Error("Synthetic matrix is missing linux-x64");
	return {
		schemaVersion: 1,
		targetId: `standalone-cli:linux-x64:${VERSION}`,
		upstreamVersion: VERSION,
		platform: "linux-x64",
		profile: "self-hosted-runner",
		structuralPatchedSha256: row.receipt.patchedSha256,
		finalizedSha256: row.receipt.patchedSha256,
		signingPolicy: "not-required",
		signingVerification: "not-required",
		reextraction: "pass",
		hostExecution: "pass",
		runtimeVersion: VERSION,
		runtimeTags: [...RUNTIME_TAGS],
		warningCodes: [],
		createdAt: CREATED_AT,
	};
}

export function createSyntheticSelfHostedImageReceipt(): SelfHostedImageReceipt {
	const baseDigest = "4".repeat(64);
	return {
		schemaVersion: 1,
		surface: "self-hosted-runner",
		profile: "self-hosted-runner",
		upstreamVersion: VERSION,
		platform: "linux-x64",
		base: {
			reference: `ubuntu@sha256:${baseDigest}`,
			imageId: `sha256:${baseDigest}`,
			os: "linux",
			architecture: "amd64",
			pull: "not-run",
		},
		source: {
			matrixReceiptSha256: "1".repeat(64),
			hostReceiptSha256: "2".repeat(64),
			binarySha256: PATCHED_SHA256,
			runtimeTags: [...RUNTIME_TAGS],
		},
		context: {
			dockerfileSha256: "3".repeat(64),
			entries: ["Dockerfile", "claude"],
			textSecretScan: {
				tool: "gitleaks",
				version: "8.30.1",
				status: "pass",
			},
		},
		image: {
			id: `sha256:${"5".repeat(64)}`,
			tags: [],
			user: "65532:65532",
			workingDirectory: "/workspace",
			entrypoint: ["/usr/local/bin/claude"],
			defaultCommand: ["--version"],
			environmentNames: ["HOME", "PATH"],
			layerCount: 4,
		},
		dependencies: {
			git: "git version 2.43.0",
			ssh: "OpenSSH_9.6p1",
			caCertificates: "20240203",
		},
		runtime: {
			defaultExecution: "pass",
			version: VERSION,
			tags: [...RUNTIME_TAGS],
			network: "none",
			rootFilesystem: "read-only",
			capabilities: "dropped",
			noNewPrivileges: true,
		},
		verification: {
			provenance: "pass",
			base: "pass",
			build: "pass",
			metadataSecretScan: "pass",
			version: "pass",
			dependencies: "pass",
		},
		build: {
			basePull: "not-run",
			registryTag: "not-run",
			registryPush: "not-run",
			packageNetwork: "used",
			provenanceAttestation: "not-generated",
			sbom: "not-generated",
		},
		boundaries: {
			runnerStart: "not-run",
			runnerRegistration: "not-run",
			wrapperControlChannel: "not-run",
			environmentKey: "not-accessed",
			organizationState: "not-accessed",
			childSession: "not-run",
			deployment: "not-run",
			endToEnd: "not-run",
			clientProbe: "not-run",
		},
		createdAt: CREATED_AT,
	};
}

export function createSyntheticSelfHostedWrapperReceipt(): SelfHostedWrapperReceipt {
	return {
		schemaVersion: 1,
		surface: "self-hosted-runner",
		wrapper: {
			scriptSha256: createHash("sha256")
				.update(createSelfHostedWrapperScript())
				.digest("hex"),
			language: "posix-sh",
			binarySource: "CLAUDE_RUNNER_CLAUDE_BIN",
			sourceRequirement: "absolute",
			handoff: "exec",
		},
		staticChecks: {
			shellcheck: { version: "0.9.0", status: "pass" },
			shfmt: { version: "3.11.0", status: "pass" },
		},
		probe: {
			kind: "synthetic-posix-helper",
			unsetSourceGuard: "pass",
			relativeSourceGuard: "pass",
			argv: "pass",
			environment: "pass",
			stdin: "pass",
			activityFileDescriptor3: "pass",
			pidExecHandoff: "pass",
			exitCode: "pass",
			signal: "pass",
		},
		boundaries: {
			imageIntegration: "not-run",
			runnerProvidedBinary: "not-run",
			environmentKey: "not-accessed",
			runnerStart: "not-run",
			childSession: "not-run",
			tokenRotation: "not-run",
			sessionAttachment: "not-run",
			controlPlaneTraffic: "not-sent",
			deployment: "not-run",
			endToEnd: "not-run",
			clientProbe: "not-run",
		},
		createdAt: CREATED_AT,
	};
}
