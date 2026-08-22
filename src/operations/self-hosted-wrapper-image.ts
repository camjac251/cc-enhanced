import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { sha256File } from "../artifacts/native-evidence.js";
import { parsePatchedVersionOutput } from "../artifacts/native-host-evidence.js";
import {
	assertNoSensitiveImageMetadata,
	SELF_HOSTED_IMAGE_DEFAULT_COMMAND,
	SELF_HOSTED_IMAGE_ENTRYPOINT,
	SELF_HOSTED_IMAGE_HOME,
	SELF_HOSTED_IMAGE_USER,
	SELF_HOSTED_IMAGE_WORKDIR,
	type SelfHostedImageSecretScan,
	validateSelfHostedImageReceipt,
} from "../self-hosted/image.js";
import {
	validateSelfHostedWrapperReceipt,
	validateSelfHostedWrapperScript,
} from "../self-hosted/wrapper.js";
import {
	bindSelfHostedWrapperImageInputs,
	createSelfHostedWrapperImageArchive,
	SELF_HOSTED_WRAPPER_CONFIGURATION_ENVIRONMENT,
	SELF_HOSTED_WRAPPER_CONFIGURATION_FLAG,
	type SELF_HOSTED_WRAPPER_IMAGE_FILESYSTEM_CHANGES,
	SELF_HOSTED_WRAPPER_IMAGE_MODE,
	SELF_HOSTED_WRAPPER_IMAGE_OWNER,
	SELF_HOSTED_WRAPPER_IMAGE_PATH,
	type SelfHostedWrapperImageReceipt,
	validateSelfHostedWrapperImageChanges,
	validateSelfHostedWrapperImageReceipt,
} from "../self-hosted/wrapper-image.js";
import { createOperationResult, type OperationResult } from "./contract.js";
import {
	createDockerSelfHostedImageEngine,
	createGitleaksSelfHostedImageScanner,
	type DockerCommandRunner,
	type DockerImageInspection,
	runBoundedCommand,
	type SelfHostedImageSecretScanner,
} from "./self-hosted-image.js";

export interface SelfHostedWrapperImageInspection {
	scriptSha256: string;
	mode: typeof SELF_HOSTED_WRAPPER_IMAGE_MODE;
	owner: typeof SELF_HOSTED_WRAPPER_IMAGE_OWNER;
}

export interface SelfHostedWrapperAssemblyInspection {
	id: string;
	parentImageId: string;
	status: string;
	running: boolean;
	user: string;
	networkMode: string;
	readOnlyRootFilesystem: boolean;
	capabilityDrops: string[];
	securityOptions: string[];
}

export interface SelfHostedWrapperImageEngine {
	inspectImage(reference: string): Promise<DockerImageInspection>;
	createAssemblyContainer(parentImageId: string): Promise<string>;
	copyWrapper(containerId: string, archive: Uint8Array): Promise<void>;
	inspectAssemblyContainer(
		containerId: string,
	): Promise<SelfHostedWrapperAssemblyInspection>;
	listAssemblyChanges(containerId: string): Promise<string[]>;
	commitAssemblyContainer(containerId: string): Promise<string>;
	removeAssemblyContainer(containerId: string): Promise<void>;
	imageHistory(imageId: string): Promise<string[]>;
	runDefault(imageId: string): Promise<string>;
	runWrapperVersion(imageId: string): Promise<string>;
	runRunnerHelp(imageId: string): Promise<string>;
	inspectWrapper(imageId: string): Promise<SelfHostedWrapperImageInspection>;
}

export interface SelfHostedWrapperImageBuildOptions {
	parentReceiptPath: string;
	wrapperReceiptPath: string;
	wrapperPath: string;
	contextDir: string;
	allowedContextRoot: string;
}

export interface SelfHostedWrapperImageBuildDependencies {
	engine?: SelfHostedWrapperImageEngine;
	scanner?: SelfHostedImageSecretScanner;
	now?: () => string;
}

const IMAGE_ID_RE = /^sha256:[a-f0-9]{64}$/;
const CONTAINER_ID_RE = /^[a-f0-9]{64}$/;
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string")
		? value
		: [];
}

function lockedDockerRunArgs(options: {
	imageId: string;
	dockerOptions?: readonly string[];
	commandArgs?: readonly string[];
}): string[] {
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
		...(options.dockerOptions ?? []),
		options.imageId,
		...(options.commandArgs ?? []),
	];
}

function parseWrapperInspection(
	output: string,
): SelfHostedWrapperImageInspection {
	const lines = output.trim().split("\n");
	const scriptSha256 = /^([a-f0-9]{64})\s+/.exec(lines[0] ?? "")?.[1];
	const mode = /^mode=(\d+)$/.exec(lines[1] ?? "")?.[1];
	const owner = /^owner=(\d+:\d+)$/.exec(lines[2] ?? "")?.[1];
	if (
		!scriptSha256 ||
		mode !== "755" ||
		owner !== SELF_HOSTED_WRAPPER_IMAGE_OWNER
	) {
		throw new Error("In-image wrapper inspection is incomplete");
	}
	return {
		scriptSha256,
		mode: SELF_HOSTED_WRAPPER_IMAGE_MODE,
		owner: SELF_HOSTED_WRAPPER_IMAGE_OWNER,
	};
}

function parseAssemblyInspection(
	output: string,
): SelfHostedWrapperAssemblyInspection {
	const parsed = JSON.parse(output) as unknown;
	if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0])) {
		throw new Error("Assembly container inspection returned an invalid shape");
	}
	const container = parsed[0];
	const config = isRecord(container.Config) ? container.Config : {};
	const state = isRecord(container.State) ? container.State : {};
	const hostConfig = isRecord(container.HostConfig) ? container.HostConfig : {};
	if (
		typeof container.Id !== "string" ||
		typeof container.Image !== "string" ||
		typeof state.Status !== "string" ||
		typeof state.Running !== "boolean" ||
		typeof config.User !== "string" ||
		typeof hostConfig.NetworkMode !== "string" ||
		typeof hostConfig.ReadonlyRootfs !== "boolean"
	) {
		throw new Error("Assembly container inspection lacks boundary fields");
	}
	return {
		id: container.Id,
		parentImageId: container.Image,
		status: state.Status,
		running: state.Running,
		user: config.User,
		networkMode: hostConfig.NetworkMode,
		readOnlyRootFilesystem: hostConfig.ReadonlyRootfs,
		capabilityDrops: stringArray(hostConfig.CapDrop),
		securityOptions: stringArray(hostConfig.SecurityOpt),
	};
}

export function createDockerSelfHostedWrapperImageEngine(
	runCommand: DockerCommandRunner = runBoundedCommand,
): SelfHostedWrapperImageEngine {
	const base = createDockerSelfHostedImageEngine(runCommand);
	const wrapperDockerOptions = [
		"--env",
		"CLAUDE_RUNNER_CLAUDE_BIN=/usr/local/bin/claude",
		"--entrypoint",
		SELF_HOSTED_WRAPPER_IMAGE_PATH,
	] as const;
	return {
		inspectImage: base.inspectImage,
		async createAssemblyContainer(parentImageId) {
			const result = await runCommand(
				"docker",
				[
					"container",
					"create",
					"--pull",
					"never",
					"--network",
					"none",
					"--cap-drop",
					"ALL",
					"--security-opt",
					"no-new-privileges",
					"--user",
					SELF_HOSTED_IMAGE_USER,
					parentImageId,
				],
				{ timeoutMs: 30_000 },
			);
			return result.stdout.trim();
		},
		async copyWrapper(containerId, archive) {
			await runCommand(
				"docker",
				["container", "cp", "--archive", "-", `${containerId}:/usr/local/bin`],
				{ timeoutMs: 30_000, stdin: archive },
			);
		},
		async inspectAssemblyContainer(containerId) {
			const result = await runCommand("docker", [
				"container",
				"inspect",
				containerId,
			]);
			return parseAssemblyInspection(result.stdout);
		},
		async listAssemblyChanges(containerId) {
			const result = await runCommand("docker", [
				"container",
				"diff",
				containerId,
			]);
			return result.stdout
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);
		},
		async commitAssemblyContainer(containerId) {
			const result = await runCommand(
				"docker",
				["container", "commit", containerId],
				{ timeoutMs: 10 * 60_000, maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES },
			);
			return result.stdout.trim();
		},
		async removeAssemblyContainer(containerId) {
			await runCommand("docker", ["container", "rm", containerId], {
				timeoutMs: 30_000,
			});
			const remaining = await runCommand("docker", [
				"container",
				"ls",
				"--all",
				"--quiet",
				"--no-trunc",
				"--filter",
				`id=${containerId}`,
			]);
			if (remaining.stdout.trim()) {
				throw new Error("Assembly container still exists after removal");
			}
		},
		imageHistory: base.imageHistory,
		runDefault: base.runDefault,
		async runWrapperVersion(imageId) {
			const result = await runCommand(
				"docker",
				lockedDockerRunArgs({
					imageId,
					dockerOptions: wrapperDockerOptions,
					commandArgs: ["--version"],
				}),
				{ timeoutMs: 30_000 },
			);
			return result.stdout;
		},
		async runRunnerHelp(imageId) {
			const result = await runCommand(
				"docker",
				lockedDockerRunArgs({
					imageId,
					dockerOptions: wrapperDockerOptions,
					commandArgs: ["self-hosted-runner", "--help"],
				}),
				{ timeoutMs: 30_000 },
			);
			return result.stdout;
		},
		async inspectWrapper(imageId) {
			const result = await runCommand(
				"docker",
				lockedDockerRunArgs({
					imageId,
					dockerOptions: ["--entrypoint", "/bin/sh"],
					commandArgs: [
						"-eu",
						"-c",
						`sha256sum ${SELF_HOSTED_WRAPPER_IMAGE_PATH}; stat -c 'mode=%a' ${SELF_HOSTED_WRAPPER_IMAGE_PATH}; stat -c 'owner=%u:%g' ${SELF_HOSTED_WRAPPER_IMAGE_PATH}`,
					],
				}),
				{ timeoutMs: 30_000 },
			);
			return parseWrapperInspection(result.stdout);
		},
	};
}

function environmentNames(environment: readonly string[]): string[] {
	return [
		...new Set(environment.map((entry) => entry.split("=", 1)[0])),
	].sort();
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

async function assertSafePaths(options: SelfHostedWrapperImageBuildOptions) {
	const [parent, wrapperReceipt, wrapper, context, allowedRoot] =
		await Promise.all([
			canonicalizePotentialPath(options.parentReceiptPath),
			canonicalizePotentialPath(options.wrapperReceiptPath),
			canonicalizePotentialPath(options.wrapperPath),
			canonicalizePotentialPath(options.contextDir),
			canonicalizePotentialPath(options.allowedContextRoot),
		]);
	if (new Set([parent, wrapperReceipt, wrapper, context]).size !== 4) {
		throw new Error("Wrapper image inputs and context must be distinct");
	}
	const relative = path.relative(allowedRoot, context);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error("Wrapper image context must be inside the allowed root");
	}
	try {
		await fs.lstat(options.contextDir);
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
	throw new Error("Wrapper image context already exists");
}

function assertParentConfiguration(
	parent: DockerImageInspection,
	expectedId: string,
	expectedLayerCount: number,
): void {
	if (
		parent.id !== expectedId ||
		parent.repoTags.length !== 0 ||
		parent.os !== "linux" ||
		parent.architecture !== "amd64" ||
		parent.user !== SELF_HOSTED_IMAGE_USER ||
		parent.workingDirectory !== SELF_HOSTED_IMAGE_WORKDIR ||
		!arraysEqual(parent.entrypoint, SELF_HOSTED_IMAGE_ENTRYPOINT) ||
		!arraysEqual(parent.defaultCommand, SELF_HOSTED_IMAGE_DEFAULT_COMMAND) ||
		!parent.environment.includes(`HOME=${SELF_HOSTED_IMAGE_HOME}`) ||
		!arraysEqual(environmentNames(parent.environment), ["HOME", "PATH"]) ||
		parent.rootFsLayers.length !== expectedLayerCount
	) {
		throw new Error("Local parent image configuration is inconsistent");
	}
}

function assertDerivedConfiguration(
	parent: DockerImageInspection,
	derived: DockerImageInspection,
): void {
	if (
		derived.id === parent.id ||
		derived.repoTags.length !== 0 ||
		derived.os !== parent.os ||
		derived.architecture !== parent.architecture ||
		derived.user !== parent.user ||
		derived.workingDirectory !== parent.workingDirectory ||
		!arraysEqual(derived.entrypoint, parent.entrypoint) ||
		!arraysEqual(derived.defaultCommand, parent.defaultCommand) ||
		!arraysEqual(derived.environment, parent.environment) ||
		JSON.stringify(derived.labels) !== JSON.stringify(parent.labels) ||
		derived.rootFsLayers.length !== parent.rootFsLayers.length + 1 ||
		!arraysEqual(
			derived.rootFsLayers.slice(0, parent.rootFsLayers.length),
			parent.rootFsLayers,
		)
	) {
		throw new Error("Derived image did not preserve the parent configuration");
	}
}

function assertAssemblyConfiguration(
	assembly: SelfHostedWrapperAssemblyInspection,
	containerId: string,
	parentImageId: string,
): void {
	if (
		assembly.id !== containerId ||
		assembly.parentImageId !== parentImageId ||
		assembly.status !== "created" ||
		assembly.running !== false ||
		assembly.user !== SELF_HOSTED_IMAGE_USER ||
		assembly.networkMode !== "none" ||
		assembly.readOnlyRootFilesystem !== false ||
		!assembly.capabilityDrops.includes("ALL") ||
		!assembly.securityOptions.some((option) =>
			option.startsWith("no-new-privileges"),
		)
	) {
		throw new Error("Assembly container boundaries are inconsistent");
	}
}

export async function buildSelfHostedWrapperImage(
	options: SelfHostedWrapperImageBuildOptions,
	dependencies: SelfHostedWrapperImageBuildDependencies = {},
): Promise<OperationResult<SelfHostedWrapperImageReceipt>> {
	await assertSafePaths(options);
	const [
		parentJson,
		wrapperJson,
		parentReceiptSha256,
		wrapperReceiptSha256,
		wrapperScriptSha256,
		wrapperScript,
		wrapperStat,
	] = await Promise.all([
		fs.readFile(options.parentReceiptPath, "utf8"),
		fs.readFile(options.wrapperReceiptPath, "utf8"),
		sha256File(options.parentReceiptPath),
		sha256File(options.wrapperReceiptPath),
		sha256File(options.wrapperPath),
		fs.readFile(options.wrapperPath, "utf8"),
		fs.stat(options.wrapperPath),
	]);
	const parentReceipt = validateSelfHostedImageReceipt(JSON.parse(parentJson));
	const wrapperReceipt = validateSelfHostedWrapperReceipt(
		JSON.parse(wrapperJson),
	);
	validateSelfHostedWrapperScript(wrapperScript);
	if ((wrapperStat.mode & 0o777) !== 0o755) {
		throw new Error("Wrapper candidate mode must be 0755");
	}
	const binding = bindSelfHostedWrapperImageInputs({
		parent: parentReceipt,
		wrapper: wrapperReceipt,
		parentReceiptSha256,
		wrapperReceiptSha256,
		wrapperScriptSha256,
	});

	const engine =
		dependencies.engine ?? createDockerSelfHostedWrapperImageEngine();
	const scanner =
		dependencies.scanner ?? createGitleaksSelfHostedImageScanner();
	const parentImage = await engine.inspectImage(binding.parentImageId);
	assertParentConfiguration(
		parentImage,
		binding.parentImageId,
		binding.parentLayerCount,
	);

	await fs.mkdir(path.dirname(options.contextDir), { recursive: true });
	await fs.mkdir(options.contextDir);
	const contextWrapperPath = path.join(
		options.contextDir,
		"claude-session-wrapper",
	);
	await fs.copyFile(
		options.wrapperPath,
		contextWrapperPath,
		fsConstants.COPYFILE_EXCL,
	);
	await fs.chmod(contextWrapperPath, 0o755);
	if ((await sha256File(contextWrapperPath)) !== binding.wrapperScriptSha256) {
		throw new Error("Wrapper image context script changed while copying");
	}
	const entries = (await fs.readdir(options.contextDir)).sort();
	if (!arraysEqual(entries, ["claude-session-wrapper"])) {
		throw new Error("Wrapper image context contains unexpected entries");
	}
	const textSecretScan: SelfHostedImageSecretScan = await scanner.scanContext(
		options.contextDir,
	);
	const contextWrapperSha256 = await sha256File(contextWrapperPath);
	const wrapperArchive = createSelfHostedWrapperImageArchive(
		await fs.readFile(contextWrapperPath),
	);

	let assemblyContainerId: string | undefined;
	let imageId: string | undefined;
	let filesystemChanges:
		| typeof SELF_HOSTED_WRAPPER_IMAGE_FILESYSTEM_CHANGES
		| undefined;
	try {
		assemblyContainerId = await engine.createAssemblyContainer(
			binding.parentImageId,
		);
		if (!CONTAINER_ID_RE.test(assemblyContainerId)) {
			throw new Error("Assembly container lacks a content-addressed ID");
		}
		await engine.copyWrapper(assemblyContainerId, wrapperArchive);
		const assembly = await engine.inspectAssemblyContainer(assemblyContainerId);
		assertAssemblyConfiguration(
			assembly,
			assemblyContainerId,
			binding.parentImageId,
		);
		filesystemChanges = validateSelfHostedWrapperImageChanges(
			await engine.listAssemblyChanges(assemblyContainerId),
		);
		imageId = await engine.commitAssemblyContainer(assemblyContainerId);
	} finally {
		if (assemblyContainerId && CONTAINER_ID_RE.test(assemblyContainerId)) {
			await engine.removeAssemblyContainer(assemblyContainerId);
		}
	}
	if (!imageId || !IMAGE_ID_RE.test(imageId) || !filesystemChanges) {
		throw new Error("Derived wrapper image lacks a content-addressed image ID");
	}
	const derivedImage = await engine.inspectImage(imageId);
	assertDerivedConfiguration(parentImage, derivedImage);
	const history = await engine.imageHistory(imageId);
	assertNoSensitiveImageMetadata({
		environment: derivedImage.environment,
		labels: derivedImage.labels,
		history,
		forbiddenPaths: [
			path.resolve(options.parentReceiptPath),
			path.resolve(options.wrapperReceiptPath),
			path.resolve(options.wrapperPath),
			path.resolve(options.contextDir),
		],
	});

	const directOutput = await engine.runDefault(imageId);
	const wrapperOutput = await engine.runWrapperVersion(imageId);
	const helpOutput = await engine.runRunnerHelp(imageId);
	const installedWrapper = await engine.inspectWrapper(imageId);
	const directRuntime = parsePatchedVersionOutput(directOutput);
	const wrapperRuntime = parsePatchedVersionOutput(wrapperOutput);
	if (
		directRuntime.version !== binding.upstreamVersion ||
		wrapperRuntime.version !== binding.upstreamVersion ||
		!arraysEqual(directRuntime.tags, binding.runtimeTags) ||
		!arraysEqual(wrapperRuntime.tags, binding.runtimeTags) ||
		!helpOutput.includes(SELF_HOSTED_WRAPPER_CONFIGURATION_FLAG) ||
		installedWrapper.scriptSha256 !== binding.wrapperScriptSha256 ||
		installedWrapper.mode !== SELF_HOSTED_WRAPPER_IMAGE_MODE ||
		installedWrapper.owner !== SELF_HOSTED_WRAPPER_IMAGE_OWNER
	) {
		throw new Error("Wrapper image runtime handoff evidence is inconsistent");
	}

	const receipt = validateSelfHostedWrapperImageReceipt({
		schemaVersion: 1,
		surface: "self-hosted-runner",
		profile: binding.profile,
		upstreamVersion: binding.upstreamVersion,
		platform: binding.platform,
		parent: {
			receiptSha256: binding.parentReceiptSha256,
			imageId: binding.parentImageId,
			binarySha256: binding.binarySha256,
			layerCount: binding.parentLayerCount,
		},
		wrapper: {
			receiptSha256: binding.wrapperReceiptSha256,
			scriptSha256: binding.wrapperScriptSha256,
			imagePath: SELF_HOSTED_WRAPPER_IMAGE_PATH,
			mode: SELF_HOSTED_WRAPPER_IMAGE_MODE,
			owner: SELF_HOSTED_WRAPPER_IMAGE_OWNER,
			configurationFlag: SELF_HOSTED_WRAPPER_CONFIGURATION_FLAG,
			configurationEnvironment: SELF_HOSTED_WRAPPER_CONFIGURATION_ENVIRONMENT,
			binarySource: "CLAUDE_RUNNER_CLAUDE_BIN",
			handoff: "exec",
		},
		context: {
			wrapperSha256: contextWrapperSha256,
			entries: ["claude-session-wrapper"],
			textSecretScan,
		},
		image: {
			id: derivedImage.id,
			tags: [],
			user: SELF_HOSTED_IMAGE_USER,
			workingDirectory: SELF_HOSTED_IMAGE_WORKDIR,
			entrypoint: [...SELF_HOSTED_IMAGE_ENTRYPOINT],
			defaultCommand: [...SELF_HOSTED_IMAGE_DEFAULT_COMMAND],
			environmentNames: ["HOME", "PATH"],
			parentLayerCount: parentImage.rootFsLayers.length,
			layerCount: derivedImage.rootFsLayers.length,
		},
		runtime: {
			directDefault: "pass",
			wrapperVersion: "pass",
			runnerHelp: "pass",
			execPathFlag: "present",
			version: directRuntime.version,
			tags: directRuntime.tags,
			wrapperScriptSha256: installedWrapper.scriptSha256,
			wrapperMode: installedWrapper.mode,
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
			filesystemChanges,
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
		createdAt: (dependencies.now ?? (() => new Date().toISOString()))(),
	});

	return createOperationResult({
		operation: "self-hosted-wrapper-image-build",
		ok: true,
		data: receipt,
		checks: [
			{ id: "parent-binding", status: "pass" },
			{ id: "wrapper-binding", status: "pass" },
			{ id: "context-secret-scan", status: "pass" },
			{ id: "stopped-container-assembly", status: "pass" },
			{ id: "assembly-container-removal", status: "pass" },
			{ id: "untagged-derived-commit", status: "pass" },
			{ id: "configuration-inheritance", status: "pass" },
			{ id: "metadata-secret-scan", status: "pass" },
			{ id: "wrapper-installation", status: "pass" },
			{ id: "direct-version", status: "pass" },
			{ id: "wrapper-version", status: "pass" },
			{ id: "runner-help", status: "pass" },
		],
	});
}
