import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	getNativeBuildFileName,
	getNativeBuildOutputPath,
	Manager,
} from "./manager.js";
import type { NativeBuildResult } from "./operations/contract.js";

async function writeExecutable(filePath: string): Promise<void> {
	await fsp.writeFile(
		filePath,
		`#!${process.execPath}\nprocess.stdout.write("2.1.999 (Claude Code; patched: signature)\\n");\n`,
		"utf8",
	);
	await fsp.chmod(filePath, 0o755);
}

test("native build names preserve the Windows executable suffix", () => {
	assert.equal(
		getNativeBuildFileName("win32-arm64", "20260820T120000"),
		"20260820T120000-claude.exe",
	);
	assert.equal(
		getNativeBuildFileName("darwin-arm64", "20260820T120000"),
		"20260820T120000-claude",
	);
	assert.equal(
		getNativeBuildOutputPath(
			"C:\\cache\\2.1.240\\claude.exe",
			"win32-x64",
			"20260820T120000",
		),
		path.join(
			path.dirname("C:\\cache\\2.1.240\\claude.exe"),
			"builds",
			"20260820T120000-claude.exe",
		),
	);
	assert.equal(
		getNativeBuildOutputPath(
			"/cache/2.1.240/claude",
			"linux-x64",
			"20260820T120000",
		),
		"/cache/2.1.240/builds/20260820T120000-claude",
	);
});

test("updateNative activates the artifact returned by buildNative", async () => {
	const tempDir = await fsp.mkdtemp(
		path.join(os.tmpdir(), "manager-native-update-"),
	);
	const candidate = path.join(tempDir, "candidate");
	const versionsDir = path.join(tempDir, "versions");
	const binLink = path.join(tempDir, "bin", "claude");
	await writeExecutable(candidate);

	const buildResult: NativeBuildResult = {
		fetchResult: {
			spec: "2.1.999",
			version: "2.1.999",
			platform: "linux-x64",
			checksum: "a".repeat(64),
			bucketUrl: "https://example.invalid/releases",
			manifestUrl: "https://example.invalid/releases/2.1.999/manifest.json",
			binaryUrl: "https://example.invalid/releases/2.1.999/linux-x64/claude",
			manifestPath: path.join(tempDir, "manifest.json"),
			binaryPath: path.join(tempDir, "clean"),
			fromCache: true,
		},
		patchOutputPath: candidate,
		artifactReceipt: null,
		dryRun: false,
	};
	const manager = new Manager({});
	let buildInvocation:
		| { spec: string; platform: string | undefined }
		| undefined;
	const testManager = manager as Manager & {
		buildNative(
			spec: string,
			options?: { platform?: string },
		): Promise<NativeBuildResult>;
		fetchNativeTarget(): Promise<never>;
	};
	testManager.buildNative = async (spec, options) => {
		buildInvocation = { spec, platform: options?.platform };
		return buildResult;
	};
	testManager.fetchNativeTarget = async () => {
		throw new Error("updateNative bypassed buildNative");
	};

	try {
		const result = await manager.updateNative("2.1.999", {
			platform: "linux-x64",
			promoteOptions: {
				versionsDir,
				binLink,
				cleanOldBuilds: false,
			},
		});

		assert.deepEqual(buildInvocation, {
			spec: "2.1.999",
			platform: "linux-x64",
		});
		assert.equal(result.patchOutputPath, candidate);
		assert.equal(result.promoteResult?.target, fs.realpathSync(candidate));
		assert.equal(
			fs.realpathSync(path.join(versionsDir, "current")),
			fs.realpathSync(candidate),
		);
		assert.equal(fs.realpathSync(binLink), fs.realpathSync(candidate));
	} finally {
		await fsp.rm(tempDir, { recursive: true, force: true });
	}
});

test("updateNative never activates a dry-run build result", async () => {
	const tempDir = await fsp.mkdtemp(
		path.join(os.tmpdir(), "manager-native-dry-run-"),
	);
	const versionsDir = path.join(tempDir, "versions");
	const binLink = path.join(tempDir, "bin", "claude");
	const manager = new Manager({ dryRun: true });
	const testManager = manager as Manager & {
		buildNative(): Promise<NativeBuildResult>;
	};
	testManager.buildNative = async () => ({
		fetchResult: {
			spec: "2.1.999",
			version: "2.1.999",
			platform: "linux-x64",
			checksum: "a".repeat(64),
			bucketUrl: "https://example.invalid/releases",
			manifestUrl: "https://example.invalid/releases/2.1.999/manifest.json",
			binaryUrl: "https://example.invalid/releases/2.1.999/linux-x64/claude",
			manifestPath: path.join(tempDir, "manifest.json"),
			binaryPath: path.join(tempDir, "clean"),
			fromCache: true,
		},
		patchOutputPath: path.join(tempDir, "not-written"),
		artifactReceipt: null,
		dryRun: true,
	});

	try {
		const result = await manager.updateNative("2.1.999", {
			promoteOptions: { versionsDir, binLink },
		});

		assert.equal(result.dryRun, true);
		assert.equal(result.promoteResult, undefined);
		assert.equal(fs.existsSync(path.join(versionsDir, "current")), false);
		assert.equal(fs.existsSync(binLink), false);
	} finally {
		await fsp.rm(tempDir, { recursive: true, force: true });
	}
});
