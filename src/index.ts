#!/usr/bin/env node
import path from "node:path";
import chalk from "chalk";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { detectInstalledClaudeTarget } from "./installation-detection.js";
import { Manager } from "./manager.js";
import { allPatches } from "./patches/index.js";
import type {
	PatchedVersionInfo,
	PromoteResult,
	RollbackResult,
	StatusInfo,
} from "./promote.js";

function stringifySummary(report: unknown): string {
	const seen = new WeakSet<object>();
	const MAX_STRING_LENGTH = 200_000;

	try {
		return JSON.stringify(
			report,
			(key, value) => {
				if (key === "ast") return "[omitted: Babel AST]";
				if (typeof value === "bigint") return value.toString();
				if (value instanceof Error) {
					return {
						name: value.name,
						message: value.message,
						stack: value.stack,
					};
				}
				if (typeof value === "string" && value.length > MAX_STRING_LENGTH) {
					const truncatedBy = value.length - MAX_STRING_LENGTH;
					return `${value.slice(0, MAX_STRING_LENGTH)}... [truncated ${truncatedBy} chars]`;
				}
				if (typeof value === "object" && value !== null) {
					if (seen.has(value)) return "[Circular]";
					seen.add(value);
				}
				return value;
			},
			2,
		);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return JSON.stringify(
			{
				error: "Failed to serialize full summary",
				reason,
			},
			null,
			2,
		);
	}
}

async function main() {
	const argv = await yargs(hideBin(process.argv))
		.version(false)
		.command("$0", "Patch installed Claude target", (yargs) => {
			return (
				yargs
					.option("patch", {
						type: "boolean",
						default: true,
						description: "Apply patches (use --no-patch to skip)",
					})
					.option("dry-run", {
						type: "boolean",
						description: "Preview without writing",
					})
					.option("force", {
						type: "boolean",
						description: "Force patching even if target is already patched",
					})
					.option("diff", {
						type: "boolean",
						description: "Show diff of changes",
					})
					.option("list", {
						type: "boolean",
						description: "List available patches and exit",
					})
					.option("verify-anchors", {
						type: "boolean",
						description:
							"Verify patched/clean cli.js anchors using positional args: <patched_cli> <clean_cli>",
					})
					.option("verify-prompt-surfaces", {
						type: "boolean",
						description:
							"Verify exported live prompt surfaces using positional arg: <export_dir>",
					})
					.option("summary-path", {
						type: "string",
						description: "Write JSON summary to file",
					})
					.option("target", {
						type: "string",
						description:
							"Patch a local target path (cli.js or native claude binary)",
					})
					.option("detect-target", {
						type: "boolean",
						description:
							"Auto-detect installed claude path from PATH and patch it",
					})
					.option("output", {
						type: "string",
						description:
							"Output path for --target mode (default: patch target in-place)",
					})
					.option("backup-dir", {
						type: "string",
						description:
							"Directory for generated backups (default: ~/.claude-patcher/backups)",
					})
					.option("backup-path", {
						type: "string",
						description:
							"Explicit backup file path for --backup-only/--restore operations",
					})
					.option("backup-only", {
						type: "boolean",
						description: "Create a backup of target and exit",
					})
					.option("restore", {
						type: "boolean",
						description: "Restore target from backup and exit",
					})
					.option("unpack", {
						type: "string",
						description:
							"Extract embedded JS from native target and write to this file path",
					})
					.option("repack", {
						type: "string",
						description:
							"Read JS from this file and repack into native target (or --output path)",
					})
					.option("native-fetch", {
						type: "string",
						description:
							"Fetch native Claude binary from official releases (latest|stable|X.Y.Z) and use it as target",
					})
					.option("native-fetch-only", {
						type: "boolean",
						description:
							"Fetch native Claude binary to cache and exit without patching",
					})
					.option("native-platform", {
						type: "string",
						description:
							"Override native platform for fetch (e.g. linux-x64, darwin-arm64)",
					})
					.option("native-cache-dir", {
						type: "string",
						description:
							"Override native release cache directory (default: ~/.claude-patcher/native-cache)",
					})
					.option("native-force-download", {
						type: "boolean",
						description:
							"Force re-download native binary even when cache already exists",
					})
					// Build lifecycle flags
					.option("update", {
						type: "boolean",
						description: "Combined fetch+patch+promote flow (default: latest)",
					})
					.option("promote", {
						type: "string",
						description: "Promote a patched binary to active launcher",
					})
					.option("rollback", {
						type: "boolean",
						description: "Roll back to previous promoted binary",
					})
					.option("rollback-target", {
						type: "string",
						description:
							"Explicit binary path to roll back to (instead of previous)",
					})
					.option("status", {
						type: "boolean",
						description: "Show current/previous/cached version status and exit",
					})
					.option("skip-smoke-test", {
						type: "boolean",
						description: "Skip the post-promote smoke test (--version check)",
					})
					.option("fast-verify", {
						type: "boolean",
						description:
							"Speed up update-time anchor checks by skipping duplicate per-patch verifier pass",
					})
			);
		})
		.strictOptions()
		.help()
		.parse();

	const opts = argv as any;
	if (opts.verifyAnchors) {
		const positionalArgs = ((opts._ as unknown[]) ?? [])
			.map((value) => String(value))
			.filter((value) => value !== "$0");
		if (positionalArgs.length !== 2) {
			console.error(
				chalk.red(
					"--verify-anchors requires exactly two positional paths: <patched_cli.js> <clean_cli.js>",
				),
			);
			process.exit(1);
			return;
		}
		try {
			const [patchedCliPath, cleanCliPath] = positionalArgs.map((arg) =>
				path.resolve(arg),
			);
			const { verifyCliAnchors } = await import(
				"./verification/verify-cli-anchors.js"
			);
			const result = await verifyCliAnchors({ patchedCliPath, cleanCliPath });
			if (!result.ok) {
				for (const failure of result.failures) {
					console.error(
						chalk.red(
							`FAIL [${failure.scope}] ${failure.id}: ${failure.reason}`,
						),
					);
				}
				process.exit(1);
				return;
			}
			console.log("Anchor checks passed.");
			return;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(chalk.red(`Anchor verification failed: ${message}`));
			process.exit(1);
			return;
		}
	}
	if (opts.verifyPromptSurfaces) {
		const positionalArgs = ((opts._ as unknown[]) ?? [])
			.map((value) => String(value))
			.filter((value) => value !== "$0");
		if (positionalArgs.length !== 1) {
			console.error(
				chalk.red(
					"--verify-prompt-surfaces requires exactly one positional path: <export_dir>",
				),
			);
			process.exit(1);
			return;
		}
		try {
			const exportDir = path.resolve(positionalArgs[0]);
			const { verifyPromptSurfaces } = await import(
				"./verification/verify-prompt-surfaces.js"
			);
			const result = await verifyPromptSurfaces({ exportDir });
			if (!result.ok) {
				for (const failure of result.failures) {
					console.error(
						chalk.red(
							`FAIL [prompt-surface] ${failure.file} ${failure.id}: ${failure.reason}`,
						),
					);
				}
				process.exit(1);
				return;
			}
			console.log("Prompt surface checks passed.");
			return;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(
				chalk.red(`Prompt surface verification failed: ${message}`),
			);
			process.exit(1);
			return;
		}
	}

	const nativeFetchSpec =
		typeof opts.nativeFetch === "string" ? opts.nativeFetch.trim() : "";
	const hasNativeFetch = nativeFetchSpec.length > 0;
	const hasTargetOption = typeof opts.target === "string";
	const usesAutoTarget = opts.target === "auto";
	if (opts.detectTarget && hasTargetOption && !usesAutoTarget) {
		throw new Error("Use either --target or --detect-target, not both.");
	}
	if (opts.nativeFetchOnly && !hasNativeFetch) {
		throw new Error("--native-fetch-only requires --native-fetch.");
	}
	if (hasNativeFetch && hasTargetOption && !usesAutoTarget) {
		throw new Error("Use either --native-fetch or --target, not both.");
	}
	if (hasNativeFetch && (opts.detectTarget || usesAutoTarget)) {
		throw new Error(
			"Use either --native-fetch or --detect-target/--target auto, not both.",
		);
	}
	const operationModeCount = [
		!!opts.backupOnly,
		!!opts.restore,
		typeof opts.unpack === "string",
		typeof opts.repack === "string",
	].filter(Boolean).length;
	if (operationModeCount > 1) {
		throw new Error(
			"Use only one of --backup-only, --restore, --unpack, or --repack at a time.",
		);
	}
	if (operationModeCount > 0 && hasNativeFetch) {
		throw new Error(
			"Native operation flags cannot be combined with --native-fetch.",
		);
	}
	if (
		opts.update &&
		(hasTargetOption || opts.detectTarget || operationModeCount > 0)
	) {
		throw new Error(
			"--update cannot be combined with --target, --detect-target, or operation flags.",
		);
	}

	// ── Early-exit commands (no target needed) ─────────────────────────────

	if (opts.status) {
		const info = Manager.status({
			cacheDir: opts.nativeCacheDir
				? path.resolve(opts.nativeCacheDir)
				: undefined,
		});
		printStatus(info);
		return;
	}

	if (opts.rollback) {
		try {
			const result = Manager.rollback({
				target: opts.rollbackTarget
					? path.resolve(opts.rollbackTarget)
					: undefined,
				skipSmokeTest: opts.skipSmokeTest,
			});
			printRollbackResult(result);
		} catch (e) {
			console.error(e);
			process.exit(1);
		}
		return;
	}

	if (typeof opts.promote === "string" && !opts.update) {
		try {
			const result = Manager.promote(path.resolve(opts.promote), {
				skipSmokeTest: opts.skipSmokeTest,
			});
			printPromoteResult(result);
		} catch (e) {
			console.error(e);
			process.exit(1);
		}
		return;
	}

	if (opts.update) {
		try {
			const manager = new Manager({
				nativeCacheDir: opts.nativeCacheDir
					? path.resolve(opts.nativeCacheDir)
					: undefined,
				force: opts.force,
				patch: opts.patch,
				dryRun: opts.dryRun,
				showDiff: opts.diff,
				fastVerify: opts.fastVerify,
			});
			const result = await manager.updateNative(nativeFetchSpec || "latest", {
				platform:
					typeof opts.nativePlatform === "string"
						? opts.nativePlatform
						: undefined,
				forceDownload: !!opts.nativeForceDownload,
				promoteOptions: {
					skipSmokeTest: opts.skipSmokeTest,
				},
			});
			if (opts.summaryPath) {
				const fs = await import("node:fs/promises");
				const p = path.resolve(opts.summaryPath);
				await fs.mkdir(path.dirname(p), { recursive: true });
				await fs.writeFile(p, stringifySummary(result), "utf-8");
				console.log(`Summary written to ${p}`);
			}
			printUpdateResult(result);
		} catch (e) {
			console.error(e);
			process.exit(1);
		}
		return;
	}

	// Handle --list early to avoid target detection side effects.
	if (opts.list) {
		const { getPatchMetadata } = await import("./patch-metadata.js");
		const groups = new Map<string, typeof allPatches>();
		for (const patch of allPatches) {
			const meta = getPatchMetadata(patch.tag);
			const group = groups.get(meta.group) ?? [];
			group.push(patch);
			groups.set(meta.group, group);
		}
		console.log(chalk.bold("\nAvailable Patches\n"));
		for (const [groupName, patches] of groups) {
			console.log(chalk.bold.blue(`  ${groupName}`));
			for (const p of patches) {
				const meta = getPatchMetadata(p.tag);
				const flags = `${p.string ? "S" : " "}${p.astPasses ? "A" : " "}${p.postApply ? "P" : " "}`;
				console.log(
					`    ${chalk.cyan(p.tag.padEnd(20))} ${chalk.gray(meta.label)} ${chalk.dim(`[${flags}]`)}`,
				);
			}
		}
		console.log(`\nTotal: ${allPatches.length} patches\n`);
		return;
	}

	const hasExplicitTarget =
		typeof opts.target === "string" && opts.target !== "auto";
	const hasExplicitDetect = opts.detectTarget || opts.target === "auto";
	const shouldDetectTarget = !hasNativeFetch && !hasExplicitTarget;

	let resolvedTargetPath: string | undefined = hasExplicitTarget
		? path.resolve(opts.target)
		: undefined;
	let detectedTargetInfo:
		| { targetPath: string; source: string; kind: string }
		| undefined;
	let fetchedNativeInfo:
		| {
				spec: string;
				version: string;
				platform: string;
				binaryPath: string;
				fromCache: boolean;
		  }
		| undefined;

	if (shouldDetectTarget) {
		const detected = detectInstalledClaudeTarget();
		if (!detected) {
			if (hasExplicitDetect) {
				throw new Error(
					"Could not auto-detect an installed Claude target. Use --target /path/to/cli.js or /path/to/claude.",
				);
			}
			throw new Error(
				"Could not auto-detect an installed Claude target. Use --target or --detect-target to specify a target, or --native-fetch to download one.",
			);
		}
		resolvedTargetPath = detected.targetPath;
		detectedTargetInfo = detected;
	}

	if (hasNativeFetch) {
		try {
			const fetchManager = new Manager({
				nativeCacheDir: opts.nativeCacheDir
					? path.resolve(opts.nativeCacheDir)
					: undefined,
			});
			const fetched = await fetchManager.fetchNativeTarget(nativeFetchSpec, {
				platform:
					typeof opts.nativePlatform === "string"
						? opts.nativePlatform
						: undefined,
				forceDownload: !!opts.nativeForceDownload,
			});
			fetchedNativeInfo = {
				spec: fetched.spec,
				version: fetched.version,
				platform: fetched.platform,
				binaryPath: fetched.binaryPath,
				fromCache: fetched.fromCache,
			};
			resolvedTargetPath = fetched.binaryPath;

			if (opts.nativeFetchOnly) {
				console.log(
					chalk.green(
						`Fetched native binary: ${fetched.binaryPath} (${fetched.version}/${fetched.platform}, ${fetched.fromCache ? "cache" : "download"})`,
					),
				);
				return;
			}

			if (!opts.output && !opts.dryRun) {
				const ts = new Date()
					.toISOString()
					.replace(/[-:]/g, "")
					.replace(/\.\d+Z$/, "");
				const buildsDir = path.join(path.dirname(fetched.binaryPath), "builds");
				opts.output = path.join(buildsDir, `${ts}-claude`);
			}
		} catch (error) {
			console.error(error);
			process.exit(1);
		}
	}

	console.log(chalk.bold("\nClaude Code Patcher"));
	console.log(chalk.dim("==================="));
	console.log(`Target:  ${chalk.cyan(resolvedTargetPath)}`);
	if (opts.output) {
		console.log(`Output:  ${chalk.cyan(path.resolve(opts.output))}`);
	}
	if (detectedTargetInfo) {
		console.log(
			`Detect:  ${chalk.gray(`${detectedTargetInfo.kind} via ${detectedTargetInfo.source}`)}`,
		);
	}
	if (fetchedNativeInfo) {
		console.log(
			`Fetch:   ${chalk.gray(`${fetchedNativeInfo.version}/${fetchedNativeInfo.platform} via ${fetchedNativeInfo.spec} (${fetchedNativeInfo.fromCache ? "cache" : "download"})`)}`,
		);
	}
	console.log(`Patches: ${chalk.green(`${allPatches.length} patches`)}`);
	if (opts.dryRun)
		console.log(chalk.yellow("Dry run mode - no changes will be written"));

	if (!opts.patch) console.log(chalk.yellow("Patching disabled"));
	console.log("");

	const manager = new Manager({
		target: resolvedTargetPath,
		outputPath: opts.output ? path.resolve(opts.output) : undefined,
		backupDir: opts.backupDir ? path.resolve(opts.backupDir) : undefined,
		nativeCacheDir: opts.nativeCacheDir
			? path.resolve(opts.nativeCacheDir)
			: undefined,

		patch: opts.patch,
		dryRun: opts.dryRun,
		force: opts.force,
		showDiff: opts.diff,
		fastVerify: opts.fastVerify,
		summaryPath: opts.summaryPath ? path.resolve(opts.summaryPath) : undefined,
	});

	try {
		if (opts.backupOnly) {
			if (!resolvedTargetPath) {
				throw new Error(
					"--backup-only requires a target (use --target or --detect-target).",
				);
			}
			const result = await manager.backupTarget(
				resolvedTargetPath,
				opts.backupPath ? path.resolve(opts.backupPath) : undefined,
			);
			console.log(
				chalk.green(
					`Backup created: ${result.backupPath} (target: ${result.targetPath})`,
				),
			);
			return;
		}

		if (opts.restore) {
			if (!resolvedTargetPath) {
				throw new Error(
					"--restore requires a target (use --target or --detect-target).",
				);
			}
			const result = await manager.restoreTarget(
				resolvedTargetPath,
				opts.backupPath ? path.resolve(opts.backupPath) : undefined,
			);
			console.log(
				chalk.green(
					`Restored target: ${result.targetPath} (backup: ${result.backupPath})`,
				),
			);
			return;
		}

		if (typeof opts.unpack === "string") {
			if (!resolvedTargetPath) {
				throw new Error(
					"--unpack requires a target (use --target or --detect-target).",
				);
			}
			const result = await manager.unpackNativeTarget(
				resolvedTargetPath,
				path.resolve(opts.unpack),
			);
			console.log(
				chalk.green(
					`Unpacked native JS: ${result.outputJsPath} (target: ${result.targetPath})`,
				),
			);
			return;
		}

		if (typeof opts.repack === "string") {
			if (!resolvedTargetPath) {
				throw new Error(
					"--repack requires a target (use --target or --detect-target).",
				);
			}
			const result = await manager.repackNativeTarget(
				resolvedTargetPath,
				path.resolve(opts.repack),
				opts.output ? path.resolve(opts.output) : undefined,
			);
			console.log(
				chalk.green(
					`Repacked native target: ${result.outputPath} (source JS: ${result.inputJsPath})`,
				),
			);
			return;
		}

		const report = await manager.processTarget();

		if (opts.summaryPath && report) {
			const fs = await import("node:fs/promises");
			const p = path.resolve(opts.summaryPath);
			await fs.mkdir(path.dirname(p), { recursive: true });
			await fs.writeFile(p, stringifySummary(report), "utf-8");
			console.log(`Summary written to ${p}`);
		}
	} catch (e) {
		console.error(e);
		process.exit(1);
	}
}

// ── Display helpers ─────────────────────────────────────────────────────────

function printStatus(info: StatusInfo): void {
	console.log(chalk.bold("\nClaude Code Status\n"));

	if (info.current) {
		const v = info.current.version;
		console.log(chalk.green("  Current:"));
		console.log(`    Binary:  ${info.current.binaryPath}`);
		if (v) {
			const patchInfo = formatPatchInfo(v);
			console.log(`    Version: ${v.version}${patchInfo}`);
		}
	} else {
		console.log(chalk.yellow("  Current: (none)"));
	}

	if (info.previous) {
		const v = info.previous.version;
		console.log(chalk.blue("  Previous:"));
		console.log(`    Binary:  ${info.previous.binaryPath}`);
		if (v) {
			const patchInfo = formatPatchInfo(v);
			console.log(`    Version: ${v.version}${patchInfo}`);
		}
	} else {
		console.log(chalk.dim("  Previous: (none)"));
	}

	if (info.cachedVersions.length > 0) {
		console.log(chalk.bold("\n  Cached:"));
		for (const cv of info.cachedVersions) {
			const builds = cv.hasBuilds ? ` (${cv.buildCount} builds)` : "";
			console.log(`    ${cv.version}/${cv.platform}${builds}`);
		}
	}
	console.log("");
}

function formatPatchInfo(v: PatchedVersionInfo): string {
	if (!v.isPatched) return " (unpatched)";
	if (v.patchedTags.includes("signature")) {
		return ` (${v.patchedTags.length} patches)`;
	}
	const runtimeCount = v.patchedTags.length;
	const patchWord = runtimeCount === 1 ? "patch" : "patches";
	return ` (${runtimeCount} runtime ${patchWord} + signature)`;
}

function printPromoteResult(result: PromoteResult): void {
	console.log(chalk.green("\nPromoted:"));
	console.log(`  Target:   ${result.target}`);
	console.log(`  Current:  ${result.currentLink}`);
	if (result.previousTarget) {
		console.log(`  Previous: ${result.previousTarget}`);
	}
	if (result.smokeTestVersion) {
		console.log(`  Version:  ${result.smokeTestVersion}`);
	} else {
		console.log(
			chalk.yellow("  Warning: smoke test did not return version info"),
		);
	}
	for (const cleaned of result.cleanedBuilds) {
		console.log(chalk.dim(`  Cleaned:  ${cleaned}`));
	}
	console.log("");
}

function printRollbackResult(result: RollbackResult): void {
	console.log(chalk.green("\nRolled back:"));
	console.log(`  Target:   ${result.target}`);
	if (result.previousTarget) {
		console.log(`  Previous: ${result.previousTarget}`);
	}
	if (result.smokeTestVersion) {
		console.log(`  Version:  ${result.smokeTestVersion}`);
	}
	console.log("");
}

function printUpdateResult(result: {
	fetchResult: { version: string; platform: string; fromCache: boolean };
	patchOutputPath: string;
	dryRun: boolean;
	promoteResult?: PromoteResult;
}): void {
	const fr = result.fetchResult;
	console.log(
		chalk.green(
			result.dryRun ? "\nUpdate dry run complete:" : "\nUpdate complete:",
		),
	);
	console.log(
		`  Fetched:  ${fr.version}/${fr.platform} (${fr.fromCache ? "cache" : "download"})`,
	);
	if (result.dryRun) {
		console.log(
			`  Patch out: ${result.patchOutputPath} (not written in --dry-run mode)`,
		);
		console.log("");
		return;
	}
	console.log(`  Patched:  ${result.patchOutputPath}`);
	if (!result.promoteResult) {
		console.log(chalk.yellow("  Warning: promote step did not run"));
		console.log("");
		return;
	}
	printPromoteResult(result.promoteResult);
}

main();
