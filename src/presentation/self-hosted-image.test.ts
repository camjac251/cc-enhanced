import assert from "node:assert/strict";
import { test } from "node:test";
import type { OperationResult } from "../operations/contract.js";
import type { SelfHostedImageReceipt } from "../self-hosted/image.js";
import { renderSelfHostedImage } from "./self-hosted-image.js";

test("self-hosted image renderer reports immutable proof and closed live gates", () => {
	const result = {
		operation: "self-hosted-image-build",
		ok: true,
		data: {
			upstreamVersion: "2.1.238",
			platform: "linux-x64",
			base: {
				reference: `ubuntu@sha256:${"a".repeat(64)}`,
				pull: "not-run",
			},
			image: {
				id: `sha256:${"b".repeat(64)}`,
				user: "65532:65532",
				workingDirectory: "/workspace",
				entrypoint: ["/usr/local/bin/claude"],
				defaultCommand: ["--version"],
				tags: [],
			},
			runtime: { version: "2.1.238", tags: new Array(30).fill("tag") },
			context: { textSecretScan: { status: "pass" } },
			verification: { metadataSecretScan: "pass" },
			boundaries: {
				runnerStart: "not-run",
				runnerRegistration: "not-run",
				childSession: "not-run",
				clientProbe: "not-run",
			},
		},
	} as unknown as OperationResult<SelfHostedImageReceipt>;
	const output = renderSelfHostedImage(result).join("\n");

	assert.match(output, /Self-hosted Runner Image/);
	assert.match(output, /Code version:\s+2\.1\.238/);
	assert.match(output, /Runtime patches:\s+30/);
	assert.match(output, /Image ID:\s+sha256:b{64}/);
	assert.match(output, /Base pull:\s+not-run/);
	assert.match(output, /Default command:\s+--version/);
	assert.match(output, /Runner start:\s+not-run/);
	assert.match(output, /Client probe:\s+not-run/);
});
