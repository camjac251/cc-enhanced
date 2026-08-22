import {
	type NativeArtifactMatrixReport,
	validatePassingNativeArtifactMatrix,
} from "../artifacts/native-evidence.js";
import {
	type NativeHostReceipt,
	validateNativeHostReceipt,
} from "../artifacts/native-host-evidence.js";
import { SELF_HOSTED_RUNNER_CANDIDATE_TAGS } from "../profiles/self-hosted-runner.js";

export const SELF_HOSTED_IMAGE_RECEIPT_SCHEMA_VERSION = 1 as const;
export const SELF_HOSTED_IMAGE_PLATFORM = "linux-x64" as const;
export const SELF_HOSTED_IMAGE_USER = "65532:65532" as const;
export const SELF_HOSTED_IMAGE_HOME = "/home/sandbox" as const;
export const SELF_HOSTED_IMAGE_WORKDIR = "/workspace" as const;
export const SELF_HOSTED_IMAGE_ENTRYPOINT = ["/usr/local/bin/claude"] as const;
export const SELF_HOSTED_IMAGE_DEFAULT_COMMAND = ["--version"] as const;

const SELF_HOSTED_NATIVE_PLATFORMS = [
	"linux-x64",
	"linux-arm64",
	"linux-x64-musl",
	"linux-arm64-musl",
	"darwin-x64",
	"darwin-arm64",
] as const;

const SELF_HOSTED_IMAGE_RUNTIME_TAGS = SELF_HOSTED_RUNNER_CANDIDATE_TAGS.filter(
	(tag) => tag !== "signature",
);

const SHA256_RE = /^[a-f0-9]{64}$/;
const IMAGE_ID_RE = /^sha256:[a-f0-9]{64}$/;
const IMMUTABLE_IMAGE_REFERENCE_RE =
	/^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$/;
const LOCAL_PATH_RE = /(?:\/home\/|\/Users\/|[A-Za-z]:\\Users\\)/;
const SENSITIVE_VALUE_RE =
	/(?:ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_ENVIRONMENT_KEY|CLAUDE_RUNNER_ENVIRONMENT_KEY|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:password|token|secret|api[_-]?key)\s*[=:])/i;
const SENSITIVE_ENVIRONMENT_NAME_RE =
	/(?:PASSWORD|TOKEN|SECRET|API_?KEY|AUTH|CREDENTIAL)/i;

export interface SelfHostedImageSourceBinding {
	profile: "self-hosted-runner";
	upstreamVersion: string;
	platform: typeof SELF_HOSTED_IMAGE_PLATFORM;
	matrixReceiptSha256: string;
	hostReceiptSha256: string;
	binarySha256: string;
	runtimeTags: string[];
}

export interface SelfHostedImageSecretScan {
	tool: "gitleaks";
	version: string;
	status: "pass";
}

export interface SelfHostedImageReceipt {
	schemaVersion: typeof SELF_HOSTED_IMAGE_RECEIPT_SCHEMA_VERSION;
	surface: "self-hosted-runner";
	profile: "self-hosted-runner";
	upstreamVersion: string;
	platform: typeof SELF_HOSTED_IMAGE_PLATFORM;
	base: {
		reference: string;
		imageId: string;
		os: "linux";
		architecture: "amd64";
		pull: "not-run";
	};
	source: {
		matrixReceiptSha256: string;
		hostReceiptSha256: string;
		binarySha256: string;
		runtimeTags: string[];
	};
	context: {
		dockerfileSha256: string;
		entries: ["Dockerfile", "claude"];
		textSecretScan: SelfHostedImageSecretScan;
	};
	image: {
		id: string;
		tags: [];
		user: typeof SELF_HOSTED_IMAGE_USER;
		workingDirectory: typeof SELF_HOSTED_IMAGE_WORKDIR;
		entrypoint: ["/usr/local/bin/claude"];
		defaultCommand: ["--version"];
		environmentNames: string[];
		layerCount: number;
	};
	dependencies: {
		git: string;
		ssh: string;
		caCertificates: string;
	};
	runtime: {
		defaultExecution: "pass";
		version: string;
		tags: string[];
		network: "none";
		rootFilesystem: "read-only";
		capabilities: "dropped";
		noNewPrivileges: true;
	};
	verification: {
		provenance: "pass";
		base: "pass";
		build: "pass";
		metadataSecretScan: "pass";
		version: "pass";
		dependencies: "pass";
	};
	build: {
		basePull: "not-run";
		registryTag: "not-run";
		registryPush: "not-run";
		packageNetwork: "used";
		provenanceAttestation: "not-generated";
		sbom: "not-generated";
	};
	boundaries: {
		runnerStart: "not-run";
		runnerRegistration: "not-run";
		wrapperControlChannel: "not-run";
		environmentKey: "not-accessed";
		organizationState: "not-accessed";
		childSession: "not-run";
		deployment: "not-run";
		endToEnd: "not-run";
		clientProbe: "not-run";
	};
	createdAt: string;
}

function arraysEqual(
	left: readonly string[],
	right: readonly string[],
): boolean {
	return (
		left.length === right.length &&
		left.every((value, index) => value === right[index])
	);
}

function assertSha256(value: string, label: string): void {
	if (!SHA256_RE.test(value)) {
		throw new Error(`${label} must be a lowercase SHA-256 digest`);
	}
}

function assertImageId(value: string, label: string): void {
	if (!IMAGE_ID_RE.test(value)) {
		throw new Error(`${label} must be a content-addressed SHA-256 image ID`);
	}
}

export function assertImmutableImageReference(reference: string): void {
	if (!IMMUTABLE_IMAGE_REFERENCE_RE.test(reference)) {
		throw new Error(
			"Self-hosted image base must be an immutable @sha256 reference",
		);
	}
}

export function bindSelfHostedImageSource(options: {
	matrix: NativeArtifactMatrixReport;
	host: NativeHostReceipt;
	matrixReceiptSha256: string;
	hostReceiptSha256: string;
	binarySha256: string;
}): SelfHostedImageSourceBinding {
	validatePassingNativeArtifactMatrix(options.matrix);
	validateNativeHostReceipt(options.host);
	assertSha256(options.matrixReceiptSha256, "matrix receipt hash");
	assertSha256(options.hostReceiptSha256, "host receipt hash");
	assertSha256(options.binarySha256, "finalized artifact hash");

	if (options.matrix.profile !== "self-hosted-runner") {
		throw new Error("Image matrix must use the self-hosted-runner profile");
	}
	if (
		!options.matrix.platforms ||
		!arraysEqual(options.matrix.platforms, SELF_HOSTED_NATIVE_PLATFORMS)
	) {
		throw new Error(
			"Image matrix must contain the exact six self-hosted native platforms",
		);
	}
	const row = options.matrix.rows.find(
		(candidate) => candidate.platform === SELF_HOSTED_IMAGE_PLATFORM,
	);
	if (!row) throw new Error("Image matrix lacks the linux-x64 artifact");
	if (
		row.receipt.profile !== "self-hosted-runner" ||
		!arraysEqual(row.receipt.selectedTags, SELF_HOSTED_RUNNER_CANDIDATE_TAGS)
	) {
		throw new Error("Image matrix patch roster is not the exact full profile");
	}
	if (
		options.host.profile !== "self-hosted-runner" ||
		options.host.platform !== SELF_HOSTED_IMAGE_PLATFORM ||
		options.host.upstreamVersion !== options.matrix.version ||
		options.host.targetId !== row.receipt.targetId ||
		options.host.structuralPatchedSha256 !== row.receipt.patchedSha256
	) {
		throw new Error(
			"Image host receipt does not bind the linux-x64 matrix row",
		);
	}
	if (
		options.host.finalizedSha256 !== options.binarySha256 ||
		row.receipt.patchedSha256 !== options.binarySha256
	) {
		throw new Error(
			"Image finalized artifact hash does not match matrix and host receipts",
		);
	}
	if (!arraysEqual(options.host.runtimeTags, SELF_HOSTED_IMAGE_RUNTIME_TAGS)) {
		throw new Error("Image host runtime patch roster is not exact");
	}

	return {
		profile: "self-hosted-runner",
		upstreamVersion: options.matrix.version,
		platform: SELF_HOSTED_IMAGE_PLATFORM,
		matrixReceiptSha256: options.matrixReceiptSha256,
		hostReceiptSha256: options.hostReceiptSha256,
		binarySha256: options.binarySha256,
		runtimeTags: [...options.host.runtimeTags],
	};
}

export function createSelfHostedImageDockerfile(baseImage: string): string {
	assertImmutableImageReference(baseImage);
	return [
		`FROM ${baseImage}`,
		"RUN apt-get update \\",
		"    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates git openssh-client \\",
		"    && rm -rf /var/lib/apt/lists/*",
		"RUN groupadd --gid 65532 sandbox \\",
		"    && useradd --uid 65532 --gid 65532 --create-home --home-dir /home/sandbox --shell /bin/bash sandbox \\",
		"    && install -d -o 65532 -g 65532 /workspace",
		"COPY --chown=65532:65532 --chmod=0755 claude /usr/local/bin/claude",
		`ENV HOME=${SELF_HOSTED_IMAGE_HOME}`,
		`USER ${SELF_HOSTED_IMAGE_USER}`,
		`WORKDIR ${SELF_HOSTED_IMAGE_WORKDIR}`,
		`ENTRYPOINT [${SELF_HOSTED_IMAGE_ENTRYPOINT.map((value) => JSON.stringify(value)).join(", ")}]`,
		`CMD [${SELF_HOSTED_IMAGE_DEFAULT_COMMAND.map((value) => JSON.stringify(value)).join(", ")}]`,
		"",
	].join("\n");
}

export function assertNoSensitiveImageMetadata(options: {
	environment: readonly string[];
	labels: Readonly<Record<string, string>>;
	history: readonly string[];
	forbiddenPaths: readonly string[];
}): void {
	const metadata = [
		...options.environment,
		...Object.entries(options.labels).flat(),
		...options.history,
	].join("\n");
	if (SENSITIVE_VALUE_RE.test(metadata)) {
		throw new Error("Image metadata contains sensitive material");
	}
	for (const forbiddenPath of options.forbiddenPaths) {
		if (forbiddenPath && metadata.includes(forbiddenPath)) {
			throw new Error("Image metadata contains a host-local path");
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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

function hasExactKeys(
	value: Record<string, unknown>,
	expected: readonly string[],
): boolean {
	return arraysEqual(Object.keys(value).sort(), [...expected].sort());
}

function isStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "string")
	);
}

export function validateSelfHostedImageReceipt(
	value: unknown,
): SelfHostedImageReceipt {
	if (!isRecord(value))
		throw new Error("Self-hosted image receipt must be an object");
	if (value.schemaVersion !== SELF_HOSTED_IMAGE_RECEIPT_SCHEMA_VERSION) {
		throw new Error("Unsupported self-hosted image receipt schemaVersion");
	}
	if (
		value.surface !== "self-hosted-runner" ||
		value.profile !== "self-hosted-runner" ||
		value.platform !== SELF_HOSTED_IMAGE_PLATFORM ||
		typeof value.upstreamVersion !== "string" ||
		!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.upstreamVersion)
	) {
		throw new Error("Self-hosted image identity is inconsistent");
	}

	const receipt = value as unknown as SelfHostedImageReceipt;
	if (!isRecord(receipt.base))
		throw new Error("Image base evidence is invalid");
	assertImmutableImageReference(receipt.base.reference);
	assertImageId(receipt.base.imageId, "base image ID");
	const referencedImageId = receipt.base.reference.slice(
		receipt.base.reference.lastIndexOf("@") + 1,
	);
	if (
		referencedImageId !== receipt.base.imageId ||
		receipt.base.os !== "linux" ||
		receipt.base.architecture !== "amd64" ||
		receipt.base.pull !== "not-run"
	) {
		throw new Error("Image base evidence is inconsistent");
	}

	if (!isRecord(receipt.source))
		throw new Error("Image source evidence is invalid");
	assertSha256(receipt.source.matrixReceiptSha256, "matrix receipt hash");
	assertSha256(receipt.source.hostReceiptSha256, "host receipt hash");
	assertSha256(receipt.source.binarySha256, "image binary hash");
	if (
		!arraysEqual(receipt.source.runtimeTags, SELF_HOSTED_IMAGE_RUNTIME_TAGS)
	) {
		throw new Error("Image source runtime patch roster is inconsistent");
	}

	if (!isRecord(receipt.context)) {
		throw new Error("Image context evidence is invalid");
	}
	assertSha256(receipt.context.dockerfileSha256, "Dockerfile hash");
	if (
		!arraysEqual(receipt.context.entries, ["Dockerfile", "claude"]) ||
		!isRecord(receipt.context.textSecretScan) ||
		receipt.context.textSecretScan.tool !== "gitleaks" ||
		!receipt.context.textSecretScan.version.trim() ||
		receipt.context.textSecretScan.status !== "pass"
	) {
		throw new Error("Image context scan evidence is inconsistent");
	}

	if (!isRecord(receipt.image))
		throw new Error("Built image evidence is invalid");
	assertImageId(receipt.image.id, "built image ID");
	if (
		receipt.image.tags.length !== 0 ||
		receipt.image.user !== SELF_HOSTED_IMAGE_USER ||
		receipt.image.workingDirectory !== SELF_HOSTED_IMAGE_WORKDIR ||
		!arraysEqual(receipt.image.entrypoint, SELF_HOSTED_IMAGE_ENTRYPOINT) ||
		!arraysEqual(
			receipt.image.defaultCommand,
			SELF_HOSTED_IMAGE_DEFAULT_COMMAND,
		) ||
		!isStringArray(receipt.image.environmentNames) ||
		!arraysEqual(receipt.image.environmentNames, ["HOME", "PATH"]) ||
		receipt.image.environmentNames.some((name) =>
			SENSITIVE_ENVIRONMENT_NAME_RE.test(name),
		) ||
		!Number.isSafeInteger(receipt.image.layerCount) ||
		receipt.image.layerCount < 1
	) {
		throw new Error("Built image runtime configuration is inconsistent");
	}

	if (
		!isRecord(receipt.dependencies) ||
		!/^git version \S+/.test(receipt.dependencies.git) ||
		!/^OpenSSH_\S+/.test(receipt.dependencies.ssh) ||
		!receipt.dependencies.caCertificates.trim()
	) {
		throw new Error("Image dependency evidence is inconsistent");
	}
	if (
		!isRecord(receipt.runtime) ||
		receipt.runtime.defaultExecution !== "pass" ||
		receipt.runtime.version !== receipt.upstreamVersion ||
		!arraysEqual(receipt.runtime.tags, SELF_HOSTED_IMAGE_RUNTIME_TAGS) ||
		!arraysEqual(receipt.runtime.tags, receipt.source.runtimeTags) ||
		receipt.runtime.network !== "none" ||
		receipt.runtime.rootFilesystem !== "read-only" ||
		receipt.runtime.capabilities !== "dropped" ||
		receipt.runtime.noNewPrivileges !== true
	) {
		throw new Error("Image locked-down runtime evidence is inconsistent");
	}

	if (
		!isRecord(receipt.verification) ||
		!hasExactKeys(receipt.verification, [
			"provenance",
			"base",
			"build",
			"metadataSecretScan",
			"version",
			"dependencies",
		]) ||
		Object.values(receipt.verification).some((status) => status !== "pass")
	) {
		throw new Error("Image verification evidence is incomplete");
	}
	if (
		!isRecord(receipt.build) ||
		JSON.stringify(receipt.build) !==
			JSON.stringify({
				basePull: "not-run",
				registryTag: "not-run",
				registryPush: "not-run",
				packageNetwork: "used",
				provenanceAttestation: "not-generated",
				sbom: "not-generated",
			})
	) {
		throw new Error("Image build boundary evidence is inconsistent");
	}
	if (
		!isRecord(receipt.boundaries) ||
		JSON.stringify(receipt.boundaries) !==
			JSON.stringify({
				runnerStart: "not-run",
				runnerRegistration: "not-run",
				wrapperControlChannel: "not-run",
				environmentKey: "not-accessed",
				organizationState: "not-accessed",
				childSession: "not-run",
				deployment: "not-run",
				endToEnd: "not-run",
				clientProbe: "not-run",
			})
	) {
		throw new Error("Image live authority boundaries are inconsistent");
	}
	if (Number.isNaN(Date.parse(receipt.createdAt))) {
		throw new Error(
			"Self-hosted image receipt createdAt must be an ISO timestamp",
		);
	}

	const strings: string[] = [];
	collectStringValues(receipt, strings);
	if (strings.some((item) => LOCAL_PATH_RE.test(item))) {
		throw new Error("Self-hosted image receipt contains a host-local path");
	}
	if (strings.some((item) => SENSITIVE_VALUE_RE.test(item))) {
		throw new Error("Self-hosted image receipt contains sensitive material");
	}
	return receipt;
}
