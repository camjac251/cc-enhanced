import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { PatchProfileReceipt } from "../profiles/contract.js";
import {
	NATIVE_ARTIFACT_PLATFORMS,
	type NativeArtifactPlatform,
} from "../targets/contract.js";
import {
	createStructuralArtifactReceipt,
	expectedNativeBinaryFormat,
	type NativeArtifactMatrixReport,
	type NativeArtifactMatrixRow,
	outsideMutableRangeMatches,
	resolveNativeArtifactPlatforms,
	sanitizeArtifactDiagnostic,
	validatePassingNativeArtifactMatrix,
	verifyNativeManifestEntry,
} from "./native-evidence.js";

const profile: PatchProfileReceipt = {
	name: "cli-full",
	surface: "cli",
	selectedTags: ["alpha", "signature"],
	exclusions: [],
	requiredProbes: [],
};

function receiptFor(platform: NativeArtifactPlatform) {
	return createStructuralArtifactReceipt({
		version: "2.1.999",
		platform,
		upstreamChecksum: "a".repeat(64),
		cleanSha256: "a".repeat(64),
		patchedSha256: "b".repeat(64),
		profile,
		patcherRevision: "revision-123",
		createdAt: "2026-08-20T12:00:00.000Z",
	});
}

function passingRow(platform: NativeArtifactPlatform): NativeArtifactMatrixRow {
	const receipt = receiptFor(platform);
	return {
		platform,
		receipt,
		checks: {
			manifestEntry: "pass",
			cleanChecksum: "pass",
			binaryFormat: "pass",
			fullProfile: "pass",
			fixedLayout: "pass",
			outsideRange: "pass",
			reextraction: "pass",
			signing: receipt.signingVerification,
			hostExecution: "not-run",
		},
	};
}

function passingReport(): NativeArtifactMatrixReport {
	return {
		schemaVersion: 1,
		version: "2.1.999",
		profile: "cli-full",
		status: "pass",
		generatedAt: "2026-08-20T12:00:00.000Z",
		rows: NATIVE_ARTIFACT_PLATFORMS.map(passingRow),
	};
}

test("native platform formats and structural signing defaults are explicit", () => {
	assert.equal(expectedNativeBinaryFormat("linux-x64"), "elf");
	assert.equal(expectedNativeBinaryFormat("linux-arm64-musl"), "elf");
	assert.equal(expectedNativeBinaryFormat("darwin-arm64"), "macho");
	assert.equal(expectedNativeBinaryFormat("win32-x64"), "pe");

	const linux = receiptFor("linux-arm64");
	assert.equal(linux.signingPolicy, "not-required");
	assert.equal(linux.signingVerification, "not-required");
	assert.equal(linux.hostExecution, "not-run");

	for (const platform of ["darwin-x64", "win32-arm64"] as const) {
		const receipt = receiptFor(platform);
		assert.equal(receipt.signingPolicy, "unconfigured");
		assert.equal(receipt.signingVerification, "not-run");
		assert.equal(receipt.hostExecution, "not-run");
	}
});

test("structural receipts distinguish checksum proof from manifest signatures", () => {
	const receipt = receiptFor("win32-x64");

	assert.equal(receipt.schemaVersion, 1);
	assert.equal(receipt.targetId, "standalone-cli:win32-x64:2.1.999");
	assert.equal(receipt.upstreamManifestChecksumVerified, true);
	assert.equal(receipt.upstreamManifestSignature, "not-provided");
	assert.equal(receipt.structuralVerification, "pass");
	assert.deepEqual(receipt.selectedTags, ["alpha", "signature"]);

	assert.throws(
		() =>
			createStructuralArtifactReceipt({
				version: "2.1.999",
				platform: "linux-x64",
				upstreamChecksum: "a".repeat(64),
				cleanSha256: "c".repeat(64),
				patchedSha256: "b".repeat(64),
				profile,
				patcherRevision: "revision-123",
				createdAt: "2026-08-20T12:00:00.000Z",
			}),
		/clean artifact checksum does not match the manifest entry/,
	);
});

test("a passing matrix requires every canonical artifact exactly once", () => {
	const report = passingReport();
	assert.equal("platforms" in report, false);
	assert.doesNotThrow(() => validatePassingNativeArtifactMatrix(report));

	assert.throws(
		() =>
			validatePassingNativeArtifactMatrix({
				...report,
				rows: report.rows.slice(1),
			}),
		/missing platform linux-x64/,
	);
	assert.throws(
		() =>
			validatePassingNativeArtifactMatrix({
				...report,
				rows: [...report.rows, report.rows[0]],
			}),
		/duplicate platform linux-x64/,
	);
	assert.throws(
		() =>
			validatePassingNativeArtifactMatrix({
				...report,
				rows: report.rows.map((row) =>
					row.platform === "darwin-arm64"
						? {
								...row,
								checks: { ...row.checks, fixedLayout: "fail" },
							}
						: row,
				),
			}),
		/darwin-arm64 fixedLayout must pass/,
	);
	assert.throws(
		() =>
			validatePassingNativeArtifactMatrix({
				...report,
				rows: report.rows.map((row) =>
					row.platform === "win32-arm64"
						? {
								...row,
								receipt: {
									...row.receipt,
									selectedTags: ["signature", "alpha"],
								},
							}
						: row,
				),
			}),
		/win32-arm64.*ordered patch roster/i,
	);
});

test("an explicit matrix subset is canonical, recorded, and row-exact", () => {
	const report = passingReport();
	const platforms = NATIVE_ARTIFACT_PLATFORMS.slice(0, 6);
	const selected: NativeArtifactMatrixReport = {
		...report,
		platforms,
		rows: report.rows.slice(0, 6),
	};

	assert.deepEqual(resolveNativeArtifactPlatforms(undefined), [
		...NATIVE_ARTIFACT_PLATFORMS,
	]);
	assert.deepEqual(resolveNativeArtifactPlatforms(platforms), platforms);
	assert.doesNotThrow(() => validatePassingNativeArtifactMatrix(selected));
	assert.throws(
		() => resolveNativeArtifactPlatforms([]),
		/at least one platform/i,
	);
	assert.throws(
		() => resolveNativeArtifactPlatforms(["linux-x64", "linux-x64"]),
		/duplicate platform linux-x64/i,
	);
	assert.throws(
		() => resolveNativeArtifactPlatforms([...platforms].reverse()),
		/canonical order/i,
	);
	assert.throws(
		() => resolveNativeArtifactPlatforms(["solaris-x64"]),
		/unknown platform solaris-x64/i,
	);
	assert.throws(
		() =>
			validatePassingNativeArtifactMatrix({
				...selected,
				rows: selected.rows.slice(1),
			}),
		/missing platform linux-x64/i,
	);
	assert.throws(
		() =>
			validatePassingNativeArtifactMatrix({
				...selected,
				rows: [...selected.rows, report.rows[6]],
			}),
		/unexpected platform win32-x64/i,
	);
});

test("artifact diagnostics remove local paths and stay bounded", () => {
	const diagnostic = sanitizeArtifactDiagnostic(
		"failed at /home/example/private/cache/claude and C:\\Users\\Example\\artifact.exe\nwith details",
	);

	assert.doesNotMatch(diagnostic, /home|Users|Example|private/);
	assert.match(diagnostic, /<local-path>/);
	assert.ok(diagnostic.length <= 320);
});

test("outside-range evidence ignores only the declared mutable bytes", async () => {
	const directory = await fs.mkdtemp(
		path.join(os.tmpdir(), "native-evidence-range-"),
	);
	const cleanPath = path.join(directory, "clean");
	const patchedPath = path.join(directory, "patched");
	try {
		await fs.writeFile(cleanPath, "prefix-OLD-suffix");
		await fs.writeFile(patchedPath, "prefix-NEW-suffix");
		assert.equal(
			await outsideMutableRangeMatches({
				cleanPath,
				patchedPath,
				cleanRange: { offset: 7, size: 3 },
				patchedRange: { offset: 7, size: 3 },
			}),
			true,
		);

		await fs.writeFile(patchedPath, "prefix-NEW-changed");
		assert.equal(
			await outsideMutableRangeMatches({
				cleanPath,
				patchedPath,
				cleanRange: { offset: 7, size: 3 },
				patchedRange: { offset: 7, size: 3 },
			}),
			false,
		);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test("manifest evidence verifies the checksum entry without inventing a signature", async () => {
	const directory = await fs.mkdtemp(
		path.join(os.tmpdir(), "native-evidence-manifest-"),
	);
	const manifestPath = path.join(directory, "manifest.json");
	const manifest = {
		version: "2.1.999",
		platforms: {
			"win32-x64": {
				binary: "claude.exe",
				checksum: "a".repeat(64),
				size: 123,
			},
		},
	};
	try {
		await fs.writeFile(manifestPath, JSON.stringify(manifest));
		assert.deepEqual(
			await verifyNativeManifestEntry({
				manifestPath,
				version: "2.1.999",
				platform: "win32-x64",
				checksum: "a".repeat(64),
			}),
			{ binary: "claude.exe", size: 123, signature: "not-provided" },
		);

		await fs.writeFile(
			manifestPath,
			JSON.stringify({ ...manifest, signature: "new-contract" }),
		);
		await assert.rejects(
			verifyNativeManifestEntry({
				manifestPath,
				version: "2.1.999",
				platform: "win32-x64",
				checksum: "a".repeat(64),
			}),
			/manifest signature fields require an explicit verifier/,
		);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});
