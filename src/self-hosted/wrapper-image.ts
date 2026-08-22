import { SELF_HOSTED_RUNNER_CANDIDATE_TAGS } from "../profiles/self-hosted-runner.js";
import {
	SELF_HOSTED_IMAGE_DEFAULT_COMMAND,
	SELF_HOSTED_IMAGE_ENTRYPOINT,
	SELF_HOSTED_IMAGE_PLATFORM,
	SELF_HOSTED_IMAGE_USER,
	SELF_HOSTED_IMAGE_WORKDIR,
	type SelfHostedImageReceipt,
	type SelfHostedImageSecretScan,
	validateSelfHostedImageReceipt,
} from "./image.js";
import {
	type SelfHostedWrapperReceipt,
	validateSelfHostedWrapperReceipt,
} from "./wrapper.js";

export const SELF_HOSTED_WRAPPER_IMAGE_RECEIPT_SCHEMA_VERSION = 1 as const;
export const SELF_HOSTED_WRAPPER_IMAGE_PATH =
	"/usr/local/bin/claude-session-wrapper" as const;
export const SELF_HOSTED_WRAPPER_IMAGE_MODE = "0755" as const;
export const SELF_HOSTED_WRAPPER_IMAGE_OWNER = "65532:65532" as const;
export const SELF_HOSTED_WRAPPER_IMAGE_FILESYSTEM_CHANGES = [
	"C /usr",
	"C /usr/local",
	"C /usr/local/bin",
	`A ${SELF_HOSTED_WRAPPER_IMAGE_PATH}`,
] as const;
export const SELF_HOSTED_WRAPPER_CONFIGURATION_FLAG = "--exec-path" as const;
export const SELF_HOSTED_WRAPPER_CONFIGURATION_ENVIRONMENT =
	"SELF_HOSTED_RUNNER_EXEC_PATH" as const;

const SHA256_RE = /^[a-f0-9]{64}$/;
const IMAGE_ID_RE = /^sha256:[a-f0-9]{64}$/;
const LOCAL_PATH_RE = /(?:\/home\/|\/Users\/|[A-Za-z]:\\Users\\)/;
const SENSITIVE_VALUE_RE =
	/(?:ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_ENVIRONMENT_KEY|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:password|token|secret|api[_-]?key)\s*[=:])/i;
const RUNTIME_TAGS = SELF_HOSTED_RUNNER_CANDIDATE_TAGS.filter(
	(tag) => tag !== "signature",
);
const TAR_BLOCK_BYTES = 512;
const TAR_END_BLOCKS = 2;
const MAX_WRAPPER_ARCHIVE_SOURCE_BYTES = 64 * 1024;

function writeTarAscii(
	target: Uint8Array,
	offset: number,
	length: number,
	value: string,
): void {
	const bytes = new TextEncoder().encode(value);
	if (bytes.byteLength > length) {
		throw new Error("Wrapper archive field exceeds the POSIX tar limit");
	}
	target.set(bytes, offset);
}

function writeTarOctal(
	target: Uint8Array,
	offset: number,
	length: number,
	value: number,
): void {
	const octal = value.toString(8);
	if (octal.length > length - 1) {
		throw new Error("Wrapper archive number exceeds the POSIX tar limit");
	}
	writeTarAscii(target, offset, length, `${octal.padStart(length - 1, "0")}\0`);
}

export function createSelfHostedWrapperImageArchive(
	script: Uint8Array,
): Uint8Array {
	if (
		script.byteLength < 1 ||
		script.byteLength > MAX_WRAPPER_ARCHIVE_SOURCE_BYTES
	) {
		throw new Error("Wrapper archive source has an invalid size");
	}
	const paddedSourceBytes =
		Math.ceil(script.byteLength / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
	const archive = new Uint8Array(
		TAR_BLOCK_BYTES + paddedSourceBytes + TAR_END_BLOCKS * TAR_BLOCK_BYTES,
	);
	writeTarAscii(archive, 0, 100, "claude-session-wrapper");
	writeTarOctal(archive, 100, 8, 0o755);
	writeTarOctal(archive, 108, 8, 65_532);
	writeTarOctal(archive, 116, 8, 65_532);
	writeTarOctal(archive, 124, 12, script.byteLength);
	writeTarOctal(archive, 136, 12, 0);
	archive.fill(0x20, 148, 156);
	archive[156] = "0".charCodeAt(0);
	writeTarAscii(archive, 257, 6, "ustar\0");
	writeTarAscii(archive, 263, 2, "00");
	const checksum = archive
		.subarray(0, TAR_BLOCK_BYTES)
		.reduce((sum, byte) => sum + byte, 0);
	writeTarAscii(archive, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
	archive.set(script, TAR_BLOCK_BYTES);
	return archive;
}

export interface SelfHostedWrapperImageBinding {
	profile: "self-hosted-runner";
	upstreamVersion: string;
	platform: typeof SELF_HOSTED_IMAGE_PLATFORM;
	parentReceiptSha256: string;
	parentImageId: string;
	parentLayerCount: number;
	binarySha256: string;
	wrapperReceiptSha256: string;
	wrapperScriptSha256: string;
	runtimeTags: string[];
}

export interface SelfHostedWrapperImageReceipt {
	schemaVersion: typeof SELF_HOSTED_WRAPPER_IMAGE_RECEIPT_SCHEMA_VERSION;
	surface: "self-hosted-runner";
	profile: "self-hosted-runner";
	upstreamVersion: string;
	platform: typeof SELF_HOSTED_IMAGE_PLATFORM;
	parent: {
		receiptSha256: string;
		imageId: string;
		binarySha256: string;
		layerCount: number;
	};
	wrapper: {
		receiptSha256: string;
		scriptSha256: string;
		imagePath: typeof SELF_HOSTED_WRAPPER_IMAGE_PATH;
		mode: typeof SELF_HOSTED_WRAPPER_IMAGE_MODE;
		owner: typeof SELF_HOSTED_WRAPPER_IMAGE_OWNER;
		configurationFlag: typeof SELF_HOSTED_WRAPPER_CONFIGURATION_FLAG;
		configurationEnvironment: typeof SELF_HOSTED_WRAPPER_CONFIGURATION_ENVIRONMENT;
		binarySource: "CLAUDE_RUNNER_CLAUDE_BIN";
		handoff: "exec";
	};
	context: {
		wrapperSha256: string;
		entries: ["claude-session-wrapper"];
		textSecretScan: SelfHostedImageSecretScan;
	};
	image: {
		id: string;
		tags: [];
		user: typeof SELF_HOSTED_IMAGE_USER;
		workingDirectory: typeof SELF_HOSTED_IMAGE_WORKDIR;
		entrypoint: ["/usr/local/bin/claude"];
		defaultCommand: ["--version"];
		environmentNames: ["HOME", "PATH"];
		parentLayerCount: number;
		layerCount: number;
	};
	runtime: {
		directDefault: "pass";
		wrapperVersion: "pass";
		runnerHelp: "pass";
		execPathFlag: "present";
		version: string;
		tags: string[];
		wrapperScriptSha256: string;
		wrapperMode: typeof SELF_HOSTED_WRAPPER_IMAGE_MODE;
		network: "none";
		rootFilesystem: "read-only";
		capabilities: "dropped";
		noNewPrivileges: true;
	};
	verification: {
		parentBinding: "pass";
		wrapperBinding: "pass";
		assembly: "pass";
		metadataSecretScan: "pass";
		configurationInheritance: "pass";
		wrapperInstallation: "pass";
		directVersion: "pass";
		wrapperVersion: "pass";
		runnerHelp: "pass";
	};
	build: {
		method: "stopped-container-commit";
		parentPull: "not-run";
		parentTag: "not-run";
		parentSave: "not-run";
		parentLoad: "not-run";
		registryPush: "not-run";
		packageNetwork: "not-used";
		assemblyContainerState: "created";
		assemblyRootFilesystem: "writable";
		assemblyContainerStart: "not-run";
		assemblyContainerRemoval: "pass";
		filesystemChanges: typeof SELF_HOSTED_WRAPPER_IMAGE_FILESYSTEM_CHANGES;
		untaggedCommit: "pass";
		provenanceAttestation: "not-generated";
		sbom: "not-generated";
	};
	boundaries: {
		actualRunnerProvidedBinary: "not-run";
		runnerStart: "not-run";
		runnerRegistration: "not-run";
		liveControlChannel: "not-run";
		environmentKey: "not-accessed";
		organizationState: "not-accessed";
		tokenRotation: "not-run";
		sessionAttachment: "not-run";
		childSession: "not-run";
		doctor: "not-run";
		deployment: "not-run";
		endToEnd: "not-run";
		clientProbe: "not-run";
	};
	createdAt: string;
}

function assertSha256(value: string, label: string): void {
	if (!SHA256_RE.test(value)) throw new Error(`${label} must be a SHA-256`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
	value: Record<string, unknown>,
	expected: readonly string[],
): boolean {
	const keys = Object.keys(value);
	return (
		keys.length === expected.length &&
		expected.every((key) => Object.hasOwn(value, key))
	);
}

function arraysEqual(
	left: readonly unknown[],
	right: readonly unknown[],
): boolean {
	return (
		left.length === right.length &&
		left.every((value, index) => value === right[index])
	);
}

function collectStringValues(value: unknown, output: string[]): void {
	if (typeof value === "string") {
		output.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectStringValues(item, output);
		return;
	}
	if (isRecord(value)) {
		for (const item of Object.values(value)) collectStringValues(item, output);
	}
}

export function bindSelfHostedWrapperImageInputs(options: {
	parent: SelfHostedImageReceipt;
	wrapper: SelfHostedWrapperReceipt;
	parentReceiptSha256: string;
	wrapperReceiptSha256: string;
	wrapperScriptSha256: string;
}): SelfHostedWrapperImageBinding {
	const parent = validateSelfHostedImageReceipt(options.parent);
	const wrapper = validateSelfHostedWrapperReceipt(options.wrapper);
	assertSha256(options.parentReceiptSha256, "parent receipt hash");
	assertSha256(options.wrapperReceiptSha256, "wrapper receipt hash");
	assertSha256(options.wrapperScriptSha256, "wrapper script hash");
	if (wrapper.wrapper.scriptSha256 !== options.wrapperScriptSha256) {
		throw new Error("Wrapper script hash does not match its receipt");
	}
	if (!arraysEqual(parent.runtime.tags, RUNTIME_TAGS)) {
		throw new Error("Parent image runtime roster is inconsistent");
	}
	return {
		profile: "self-hosted-runner",
		upstreamVersion: parent.upstreamVersion,
		platform: SELF_HOSTED_IMAGE_PLATFORM,
		parentReceiptSha256: options.parentReceiptSha256,
		parentImageId: parent.image.id,
		parentLayerCount: parent.image.layerCount,
		binarySha256: parent.source.binarySha256,
		wrapperReceiptSha256: options.wrapperReceiptSha256,
		wrapperScriptSha256: options.wrapperScriptSha256,
		runtimeTags: [...parent.runtime.tags],
	};
}

export function validateSelfHostedWrapperImageChanges(
	changes: readonly string[],
): typeof SELF_HOSTED_WRAPPER_IMAGE_FILESYSTEM_CHANGES {
	if (
		changes.length !== SELF_HOSTED_WRAPPER_IMAGE_FILESYSTEM_CHANGES.length ||
		!SELF_HOSTED_WRAPPER_IMAGE_FILESYSTEM_CHANGES.every(
			(expected, index) => changes[index] === expected,
		)
	) {
		throw new Error("Assembly container changed files beyond the wrapper");
	}
	return SELF_HOSTED_WRAPPER_IMAGE_FILESYSTEM_CHANGES;
}

export function validateSelfHostedWrapperImageReceipt(
	value: unknown,
): SelfHostedWrapperImageReceipt {
	if (!isRecord(value)) {
		throw new Error("Self-hosted wrapper image receipt must be an object");
	}
	if (
		!hasExactKeys(value, [
			"schemaVersion",
			"surface",
			"profile",
			"upstreamVersion",
			"platform",
			"parent",
			"wrapper",
			"context",
			"image",
			"runtime",
			"verification",
			"build",
			"boundaries",
			"createdAt",
		]) ||
		value.schemaVersion !== SELF_HOSTED_WRAPPER_IMAGE_RECEIPT_SCHEMA_VERSION ||
		value.surface !== "self-hosted-runner" ||
		value.profile !== "self-hosted-runner" ||
		value.platform !== SELF_HOSTED_IMAGE_PLATFORM ||
		typeof value.upstreamVersion !== "string" ||
		!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.upstreamVersion)
	) {
		throw new Error("Self-hosted wrapper image identity is inconsistent");
	}
	const receipt = value as unknown as SelfHostedWrapperImageReceipt;

	if (
		!isRecord(receipt.parent) ||
		!hasExactKeys(receipt.parent, [
			"receiptSha256",
			"imageId",
			"binarySha256",
			"layerCount",
		]) ||
		!IMAGE_ID_RE.test(receipt.parent.imageId) ||
		!Number.isSafeInteger(receipt.parent.layerCount) ||
		receipt.parent.layerCount < 1
	) {
		throw new Error("Wrapper image parent evidence is inconsistent");
	}
	assertSha256(receipt.parent.receiptSha256, "parent receipt hash");
	assertSha256(receipt.parent.binarySha256, "parent binary hash");

	if (
		!isRecord(receipt.wrapper) ||
		!hasExactKeys(receipt.wrapper, [
			"receiptSha256",
			"scriptSha256",
			"imagePath",
			"mode",
			"owner",
			"configurationFlag",
			"configurationEnvironment",
			"binarySource",
			"handoff",
		]) ||
		receipt.wrapper.imagePath !== SELF_HOSTED_WRAPPER_IMAGE_PATH ||
		receipt.wrapper.mode !== SELF_HOSTED_WRAPPER_IMAGE_MODE ||
		receipt.wrapper.owner !== SELF_HOSTED_WRAPPER_IMAGE_OWNER ||
		receipt.wrapper.configurationFlag !==
			SELF_HOSTED_WRAPPER_CONFIGURATION_FLAG ||
		receipt.wrapper.configurationEnvironment !==
			SELF_HOSTED_WRAPPER_CONFIGURATION_ENVIRONMENT ||
		receipt.wrapper.binarySource !== "CLAUDE_RUNNER_CLAUDE_BIN" ||
		receipt.wrapper.handoff !== "exec"
	) {
		throw new Error("Wrapper image script evidence is inconsistent");
	}
	assertSha256(receipt.wrapper.receiptSha256, "wrapper receipt hash");
	assertSha256(receipt.wrapper.scriptSha256, "wrapper script hash");

	if (
		!isRecord(receipt.context) ||
		!hasExactKeys(receipt.context, [
			"wrapperSha256",
			"entries",
			"textSecretScan",
		]) ||
		!arraysEqual(receipt.context.entries, ["claude-session-wrapper"]) ||
		receipt.context.wrapperSha256 !== receipt.wrapper.scriptSha256 ||
		!isRecord(receipt.context.textSecretScan) ||
		!hasExactKeys(receipt.context.textSecretScan, [
			"tool",
			"version",
			"status",
		]) ||
		receipt.context.textSecretScan.tool !== "gitleaks" ||
		!receipt.context.textSecretScan.version.trim() ||
		receipt.context.textSecretScan.status !== "pass"
	) {
		throw new Error("Wrapper image context evidence is inconsistent");
	}
	assertSha256(receipt.context.wrapperSha256, "context wrapper hash");

	if (
		!isRecord(receipt.image) ||
		!hasExactKeys(receipt.image, [
			"id",
			"tags",
			"user",
			"workingDirectory",
			"entrypoint",
			"defaultCommand",
			"environmentNames",
			"parentLayerCount",
			"layerCount",
		]) ||
		!IMAGE_ID_RE.test(receipt.image.id) ||
		receipt.image.id === receipt.parent.imageId ||
		receipt.image.tags.length !== 0 ||
		receipt.image.user !== SELF_HOSTED_IMAGE_USER ||
		receipt.image.workingDirectory !== SELF_HOSTED_IMAGE_WORKDIR ||
		!arraysEqual(receipt.image.entrypoint, SELF_HOSTED_IMAGE_ENTRYPOINT) ||
		!arraysEqual(
			receipt.image.defaultCommand,
			SELF_HOSTED_IMAGE_DEFAULT_COMMAND,
		) ||
		!arraysEqual(receipt.image.environmentNames, ["HOME", "PATH"]) ||
		receipt.image.parentLayerCount !== receipt.parent.layerCount ||
		receipt.image.layerCount !== receipt.parent.layerCount + 1
	) {
		throw new Error("Derived wrapper image configuration is inconsistent");
	}

	if (
		!isRecord(receipt.runtime) ||
		!hasExactKeys(receipt.runtime, [
			"directDefault",
			"wrapperVersion",
			"runnerHelp",
			"execPathFlag",
			"version",
			"tags",
			"wrapperScriptSha256",
			"wrapperMode",
			"network",
			"rootFilesystem",
			"capabilities",
			"noNewPrivileges",
		]) ||
		receipt.runtime.directDefault !== "pass" ||
		receipt.runtime.wrapperVersion !== "pass" ||
		receipt.runtime.runnerHelp !== "pass" ||
		receipt.runtime.execPathFlag !== "present" ||
		receipt.runtime.version !== receipt.upstreamVersion ||
		!arraysEqual(receipt.runtime.tags, RUNTIME_TAGS) ||
		receipt.runtime.wrapperScriptSha256 !== receipt.wrapper.scriptSha256 ||
		receipt.runtime.wrapperMode !== SELF_HOSTED_WRAPPER_IMAGE_MODE ||
		receipt.runtime.network !== "none" ||
		receipt.runtime.rootFilesystem !== "read-only" ||
		receipt.runtime.capabilities !== "dropped" ||
		receipt.runtime.noNewPrivileges !== true
	) {
		throw new Error("Wrapper image runtime evidence is inconsistent");
	}

	if (
		!isRecord(receipt.verification) ||
		!hasExactKeys(receipt.verification, [
			"parentBinding",
			"wrapperBinding",
			"assembly",
			"metadataSecretScan",
			"configurationInheritance",
			"wrapperInstallation",
			"directVersion",
			"wrapperVersion",
			"runnerHelp",
		]) ||
		Object.values(receipt.verification).some((status) => status !== "pass")
	) {
		throw new Error("Wrapper image verification evidence is incomplete");
	}

	if (
		!isRecord(receipt.build) ||
		!hasExactKeys(receipt.build, [
			"method",
			"parentPull",
			"parentTag",
			"parentSave",
			"parentLoad",
			"registryPush",
			"packageNetwork",
			"assemblyContainerState",
			"assemblyRootFilesystem",
			"assemblyContainerStart",
			"assemblyContainerRemoval",
			"filesystemChanges",
			"untaggedCommit",
			"provenanceAttestation",
			"sbom",
		]) ||
		receipt.build.method !== "stopped-container-commit" ||
		receipt.build.parentPull !== "not-run" ||
		receipt.build.parentTag !== "not-run" ||
		receipt.build.parentSave !== "not-run" ||
		receipt.build.parentLoad !== "not-run" ||
		receipt.build.registryPush !== "not-run" ||
		receipt.build.packageNetwork !== "not-used" ||
		receipt.build.assemblyContainerState !== "created" ||
		receipt.build.assemblyRootFilesystem !== "writable" ||
		receipt.build.assemblyContainerStart !== "not-run" ||
		receipt.build.assemblyContainerRemoval !== "pass" ||
		receipt.build.untaggedCommit !== "pass" ||
		receipt.build.provenanceAttestation !== "not-generated" ||
		receipt.build.sbom !== "not-generated"
	) {
		throw new Error("Wrapper image build boundaries are inconsistent");
	}
	validateSelfHostedWrapperImageChanges(receipt.build.filesystemChanges);

	if (
		!isRecord(receipt.boundaries) ||
		!hasExactKeys(receipt.boundaries, [
			"actualRunnerProvidedBinary",
			"runnerStart",
			"runnerRegistration",
			"liveControlChannel",
			"environmentKey",
			"organizationState",
			"tokenRotation",
			"sessionAttachment",
			"childSession",
			"doctor",
			"deployment",
			"endToEnd",
			"clientProbe",
		]) ||
		receipt.boundaries.actualRunnerProvidedBinary !== "not-run" ||
		receipt.boundaries.runnerStart !== "not-run" ||
		receipt.boundaries.runnerRegistration !== "not-run" ||
		receipt.boundaries.liveControlChannel !== "not-run" ||
		receipt.boundaries.environmentKey !== "not-accessed" ||
		receipt.boundaries.organizationState !== "not-accessed" ||
		receipt.boundaries.tokenRotation !== "not-run" ||
		receipt.boundaries.sessionAttachment !== "not-run" ||
		receipt.boundaries.childSession !== "not-run" ||
		receipt.boundaries.doctor !== "not-run" ||
		receipt.boundaries.deployment !== "not-run" ||
		receipt.boundaries.endToEnd !== "not-run" ||
		receipt.boundaries.clientProbe !== "not-run"
	) {
		throw new Error("Wrapper image live authority boundaries are inconsistent");
	}
	if (
		typeof receipt.createdAt !== "string" ||
		Number.isNaN(Date.parse(receipt.createdAt))
	) {
		throw new Error("Wrapper image createdAt must be an ISO timestamp");
	}

	const strings: string[] = [];
	collectStringValues(receipt, strings);
	if (strings.some((item) => LOCAL_PATH_RE.test(item))) {
		throw new Error("Wrapper image receipt contains a host-local path");
	}
	if (strings.some((item) => SENSITIVE_VALUE_RE.test(item))) {
		throw new Error("Wrapper image receipt contains sensitive material");
	}
	return receipt;
}
