import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import chalk from "chalk";
import * as semver from "semver";
import * as tar from "tar";

const NPM_REGISTRY = "https://registry.npmjs.org";
const PKG_NAME = "@anthropic-ai/claude-code";
const CACHE_DIR = path.join(os.tmpdir(), "claude-patcher-cache");

interface Dist {
	tarball: string;
}

interface VersionMeta {
	dist: Dist;
}

interface PkgMeta {
	"dist-tags": { latest: string };
	versions: Record<string, VersionMeta>;
}

async function fetchJson<T>(url: string): Promise<T> {
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`Failed to fetch ${url}: ${res.statusText}`);
	}
	return res.json() as Promise<T>;
}

export async function getPackageMeta(): Promise<PkgMeta> {
	return fetchJson<PkgMeta>(`${NPM_REGISTRY}/${PKG_NAME}`);
}

export function getAllVersions(meta: PkgMeta): string[] {
	return Object.keys(meta.versions).sort((a, b) => {
		return semver.compare(a, b);
	});
}

export function getLatestVersion(meta: PkgMeta): string {
	const latest = meta["dist-tags"].latest || getAllVersions(meta).pop();
	if (!latest) {
		throw new Error("No versions found");
	}
	return latest;
}

export function versionExists(meta: PkgMeta, version: string): boolean {
	return version in meta.versions;
}

export function getTarballUrl(meta: PkgMeta, version: string): string {
	const vmeta = meta.versions[version];
	if (!vmeta) {
		throw new Error(`Version not found: ${version}`);
	}
	let url = vmeta.dist.tarball;
	if (!url) {
		const base = PKG_NAME.split("/").pop();
		url = `${NPM_REGISTRY}/${PKG_NAME}/-/${base}-${version}.tgz`;
	}
	return url;
}

async function getCachedOrDownload(
	version: string,
	url: string,
): Promise<Buffer> {
	const cachePath = path.join(CACHE_DIR, `${version}.tgz`);

	if (fs.existsSync(cachePath)) {
		console.log(chalk.gray(`   Using cached tarball for ${version}`));
		return fs.readFileSync(cachePath);
	}

	const res = await fetch(url);
	if (!res.ok || !res.body) {
		throw new Error(`Failed to download tarball from ${url}`);
	}

	const arrayBuffer = await res.arrayBuffer();
	const buffer = Buffer.from(arrayBuffer);

	// Cache for future use
	fs.mkdirSync(CACHE_DIR, { recursive: true });
	fs.writeFileSync(cachePath, buffer);

	return buffer;
}

export function clearCache() {
	if (fs.existsSync(CACHE_DIR)) {
		fs.rmSync(CACHE_DIR, { recursive: true, force: true });
		console.log(chalk.gray(`Cleared cache at ${CACHE_DIR}`));
	}
}

export async function downloadAndExtract(
	version: string,
	destDir: string,
	meta?: PkgMeta,
) {
	if (!meta) {
		meta = await getPackageMeta();
	}

	// Ensure a clean destination (avoids stale files on re-run)
	if (fs.existsSync(destDir)) {
		fs.rmSync(destDir, { recursive: true, force: true });
	}

	const url = getTarballUrl(meta, version);
	const buffer = await getCachedOrDownload(version, url);

	fs.mkdirSync(destDir, { recursive: true });

	// Extract from buffer
	const tempFile = path.join(destDir, `package-${version}.tgz`);
	fs.writeFileSync(tempFile, buffer);

	await tar.extract({
		file: tempFile,
		cwd: destDir,
	});

	fs.unlinkSync(tempFile);
}
