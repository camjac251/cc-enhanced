import { createHash } from "node:crypto";
import { type Dirent, constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
	CpuArchitecture,
	NativeArtifactPlatform,
	NativeBinaryFormat,
} from "../targets/contract.js";
import { readDesktopPackageMetadata } from "./asar.js";
import type {
	DesktopApplicationLayout,
	DesktopApplicationRecord,
	DesktopCodeArtifactRecord,
	DesktopInventoryReport,
	DesktopPlatform,
} from "./contract.js";
import { compareDesktopVersions } from "./contract.js";

export interface DesktopInventoryOptions {
	platform: DesktopPlatform;
	appRoot: string;
	cacheRoot: string;
	observedAt?: string;
}

const VERSION_RE = /^\d+(?:\.\d+){2,3}(?:[-+][0-9A-Za-z.-]+)?$/;
const MAX_APPLICATIONS = 32;
const MAX_CACHE_ROWS = 64;
const MAX_DIRECTORY_ENTRIES = 256;
const MAX_BINARY_BYTES = 1024 * 1024 * 1024;
const HASH_CHUNK_BYTES = 1024 * 1024;

interface ApplicationCandidate {
	rootPath: string;
	asarPath: string;
	layout: DesktopApplicationLayout;
}

interface NativeHeaderMetadata {
	binaryFormat: NativeBinaryFormat | "unknown";
	architecture: CpuArchitecture | "unknown";
}

export interface DesktopCodeSnapshot extends NativeHeaderMetadata {
	platform: NativeArtifactPlatform | null;
	size: number;
	sha256: string;
}

function isMissing(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}

async function lstatOrNull(filePath: string): Promise<Stats | null> {
	try {
		return await fs.lstat(filePath);
	} catch (error) {
		if (isMissing(error)) return null;
		throw error;
	}
}

async function readBoundedDirectory(
	directoryPath: string,
	label: string,
): Promise<Dirent[]> {
	const directory = await fs.opendir(directoryPath);
	const entries: Dirent[] = [];
	try {
		for (;;) {
			const entry = await directory.read();
			if (!entry) break;
			entries.push(entry);
			if (entries.length > MAX_DIRECTORY_ENTRIES) {
				throw new Error(`${label} directory entry count exceeds limit`);
			}
		}
		return entries;
	} finally {
		await directory.close();
	}
}

function isPathWithin(rootPath: string, candidatePath: string): boolean {
	const relative = path.relative(rootPath, candidatePath);
	return (
		relative === "" ||
		(!relative.startsWith("..") && !path.isAbsolute(relative))
	);
}

async function assertRegularFileWithin(
	rootPath: string,
	filePath: string,
): Promise<{ canonicalPath: string; stat: Stats } | null> {
	const stat = await lstatOrNull(filePath);
	if (!stat?.isFile() || stat.isSymbolicLink()) return null;
	const [canonicalRoot, canonicalPath] = await Promise.all([
		fs.realpath(rootPath),
		fs.realpath(filePath),
	]);
	if (!isPathWithin(canonicalRoot, canonicalPath)) {
		throw new Error("Desktop discovery escaped its explicit root");
	}
	return { canonicalPath, stat };
}

async function addApplicationCandidate(
	candidates: ApplicationCandidate[],
	rootPath: string,
	asarPath: string,
	layout: DesktopApplicationLayout,
): Promise<void> {
	const file = await assertRegularFileWithin(rootPath, asarPath);
	if (!file) return;
	candidates.push({ rootPath, asarPath: file.canonicalPath, layout });
	if (candidates.length > MAX_APPLICATIONS) {
		throw new Error("Desktop application candidate count exceeds limit");
	}
}

async function findApplicationCandidates(
	platform: DesktopPlatform,
	appRoot: string,
): Promise<ApplicationCandidate[]> {
	const rootStat = await lstatOrNull(appRoot);
	if (!rootStat) return [];
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
		throw new Error("Desktop application root must be a real directory");
	}
	const candidates: ApplicationCandidate[] = [];
	if (platform === "darwin") {
		await addApplicationCandidate(
			candidates,
			appRoot,
			path.join(appRoot, "Contents", "Resources", "app.asar"),
			"macos-app",
		);
		return candidates;
	}
	if (platform === "linux") {
		await addApplicationCandidate(
			candidates,
			appRoot,
			path.join(appRoot, "resources", "app.asar"),
			"linux-package",
		);
		return candidates;
	}

	await addApplicationCandidate(
		candidates,
		appRoot,
		path.join(appRoot, "resources", "app.asar"),
		"windows-squirrel",
	);
	await addApplicationCandidate(
		candidates,
		path.join(appRoot, "app"),
		path.join(appRoot, "app", "resources", "app.asar"),
		"windows-msix",
	);
	const entries = await readBoundedDirectory(appRoot, "Desktop application");
	for (const entry of entries) {
		if (!entry.isDirectory() || !/^app-\d+(?:\.\d+){2,3}/.test(entry.name)) {
			continue;
		}
		const versionRoot = path.join(appRoot, entry.name);
		await addApplicationCandidate(
			candidates,
			versionRoot,
			path.join(versionRoot, "resources", "app.asar"),
			"windows-squirrel",
		);
	}
	return candidates;
}

async function inspectApplications(
	platform: DesktopPlatform,
	appRoot: string,
): Promise<DesktopApplicationRecord[]> {
	const candidates = await findApplicationCandidates(platform, appRoot);
	const applications: DesktopApplicationRecord[] = [];
	for (const candidate of candidates) {
		const metadata = await readDesktopPackageMetadata(candidate.asarPath);
		applications.push({
			locatorId: `desktop:${metadata.packageVersion}`,
			layout: candidate.layout,
			rootPath: candidate.rootPath,
			asarPath: candidate.asarPath,
			version: metadata.packageVersion,
			packagedAgentSdk: metadata.packagedAgentSdk,
			declaredCodePin: metadata.declaredCodePin,
			asarMemberCount: metadata.memberCount,
		});
	}
	applications.sort((left, right) =>
		compareDesktopVersions(right.version, left.version),
	);
	if (
		new Set(applications.map((application) => application.locatorId)).size !==
		applications.length
	) {
		throw new Error("Desktop application locator IDs are not unique");
	}
	return applications;
}

async function readAtMost(
	handle: fs.FileHandle,
	position: number,
	length: number,
): Promise<Buffer> {
	const buffer = Buffer.alloc(length);
	const { bytesRead } = await handle.read(buffer, 0, length, position);
	return buffer.subarray(0, bytesRead);
}

async function inspectNativeHeader(
	handle: fs.FileHandle,
): Promise<NativeHeaderMetadata> {
	const prefix = await readAtMost(handle, 0, 64);
	if (
		prefix.length >= 20 &&
		prefix[0] === 0x7f &&
		prefix.subarray(1, 4).toString("ascii") === "ELF"
	) {
		if (prefix[5] !== 1)
			return { binaryFormat: "elf", architecture: "unknown" };
		const machine = prefix.readUInt16LE(18);
		return {
			binaryFormat: "elf",
			architecture:
				machine === 0x3e ? "x64" : machine === 0xb7 ? "arm64" : "unknown",
		};
	}
	if (prefix.length >= 8 && prefix.subarray(0, 2).toString("ascii") === "MZ") {
		if (prefix.length < 64)
			return { binaryFormat: "pe", architecture: "unknown" };
		const peOffset = prefix.readUInt32LE(0x3c);
		if (peOffset > 1024 * 1024) {
			throw new Error("PE header offset exceeds inventory limit");
		}
		const peHeader = await readAtMost(handle, peOffset, 6);
		if (
			peHeader.length < 6 ||
			peHeader.subarray(0, 4).toString("binary") !== "PE\0\0"
		) {
			return { binaryFormat: "pe", architecture: "unknown" };
		}
		const machine = peHeader.readUInt16LE(4);
		return {
			binaryFormat: "pe",
			architecture:
				machine === 0x8664 ? "x64" : machine === 0xaa64 ? "arm64" : "unknown",
		};
	}
	if (prefix.length >= 8) {
		const magic = prefix.subarray(0, 4);
		const isLittle =
			magic.equals(Buffer.from([0xcf, 0xfa, 0xed, 0xfe])) ||
			magic.equals(Buffer.from([0xce, 0xfa, 0xed, 0xfe]));
		const isBig =
			magic.equals(Buffer.from([0xfe, 0xed, 0xfa, 0xcf])) ||
			magic.equals(Buffer.from([0xfe, 0xed, 0xfa, 0xce]));
		if (isLittle || isBig) {
			const cpuType = isLittle
				? prefix.readUInt32LE(4)
				: prefix.readUInt32BE(4);
			return {
				binaryFormat: "macho",
				architecture:
					cpuType === 0x01000007
						? "x64"
						: cpuType === 0x0100000c
							? "arm64"
							: "unknown",
			};
		}
	}
	return { binaryFormat: "unknown", architecture: "unknown" };
}

function hasSameFileIdentity(left: Stats, right: Stats): boolean {
	return (
		left.size === right.size &&
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs
	);
}

async function sha256Handle(
	handle: fs.FileHandle,
	expectedSize: number,
): Promise<string> {
	const hash = createHash("sha256");
	const chunk = Buffer.alloc(HASH_CHUNK_BYTES);
	let position = 0;
	for (;;) {
		const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
		if (bytesRead === 0) break;
		hash.update(chunk.subarray(0, bytesRead));
		position += bytesRead;
		if (position > expectedSize) {
			throw new Error("Desktop Code binary changed while hashing");
		}
	}
	if (position !== expectedSize) {
		throw new Error("Desktop Code binary changed while hashing");
	}
	return hash.digest("hex");
}

function toNativePlatform(
	platform: DesktopPlatform,
	metadata: NativeHeaderMetadata,
): NativeArtifactPlatform | null {
	if (metadata.architecture === "unknown") return null;
	if (platform === "win32" && metadata.binaryFormat === "pe") {
		return `win32-${metadata.architecture}`;
	}
	if (platform === "darwin" && metadata.binaryFormat === "macho") {
		return `darwin-${metadata.architecture}`;
	}
	if (platform === "linux" && metadata.binaryFormat === "elf") {
		return `linux-${metadata.architecture}`;
	}
	return null;
}

export async function inspectDesktopCodeSnapshotFromHandle(
	handle: fs.FileHandle,
	platform: DesktopPlatform,
	expectedIdentity: Stats,
): Promise<DesktopCodeSnapshot> {
	const before = await handle.stat();
	if (!hasSameFileIdentity(before, expectedIdentity)) {
		throw new Error("Desktop Code binary changed before inspection");
	}
	if (
		before.size < 1 ||
		before.size > MAX_BINARY_BYTES ||
		!Number.isSafeInteger(before.size)
	) {
		throw new Error("Desktop Code binary size exceeds inventory limit");
	}
	const metadata = await inspectNativeHeader(handle);
	const sha256 = await sha256Handle(handle, before.size);
	const after = await handle.stat();
	if (!hasSameFileIdentity(before, after)) {
		throw new Error("Desktop Code binary changed while inspecting");
	}
	return {
		...metadata,
		platform: toNativePlatform(platform, metadata),
		size: before.size,
		sha256,
	};
}

async function inspectCache(
	platform: DesktopPlatform,
	cacheRoot: string,
): Promise<DesktopCodeArtifactRecord[]> {
	const rootStat = await lstatOrNull(cacheRoot);
	if (!rootStat) return [];
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
		throw new Error("Desktop Code cache root must be a real directory");
	}
	const canonicalRoot = await fs.realpath(cacheRoot);
	const entries = await readBoundedDirectory(cacheRoot, "Desktop Code cache");
	const versionEntries = entries.filter(
		(entry) => entry.isDirectory() && VERSION_RE.test(entry.name),
	);
	if (versionEntries.length > MAX_CACHE_ROWS) {
		throw new Error("Desktop Code cache row count exceeds limit");
	}
	const binaryName = platform === "win32" ? "claude.exe" : "claude";
	const artifacts: DesktopCodeArtifactRecord[] = [];
	for (const entry of versionEntries) {
		const versionRoot = path.join(cacheRoot, entry.name);
		const canonicalVersionRoot = await fs.realpath(versionRoot);
		if (
			!isPathWithin(canonicalRoot, canonicalVersionRoot) ||
			path.dirname(canonicalVersionRoot) !== canonicalRoot
		) {
			throw new Error("Desktop Code cache row escaped its explicit root");
		}
		const binaryPath = path.join(versionRoot, binaryName);
		const binary = await assertRegularFileWithin(versionRoot, binaryPath);
		if (!binary) continue;
		if (
			binary.stat.size < 1 ||
			binary.stat.size > MAX_BINARY_BYTES ||
			!Number.isSafeInteger(binary.stat.size)
		) {
			throw new Error("Desktop Code binary size exceeds inventory limit");
		}
		const handle = await fs.open(binary.canonicalPath, fsConstants.O_RDONLY);
		try {
			const snapshot = await inspectDesktopCodeSnapshotFromHandle(
				handle,
				platform,
				binary.stat,
			);
			const pathAfter = await fs.lstat(binary.canonicalPath);
			if (!hasSameFileIdentity(binary.stat, pathAfter)) {
				throw new Error("Desktop Code cache path changed while inspecting");
			}
			artifacts.push({
				locatorId: `desktop-code:${entry.name}`,
				version: entry.name,
				cacheRootPath: cacheRoot,
				binaryPath: binary.canonicalPath,
				platform: snapshot.platform,
				binaryFormat: snapshot.binaryFormat,
				architecture: snapshot.architecture,
				size: snapshot.size,
				sha256: snapshot.sha256,
				signatureInspection: "not-inspected",
				patchReceiptInspection: "not-inspected",
			});
		} finally {
			await handle.close();
		}
	}
	artifacts.sort((left, right) =>
		compareDesktopVersions(right.version, left.version),
	);
	return artifacts;
}

export async function inspectDesktopInventory(
	options: DesktopInventoryOptions,
): Promise<DesktopInventoryReport> {
	const observedAt = options.observedAt ?? new Date().toISOString();
	if (Number.isNaN(Date.parse(observedAt))) {
		throw new Error("Desktop inventory observedAt is invalid");
	}
	const applications = await inspectApplications(
		options.platform,
		options.appRoot,
	);
	const cachedCode = await inspectCache(options.platform, options.cacheRoot);
	const selectedApplication = applications[0] ?? null;
	const pinned =
		selectedApplication?.declaredCodePin.status === "resolved"
			? cachedCode.find(
					(artifact) =>
						artifact.version === selectedApplication.declaredCodePin.version,
				)
			: null;
	const selectedCode = pinned ?? cachedCode[0] ?? null;
	return {
		schemaVersion: 1,
		platform: options.platform,
		applications,
		selectedApplicationLocatorId: selectedApplication?.locatorId ?? null,
		cacheRoots: [{ locatorId: "desktop-code-cache", path: options.cacheRoot }],
		cachedCode,
		selectedCodeLocatorId: selectedCode?.locatorId ?? null,
		selectedCodeReason: selectedCode
			? pinned
				? "declared-pin"
				: "highest-cached"
			: null,
		observedAt,
	};
}
