import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	DEFAULT_NATIVE_CACHE_DIR,
	resolveVersionPaths,
} from "./version-paths.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface PromoteOptions {
	versionsDir?: string;
	binLink?: string;
	skipSmokeTest?: boolean;
	cleanOldBuilds?: boolean;
}

export interface PromoteResult {
	target: string;
	currentLink: string;
	previousTarget?: string;
	smokeTestVersion?: string;
	cleanedBuilds: string[];
}

export interface RollbackOptions {
	target?: string;
	versionsDir?: string;
	binLink?: string;
	skipSmokeTest?: boolean;
}

export interface RollbackResult {
	target: string;
	previousTarget?: string;
	smokeTestVersion?: string;
}

export interface PatchedVersionInfo {
	version: string;
	patchedTags: string[];
	isPatched: boolean;
}

export interface StatusInfo {
	current?: {
		binaryPath: string;
		version?: PatchedVersionInfo;
	};
	previous?: {
		binaryPath: string;
		version?: PatchedVersionInfo;
	};
	cachedVersions: Array<{
		version: string;
		platform: string;
		binaryPath: string;
		hasBuilds: boolean;
		buildCount: number;
	}>;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function resolveSymlinkTarget(linkPath: string): string | null {
	try {
		const stat = fs.lstatSync(linkPath);
		if (!stat.isSymbolicLink()) return null;
		return fs.realpathSync(linkPath);
	} catch {
		return null;
	}
}

/**
 * Atomic symlink update: create tmp symlink then rename over target.
 * `ln -sfn` is not atomic on all filesystems; rename is.
 */
function atomicSymlink(target: string, linkPath: string): void {
	const tmp = `${linkPath}.tmp-${process.pid}`;
	try {
		fs.symlinkSync(target, tmp);
		fs.renameSync(tmp, linkPath);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {}
		throw err;
	}
}

const VERSION_RE = /^(\d+\.\d+\.\d+)\s+\(Claude Code(?:;\s*patched:\s*(.+))?\)/;

/**
 * Run `<binary> --version` and parse the output.
 * Returns null if the binary can't be run or output doesn't match.
 */
export function extractVersionFromBinary(
	binaryPath: string,
): PatchedVersionInfo | null {
	try {
		const output = execFileSync(binaryPath, ["--version"], {
			encoding: "utf-8",
			timeout: 10_000,
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
		const match = VERSION_RE.exec(output);
		if (!match) return null;
		const version = match[1];
		const tagsStr = match[2]?.trim();
		const patchedTags = tagsStr
			? tagsStr
					.split(",")
					.map((t) => t.trim())
					.filter(Boolean)
			: [];
		return { version, patchedTags, isPatched: patchedTags.length > 0 };
	} catch {
		return null;
	}
}

// ── Promote ─────────────────────────────────────────────────────────────────

export function promote(
	target: string,
	options: PromoteOptions = {},
): PromoteResult {
	const resolvedTarget = fs.realpathSync(target);
	if (!fs.statSync(resolvedTarget).isFile()) {
		throw new Error(`Promote target is not a file: ${resolvedTarget}`);
	}

	const vp = resolveVersionPaths({
		versionsDir: options.versionsDir,
		binLink: options.binLink,
	});

	fs.mkdirSync(vp.versionsDir, { recursive: true });
	fs.mkdirSync(path.dirname(vp.binLink), { recursive: true });

	// Ensure target is executable
	const mode = fs.statSync(resolvedTarget).mode;
	if ((mode & 0o111) === 0) {
		fs.chmodSync(resolvedTarget, 0o755);
	}

	// Save old current as previous
	const oldTarget =
		resolveSymlinkTarget(vp.currentLink) ?? resolveSymlinkTarget(vp.binLink);

	let previousTarget: string | undefined;
	if (oldTarget && oldTarget !== resolvedTarget && fs.existsSync(oldTarget)) {
		atomicSymlink(oldTarget, vp.previousLink);
		previousTarget = oldTarget;
	}

	// Wire current -> target, binLink -> current
	atomicSymlink(resolvedTarget, vp.currentLink);
	atomicSymlink(vp.currentLink, vp.binLink);

	// Smoke test
	let smokeTestVersion: string | undefined;
	if (!options.skipSmokeTest) {
		const info = extractVersionFromBinary(resolvedTarget);
		smokeTestVersion = info
			? `${info.version}${info.isPatched ? " (patched)" : ""}`
			: undefined;
	}

	// Clean old builds
	const cleanedBuilds: string[] = [];
	if (options.cleanOldBuilds !== false) {
		const buildsDir = path.dirname(resolvedTarget);
		if (path.basename(buildsDir) === "builds") {
			const entries = fs.readdirSync(buildsDir);
			for (const name of entries) {
				const fullPath = path.join(buildsDir, name);
				if (name.endsWith(".patch-meta.json")) {
					const ownerPath = fullPath.replace(/\.patch-meta\.json$/, "");
					if (ownerPath === resolvedTarget) continue;
					if (previousTarget && ownerPath === previousTarget) continue;
				}
				// Keep current and previous targets
				if (fullPath === resolvedTarget) continue;
				if (previousTarget && fullPath === previousTarget) continue;
				try {
					fs.unlinkSync(fullPath);
					cleanedBuilds.push(fullPath);
				} catch {
					// best-effort
				}
			}
		}
	}

	return {
		target: resolvedTarget,
		currentLink: vp.currentLink,
		previousTarget,
		smokeTestVersion,
		cleanedBuilds,
	};
}

// ── Rollback ────────────────────────────────────────────────────────────────

export function rollback(options: RollbackOptions = {}): RollbackResult {
	const vp = resolveVersionPaths({
		versionsDir: options.versionsDir,
		binLink: options.binLink,
	});

	let resolvedTarget: string;
	if (options.target) {
		resolvedTarget = fs.realpathSync(options.target);
	} else {
		const prevTarget = resolveSymlinkTarget(vp.previousLink);
		if (!prevTarget) {
			throw new Error(
				`No previous target at ${vp.previousLink}. Use --rollback-target to specify one.`,
			);
		}
		resolvedTarget = prevTarget;
	}

	if (!fs.existsSync(resolvedTarget)) {
		throw new Error(`Rollback target does not exist: ${resolvedTarget}`);
	}

	// Swap: old current becomes new previous
	const oldCurrent = resolveSymlinkTarget(vp.currentLink);
	let previousTarget: string | undefined;
	if (
		oldCurrent &&
		oldCurrent !== resolvedTarget &&
		fs.existsSync(oldCurrent)
	) {
		atomicSymlink(oldCurrent, vp.previousLink);
		previousTarget = oldCurrent;
	}

	// Point current at rollback target
	atomicSymlink(resolvedTarget, vp.currentLink);
	atomicSymlink(vp.currentLink, vp.binLink);

	// Ensure executable
	const mode = fs.statSync(resolvedTarget).mode;
	if ((mode & 0o111) === 0) {
		fs.chmodSync(resolvedTarget, 0o755);
	}

	let smokeTestVersion: string | undefined;
	if (!options.skipSmokeTest) {
		const info = extractVersionFromBinary(resolvedTarget);
		smokeTestVersion = info
			? `${info.version}${info.isPatched ? " (patched)" : ""}`
			: undefined;
	}

	return { target: resolvedTarget, previousTarget, smokeTestVersion };
}

// ── Status ──────────────────────────────────────────────────────────────────

function compareSemverDesc(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

export interface StatusOptions {
	versionsDir?: string;
	binLink?: string;
	cacheDir?: string;
}

export function status(options: StatusOptions = {}): StatusInfo {
	const vp = resolveVersionPaths({
		versionsDir: options.versionsDir,
		binLink: options.binLink,
	});
	const cacheDir = options.cacheDir ?? DEFAULT_NATIVE_CACHE_DIR;

	let current: StatusInfo["current"];
	const currentTarget = resolveSymlinkTarget(vp.currentLink);
	if (currentTarget && fs.existsSync(currentTarget)) {
		current = {
			binaryPath: currentTarget,
			version: extractVersionFromBinary(currentTarget) ?? undefined,
		};
	}

	let previous: StatusInfo["previous"];
	const previousTarget = resolveSymlinkTarget(vp.previousLink);
	if (previousTarget && fs.existsSync(previousTarget)) {
		previous = {
			binaryPath: previousTarget,
			version: extractVersionFromBinary(previousTarget) ?? undefined,
		};
	}

	const cachedVersions: StatusInfo["cachedVersions"] = [];
	if (fs.existsSync(cacheDir)) {
		const versionDirs = fs
			.readdirSync(cacheDir)
			.filter((e) => /^\d+\.\d+\.\d+/.test(e))
			.sort(compareSemverDesc);

		for (const ver of versionDirs) {
			const verDir = path.join(cacheDir, ver);
			let entries: string[];
			try {
				entries = fs.readdirSync(verDir);
			} catch {
				continue;
			}
			const platformDirs = entries.filter((e) => {
				try {
					return fs.statSync(path.join(verDir, e)).isDirectory();
				} catch {
					return false;
				}
			});

			for (const plat of platformDirs) {
				const platDir = path.join(verDir, plat);
				const binaryName = plat.startsWith("windows-")
					? "claude.exe"
					: "claude";
				const binaryPath = path.join(platDir, binaryName);
				const buildsDir = path.join(platDir, "builds");
				let buildCount = 0;
				let hasBuilds = false;
				try {
					const buildEntries = fs.readdirSync(buildsDir);
					hasBuilds = true;
					buildCount = buildEntries.length;
				} catch {
					// no builds dir
				}
				cachedVersions.push({
					version: ver,
					platform: plat,
					binaryPath,
					hasBuilds,
					buildCount,
				});
			}
		}
	}

	return { current, previous, cachedVersions };
}

// ── Protected Paths (for eviction) ──────────────────────────────────────────

/**
 * Returns version directory paths that must never be evicted.
 * Layout: <cacheDir>/<version>/<platform>/builds/<timestamp>-claude
 */
export function getProtectedPaths(overrides?: {
	versionsDir?: string;
	binLink?: string;
}): Set<string> {
	const vp = resolveVersionPaths(overrides);
	const paths = new Set<string>();

	for (const link of [vp.currentLink, vp.previousLink]) {
		const target = resolveSymlinkTarget(link);
		if (!target) continue;

		// Walk up: binary -> builds/ -> platform/ -> version/
		let dir = path.dirname(target);
		if (path.basename(dir) === "builds") dir = path.dirname(dir);
		const versionDir = path.dirname(dir);

		if (/^\d+\.\d+\.\d+/.test(path.basename(versionDir))) {
			try {
				paths.add(fs.realpathSync(versionDir));
			} catch {
				// dangling symlink chain, skip
			}
		}
	}

	return paths;
}
