import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { detectNativeBinaryKind } from "./native.js";

export type InstalledTargetKind =
	| "native-linux"
	| "native-macos"
	| "native-windows"
	| "cli.js";

export interface DetectedInstalledTarget {
	targetPath: string;
	source: string;
	kind: InstalledTargetKind;
}

function fileExists(filePath: string): boolean {
	try {
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}

function isExecutableFile(filePath: string): boolean {
	try {
		const stat = fs.statSync(filePath);
		if (!stat.isFile()) return false;
		if (process.platform === "win32") return true;
		return (stat.mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

function tryResolveRealpath(filePath: string): string {
	try {
		return fs.realpathSync(filePath);
	} catch {
		return filePath;
	}
}

function tryResolveFromPathEnv(binaryName: string): string | null {
	const pathValue = process.env.PATH;
	if (!pathValue) return null;

	for (const dir of pathValue.split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, binaryName);
		if (!isExecutableFile(candidate)) continue;
		return candidate;
	}
	return null;
}

function detectKind(filePath: string): InstalledTargetKind | null {
	if (!fileExists(filePath)) return null;
	const nativeKind = detectNativeBinaryKind(filePath);
	if (nativeKind === "elf") return "native-linux";
	if (nativeKind === "macho") return "native-macos";
	if (nativeKind === "pe") return "native-windows";
	if (
		path.basename(filePath) === "cli.js" ||
		path.extname(filePath) === ".js"
	) {
		return "cli.js";
	}
	return null;
}

function tryResolveCliJsNearExecutable(execPath: string): string | null {
	const baseDir = path.dirname(execPath);
	const relCandidates = [
		"../lib/node_modules/@anthropic-ai/claude-code/cli.js",
		"../node_modules/@anthropic-ai/claude-code/cli.js",
		"node_modules/@anthropic-ai/claude-code/cli.js",
	];
	for (const rel of relCandidates) {
		const candidate = path.resolve(baseDir, rel);
		if (fileExists(candidate)) return candidate;
	}

	let current = baseDir;
	for (let i = 0; i < 6; i++) {
		const candidate = path.join(
			current,
			"node_modules",
			"@anthropic-ai",
			"claude-code",
			"cli.js",
		);
		if (fileExists(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return null;
}

function tryDetectFromPathExecutable(): DetectedInstalledTarget | null {
	let rawPath = tryResolveFromPathEnv("claude");
	if (!rawPath) {
		// Fallback for environments where PATH resolution differs from Node process PATH.
		try {
			rawPath = execFileSync("which", ["claude"], { encoding: "utf-8" }).trim();
		} catch {
			return null;
		}
	}
	if (!rawPath) return null;

	const resolved = tryResolveRealpath(rawPath);
	const directKind = detectKind(resolved);
	if (directKind) {
		return { targetPath: resolved, source: "PATH:claude", kind: directKind };
	}

	const nearCli = tryResolveCliJsNearExecutable(resolved);
	if (!nearCli) return null;
	const kind = detectKind(nearCli);
	if (!kind) return null;
	return { targetPath: nearCli, source: "PATH:claude-nearby-cli", kind };
}

function listVersionedNativeCandidates(dirPath: string): string[] {
	try {
		const entries = fs.readdirSync(dirPath);
		const versionLike = /^\d+\.\d+\.\d+$/;
		return entries
			.filter((entry) => versionLike.test(entry))
			.map((entry) => path.join(dirPath, entry));
	} catch {
		return [];
	}
}

function tryDetectFromKnownPaths(): DetectedInstalledTarget | null {
	const home = os.homedir();
	const candidates = [
		path.join(home, ".local", "bin", "claude"),
		path.join(home, ".claude", "local", "claude"),
		path.join(home, ".local", "share", "claude", "current"),
		path.join(
			home,
			"Library",
			"Application Support",
			"Claude",
			"current",
			"claude",
		),
		...listVersionedNativeCandidates(
			path.join(home, ".local", "share", "claude", "versions"),
		),
		...listVersionedNativeCandidates(
			path.join(home, "Library", "Application Support", "Claude", "versions"),
		),
	];
	for (const candidate of candidates) {
		const resolved = tryResolveRealpath(candidate);
		const kind = detectKind(resolved);
		if (kind) {
			return { targetPath: resolved, source: "known-path", kind };
		}
	}
	return null;
}

export function detectInstalledClaudeTarget(): DetectedInstalledTarget | null {
	return tryDetectFromPathExecutable() ?? tryDetectFromKnownPaths();
}
