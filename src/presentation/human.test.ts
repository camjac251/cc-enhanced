import assert from "node:assert/strict";
import { test } from "node:test";
import type { NativeFetchResult } from "../native-release.js";
import { createOperationResult } from "../operations/contract.js";
import { renderNativePull } from "./human.js";

const fetchResult = {
	spec: "latest",
	version: "2.1.999",
	platform: "linux-x64",
	checksum: "a".repeat(64),
	bucketUrl: "https://example.invalid/releases",
	manifestUrl: "https://example.invalid/releases/2.1.999/manifest.json",
	binaryUrl: "https://example.invalid/releases/2.1.999/linux-x64/claude",
	manifestPath: "/tmp/cache/manifest.json",
	binaryPath: "/tmp/cache/claude",
	fromCache: true,
} satisfies NativeFetchResult;

test("human presentation describes the stock native pull", () => {
	assert.deepEqual(
		renderNativePull(
			createOperationResult({
				operation: "native-pull",
				ok: true,
				data: { fetchResult, outputJsPath: "/tmp/clean/cli.js" },
			}),
		),
		[
			"",
			"Clean native JS extracted:",
			"  Fetched: 2.1.999/linux-x64 (cache)",
			"  Output:  /tmp/clean/cli.js",
			"",
		],
	);
});
