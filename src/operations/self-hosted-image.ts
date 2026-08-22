import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	sanitizeArtifactDiagnostic,
	sha256File,
} from "../artifacts/native-evidence.js";
import {
	type NativeHostReceipt,
	parseNativeArtifactMatrixJson,
	parsePatchedVersionOutput,
	validateNativeHostReceipt,
} from "../artifacts/native-host-evidence.js";
import {
	assertImmutableImageReference,
	assertNoSensitiveImageMetadata,
	bindSelfHostedImageSource,
	createSelfHostedImageDockerfile,
	SELF_HOSTED_IMAGE_DEFAULT_COMMAND,
	SELF_HOSTED_IMAGE_ENTRYPOINT,
	SELF_HOSTED_IMAGE_HOME,
	SELF_HOSTED_IMAGE_USER,
	SELF_HOSTED_IMAGE_WORKDIR,
	type SelfHostedImageReceipt,
	type SelfHostedImageSecretScan,
	validateSelfHostedImageReceipt,
} from "../self-hosted/image.js";
import { createOperationResult, type OperationResult } from "./contract.js";

export interface DockerCommandResult {
	stdout: string;
	stderr: string;
}

export interface DockerCommandOptions {
	timeoutMs?: number;
	maxOutputBytes?: number;
	stdin?: Uint8Array;
}

export type DockerCommandRunner = (
	command: string,
	args: readonly string[],
	options?: DockerCommandOptions,
) => Promise<DockerCommandResult>;

export interface DockerImageInspection {
	id: string;
	repoTags: string[];
	os: string;
	architecture: string;
	user: string;
	workingDirectory: string;
	entrypoint: string[];
	defaultCommand: string[];
	environment: string[];
	labels: Record<string, string>;
	rootFsLayers: string[];
}

export interface SelfHostedImageDependencyEvidence {
	git: string;
	ssh: string;
	caCertificates: string;
}

export interface SelfHostedImageEngine {
	inspectImage(reference: string): Promise<DockerImageInspection>;
	buildImage(options: { contextDir: string }): Promise<string>;
	imageHistory(imageId: string): Promise<string[]>;
	runDefault(imageId: string): Promise<string>;
	probeDependencies(
		imageId: string,
	): Promise<SelfHostedImageDependencyEvidence>;
}

export interface SelfHostedImageSecretScanner {
	scanContext(contextDir: string): Promise<SelfHostedImageSecretScan>;
}

export interface SelfHostedImageBuildOptions {
	matrixReceiptPath: string;
	hostReceiptPath: string;
	artifactPath: string;
	contextDir: string;
	allowedContextRoot: string;
	baseImage: string;
}

export interface SelfHostedImageBuildDependencies {
	engine?: SelfHostedImageEngine;
	scanner?: SelfHostedImageSecretScanner;
	now?: () => string;
}

const IMAGE_ID_RE = /^sha256:[a-f0-9]{64}$/;
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string")
		? value
		: [];
}

function parseDockerImageInspection(output: string): DockerImageInspection {
	const parsed = JSON.parse(output) as unknown;
	if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0])) {
		throw new Error("Docker image inspection returned an invalid shape");
	}
	const image = parsed[0];
	const config = isRecord(image.Config) ? image.Config : {};
	const rootFs = isRecord(image.RootFS) ? image.RootFS : {};
	const rawLabels = isRecord(config.Labels) ? config.Labels : {};
	const labels: Record<string, string> = {};
	for (const [key, value] of Object.entries(rawLabels)) {
		if (typeof value !== "string") {
			throw new Error("Docker image labels must contain string values");
		}
		labels[key] = value;
	}
	if (
		typeof image.Id !== "string" ||
		typeof image.Os !== "string" ||
		typeof image.Architecture !== "string"
	) {
		throw new Error("Docker image inspection lacks identity fields");
	}
	return {
		id: image.Id,
		repoTags: stringArray(image.RepoTags),
		os: image.Os,
		architecture: image.Architecture,
		user: typeof config.User === "string" ? config.User : "",
		workingDirectory:
			typeof config.WorkingDir === "string" ? config.WorkingDir : "",
		entrypoint: stringArray(config.Entrypoint),
		defaultCommand: stringArray(config.Cmd),
		environment: stringArray(config.Env),
		labels,
		rootFsLayers: stringArray(rootFs.Layers),
	};
}

export const runBoundedCommand: DockerCommandRunner = async (
	command,
	args,
	options = {},
) => {
	const timeoutMs = options.timeoutMs ?? 60_000;
	const maxOutputBytes = options.maxOutputBytes ?? MAX_COMMAND_OUTPUT_BYTES;
	return await new Promise((resolve, reject) => {
		const child = spawn(command, [...args], {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		let outputBytes = 0;
		let settled = false;
		const finish = (error?: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
			else resolve({ stdout, stderr });
		};
		const append = (stream: "stdout" | "stderr", chunk: Buffer): void => {
			outputBytes += chunk.byteLength;
			if (outputBytes > maxOutputBytes) {
				child.kill();
				finish(new Error(`${command} output exceeded the safety limit`));
				return;
			}
			if (stream === "stdout") stdout += chunk.toString("utf8");
			else stderr += chunk.toString("utf8");
		};
		const timer = setTimeout(() => {
			child.kill();
			finish(new Error(`${command} timed out`));
		}, timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
		child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
		child.once("error", () =>
			finish(new Error(`${command} could not be started`)),
		);
		child.stdin.once("error", (error: NodeJS.ErrnoException) => {
			if (error.code !== "EPIPE") {
				finish(new Error(`${command} stdin failed`));
			}
		});
		child.stdin.end(options.stdin);
		child.once("close", (exitCode) => {
			if (exitCode !== 0) {
				const diagnostic = sanitizeArtifactDiagnostic(
					stderr.trim() || stdout.trim() || `${command} exited ${exitCode}`,
				);
				finish(new Error(`${command} failed: ${diagnostic}`));
				return;
			}
			finish();
		});
	});
};

function lockedDockerRunArgs(imageId: string): string[] {
	return [
		"run",
		"--rm",
		"--network",
		"none",
		"--read-only",
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges",
		"--user",
		SELF_HOSTED_IMAGE_USER,
		"--tmpfs",
		"/tmp:rw,noexec,nosuid,nodev,size=16m",
		imageId,
	];
}

export function createDockerSelfHostedImageEngine(
	runCommand: DockerCommandRunner = runBoundedCommand,
): SelfHostedImageEngine {
	return {
		async inspectImage(reference) {
			const result = await runCommand("docker", [
				"image",
				"inspect",
				reference,
			]);
			return parseDockerImageInspection(result.stdout);
		},
		async buildImage({ contextDir }) {
			const result = await runCommand(
				"docker",
				[
					"build",
					"--quiet",
					"--pull=false",
					"--provenance=false",
					"--sbom=false",
					"--file",
					path.join(contextDir, "Dockerfile"),
					contextDir,
				],
				{ timeoutMs: 10 * 60_000, maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES },
			);
			const imageId = result.stdout.trim();
			if (!IMAGE_ID_RE.test(imageId)) {
				throw new Error(
					"Docker build did not return a content-addressed image ID",
				);
			}
			return imageId;
		},
		async imageHistory(imageId) {
			const result = await runCommand("docker", [
				"image",
				"history",
				"--no-trunc",
				"--format",
				"{{json .CreatedBy}}",
				imageId,
			]);
			return result.stdout
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					const parsed = JSON.parse(line) as unknown;
					if (typeof parsed !== "string") {
						throw new Error("Docker image history contains an invalid row");
					}
					return parsed;
				});
		},
		async runDefault(imageId) {
			const result = await runCommand("docker", lockedDockerRunArgs(imageId), {
				timeoutMs: 30_000,
			});
			return result.stdout;
		},
		async probeDependencies(imageId) {
			const args = lockedDockerRunArgs(imageId);
			args.splice(args.length - 1, 0, "--entrypoint", "/bin/sh");
			args.push(
				"-eu",
				"-c",
				"printf 'git='; git --version; printf 'ssh='; ssh -V 2>&1; printf 'ca='; dpkg-query -W -f='${Version}\\n' ca-certificates",
			);
			const result = await runCommand("docker", args, { timeoutMs: 30_000 });
			const fields = new Map<string, string>();
			for (const line of result.stdout.trim().split("\n")) {
				const separator = line.indexOf("=");
				if (separator > 0) {
					fields.set(line.slice(0, separator), line.slice(separator + 1));
				}
			}
			const git = fields.get("git");
			const ssh = fields.get("ssh");
			const caCertificates = fields.get("ca");
			if (!git || !ssh || !caCertificates) {
				throw new Error("Image dependency probe returned incomplete evidence");
			}
			return { git, ssh, caCertificates };
		},
	};
}

export function createGitleaksSelfHostedImageScanner(
	runCommand: DockerCommandRunner = runBoundedCommand,
): SelfHostedImageSecretScanner {
	return {
		async scanContext(contextDir) {
			const version = (await runCommand("gitleaks", ["version"])).stdout.trim();
			if (!version) throw new Error("gitleaks did not report a version");
			await runCommand(
				"gitleaks",
				[
					"dir",
					"--no-banner",
					"--no-color",
					"--redact=100",
					"--max-target-megabytes",
					"1",
					contextDir,
				],
				{ timeoutMs: 60_000 },
			);
			return { tool: "gitleaks", version, status: "pass" };
		},
	};
}

async function canonicalizePotentialPath(filePath: string): Promise<string> {
	let current = path.resolve(filePath);
	const missing: string[] = [];
	for (;;) {
		try {
			return path.join(await fs.realpath(current), ...missing);
		} catch (error) {
			if (
				typeof error !== "object" ||
				error === null ||
				!("code" in error) ||
				error.code !== "ENOENT"
			) {
				throw error;
			}
			const parent = path.dirname(current);
			if (parent === current) throw error;
			missing.unshift(path.basename(current));
			current = parent;
		}
	}
}

async function assertSafeImagePaths(options: SelfHostedImageBuildOptions) {
	const [matrix, host, artifact, context, allowedRoot] = await Promise.all([
		canonicalizePotentialPath(options.matrixReceiptPath),
		canonicalizePotentialPath(options.hostReceiptPath),
		canonicalizePotentialPath(options.artifactPath),
		canonicalizePotentialPath(options.contextDir),
		canonicalizePotentialPath(options.allowedContextRoot),
	]);
	if (new Set([matrix, host, artifact, context]).size !== 4) {
		throw new Error(
			"Self-hosted image input and output paths must be distinct",
		);
	}
	const relative = path.relative(allowedRoot, context);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error(
			"Self-hosted image context must be inside the allowed root",
		);
	}
}

async function assertPathAbsent(filePath: string): Promise<void> {
	try {
		await fs.lstat(filePath);
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "ENOENT"
		) {
			return;
		}
		throw error;
	}
	throw new Error("Self-hosted image context already exists");
}

function environmentNames(environment: readonly string[]): string[] {
	return [
		...new Set(environment.map((entry) => entry.split("=", 1)[0])),
	].sort();
}

export async function buildSelfHostedImage(
	options: SelfHostedImageBuildOptions,
	dependencies: SelfHostedImageBuildDependencies = {},
): Promise<OperationResult<SelfHostedImageReceipt>> {
	assertImmutableImageReference(options.baseImage);
	await assertSafeImagePaths(options);
	await assertPathAbsent(options.contextDir);

	const [
		matrixJson,
		hostJson,
		matrixReceiptSha256,
		hostReceiptSha256,
		binarySha256,
	] = await Promise.all([
		fs.readFile(options.matrixReceiptPath, "utf8"),
		fs.readFile(options.hostReceiptPath, "utf8"),
		sha256File(options.matrixReceiptPath),
		sha256File(options.hostReceiptPath),
		sha256File(options.artifactPath),
	]);
	const matrix = parseNativeArtifactMatrixJson(matrixJson);
	const host = JSON.parse(hostJson) as NativeHostReceipt;
	validateNativeHostReceipt(host);
	const source = bindSelfHostedImageSource({
		matrix,
		host,
		matrixReceiptSha256,
		hostReceiptSha256,
		binarySha256,
	});

	const engine = dependencies.engine ?? createDockerSelfHostedImageEngine();
	const scanner =
		dependencies.scanner ?? createGitleaksSelfHostedImageScanner();
	const base = await engine.inspectImage(options.baseImage);
	if (base.id !== options.baseImage.slice(options.baseImage.indexOf("@") + 1)) {
		throw new Error(
			"Cached base image ID does not match its exact digest reference",
		);
	}
	if (base.os !== "linux" || base.architecture !== "amd64") {
		throw new Error("Cached base image architecture must be linux amd64");
	}

	await fs.mkdir(path.dirname(options.contextDir), { recursive: true });
	await fs.mkdir(options.contextDir);
	const dockerfilePath = path.join(options.contextDir, "Dockerfile");
	const contextArtifactPath = path.join(options.contextDir, "claude");
	await fs.writeFile(
		dockerfilePath,
		createSelfHostedImageDockerfile(options.baseImage),
		{ flag: "wx" },
	);
	await fs.copyFile(
		options.artifactPath,
		contextArtifactPath,
		fsConstants.COPYFILE_EXCL,
	);
	await fs.chmod(contextArtifactPath, 0o755);
	if ((await sha256File(contextArtifactPath)) !== source.binarySha256) {
		throw new Error("Image context binary changed while copying");
	}
	const entries = (await fs.readdir(options.contextDir)).sort();
	if (JSON.stringify(entries) !== JSON.stringify(["Dockerfile", "claude"])) {
		throw new Error("Self-hosted image context contains unexpected entries");
	}
	const textSecretScan = await scanner.scanContext(options.contextDir);
	const dockerfileSha256 = await sha256File(dockerfilePath);

	const imageId = await engine.buildImage({ contextDir: options.contextDir });
	if (!IMAGE_ID_RE.test(imageId)) {
		throw new Error("Built image lacks a content-addressed image ID");
	}
	const [image, history, versionOutput, dependencyEvidence] = await Promise.all(
		[
			engine.inspectImage(imageId),
			engine.imageHistory(imageId),
			engine.runDefault(imageId),
			engine.probeDependencies(imageId),
		],
	);
	if (
		image.id !== imageId ||
		image.os !== "linux" ||
		image.architecture !== "amd64"
	) {
		throw new Error("Built image identity or architecture is inconsistent");
	}
	if (
		image.repoTags.length !== 0 ||
		image.user !== SELF_HOSTED_IMAGE_USER ||
		image.workingDirectory !== SELF_HOSTED_IMAGE_WORKDIR ||
		JSON.stringify(image.entrypoint) !==
			JSON.stringify(SELF_HOSTED_IMAGE_ENTRYPOINT) ||
		JSON.stringify(image.defaultCommand) !==
			JSON.stringify(SELF_HOSTED_IMAGE_DEFAULT_COMMAND) ||
		!image.environment.includes(`HOME=${SELF_HOSTED_IMAGE_HOME}`)
	) {
		throw new Error("Built image is tagged or has an unsafe runtime default");
	}
	assertNoSensitiveImageMetadata({
		environment: image.environment,
		labels: image.labels,
		history,
		forbiddenPaths: [
			path.resolve(options.matrixReceiptPath),
			path.resolve(options.hostReceiptPath),
			path.resolve(options.artifactPath),
			path.resolve(options.contextDir),
		],
	});

	const runtime = parsePatchedVersionOutput(versionOutput);
	if (
		runtime.version !== source.upstreamVersion ||
		JSON.stringify(runtime.tags) !== JSON.stringify(source.runtimeTags)
	) {
		throw new Error("Image runtime version or patch roster is inconsistent");
	}

	const receipt = validateSelfHostedImageReceipt({
		schemaVersion: 1,
		surface: "self-hosted-runner",
		profile: source.profile,
		upstreamVersion: source.upstreamVersion,
		platform: source.platform,
		base: {
			reference: options.baseImage,
			imageId: base.id,
			os: "linux",
			architecture: "amd64",
			pull: "not-run",
		},
		source: {
			matrixReceiptSha256: source.matrixReceiptSha256,
			hostReceiptSha256: source.hostReceiptSha256,
			binarySha256: source.binarySha256,
			runtimeTags: source.runtimeTags,
		},
		context: {
			dockerfileSha256,
			entries: ["Dockerfile", "claude"],
			textSecretScan,
		},
		image: {
			id: image.id,
			tags: [],
			user: SELF_HOSTED_IMAGE_USER,
			workingDirectory: SELF_HOSTED_IMAGE_WORKDIR,
			entrypoint: [...SELF_HOSTED_IMAGE_ENTRYPOINT],
			defaultCommand: [...SELF_HOSTED_IMAGE_DEFAULT_COMMAND],
			environmentNames: environmentNames(image.environment),
			layerCount: image.rootFsLayers.length,
		},
		dependencies: dependencyEvidence,
		runtime: {
			defaultExecution: "pass",
			version: runtime.version,
			tags: runtime.tags,
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
		createdAt: (dependencies.now ?? (() => new Date().toISOString()))(),
	});

	return createOperationResult({
		operation: "self-hosted-image-build",
		ok: true,
		data: receipt,
		checks: [
			{ id: "source-provenance", status: "pass" },
			{ id: "immutable-base", status: "pass" },
			{ id: "context-secret-scan", status: "pass" },
			{ id: "untagged-build", status: "pass" },
			{ id: "metadata-secret-scan", status: "pass" },
			{ id: "locked-down-version", status: "pass" },
			{ id: "runtime-dependencies", status: "pass" },
		],
	});
}
