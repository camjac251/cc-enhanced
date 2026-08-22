import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	createSyntheticSelfHostedImageReceipt,
	createSyntheticSelfHostedWrapperReceipt,
} from "../../scripts/test-fixtures/self-hosted.js";
import { sha256File } from "../artifacts/native-evidence.js";
import { SELF_HOSTED_RUNNER_CANDIDATE_TAGS } from "../profiles/self-hosted-runner.js";
import { createSelfHostedWrapperScript } from "../self-hosted/wrapper.js";
import type {
	DockerCommandRunner,
	DockerImageInspection,
	SelfHostedImageSecretScanner,
} from "./self-hosted-image.js";
import {
	buildSelfHostedWrapperImage,
	createDockerSelfHostedWrapperImageEngine,
	type SelfHostedWrapperImageEngine,
} from "./self-hosted-wrapper-image.js";

const parent = createSyntheticSelfHostedImageReceipt();
const wrapper = createSyntheticSelfHostedWrapperReceipt();
const derivedImageId = `sha256:${"9".repeat(64)}`;
const assemblyContainerId = "7".repeat(64);
const parentLayers = Array.from(
	{ length: parent.image.layerCount },
	(_, index) => `sha256:${String(index + 1).repeat(64)}`,
);
const derivedLayers = [...parentLayers, `sha256:${"8".repeat(64)}`];
const versionOutput = `${parent.upstreamVersion} (Claude Code; patched: ${SELF_HOSTED_RUNNER_CANDIDATE_TAGS.filter((tag) => tag !== "signature").join(", ")})\n`;

function inspection(id: string, layers: string[]): DockerImageInspection {
	return {
		id,
		repoTags: [],
		os: "linux",
		architecture: "amd64",
		user: "65532:65532",
		workingDirectory: "/workspace",
		entrypoint: ["/usr/local/bin/claude"],
		defaultCommand: ["--version"],
		environment: [
			"HOME=/home/sandbox",
			"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		],
		labels: {},
		rootFsLayers: layers,
	};
}

async function writeCanonicalWrapper(root: string): Promise<string> {
	const wrapperPath = path.join(root, "exec-claude-v1");
	await fs.writeFile(wrapperPath, createSelfHostedWrapperScript(), {
		mode: 0o755,
	});
	return wrapperPath;
}

async function writeReceiptInputs(root: string): Promise<{
	parentReceiptPath: string;
	wrapperReceiptPath: string;
}> {
	const parentReceiptPath = path.join(root, "parent-receipt.json");
	const wrapperReceiptPath = path.join(root, "wrapper-receipt.json");
	await fs.writeFile(parentReceiptPath, JSON.stringify(parent));
	await fs.writeFile(wrapperReceiptPath, JSON.stringify(wrapper));
	return { parentReceiptPath, wrapperReceiptPath };
}

function successfulEngine(): SelfHostedWrapperImageEngine {
	let assemblyRemoved = false;
	return {
		async inspectImage(reference) {
			if (reference === parent.image.id) {
				return inspection(parent.image.id, parentLayers);
			}
			assert.equal(reference, derivedImageId);
			return inspection(derivedImageId, derivedLayers);
		},
		async createAssemblyContainer(parentImageId) {
			assert.equal(parentImageId, parent.image.id);
			return assemblyContainerId;
		},
		async copyWrapper(containerId, archive) {
			assert.equal(containerId, assemblyContainerId);
			assert.ok(archive instanceof Uint8Array);
			assert.equal(archive.byteLength, 2_048);
		},
		async inspectAssemblyContainer(containerId) {
			assert.equal(containerId, assemblyContainerId);
			return {
				id: assemblyContainerId,
				parentImageId: parent.image.id,
				status: "created",
				running: false,
				user: "65532:65532",
				networkMode: "none",
				readOnlyRootFilesystem: false,
				capabilityDrops: ["ALL"],
				securityOptions: ["no-new-privileges"],
			};
		},
		async listAssemblyChanges(containerId) {
			assert.equal(containerId, assemblyContainerId);
			return [
				"C /usr",
				"C /usr/local",
				"C /usr/local/bin",
				"A /usr/local/bin/claude-session-wrapper",
			];
		},
		async commitAssemblyContainer(containerId) {
			assert.equal(containerId, assemblyContainerId);
			return derivedImageId;
		},
		async removeAssemblyContainer(containerId) {
			assert.equal(containerId, assemblyContainerId);
			assemblyRemoved = true;
		},
		async imageHistory() {
			assert.equal(assemblyRemoved, true);
			return ["", ...new Array(parent.image.layerCount).fill("")];
		},
		async runDefault() {
			return versionOutput;
		},
		async runWrapperVersion() {
			return versionOutput;
		},
		async runRunnerHelp() {
			return "Usage: claude self-hosted-runner\n  --exec-path <path>\n";
		},
		async inspectWrapper() {
			return {
				scriptSha256: wrapper.wrapper.scriptSha256,
				mode: "0755",
				owner: "65532:65532",
			};
		},
	};
}

const scanner: SelfHostedImageSecretScanner = {
	async scanContext() {
		return { tool: "gitleaks", version: "8.30.1", status: "pass" };
	},
};

test("wrapper image operation binds both receipts and adds one inert layer", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "cc-enhanced-wrapper-image-"),
	);
	try {
		const { parentReceiptPath, wrapperReceiptPath } =
			await writeReceiptInputs(root);
		const wrapperPath = await writeCanonicalWrapper(root);
		const contextDir = path.join(root, "context");
		const result = await buildSelfHostedWrapperImage(
			{
				parentReceiptPath,
				wrapperReceiptPath,
				wrapperPath,
				contextDir,
				allowedContextRoot: root,
			},
			{
				engine: successfulEngine(),
				scanner,
				now: () => "2026-08-22T12:00:00.000Z",
			},
		);

		assert.equal(result.operation, "self-hosted-wrapper-image-build");
		assert.equal(result.ok, true);
		assert.equal(result.data.parent.imageId, parent.image.id);
		assert.equal(
			result.data.wrapper.scriptSha256,
			wrapper.wrapper.scriptSha256,
		);
		assert.equal(result.data.image.id, derivedImageId);
		assert.equal(result.data.image.parentLayerCount, parent.image.layerCount);
		assert.equal(result.data.image.layerCount, parent.image.layerCount + 1);
		assert.equal(result.data.runtime.execPathFlag, "present");
		assert.equal(result.data.build.assemblyContainerStart, "not-run");
		assert.equal(result.data.build.assemblyRootFilesystem, "writable");
		assert.equal(result.data.build.assemblyContainerRemoval, "pass");
		assert.equal(result.data.boundaries.runnerStart, "not-run");
		assert.deepEqual((await fs.readdir(contextDir)).sort(), [
			"claude-session-wrapper",
		]);
		assert.equal(
			await sha256File(path.join(contextDir, "claude-session-wrapper")),
			wrapper.wrapper.scriptSha256,
		);
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});

test("wrapper image operation rejects drift before creating a context", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "cc-enhanced-wrapper-image-"),
	);
	try {
		const { parentReceiptPath, wrapperReceiptPath } =
			await writeReceiptInputs(root);
		const contextDir = path.join(root, "context");
		const changedWrapper = path.join(root, "changed-wrapper");
		await fs.writeFile(changedWrapper, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		await assert.rejects(
			buildSelfHostedWrapperImage(
				{
					parentReceiptPath,
					wrapperReceiptPath,
					wrapperPath: changedWrapper,
					contextDir,
					allowedContextRoot: root,
				},
				{ engine: successfulEngine(), scanner },
			),
			/wrapper.*(?:hash|canonical)|canonical.*wrapper/i,
		);
		await assert.rejects(fs.access(contextDir));
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});

test("wrapper image operation never cleans up an untrusted container ID", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "cc-enhanced-wrapper-image-"),
	);
	let cleanupCalls = 0;
	try {
		const { parentReceiptPath, wrapperReceiptPath } =
			await writeReceiptInputs(root);
		const wrapperPath = await writeCanonicalWrapper(root);
		const engine = successfulEngine();
		engine.createAssemblyContainer = async () => "--force";
		engine.removeAssemblyContainer = async () => {
			cleanupCalls += 1;
		};
		await assert.rejects(
			buildSelfHostedWrapperImage(
				{
					parentReceiptPath,
					wrapperReceiptPath,
					wrapperPath,
					contextDir: path.join(root, "context"),
					allowedContextRoot: root,
				},
				{ engine, scanner },
			),
			/container.*content-addressed/i,
		);
		assert.equal(cleanupCalls, 0);
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});

test("Docker wrapper-image engine uses a never-started local assembly container", async () => {
	const calls: Array<{
		command: string;
		args: string[];
		options: Parameters<DockerCommandRunner>[2];
	}> = [];
	const runner: DockerCommandRunner = async (command, args, options) => {
		calls.push({ command, args: [...args], options });
		if (args[0] === "image" && args[1] === "inspect") {
			return {
				stdout: `${JSON.stringify([
					{
						Id: derivedImageId,
						RepoTags: [],
						Os: "linux",
						Architecture: "amd64",
						Config: {
							User: "65532:65532",
							WorkingDir: "/workspace",
							Entrypoint: ["/usr/local/bin/claude"],
							Cmd: ["--version"],
							Env: ["HOME=/home/sandbox", "PATH=/usr/bin:/bin"],
							Labels: {},
						},
						RootFS: { Layers: derivedLayers },
					},
				])}\n`,
				stderr: "",
			};
		}
		if (args[0] === "container" && args[1] === "create") {
			return { stdout: `${assemblyContainerId}\n`, stderr: "" };
		}
		if (args[0] === "container" && args[1] === "cp") {
			return { stdout: "", stderr: "" };
		}
		if (args[0] === "container" && args[1] === "inspect") {
			return {
				stdout: `${JSON.stringify([
					{
						Id: assemblyContainerId,
						Image: parent.image.id,
						Config: { User: "65532:65532" },
						State: { Status: "created", Running: false },
						HostConfig: {
							NetworkMode: "none",
							ReadonlyRootfs: false,
							CapDrop: ["ALL"],
							SecurityOpt: ["no-new-privileges"],
						},
					},
				])}\n`,
				stderr: "",
			};
		}
		if (args[0] === "container" && args[1] === "diff") {
			return {
				stdout:
					"C /usr\nC /usr/local\nC /usr/local/bin\nA /usr/local/bin/claude-session-wrapper\n",
				stderr: "",
			};
		}
		if (args[0] === "container" && args[1] === "commit") {
			return { stdout: `${derivedImageId}\n`, stderr: "" };
		}
		if (args[0] === "container" && args[1] === "rm") {
			return { stdout: `${assemblyContainerId}\n`, stderr: "" };
		}
		if (args[0] === "container" && args[1] === "ls") {
			return { stdout: "", stderr: "" };
		}
		if (args[0] === "image" && args[1] === "history") {
			return { stdout: '"COPY claude-session-wrapper"\n', stderr: "" };
		}
		if (args.some((argument) => argument.includes("sha256sum"))) {
			return {
				stdout: `${wrapper.wrapper.scriptSha256}  /usr/local/bin/claude-session-wrapper\nmode=755\nowner=65532:65532\n`,
				stderr: "",
			};
		}
		if (args.includes("self-hosted-runner")) {
			return { stdout: "--exec-path <path>\n", stderr: "" };
		}
		return { stdout: versionOutput, stderr: "" };
	};
	const engine = createDockerSelfHostedWrapperImageEngine(runner);
	const containerId = await engine.createAssemblyContainer(parent.image.id);
	await engine.copyWrapper(containerId, new Uint8Array(2_048));
	await engine.inspectAssemblyContainer(containerId);
	await engine.listAssemblyChanges(containerId);
	await engine.commitAssemblyContainer(containerId);
	await engine.removeAssemblyContainer(containerId);
	await engine.inspectImage(derivedImageId);
	await engine.imageHistory(derivedImageId);
	await engine.runDefault(derivedImageId);
	await engine.runWrapperVersion(derivedImageId);
	await engine.runRunnerHelp(derivedImageId);
	await engine.inspectWrapper(derivedImageId);

	assert.ok(calls.every(({ command }) => command === "docker"));
	const create = calls.find(
		({ args }) => args[0] === "container" && args[1] === "create",
	);
	assert.ok(create);
	assert.ok(create.args.includes(parent.image.id));
	assert.ok(create.args.includes("--pull"));
	assert.ok(create.args.includes("never"));
	assert.ok(create.args.includes("--network"));
	assert.ok(create.args.includes("none"));
	assert.ok(!create.args.includes("--read-only"));
	assert.ok(create.args.includes("--cap-drop"));
	assert.ok(create.args.includes("ALL"));
	assert.ok(create.args.includes("no-new-privileges"));
	assert.ok(create.args.includes("65532:65532"));
	const copy = calls.find(
		({ args }) => args[0] === "container" && args[1] === "cp",
	);
	assert.deepEqual(copy?.args, [
		"container",
		"cp",
		"--archive",
		"-",
		`${assemblyContainerId}:/usr/local/bin`,
	]);
	assert.equal(copy?.options?.stdin?.byteLength, 2_048);
	const commit = calls.find(
		({ args }) => args[0] === "container" && args[1] === "commit",
	);
	assert.deepEqual(commit?.args, ["container", "commit", assemblyContainerId]);
	assert.equal(
		calls.some(({ args }) =>
			[
				"build",
				"tag",
				"save",
				"load",
				"push",
				"pull",
				"start",
				"exec",
			].includes(args[0] ?? ""),
		),
		false,
	);
	for (const call of calls.filter(({ args }) => args[0] === "run")) {
		assert.ok(call.args.includes("--network"));
		assert.ok(call.args.includes("none"));
		assert.ok(call.args.includes("--read-only"));
		assert.ok(call.args.includes("--cap-drop"));
		assert.ok(call.args.includes("ALL"));
		assert.ok(call.args.includes("no-new-privileges"));
		assert.ok(call.args.includes("65532:65532"));
		assert.ok(!call.args.includes("doctor"));
	}
	const wrapperRuns = calls.filter(({ args }) =>
		args.includes("/usr/local/bin/claude-session-wrapper"),
	);
	assert.equal(wrapperRuns.length, 2);
	assert.ok(
		wrapperRuns.every(({ args }) =>
			args.includes("CLAUDE_RUNNER_CLAUDE_BIN=/usr/local/bin/claude"),
		),
	);
});
