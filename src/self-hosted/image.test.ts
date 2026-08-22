import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createSyntheticSelfHostedHost,
	createSyntheticSelfHostedImageReceipt,
	createSyntheticSelfHostedMatrix,
} from "../../scripts/test-fixtures/self-hosted.js";
import { SELF_HOSTED_RUNNER_CANDIDATE_TAGS } from "../profiles/self-hosted-runner.js";
import {
	assertNoSensitiveImageMetadata,
	bindSelfHostedImageSource,
	createSelfHostedImageDockerfile,
	validateSelfHostedImageReceipt,
} from "./image.js";

const matrix = createSyntheticSelfHostedMatrix();
const host = createSyntheticSelfHostedHost(matrix);

const sha = (value: string): string => value.repeat(64);
const runtimeTags = SELF_HOSTED_RUNNER_CANDIDATE_TAGS.filter(
	(tag) => tag !== "signature",
);

function sampleReceipt() {
	return createSyntheticSelfHostedImageReceipt();
}

test("image source binding requires the exact self-hosted matrix, host, and roster", () => {
	const binding = bindSelfHostedImageSource({
		matrix,
		host,
		matrixReceiptSha256: sha("1"),
		hostReceiptSha256: sha("2"),
		binarySha256: host.finalizedSha256,
	});

	assert.equal(binding.upstreamVersion, "9.9.9");
	assert.equal(binding.platform, "linux-x64");
	assert.equal(binding.profile, "self-hosted-runner");
	assert.deepEqual(binding.runtimeTags, runtimeTags);

	const wrongHost = structuredClone(host);
	wrongHost.runtimeTags = [...wrongHost.runtimeTags].reverse();
	assert.throws(
		() =>
			bindSelfHostedImageSource({
				matrix,
				host: wrongHost,
				matrixReceiptSha256: sha("1"),
				hostReceiptSha256: sha("2"),
				binarySha256: host.finalizedSha256,
			}),
		/runtime patch roster/i,
	);
	assert.throws(
		() =>
			bindSelfHostedImageSource({
				matrix,
				host,
				matrixReceiptSha256: sha("1"),
				hostReceiptSha256: sha("2"),
				binarySha256: sha("3"),
			}),
		/finalized artifact hash/i,
	);
});

test("image Dockerfile pins the base and has a non-root inert default", () => {
	const base =
		"ubuntu@sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90";
	const dockerfile = createSelfHostedImageDockerfile(base);

	assert.match(dockerfile, new RegExp(`^FROM ${base}$`, "m"));
	assert.match(
		dockerfile,
		/apt-get install -y --no-install-recommends ca-certificates git openssh-client/,
	);
	assert.match(dockerfile, /^USER 65532:65532$/m);
	assert.match(dockerfile, /^ENV HOME=\/home\/sandbox$/m);
	assert.match(dockerfile, /^WORKDIR \/workspace$/m);
	assert.match(dockerfile, /^ENTRYPOINT \["\/usr\/local\/bin\/claude"\]$/m);
	assert.match(dockerfile, /^CMD \["--version"\]$/m);
	assert.doesNotMatch(
		dockerfile,
		/self-hosted-runner|token|secret|api[_-]?key/i,
	);
	assert.throws(
		() => createSelfHostedImageDockerfile("ubuntu:24.04"),
		/immutable.*sha256/i,
	);
});

test("image receipt is strict, path-free, and keeps every live boundary closed", () => {
	const receipt = sampleReceipt();
	assert.deepEqual(validateSelfHostedImageReceipt(receipt), receipt);
	assert.doesNotMatch(JSON.stringify(receipt), /\/home\/|[A-Z]:\\/);

	for (const invalid of [
		{ ...receipt, platform: "linux-arm64" },
		{ ...receipt, profile: "cli-full" },
		{ ...receipt, base: { ...receipt.base, reference: "ubuntu:24.04" } },
		{
			...receipt,
			base: { ...receipt.base, imageId: `sha256:${sha("a")}` },
		},
		{
			...receipt,
			image: {
				...receipt.image,
				defaultCommand: ["self-hosted-runner"],
			},
		},
		{
			...receipt,
			image: {
				...receipt.image,
				environmentNames: ["PATH"],
			},
		},
		{
			...receipt,
			image: {
				...receipt.image,
				environmentNames: ["PATH", "CLAUDE_ENVIRONMENT_KEY"],
			},
		},
		{
			...receipt,
			boundaries: { ...receipt.boundaries, runnerStart: "pass" },
		},
	]) {
		assert.throws(() => validateSelfHostedImageReceipt(invalid));
	}
});

test("image metadata scan rejects credentials and host-local paths", () => {
	assert.doesNotThrow(() =>
		assertNoSensitiveImageMetadata({
			environment: ["PATH=/usr/local/bin:/usr/bin:/bin"],
			labels: { "org.opencontainers.image.version": "9.9.9" },
			history: ["RUN apt-get install ca-certificates git openssh-client"],
			forbiddenPaths: ["/home/example/private-project"],
		}),
	);
	assert.throws(
		() =>
			assertNoSensitiveImageMetadata({
				environment: ["CLAUDE_ENVIRONMENT_KEY=example-value"],
				labels: {},
				history: [],
				forbiddenPaths: [],
			}),
		/sensitive/i,
	);
	assert.throws(
		() =>
			assertNoSensitiveImageMetadata({
				environment: [],
				labels: {},
				history: ["COPY /home/example/private-project /workspace"],
				forbiddenPaths: ["/home/example/private-project"],
			}),
		/local path/i,
	);
});
