import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	createSyntheticSelfHostedHost,
	createSyntheticSelfHostedMatrix,
} from "../../scripts/test-fixtures/self-hosted.js";
import { sha256File } from "../artifacts/native-evidence.js";
import {
	buildSelfHostedImage,
	createDockerSelfHostedImageEngine,
	type DockerCommandRunner,
	type DockerImageInspection,
	runBoundedCommand,
	type SelfHostedImageEngine,
	type SelfHostedImageSecretScanner,
} from "./self-hosted-image.js";

test("bounded commands stream exact stdin bytes", async () => {
	const input = new TextEncoder().encode("bounded-input\n");
	const result = await runBoundedCommand(
		process.execPath,
		["-e", "process.stdin.pipe(process.stdout)"],
		{ stdin: input },
	);
	assert.equal(result.stdout, "bounded-input\n");
});

const baseReference =
	"ubuntu@sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90";
const baseId =
	"sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90";
const imageId = `sha256:${"f".repeat(64)}`;

async function createInputs(root: string): Promise<{
	matrixPath: string;
	hostPath: string;
	artifactPath: string;
	contextPath: string;
}> {
	const artifactPath = path.join(root, "artifact");
	await fs.writeFile(artifactPath, "synthetic native artifact");
	const artifactSha256 = await sha256File(artifactPath);
	const matrix = createSyntheticSelfHostedMatrix(artifactSha256);
	const host = createSyntheticSelfHostedHost(matrix);
	const matrixPath = path.join(root, "matrix.json");
	const hostPath = path.join(root, "host.json");
	await fs.writeFile(matrixPath, `${JSON.stringify(matrix, null, "\t")}\n`);
	await fs.writeFile(hostPath, `${JSON.stringify(host, null, "\t")}\n`);
	return {
		matrixPath,
		hostPath,
		artifactPath,
		contextPath: path.join(root, "context"),
	};
}

function successfulEngine(): SelfHostedImageEngine {
	return {
		async inspectImage(reference): Promise<DockerImageInspection> {
			if (reference === baseReference) {
				return {
					id: baseId,
					repoTags: ["ubuntu:24.04"],
					os: "linux",
					architecture: "amd64",
					user: "",
					workingDirectory: "",
					entrypoint: [],
					defaultCommand: ["/bin/bash"],
					environment: [
						"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
					],
					labels: {},
					rootFsLayers: [`sha256:${"1".repeat(64)}`],
				};
			}
			assert.equal(reference, imageId);
			return {
				id: imageId,
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
				labels: { "org.opencontainers.image.version": "9.9.9" },
				rootFsLayers: [
					`sha256:${"1".repeat(64)}`,
					`sha256:${"2".repeat(64)}`,
					`sha256:${"3".repeat(64)}`,
					`sha256:${"4".repeat(64)}`,
				],
			};
		},
		async buildImage() {
			return imageId;
		},
		async imageHistory() {
			return [
				'CMD ["--version"]',
				'ENTRYPOINT ["/usr/local/bin/claude"]',
				"RUN apt-get install ca-certificates git openssh-client",
			];
		},
		async runDefault() {
			return `9.9.9 (Claude Code; patched: bash-prompt, built-in-agent-prompt, claude-api-scope, claudemd-strong, memory-prompt-soften, mcp-server-name, session-guidance, todo-use, cache-tail-policy, edit-extended, effort-stack, feature-flags, image-limits, tools-off-desktop, no-autoupdate, read-bat, agents-off, commands-off, lsp-multi-server, lsp-filename-schema, skill-paths-invoke, skill-global-paths, skill-listing-ui, subagent-system-prompt, session-mem, sys-prompt-file, limits, prompt-dash-style, workflow-safety)\n`;
		},
		async probeDependencies() {
			return {
				git: "git version 2.43.0",
				ssh: "OpenSSH_9.6p1 Ubuntu-3ubuntu13.13",
				caCertificates: "20240203",
			};
		},
	};
}

const scanner: SelfHostedImageSecretScanner = {
	async scanContext() {
		return { tool: "gitleaks", version: "8.30.1", status: "pass" };
	},
};

test("image operation constructs an untagged receipt-bound inert image", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "cc-enhanced-image-"));
	try {
		const inputs = await createInputs(root);
		const result = await buildSelfHostedImage(
			{
				matrixReceiptPath: inputs.matrixPath,
				hostReceiptPath: inputs.hostPath,
				artifactPath: inputs.artifactPath,
				contextDir: inputs.contextPath,
				allowedContextRoot: root,
				baseImage: baseReference,
			},
			{
				engine: successfulEngine(),
				scanner,
				now: () => "2026-08-22T10:00:00.000Z",
			},
		);

		assert.equal(result.operation, "self-hosted-image-build");
		assert.equal(result.ok, true);
		assert.equal(result.data.image.id, imageId);
		assert.equal(result.data.base.pull, "not-run");
		assert.deepEqual(result.data.image.tags, []);
		assert.deepEqual(result.data.image.defaultCommand, ["--version"]);
		assert.equal(result.data.runtime.version, "9.9.9");
		assert.equal(result.data.runtime.tags.length, 29);
		assert.equal(result.data.boundaries.runnerStart, "not-run");
		assert.deepEqual((await fs.readdir(inputs.contextPath)).sort(), [
			"Dockerfile",
			"claude",
		]);
		assert.equal(
			await fs.readFile(path.join(inputs.contextPath, "claude"), "utf8"),
			"synthetic native artifact",
		);
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});

test("image operation fails before context creation when the base is not exact", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "cc-enhanced-image-"));
	try {
		const inputs = await createInputs(root);
		const engine = successfulEngine();
		engine.inspectImage = async () => ({
			id: baseId,
			repoTags: [],
			os: "linux",
			architecture: "arm64",
			user: "",
			workingDirectory: "",
			entrypoint: [],
			defaultCommand: [],
			environment: [],
			labels: {},
			rootFsLayers: [],
		});
		await assert.rejects(
			buildSelfHostedImage(
				{
					matrixReceiptPath: inputs.matrixPath,
					hostReceiptPath: inputs.hostPath,
					artifactPath: inputs.artifactPath,
					contextDir: inputs.contextPath,
					allowedContextRoot: root,
					baseImage: baseReference,
				},
				{ engine, scanner },
			),
			/base.*architecture/i,
		);
		await assert.rejects(fs.access(inputs.contextPath));
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});

test("Docker engine never tags or starts a runner and locks diagnostic runs", async () => {
	const calls: Array<{ command: string; args: string[] }> = [];
	const runner: DockerCommandRunner = async (command, args) => {
		calls.push({ command, args: [...args] });
		if (args[0] === "image" && args[1] === "inspect") {
			return {
				stdout: `${JSON.stringify([
					{
						Id: imageId,
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
						RootFS: { Layers: [`sha256:${"1".repeat(64)}`] },
					},
				])}\n`,
				stderr: "",
			};
		}
		if (args[0] === "build") return { stdout: `${imageId}\n`, stderr: "" };
		if (args[0] === "image" && args[1] === "history") {
			return { stdout: '"CMD [\\"--version\\"]"\n', stderr: "" };
		}
		if (args[0] === "run" && args.includes("--entrypoint")) {
			return {
				stdout: "git=git version 2.43.0\nssh=OpenSSH_9.6p1\nca=20240203\n",
				stderr: "",
			};
		}
		return { stdout: "9.9.9 (Claude Code; patched: one)\n", stderr: "" };
	};
	const engine = createDockerSelfHostedImageEngine(runner);
	await engine.inspectImage(imageId);
	await engine.buildImage({ contextDir: "/tmp/context" });
	await engine.imageHistory(imageId);
	await engine.runDefault(imageId);
	await engine.probeDependencies(imageId);

	assert.ok(calls.every(({ command }) => command === "docker"));
	assert.ok(calls.every(({ args }) => !args.includes("self-hosted-runner")));
	const build = calls.find(({ args }) => args[0] === "build");
	assert.ok(build);
	assert.ok(build.args.includes("--pull=false"));
	assert.ok(!build.args.includes("-t"));
	for (const call of calls.filter(({ args }) => args[0] === "run")) {
		assert.ok(call.args.includes("--network"));
		assert.ok(call.args.includes("none"));
		assert.ok(call.args.includes("--read-only"));
		assert.ok(call.args.includes("--cap-drop"));
		assert.ok(call.args.includes("ALL"));
		assert.ok(call.args.includes("no-new-privileges"));
		assert.ok(call.args.includes("65532:65532"));
	}
});
