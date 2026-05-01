#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");

interface DryRunSummary {
	error?: unknown;
	result?: {
		failedTags?: unknown;
		appliedTags?: unknown;
		verifications?: unknown;
	};
}

interface PatchVerification {
	tag?: unknown;
	passed?: unknown;
	reason?: unknown;
}

interface VerifyPaths {
	tmpDir: string;
	ownTmpDir: boolean;
	cliSummary: string;
	nativeSummary: string;
	cliPatchedForAnchors: string;
	nativePatchedForPrompts: string;
	nativePatchedJsDir: string;
	nativePatchedJs: string;
	nativePromptExportLabel: string;
	nativePromptExportDir: string;
	ownPromptExportDir: boolean;
}

function envValue(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value ? value : undefined;
}

function resolvePath(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return path.resolve(repoRoot, value);
}

function fileExists(filePath: string | undefined): filePath is string {
	if (!filePath) return false;
	try {
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}

function formatCommand(command: string, args: readonly string[]): string {
	return [command, ...args]
		.map((part) =>
			/^[A-Za-z0-9_./:=@+-]+$/.test(part) ? part : JSON.stringify(part),
		)
		.join(" ");
}

function run(
	command: string,
	args: string[],
	env: NodeJS.ProcessEnv = process.env,
): void {
	console.log(`$ ${formatCommand(command, args)}`);
	const result = spawnSync(command, args, {
		cwd: repoRoot,
		env,
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`${command} exited with code ${result.status ?? 1}: ${formatCommand(command, args)}`,
		);
	}
}

function runBun(args: string[]): void {
	run("bun", args);
}

function compareSemverLike(a: string, b: string): number {
	const parse = (value: string) =>
		value.split(".").map((part) => Number.parseInt(part, 10) || 0);
	const left = parse(a);
	const right = parse(b);
	const maxLen = Math.max(left.length, right.length);
	for (let index = 0; index < maxLen; index++) {
		const delta = (left[index] ?? 0) - (right[index] ?? 0);
		if (delta !== 0) return delta;
	}
	return 0;
}

function createVerifyPaths(): VerifyPaths {
	const configuredTmpDir = envValue("TMP_VERIFY_DIR");
	const tmpDir = configuredTmpDir
		? resolvePath(configuredTmpDir)
		: fs.mkdtempSync(path.join(os.tmpdir(), "cc-verify-patches."));
	const ownTmpDir = configuredTmpDir === undefined;

	const nativePatchedJsDir = resolvePath(
		envValue("NATIVE_PATCHED_JS_DIR") ??
			path.join(tmpDir, "native-prompt-export"),
	);
	const nativePromptExportLabel = path.basename(nativePatchedJsDir);
	const configuredPromptExportDir = envValue("NATIVE_PROMPT_EXPORT_DIR");

	return {
		tmpDir,
		ownTmpDir,
		cliSummary: resolvePath(
			envValue("CLI_SUMMARY") ??
				path.join(tmpDir, "cc-cli-dryrun-summary.json"),
		),
		nativeSummary: resolvePath(
			envValue("NATIVE_SUMMARY") ??
				path.join(tmpDir, "cc-native-dryrun-summary.json"),
		),
		cliPatchedForAnchors: resolvePath(
			envValue("CLI_PATCHED_FOR_ANCHORS") ??
				path.join(tmpDir, "cc-cli-patched-for-anchors.js"),
		),
		nativePatchedForPrompts: resolvePath(
			envValue("NATIVE_PATCHED_FOR_PROMPTS") ??
				path.join(tmpDir, "cc-native-patched"),
		),
		nativePatchedJsDir,
		nativePatchedJs: resolvePath(
			envValue("NATIVE_PATCHED_JS") ?? path.join(nativePatchedJsDir, "cli.js"),
		),
		nativePromptExportLabel,
		nativePromptExportDir: resolvePath(
			configuredPromptExportDir ??
				path.join(tmpDir, "exported-prompts", nativePromptExportLabel),
		),
		ownPromptExportDir: configuredPromptExportDir === undefined,
	};
}

function assertCleanSummary(summaryPath: string, label: string): void {
	const parsed = JSON.parse(
		fs.readFileSync(summaryPath, "utf8"),
	) as DryRunSummary;
	const result = parsed.result;
	if (
		!result ||
		!Array.isArray(result.failedTags) ||
		!Array.isArray(result.appliedTags)
	) {
		throw new Error(
			`Invalid dry-run summary schema for ${label}: ${summaryPath}`,
		);
	}
	if (parsed.error != null) {
		throw new Error(
			`Dry-run summary reports top-level error for ${label}: ${String(
				parsed.error,
			)}`,
		);
	}
	if (result.failedTags.length === 0) return;

	const verificationLines = Array.isArray(result.verifications)
		? (result.verifications as PatchVerification[])
				.filter((verification) => verification.passed === false)
				.map(
					(verification) =>
						`  - ${String(verification.tag ?? "unknown")}: ${String(
							verification.reason ?? "unknown",
						)}`,
				)
		: [];
	const details =
		verificationLines.length > 0 ? `\n${verificationLines.join("\n")}` : "";
	throw new Error(
		`Dry-run summary contains failed tags for ${label}: ${summaryPath}${details}`,
	);
}

function detectNativeTarget(): string | undefined {
	const currentLink = path.join(
		os.homedir(),
		".local/share/claude/versions/current",
	);
	try {
		if (!fs.lstatSync(currentLink).isSymbolicLink()) return undefined;
		const promotedBin = fs.realpathSync(currentLink);
		if (!fileExists(promotedBin)) return undefined;

		const buildsDir = path.dirname(promotedBin);
		if (path.basename(buildsDir) !== "builds") return undefined;

		const sourceBin = path.join(path.dirname(buildsDir), "claude");
		return fileExists(sourceBin) ? sourceBin : undefined;
	} catch {
		return undefined;
	}
}

function preparePromptExport(paths: VerifyPaths): void {
	fs.rmSync(paths.nativePatchedJsDir, { recursive: true, force: true });
	fs.rmSync(paths.nativePromptExportDir, { recursive: true, force: true });
	fs.mkdirSync(paths.nativePatchedJsDir, { recursive: true });
}

function verifyCliTarget(cliTarget: string, paths: VerifyPaths): void {
	runBun([
		"src/index.ts",
		"--target",
		cliTarget,
		"--dry-run",
		"--summary-path",
		paths.cliSummary,
	]);
	assertCleanSummary(paths.cliSummary, "cli.js");
}

function verifyNativeTarget(nativeTarget: string, paths: VerifyPaths): void {
	runBun([
		"src/index.ts",
		"--target",
		nativeTarget,
		"--dry-run",
		"--summary-path",
		paths.nativeSummary,
	]);
	assertCleanSummary(paths.nativeSummary, "native");

	runBun([
		"src/index.ts",
		"--target",
		nativeTarget,
		"--output",
		paths.nativePatchedForPrompts,
	]);
	runBun([
		"src/index.ts",
		"--target",
		paths.nativePatchedForPrompts,
		"--unpack",
		paths.nativePatchedJs,
	]);
	runBun([
		"scripts/export-prompts.ts",
		paths.nativePatchedJs,
		"--label",
		paths.nativePromptExportLabel,
		"--output-dir",
		paths.nativePromptExportDir,
	]);
	runBun([
		"src/index.ts",
		"--verify-prompt-surfaces",
		paths.nativePromptExportDir,
	]);

	const driftBaseline = envValue("PROMPT_DRIFT_BASELINE");
	if (driftBaseline) {
		runBun([
			"src/index.ts",
			"--verify-prompt-drift",
			paths.nativePromptExportDir,
			"--prompt-drift-baseline",
			resolvePath(driftBaseline),
		]);
	} else {
		console.log(
			"Skipping prompt drift check (set PROMPT_DRIFT_BASELINE to enable)",
		);
	}
}

function verifyAnchors(cliTarget: string, paths: VerifyPaths): void {
	fs.copyFileSync(cliTarget, paths.cliPatchedForAnchors);
	runBun(["src/index.ts", "--target", paths.cliPatchedForAnchors]);
	runBun([
		"src/index.ts",
		"--verify-anchors",
		paths.cliPatchedForAnchors,
		cliTarget,
	]);
}

function cleanup(paths: VerifyPaths): void {
	if (!paths.ownTmpDir) return;
	fs.rmSync(paths.tmpDir, { recursive: true, force: true });
	if (paths.ownPromptExportDir) {
		fs.rmSync(paths.nativePromptExportDir, { recursive: true, force: true });
	}
}

function listCleanVersions(): string[] {
	const versionsDir = path.join(repoRoot, "versions_clean");
	try {
		return fs
			.readdirSync(versionsDir, { withFileTypes: true })
			.filter(
				(entry) => entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name),
			)
			.map((entry) => entry.name)
			.sort(compareSemverLike);
	} catch {
		return [];
	}
}

function detectMatrixVersion(): string | undefined {
	const selected = envValue("SELECTED_VERSION");
	if (selected) return selected;

	const currentLink = path.join(
		os.homedir(),
		".local/share/claude/versions/current",
	);
	try {
		const currentTarget = fs.realpathSync(currentLink);
		const match = currentTarget.match(
			/\/native-cache\/([0-9]+\.[0-9]+\.[0-9]+)/,
		);
		if (match) return match[1];
	} catch {
		// Fall back to the newest clean version.
	}

	const cleanVersions = listCleanVersions();
	return cleanVersions[cleanVersions.length - 1];
}

function selectMatrixVersions(): string[] {
	const selected = envValue("SELECTED_VERSION");
	if (selected) return [selected];
	if (process.env.VERIFY_PATCHES_MATRIX_SCOPE === "all") {
		return listCleanVersions();
	}
	const detected = detectMatrixVersion();
	return detected ? [detected] : [];
}

function runPatchMatrix(): void {
	const selectedVersions = selectMatrixVersions();
	if (selectedVersions.length === 0) {
		throw new Error(
			"No versions selected. Set SELECTED_VERSION=<X.Y.Z>, VERIFY_PATCHES_MATRIX_SCOPE=all, or ensure versions_clean/<X.Y.Z>/cli.js exists.",
		);
	}

	const tmpDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "claude-patcher-matrix."),
	);
	let failures = 0;
	try {
		for (const selectedVersion of selectedVersions) {
			const target = path.join(
				repoRoot,
				"versions_clean",
				selectedVersion,
				"cli.js",
			);
			if (!fileExists(target)) {
				console.log(`==> Verifying ${selectedVersion}: missing target`);
				console.error(`  FAIL: selected target not found: ${target}`);
				failures += 1;
				continue;
			}

			const summaryPath = path.join(tmpDir, `summary-${selectedVersion}.json`);
			console.log(`==> Verifying ${selectedVersion}: ${target}`);
			const env = { ...process.env };
			delete env.CLAUDE_PATCHER_INCLUDE_TAGS;
			delete env.CLAUDE_PATCHER_EXCLUDE_TAGS;

			try {
				run(
					"bun",
					[
						"src/index.ts",
						"--target",
						target,
						"--dry-run",
						"--summary-path",
						summaryPath,
					],
					env,
				);
				assertCleanSummary(summaryPath, selectedVersion);
				const parsed = JSON.parse(
					fs.readFileSync(summaryPath, "utf8"),
				) as DryRunSummary;
				const appliedCount = Array.isArray(parsed.result?.appliedTags)
					? parsed.result.appliedTags.length
					: 0;
				console.log(`  PASS: 0 failed tags, ${appliedCount} applied`);
			} catch (error) {
				console.error(
					`  FAIL: ${error instanceof Error ? error.message : String(error)}`,
				);
				failures += 1;
			}
		}
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}

	if (failures > 0) {
		throw new Error(
			`Matrix failed: ${failures}/${selectedVersions.length} version(s) failed`,
		);
	}
	console.log(`Matrix passed: ${selectedVersions.length} version(s) verified`);
}

function main(): void {
	if (process.argv.includes("--help") || process.argv.includes("-h")) {
		console.log(`Usage: bun scripts/verify-patches.ts [--matrix]

Options:
  --matrix  Dry-run patches against selected clean cli.js versions.

Environment:
  CLI_TARGET                   Optional clean cli.js target for default verification.
  NATIVE_TARGET                Optional native binary target for default verification.
  PROMPT_DRIFT_BASELINE        Optional prompt drift baseline for default verification.
  SELECTED_VERSION             Version used by --matrix.
  VERIFY_PATCHES_MATRIX_SCOPE  Set to "all" to verify every versions_clean/<version>/cli.js.
`);
		return;
	}

	if (process.argv.includes("--matrix")) {
		runPatchMatrix();
		return;
	}

	const paths = createVerifyPaths();
	const cliTarget = envValue("CLI_TARGET")
		? resolvePath(envValue("CLI_TARGET") as string)
		: undefined;
	const configuredNativeTarget = envValue("NATIVE_TARGET");
	const nativeTarget = configuredNativeTarget
		? resolvePath(configuredNativeTarget)
		: detectNativeTarget();

	try {
		fs.mkdirSync(paths.tmpDir, { recursive: true });
		preparePromptExport(paths);

		runBun(["run", "typecheck"]);
		run(path.join(repoRoot, "node_modules", ".bin", "biome"), [
			"check",
			"src/",
			"scripts/verify-patches.ts",
		]);

		if (fileExists(cliTarget)) {
			verifyCliTarget(cliTarget, paths);
		} else {
			console.log("Skipping cli.js dry-run (set CLI_TARGET to enable)");
		}

		if (fileExists(nativeTarget)) {
			verifyNativeTarget(nativeTarget, paths);
		} else {
			console.log(
				"Skipping native dry-run (no NATIVE_TARGET and no promoted binary found)",
			);
		}

		if (fileExists(cliTarget)) {
			verifyAnchors(cliTarget, paths);
		} else {
			console.log("Skipping anchor checks (set CLI_TARGET to enable)");
		}
	} finally {
		cleanup(paths);
	}
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
}
