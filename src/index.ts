#!/usr/bin/env node
import path from "node:path";
import chalk from "chalk";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { detectInstalledClaudeTarget } from "./installation-detection.js";
import { Manager } from "./manager.js";
import { allPatches } from "./patches/index.js";

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
			return yargs
				.option("format", {
					type: "boolean",
					default: true,
					description: "Format with Prettier (use --no-format to skip)",
				})
				.option("patch", {
					type: "boolean",
					default: true,
					description: "Apply patches (use --no-patch to skip)",
				})
				.option("dry-run", {
					type: "boolean",
					description: "Preview without writing",
				})
				.option("diff", {
					type: "boolean",
					description: "Show diff of changes",
				})
				.option("list", {
					type: "boolean",
					description: "List available patches and exit",
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
				});
		})
		.help()
		.parse();

	const opts = argv as any;
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

	// Handle --list early to avoid target detection side effects.
	if (opts.list) {
		console.log(chalk.bold("\nAvailable Patches\n"));
		for (const patch of allPatches) {
			console.log(`  • ${chalk.cyan(patch.tag)}`);
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
	if (!opts.format) console.log(chalk.yellow("Formatting disabled"));
	if (!opts.patch) console.log(chalk.yellow("Patching disabled"));
	console.log("");

	const manager = new Manager({
		target: resolvedTargetPath,
		outputPath: opts.output ? path.resolve(opts.output) : undefined,
		backupDir: opts.backupDir ? path.resolve(opts.backupDir) : undefined,
		nativeCacheDir: opts.nativeCacheDir
			? path.resolve(opts.nativeCacheDir)
			: undefined,
		format: opts.format,
		patch: opts.patch,
		dryRun: opts.dryRun,
		showDiff: opts.diff,
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

main();
