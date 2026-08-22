import assert from "node:assert/strict";
import { test } from "node:test";
import type { OperationResult } from "../operations/contract.js";
import type { SelfHostedWrapperImageReceipt } from "../self-hosted/wrapper-image.js";
import { renderSelfHostedWrapperImage } from "./self-hosted-wrapper-image.js";

test("wrapper image renderer reports offline binding without runner support", () => {
	const result = {
		operation: "self-hosted-wrapper-image-build",
		ok: true,
		data: {
			upstreamVersion: "2.1.238",
			platform: "linux-x64",
			parent: { imageId: `sha256:${"a".repeat(64)}`, layerCount: 5 },
			wrapper: {
				imagePath: "/usr/local/bin/claude-session-wrapper",
				configurationFlag: "--exec-path",
				binarySource: "CLAUDE_RUNNER_CLAUDE_BIN",
				owner: "65532:65532",
			},
			image: {
				id: `sha256:${"b".repeat(64)}`,
				tags: [],
				parentLayerCount: 5,
				layerCount: 6,
				entrypoint: ["/usr/local/bin/claude"],
				defaultCommand: ["--version"],
			},
			context: { textSecretScan: { status: "pass" } },
			build: {
				method: "stopped-container-commit",
				assemblyRootFilesystem: "writable",
				assemblyContainerRemoval: "pass",
			},
			runtime: {
				version: "2.1.238",
				tags: new Array(30).fill("tag"),
				wrapperVersion: "pass",
				runnerHelp: "pass",
				execPathFlag: "present",
			},
			verification: { metadataSecretScan: "pass" },
			boundaries: {
				actualRunnerProvidedBinary: "not-run",
				runnerStart: "not-run",
				liveControlChannel: "not-run",
				doctor: "not-run",
				clientProbe: "not-run",
			},
		},
	} as unknown as OperationResult<SelfHostedWrapperImageReceipt>;
	const output = renderSelfHostedWrapperImage(result).join("\n");

	assert.match(output, /Self-hosted Runner Wrapper Image/);
	assert.match(output, /Code version:\s+2\.1\.238/);
	assert.match(output, /Runtime patches:\s+30/);
	assert.match(output, /Added layers:\s+1/);
	assert.match(output, /Wrapper version:\s+pass/);
	assert.match(output, /Runner help:\s+pass/);
	assert.match(output, /Assembly method:\s+stopped-container-commit/);
	assert.match(output, /Assembly rootfs:\s+writable/);
	assert.match(output, /Assembly cleanup:\s+pass/);
	assert.match(output, /Actual runner binary:\s+not-run/);
	assert.match(output, /Live control channel:\s+not-run/);
	assert.match(output, /Doctor:\s+not-run/);
});
