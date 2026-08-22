import assert from "node:assert/strict";
import { test } from "node:test";
import type { NativeFetchResult } from "../native-release.js";
import { createOperationResult } from "../operations/contract.js";
import type { PromoteResult, RollbackResult, StatusInfo } from "../promote.js";
import {
	renderNativeBuild,
	renderNativePull,
	renderNativeUpdate,
	renderPromote,
	renderRollback,
	renderStatus,
} from "./human.js";

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

const promoteResult: PromoteResult = {
	target: "/tmp/build",
	currentLink: "/tmp/versions/current",
	previousTarget: "/tmp/previous",
	smokeTestVersion: "2.1.999 (patched)",
	cleanedBuilds: ["/tmp/old-build"],
};

test("human presentation preserves existing lifecycle CLI output", () => {
	const status: StatusInfo = {
		current: {
			binaryPath: "/tmp/current",
			version: {
				version: "2.1.999",
				patchedTags: ["read-bat", "signature"],
				isPatched: true,
			},
		},
		cachedVersions: [
			{
				version: "2.1.999",
				platform: "linux-x64",
				binaryPath: "/tmp/cache/claude",
				hasBuilds: true,
				buildCount: 2,
			},
		],
	};
	assert.deepEqual(
		renderStatus(
			createOperationResult({ operation: "status", ok: true, data: status }),
		),
		[
			"",
			"Claude Code Status",
			"",
			"  Current:",
			"    Binary:  /tmp/current",
			"    Version: 2.1.999 (2 patches)",
			"  Previous: (none)",
			"",
			"  Cached:",
			"    2.1.999/linux-x64 (2 builds)",
			"",
		],
	);

	assert.deepEqual(
		renderPromote(
			createOperationResult({
				operation: "promote",
				ok: true,
				data: promoteResult,
			}),
		),
		[
			"",
			"Promoted:",
			"  Target:   /tmp/build",
			"  Current:  /tmp/versions/current",
			"  Previous: /tmp/previous",
			"  Version:  2.1.999 (patched)",
			"  Cleaned:  /tmp/old-build",
			"",
		],
	);

	const rollback: RollbackResult = {
		target: "/tmp/previous",
		previousTarget: "/tmp/build",
		smokeTestVersion: "2.1.998 (patched)",
	};
	assert.deepEqual(
		renderRollback(
			createOperationResult({
				operation: "rollback",
				ok: true,
				data: rollback,
			}),
		),
		[
			"",
			"Rolled back:",
			"  Target:   /tmp/previous",
			"  Previous: /tmp/build",
			"  Version:  2.1.998 (patched)",
			"",
		],
	);

	const buildData = {
		fetchResult,
		patchOutputPath: "/tmp/build",
		artifactReceipt: null,
		dryRun: false,
	};
	assert.deepEqual(
		renderNativeBuild(
			createOperationResult({
				operation: "native-build",
				ok: true,
				data: buildData,
			}),
		),
		[
			"",
			"Build complete:",
			"  Fetched:  2.1.999/linux-x64 (cache)",
			"  Patched:  /tmp/build",
			"",
		],
	);

	assert.deepEqual(
		renderNativeUpdate(
			createOperationResult({
				operation: "native-update",
				ok: true,
				data: { ...buildData, promoteResult },
			}),
		),
		[
			"",
			"Update complete:",
			"  Fetched:  2.1.999/linux-x64 (cache)",
			"  Patched:  /tmp/build",
			"",
			"Promoted:",
			"  Target:   /tmp/build",
			"  Current:  /tmp/versions/current",
			"  Previous: /tmp/previous",
			"  Version:  2.1.999 (patched)",
			"  Cleaned:  /tmp/old-build",
			"",
		],
	);

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
