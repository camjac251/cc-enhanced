import assert from "node:assert/strict";
import { test } from "node:test";
import { SELF_HOSTED_RUNNER_CANDIDATE_TAGS } from "../profiles/self-hosted-runner.js";
import type { SelfHostedImageReceipt } from "./image.js";
import type { SelfHostedWrapperReceipt } from "./wrapper.js";
import {
	bindSelfHostedWrapperImageInputs,
	createSelfHostedWrapperImageArchive,
	SELF_HOSTED_WRAPPER_IMAGE_FILESYSTEM_CHANGES,
	type SelfHostedWrapperImageReceipt,
	validateSelfHostedWrapperImageChanges,
	validateSelfHostedWrapperImageReceipt,
} from "./wrapper-image.js";

const sha = (value: string): string => value.repeat(64);
const imageId = (value: string): string => `sha256:${sha(value)}`;
const runtimeTags = SELF_HOSTED_RUNNER_CANDIDATE_TAGS.filter(
	(tag) => tag !== "signature",
);

function parentReceipt(): SelfHostedImageReceipt {
	return {
		schemaVersion: 1,
		surface: "self-hosted-runner",
		profile: "self-hosted-runner",
		upstreamVersion: "2.1.238",
		platform: "linux-x64",
		base: {
			reference: `ubuntu@${imageId("a")}`,
			imageId: imageId("a"),
			os: "linux",
			architecture: "amd64",
			pull: "not-run",
		},
		source: {
			matrixReceiptSha256: sha("b"),
			hostReceiptSha256: sha("c"),
			binarySha256: sha("d"),
			runtimeTags: [...runtimeTags],
		},
		context: {
			dockerfileSha256: sha("e"),
			entries: ["Dockerfile", "claude"],
			textSecretScan: {
				tool: "gitleaks",
				version: "8.30.1",
				status: "pass",
			},
		},
		image: {
			id: imageId("f"),
			tags: [],
			user: "65532:65532",
			workingDirectory: "/workspace",
			entrypoint: ["/usr/local/bin/claude"],
			defaultCommand: ["--version"],
			environmentNames: ["HOME", "PATH"],
			layerCount: 5,
		},
		dependencies: {
			git: "git version 2.43.0",
			ssh: "OpenSSH_9.6p1",
			caCertificates: "20260601",
		},
		runtime: {
			defaultExecution: "pass",
			version: "2.1.238",
			tags: [...runtimeTags],
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
		createdAt: "2026-08-22T10:00:00.000Z",
	};
}

function wrapperReceipt(): SelfHostedWrapperReceipt {
	return {
		schemaVersion: 1,
		surface: "self-hosted-runner",
		wrapper: {
			scriptSha256: sha("1"),
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
		createdAt: "2026-08-22T11:00:00.000Z",
	};
}

function sampleReceipt(): SelfHostedWrapperImageReceipt {
	return {
		schemaVersion: 1,
		surface: "self-hosted-runner",
		profile: "self-hosted-runner",
		upstreamVersion: "2.1.238",
		platform: "linux-x64",
		parent: {
			receiptSha256: sha("2"),
			imageId: imageId("f"),
			binarySha256: sha("d"),
			layerCount: 5,
		},
		wrapper: {
			receiptSha256: sha("3"),
			scriptSha256: sha("1"),
			imagePath: "/usr/local/bin/claude-session-wrapper",
			mode: "0755",
			owner: "65532:65532",
			configurationFlag: "--exec-path",
			configurationEnvironment: "SELF_HOSTED_RUNNER_EXEC_PATH",
			binarySource: "CLAUDE_RUNNER_CLAUDE_BIN",
			handoff: "exec",
		},
		context: {
			wrapperSha256: sha("1"),
			entries: ["claude-session-wrapper"],
			textSecretScan: {
				tool: "gitleaks",
				version: "8.30.1",
				status: "pass",
			},
		},
		image: {
			id: imageId("5"),
			tags: [],
			user: "65532:65532",
			workingDirectory: "/workspace",
			entrypoint: ["/usr/local/bin/claude"],
			defaultCommand: ["--version"],
			environmentNames: ["HOME", "PATH"],
			parentLayerCount: 5,
			layerCount: 6,
		},
		runtime: {
			directDefault: "pass",
			wrapperVersion: "pass",
			runnerHelp: "pass",
			execPathFlag: "present",
			version: "2.1.238",
			tags: [...runtimeTags],
			wrapperScriptSha256: sha("1"),
			wrapperMode: "0755",
			network: "none",
			rootFilesystem: "read-only",
			capabilities: "dropped",
			noNewPrivileges: true,
		},
		verification: {
			parentBinding: "pass",
			wrapperBinding: "pass",
			assembly: "pass",
			metadataSecretScan: "pass",
			configurationInheritance: "pass",
			wrapperInstallation: "pass",
			directVersion: "pass",
			wrapperVersion: "pass",
			runnerHelp: "pass",
		},
		build: {
			method: "stopped-container-commit",
			parentPull: "not-run",
			parentTag: "not-run",
			parentSave: "not-run",
			parentLoad: "not-run",
			registryPush: "not-run",
			packageNetwork: "not-used",
			assemblyContainerState: "created",
			assemblyRootFilesystem: "writable",
			assemblyContainerStart: "not-run",
			assemblyContainerRemoval: "pass",
			filesystemChanges: [...SELF_HOSTED_WRAPPER_IMAGE_FILESYSTEM_CHANGES],
			untaggedCommit: "pass",
			provenanceAttestation: "not-generated",
			sbom: "not-generated",
		},
		boundaries: {
			actualRunnerProvidedBinary: "not-run",
			runnerStart: "not-run",
			runnerRegistration: "not-run",
			liveControlChannel: "not-run",
			environmentKey: "not-accessed",
			organizationState: "not-accessed",
			tokenRotation: "not-run",
			sessionAttachment: "not-run",
			childSession: "not-run",
			doctor: "not-run",
			deployment: "not-run",
			endToEnd: "not-run",
			clientProbe: "not-run",
		},
		createdAt: "2026-08-22T12:00:00.000Z",
	};
}

test("wrapper image binding requires exact parent and wrapper receipts", () => {
	const parent = parentReceipt();
	const wrapper = wrapperReceipt();
	const binding = bindSelfHostedWrapperImageInputs({
		parent,
		wrapper,
		parentReceiptSha256: sha("2"),
		wrapperReceiptSha256: sha("3"),
		wrapperScriptSha256: wrapper.wrapper.scriptSha256,
	});

	assert.equal(binding.upstreamVersion, "2.1.238");
	assert.equal(binding.parentImageId, parent.image.id);
	assert.equal(binding.binarySha256, parent.source.binarySha256);
	assert.equal(binding.wrapperScriptSha256, wrapper.wrapper.scriptSha256);
	assert.deepEqual(binding.runtimeTags, runtimeTags);

	assert.throws(
		() =>
			bindSelfHostedWrapperImageInputs({
				parent,
				wrapper,
				parentReceiptSha256: sha("2"),
				wrapperReceiptSha256: sha("3"),
				wrapperScriptSha256: sha("9"),
			}),
		/wrapper script hash/i,
	);
});

test("stopped-container assembly permits only the wrapper addition", () => {
	assert.deepEqual(
		validateSelfHostedWrapperImageChanges(
			SELF_HOSTED_WRAPPER_IMAGE_FILESYSTEM_CHANGES,
		),
		SELF_HOSTED_WRAPPER_IMAGE_FILESYSTEM_CHANGES,
	);
	assert.throws(() =>
		validateSelfHostedWrapperImageChanges([
			...SELF_HOSTED_WRAPPER_IMAGE_FILESYSTEM_CHANGES,
			"C /workspace",
		]),
	);
	assert.throws(() =>
		validateSelfHostedWrapperImageChanges([
			SELF_HOSTED_WRAPPER_IMAGE_FILESYSTEM_CHANGES[1],
			SELF_HOSTED_WRAPPER_IMAGE_FILESYSTEM_CHANGES[0],
			...SELF_HOSTED_WRAPPER_IMAGE_FILESYSTEM_CHANGES.slice(2),
		]),
	);
	assert.throws(() =>
		validateSelfHostedWrapperImageChanges([
			...SELF_HOSTED_WRAPPER_IMAGE_FILESYSTEM_CHANGES,
			SELF_HOSTED_WRAPPER_IMAGE_FILESYSTEM_CHANGES[3],
		]),
	);
});

test("wrapper archive is deterministic POSIX tar with numeric ownership", () => {
	const script = new TextEncoder().encode("#!/bin/sh\nexec true\n");
	const archive = createSelfHostedWrapperImageArchive(script);
	const repeated = createSelfHostedWrapperImageArchive(script);
	const decoder = new TextDecoder();
	const field = (start: number, end: number): string =>
		decoder.decode(archive.subarray(start, end)).replace(/\0.*$/, "");

	assert.deepEqual(archive, repeated);
	assert.equal(archive.byteLength, 2_048);
	assert.equal(field(0, 100), "claude-session-wrapper");
	assert.equal(Number.parseInt(field(100, 108), 8), 0o755);
	assert.equal(Number.parseInt(field(108, 116), 8), 65_532);
	assert.equal(Number.parseInt(field(116, 124), 8), 65_532);
	assert.equal(Number.parseInt(field(124, 136), 8), script.byteLength);
	assert.equal(field(257, 263), "ustar");
	assert.deepEqual(archive.subarray(512, 512 + script.byteLength), script);
	assert.ok(archive.subarray(1_024).every((byte) => byte === 0));

	const expectedChecksum = Number.parseInt(field(148, 156), 8);
	const header = archive.slice(0, 512);
	header.fill(0x20, 148, 156);
	assert.equal(
		header.reduce((sum, byte) => sum + byte, 0),
		expectedChecksum,
	);
});

test("wrapper image receipt is exact, path-free, and live-closed", () => {
	const receipt = sampleReceipt();
	assert.deepEqual(validateSelfHostedWrapperImageReceipt(receipt), receipt);
	assert.doesNotMatch(JSON.stringify(receipt), /\/home\/|[A-Z]:\\|https?:\/\//);

	for (const invalid of [
		{ ...receipt, unexpected: "pass" },
		{ ...receipt, parent: { ...receipt.parent, layerCount: 6 } },
		{ ...receipt, wrapper: { ...receipt.wrapper, mode: "0777" } },
		{
			...receipt,
			image: { ...receipt.image, defaultCommand: ["self-hosted-runner"] },
		},
		{
			...receipt,
			runtime: { ...receipt.runtime, execPathFlag: "missing" },
		},
		{
			...receipt,
			build: { ...receipt.build, assemblyContainerStart: "pass" },
		},
		{
			...receipt,
			boundaries: { ...receipt.boundaries, runnerStart: "pass" },
		},
	]) {
		assert.throws(() => validateSelfHostedWrapperImageReceipt(invalid));
	}
});
