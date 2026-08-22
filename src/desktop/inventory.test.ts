import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	inspectDesktopCodeSnapshotFromHandle,
	inspectDesktopInventory,
} from "./inventory.js";

function align4(value: number): number {
	return (value + 3) & ~3;
}

function createAsar(packageJson: Record<string, unknown>): Buffer {
	const contents = Buffer.from(JSON.stringify(packageJson), "utf8");
	const json = Buffer.from(
		JSON.stringify({
			files: {
				"package.json": { size: contents.length, offset: "0" },
			},
		}),
		"utf8",
	);
	const stringSize = json.length;
	const headerPayload = Buffer.alloc(4 + align4(stringSize));
	headerPayload.writeUInt32LE(stringSize, 0);
	json.copy(headerPayload, 4);
	const headerPickle = Buffer.alloc(4 + headerPayload.length);
	headerPickle.writeUInt32LE(headerPayload.length, 0);
	headerPayload.copy(headerPickle, 4);
	const sizePickle = Buffer.alloc(8);
	sizePickle.writeUInt32LE(4, 0);
	sizePickle.writeUInt32LE(headerPickle.length, 4);
	return Buffer.concat([sizePickle, headerPickle, contents]);
}

function createPe(machine: number): Buffer {
	const binary = Buffer.alloc(96);
	binary.write("MZ", 0, "ascii");
	binary.writeUInt32LE(64, 0x3c);
	binary.write("PE\0\0", 64, "binary");
	binary.writeUInt16LE(machine, 68);
	return binary;
}

function createElf(machine: number): Buffer {
	const binary = Buffer.alloc(64);
	binary.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0);
	binary.writeUInt16LE(machine, 18);
	return binary;
}

function createMachO(cpuType: number): Buffer {
	const binary = Buffer.alloc(32);
	binary.set([0xcf, 0xfa, 0xed, 0xfe], 0);
	binary.writeUInt32LE(cpuType, 4);
	return binary;
}

async function writeDesktopAsar(
	appRoot: string,
	platform: "win32" | "darwin" | "linux",
	packageJson: Record<string, unknown>,
): Promise<void> {
	const resources =
		platform === "darwin"
			? path.join(appRoot, "Contents", "Resources")
			: path.join(appRoot, "resources");
	await fs.mkdir(resources, { recursive: true });
	await fs.writeFile(path.join(resources, "app.asar"), createAsar(packageJson));
}

async function writeCacheBinary(
	cacheRoot: string,
	version: string,
	name: string,
	contents: Buffer,
): Promise<void> {
	const versionRoot = path.join(cacheRoot, version);
	await fs.mkdir(versionRoot, { recursive: true });
	await fs.writeFile(path.join(versionRoot, name), contents);
}

test("Windows inventory selects the current app and highest cache without inventing a pin", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-win-"));
	const appContainer = path.join(tempDir, "apps");
	const cacheRoot = path.join(tempDir, "claude-code");
	try {
		await writeDesktopAsar(path.join(appContainer, "app-1.2.2"), "win32", {
			version: "1.2.2",
		});
		await writeDesktopAsar(path.join(appContainer, "app-1.2.3"), "win32", {
			version: "1.2.3",
			devDependencies: {
				"@anthropic-ai/claude-agent-sdk": "0.3.4",
			},
		});
		await writeCacheBinary(cacheRoot, "2.1.8", "claude.exe", createPe(0x8664));
		await writeCacheBinary(cacheRoot, "2.1.9", "claude.exe", createPe(0x8664));
		await writeCacheBinary(
			path.join(cacheRoot, "2.1.9", "nested"),
			"9.9.9",
			"claude.exe",
			createPe(0x8664),
		);

		const report = await inspectDesktopInventory({
			platform: "win32",
			appRoot: appContainer,
			cacheRoot,
			observedAt: "2026-08-20T12:00:00.000Z",
		});

		assert.deepEqual(
			report.applications.map((application) => application.version),
			["1.2.3", "1.2.2"],
		);
		assert.equal(report.applications[0]?.packagedAgentSdk.version, "0.3.4");
		assert.deepEqual(report.applications[0]?.declaredCodePin, {
			status: "unresolved",
			version: null,
		});
		assert.deepEqual(
			report.cachedCode.map((artifact) => artifact.version),
			["2.1.9", "2.1.8"],
		);
		assert.equal(report.cachedCode[0]?.platform, "win32-x64");
		assert.equal(report.cachedCode[0]?.binaryFormat, "pe");
		assert.equal(report.selectedCodeLocatorId, "desktop-code:2.1.9");
		assert.equal(report.selectedCodeReason, "highest-cached");
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("macOS and Linux adapters classify explicit application and cache roots", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-os-"));
	try {
		const macApp = path.join(tempDir, "Claude.app");
		const macCache = path.join(tempDir, "mac-cache");
		await writeDesktopAsar(macApp, "darwin", { version: "1.2.3" });
		await writeCacheBinary(
			macCache,
			"2.1.9",
			"claude",
			createMachO(0x0100000c),
		);
		const mac = await inspectDesktopInventory({
			platform: "darwin",
			appRoot: macApp,
			cacheRoot: macCache,
			observedAt: "2026-08-20T12:00:00.000Z",
		});
		assert.equal(mac.applications[0]?.layout, "macos-app");
		assert.equal(mac.cachedCode[0]?.platform, "darwin-arm64");
		assert.equal(mac.cachedCode[0]?.binaryFormat, "macho");

		const linuxApp = path.join(tempDir, "linux-app");
		const linuxCache = path.join(tempDir, "linux-cache");
		await writeDesktopAsar(linuxApp, "linux", { version: "1.2.3" });
		await writeCacheBinary(linuxCache, "2.1.9", "claude", createElf(0x3e));
		const linux = await inspectDesktopInventory({
			platform: "linux",
			appRoot: linuxApp,
			cacheRoot: linuxCache,
			observedAt: "2026-08-20T12:00:00.000Z",
		});
		assert.equal(linux.applications[0]?.layout, "linux-package");
		assert.equal(linux.cachedCode[0]?.platform, "linux-x64");
		assert.equal(linux.cachedCode[0]?.binaryFormat, "elf");
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("an explicit Desktop Code pin selects its exact cache row", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-select-"));
	const appRoot = path.join(tempDir, "app");
	const cacheRoot = path.join(tempDir, "cache");
	try {
		await writeDesktopAsar(appRoot, "linux", {
			version: "1.2.3",
			claudeCodeVersion: "2.1.8",
		});
		await writeCacheBinary(cacheRoot, "2.1.8", "claude", createElf(0x3e));
		await writeCacheBinary(cacheRoot, "2.1.9", "claude", createElf(0x3e));

		const report = await inspectDesktopInventory({
			platform: "linux",
			appRoot,
			cacheRoot,
			observedAt: "2026-08-20T12:00:00.000Z",
		});
		assert.equal(report.selectedCodeLocatorId, "desktop-code:2.1.8");
		assert.equal(report.selectedCodeReason, "declared-pin");
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("cache discovery ignores links and rejects more than 64 direct version rows", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-cap-"));
	const appRoot = path.join(tempDir, "app");
	const cacheRoot = path.join(tempDir, "cache");
	const outside = path.join(tempDir, "outside");
	try {
		await writeDesktopAsar(appRoot, "linux", { version: "1.2.3" });
		await writeCacheBinary(outside, "2.1.1", "claude", createElf(0x3e));
		await fs.mkdir(cacheRoot, { recursive: true });
		await fs.symlink(
			path.join(outside, "2.1.1"),
			path.join(cacheRoot, "2.1.1"),
		);
		const report = await inspectDesktopInventory({
			platform: "linux",
			appRoot,
			cacheRoot,
			observedAt: "2026-08-20T12:00:00.000Z",
		});
		assert.equal(report.cachedCode.length, 0);

		await fs.rm(path.join(cacheRoot, "2.1.1"));
		for (let index = 0; index < 65; index += 1) {
			await fs.mkdir(path.join(cacheRoot, `2.1.${index}`));
		}
		await assert.rejects(
			inspectDesktopInventory({
				platform: "linux",
				appRoot,
				cacheRoot,
				observedAt: "2026-08-20T12:00:00.000Z",
			}),
			/cache.*limit/i,
		);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("Desktop discovery bounds total direct directory entries", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-scan-cap-"));
	const appRoot = path.join(tempDir, "app");
	const cacheRoot = path.join(tempDir, "cache");
	try {
		await writeDesktopAsar(appRoot, "linux", { version: "1.2.3" });
		await fs.mkdir(cacheRoot, { recursive: true });
		for (let index = 0; index < 257; index += 1) {
			await fs.writeFile(path.join(cacheRoot, `noise-${index}`), "noise");
		}

		await assert.rejects(
			inspectDesktopInventory({
				platform: "linux",
				appRoot,
				cacheRoot,
				observedAt: "2026-08-20T12:00:00.000Z",
			}),
			/directory.*limit/i,
		);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("cache classification and hashing stay bound to one opened file identity", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-identity-"));
	const binaryPath = path.join(tempDir, "claude.exe");
	const displacedPath = path.join(tempDir, "claude-original.exe");
	const original = createPe(0x8664);
	const replacement = createElf(0x3e);
	await fs.writeFile(binaryPath, original);
	const handle = await fs.open(binaryPath, "r");
	try {
		await fs.rename(binaryPath, displacedPath);
		await fs.writeFile(binaryPath, replacement);
		const expectedIdentity = await handle.stat();

		const snapshot = await inspectDesktopCodeSnapshotFromHandle(
			handle,
			"win32",
			expectedIdentity,
		);

		assert.equal(snapshot.binaryFormat, "pe");
		assert.equal(snapshot.architecture, "x64");
		assert.equal(snapshot.platform, "win32-x64");
		assert.equal(snapshot.size, original.length);
		assert.equal(
			snapshot.sha256,
			createHash("sha256").update(original).digest("hex"),
		);
	} finally {
		await handle.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});
