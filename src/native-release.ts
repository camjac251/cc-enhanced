import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getProtectedPaths } from "./promote.js";
import { DEFAULT_NATIVE_CACHE_DIR } from "./version-paths.js";

const DEFAULT_NATIVE_BUCKET =
	"https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases";
const VERSION_CHANNELS = new Set(["latest", "stable"]);
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 180_000;

interface NativeManifestPlatform {
	checksum: string;
}

interface NativeManifest {
	platforms: Record<string, NativeManifestPlatform>;
}

type NativeDownloadCandidateError = {
	candidate: string;
	message: string;
};

export function getNativeBinaryCandidates(platform: string): string[] {
	return platform.startsWith("windows-")
		? ["claude.exe", "claude"]
		: ["claude", "claude.exe"];
}

export function formatNativeDownloadFailure(
	version: string,
	platform: string,
	errors: NativeDownloadCandidateError[],
): string {
	if (errors.length === 0) {
		return `Could not download native binary for ${version}/${platform}. No download attempts were made.`;
	}

	const detail = errors
		.map(({ candidate, message }) => `  - ${candidate}: ${message}`)
		.join("\n");
	return `Could not download native binary for ${version}/${platform}. Attempts:\n${detail}`;
}

export interface NativeFetchOptions {
	spec?: string;
	platform?: string;
	cacheDir?: string;
	forceDownload?: boolean;
	bucketUrl?: string;
}

export interface NativeFetchResult {
	spec: string;
	version: string;
	platform: string;
	checksum: string;
	bucketUrl: string;
	manifestUrl: string;
	binaryUrl: string;
	manifestPath: string;
	binaryPath: string;
	fromCache: boolean;
}

function normalizeBucketUrl(bucketUrl: string): string {
	return bucketUrl.replace(/\/+$/, "");
}

function normalizeSpec(spec?: string): string {
	const value = (spec ?? "latest").trim();
	if (value.length === 0) return "latest";
	return value;
}

function parseTimeoutMs(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function getRequestTimeoutMs(): number {
	return parseTimeoutMs(
		process.env.CLAUDE_PATCHER_FETCH_TIMEOUT_MS,
		DEFAULT_FETCH_TIMEOUT_MS,
	);
}

function getDownloadTimeoutMs(): number {
	return parseTimeoutMs(
		process.env.CLAUDE_PATCHER_DOWNLOAD_TIMEOUT_MS,
		DEFAULT_DOWNLOAD_TIMEOUT_MS,
	);
}

async function fetchWithTimeout(
	url: string,
	timeoutMs: number,
): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { signal: controller.signal });
	} catch (error) {
		if (controller.signal.aborted) {
			throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

function resolveArch(rawArch: string): string {
	if (rawArch === "x64") return "x64";
	if (rawArch === "arm64") return "arm64";
	throw new Error(`Unsupported architecture for native fetch: ${rawArch}`);
}

function isMuslLinux(): boolean {
	if (process.platform !== "linux") return false;
	const muslLibs = [
		"/lib/libc.musl-x86_64.so.1",
		"/lib/libc.musl-aarch64.so.1",
	];
	if (muslLibs.some((filePath) => fs.existsSync(filePath))) return true;
	try {
		const out = execFileSync("ldd", ["/bin/ls"], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return out.includes("musl");
	} catch (error) {
		const text = error instanceof Error ? error.message : String(error);
		return text.includes("musl");
	}
}

export function detectNativeReleasePlatform(): string {
	const arch = resolveArch(process.arch);
	if (process.platform === "linux") {
		return isMuslLinux() ? `linux-${arch}-musl` : `linux-${arch}`;
	}
	if (process.platform === "darwin") {
		return `darwin-${arch}`;
	}
	if (process.platform === "win32") {
		return `windows-${arch}`;
	}
	throw new Error(`Unsupported platform for native fetch: ${process.platform}`);
}

async function fetchText(url: string): Promise<string> {
	const res = await fetchWithTimeout(url, getRequestTimeoutMs());
	if (!res.ok) {
		throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
	}
	return (await res.text()).trim();
}

async function fetchJson<T>(url: string): Promise<T> {
	const res = await fetchWithTimeout(url, getRequestTimeoutMs());
	if (!res.ok) {
		throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
	}
	return (await res.json()) as T;
}

function fileSha256(filePath: string): string {
	const hash = createHash("sha256");
	hash.update(fs.readFileSync(filePath));
	return hash.digest("hex");
}

function cleanupPartialDownload(filePath: string): void {
	if (!fs.existsSync(filePath)) return;
	fs.rmSync(filePath, { force: true });
}

function isCommandAvailable(command: string): boolean {
	try {
		execFileSync(command, ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function downloadToFileViaExternal(
	url: string,
	outPath: string,
): string | null {
	const downloadTimeoutSeconds = Math.max(
		1,
		Math.ceil(getDownloadTimeoutMs() / 1000),
	);
	const requestTimeoutSeconds = Math.max(
		1,
		Math.ceil(getRequestTimeoutMs() / 1000),
	);
	const downloaders: Array<{
		command: string;
		args: string[];
	}> = [
		{
			command: "curl",
			args: [
				"-fL",
				"--retry",
				"3",
				"--retry-delay",
				"1",
				"--connect-timeout",
				String(requestTimeoutSeconds),
				"--max-time",
				String(downloadTimeoutSeconds),
				"-o",
				outPath,
				url,
			],
		},
		{
			command: "wget",
			args: [
				"-q",
				"--tries=3",
				"--timeout",
				String(downloadTimeoutSeconds),
				"-O",
				outPath,
				url,
			],
		},
	];

	const errors: string[] = [];
	for (const downloader of downloaders) {
		if (!isCommandAvailable(downloader.command)) continue;
		try {
			execFileSync(downloader.command, downloader.args, { stdio: "ignore" });
			return null;
		} catch (error) {
			cleanupPartialDownload(outPath);
			errors.push(
				`${downloader.command}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	if (errors.length === 0) {
		return "no external downloader available";
	}
	return errors.join("; ");
}

async function downloadToFile(url: string, outPath: string): Promise<void> {
	try {
		const res = await fetchWithTimeout(url, getDownloadTimeoutMs());
		if (!res.ok) {
			throw new Error(`Download failed for ${url}: HTTP ${res.status}`);
		}
		if (!res.body) {
			throw new Error(`No response body from ${url}`);
		}
		const nodeStream = Readable.fromWeb(
			res.body as unknown as Parameters<typeof Readable.fromWeb>[0],
		);
		await pipeline(nodeStream, fs.createWriteStream(outPath));
	} catch (error) {
		cleanupPartialDownload(outPath);
		const fetchMessage = error instanceof Error ? error.message : String(error);
		const externalMessage = downloadToFileViaExternal(url, outPath);
		if (externalMessage === null) {
			return;
		}
		throw new Error(
			`Download failed for ${url} via fetch (${fetchMessage}); external fallback failed (${externalMessage})`,
		);
	}
}
function ensureExecutable(filePath: string): void {
	if (process.platform === "win32") return;
	fs.chmodSync(filePath, 0o755);
}

function compareSemver(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

function evictOldVersions(cacheDir: string): void {
	const keep = Number(process.env.CLAUDE_PATCHER_CACHE_KEEP) || 2;
	if (!fs.existsSync(cacheDir)) return;

	const protectedPaths = getProtectedPaths();
	const entries = fs
		.readdirSync(cacheDir)
		.filter((e) => /^\d+\.\d+\.\d+/.test(e));
	entries.sort(compareSemver); // descending by semver

	let kept = 0;
	for (const entry of entries) {
		const entryPath = path.resolve(path.join(cacheDir, entry));
		if (protectedPaths.has(entryPath)) {
			// Never evict versions referenced by current/previous symlinks
			continue;
		}
		kept++;
		if (kept > keep) {
			try {
				fs.rmSync(entryPath, { recursive: true, force: true });
			} catch {
				// best-effort cleanup
			}
		}
	}
}

export async function fetchNativeRelease(
	options: NativeFetchOptions = {},
): Promise<NativeFetchResult> {
	const spec = normalizeSpec(options.spec);
	const bucketUrl = normalizeBucketUrl(
		options.bucketUrl ??
			process.env.CLAUDE_PATCHER_NATIVE_BUCKET ??
			DEFAULT_NATIVE_BUCKET,
	);
	const platform = options.platform ?? detectNativeReleasePlatform();
	const cacheDir = path.resolve(options.cacheDir ?? DEFAULT_NATIVE_CACHE_DIR);

	const version = VERSION_CHANNELS.has(spec)
		? await fetchText(`${bucketUrl}/${spec}`)
		: spec;
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
		throw new Error(
			`Invalid native version resolved from '${spec}': ${version}`,
		);
	}

	const manifestUrl = `${bucketUrl}/${version}/manifest.json`;
	const manifest = await fetchJson<NativeManifest>(manifestUrl);
	const platformEntry = manifest.platforms?.[platform];
	if (!platformEntry?.checksum) {
		const available = Object.keys(manifest.platforms ?? {})
			.sort()
			.join(", ");
		throw new Error(
			`Platform '${platform}' not found in manifest for ${version}. Available: ${available}`,
		);
	}
	const checksum = platformEntry.checksum.toLowerCase();
	if (!/^[a-f0-9]{64}$/.test(checksum)) {
		throw new Error(
			`Manifest checksum for ${platform} in ${version} is invalid: ${platformEntry.checksum}`,
		);
	}

	evictOldVersions(cacheDir);

	const platformDir = path.join(cacheDir, version, platform);
	fs.mkdirSync(platformDir, { recursive: true });
	const manifestPath = path.join(cacheDir, version, "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

	const fileName = platform.startsWith("windows-") ? "claude.exe" : "claude";
	const binaryPath = path.join(platformDir, fileName);
	if (
		!options.forceDownload &&
		fs.existsSync(binaryPath) &&
		fileSha256(binaryPath) === checksum
	) {
		ensureExecutable(binaryPath);
		return {
			spec,
			version,
			platform,
			checksum,
			bucketUrl,
			manifestUrl,
			binaryUrl: `${bucketUrl}/${version}/${platform}/${fileName}`,
			manifestPath,
			binaryPath,
			fromCache: true,
		};
	}

	const binaryCandidates = getNativeBinaryCandidates(platform);
	const tmpPath = `${binaryPath}.tmp-download`;
	let selectedUrl = "";
	const candidateErrors: NativeDownloadCandidateError[] = [];
	try {
		for (const candidate of binaryCandidates) {
			const candidateUrl = `${bucketUrl}/${version}/${platform}/${candidate}`;
			try {
				await downloadToFile(candidateUrl, tmpPath);
				selectedUrl = candidateUrl;
				break;
			} catch (error) {
				candidateErrors.push({
					candidate,
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}
		if (!selectedUrl) {
			throw new Error(
				formatNativeDownloadFailure(version, platform, candidateErrors),
			);
		}
		const actual = fileSha256(tmpPath);
		if (actual !== checksum) {
			throw new Error(
				`Checksum mismatch for ${selectedUrl}: expected ${checksum}, got ${actual}`,
			);
		}
		fs.renameSync(tmpPath, binaryPath);
		ensureExecutable(binaryPath);
		return {
			spec,
			version,
			platform,
			checksum,
			bucketUrl,
			manifestUrl,
			binaryUrl: selectedUrl,
			manifestPath,
			binaryPath,
			fromCache: false,
		};
	} finally {
		if (fs.existsSync(tmpPath)) {
			fs.rmSync(tmpPath, { force: true });
		}
	}
}
