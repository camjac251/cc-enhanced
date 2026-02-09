import { createHash } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import chalk from "chalk";
import {
	extractClaudeJsFromNativeBinary,
	isNativeBinary,
	repackNativeBinary,
	unwrapBunCjsModule,
	wrapBunCjsModule,
} from "./native.js";
import {
	fetchNativeRelease,
	type NativeFetchResult,
} from "./native-release.js";
import { normalize } from "./normalizer.js";
import { PatchRunner } from "./patch-runner.js";
import { allPatches } from "./patches/index.js";
import type { PatchResult } from "./types.js";

interface ManagerOptions {
	target?: string;
	outputPath?: string;
	backupDir?: string;
	format?: boolean;
	patch?: boolean;
	dryRun?: boolean;
	showDiff?: boolean;
	summaryPath?: string;
	nativeCacheDir?: string;
}

export class Manager {
	constructor(private options: ManagerOptions) {}

	private async ensureOutputDir(filePath: string) {
		await fs.mkdir(path.dirname(filePath), { recursive: true });
	}

	private getDefaultBackupPath(targetPath: string): string {
		const digest = createHash("sha256")
			.update(path.resolve(targetPath))
			.digest("hex")
			.slice(0, 12);
		const backupRoot =
			this.options.backupDir ??
			path.join(os.homedir(), ".claude-patcher", "backups");
		return path.join(
			backupRoot,
			`${path.basename(targetPath)}.${digest}.backup`,
		);
	}

	private buildRunner(nativeMode = false): PatchRunner {
		if (!nativeMode) return new PatchRunner();
		const patches = allPatches.filter((p) => p.tag !== "signature");
		return new PatchRunner(patches);
	}

	private async normalizeCliJs(cliPath: string) {
		if (this.options.format === false) return;
		console.log(chalk.gray(`   Formatting ${path.basename(cliPath)}...`));
		try {
			const raw = await fs.readFile(cliPath, "utf-8");
			const formatted = await normalize(raw, { filepath: cliPath });
			await fs.writeFile(cliPath, formatted, "utf-8");
		} catch (e) {
			console.error(chalk.yellow(`   Formatting failed: ${e}`));
		}
	}

	private async patchCliPath(
		cliPath: string,
		nativeMode = false,
	): Promise<{ result?: PatchResult; error?: string }> {
		if (this.options.patch === false) {
			console.log(chalk.gray("   Skipping patches (--no-patch)"));
			return {};
		}

		console.log(chalk.gray("   Enhancing prompt/help text..."));
		try {
			const runner = this.buildRunner(nativeMode);
			const result = await runner.run(cliPath, {
				dryRun: this.options.dryRun,
				showDiff: this.options.showDiff,
			});
			this.logResult(result);
			return { result };
		} catch (e) {
			const error = String(e);
			console.error(chalk.red(`   Patch error: ${error}`));
			return { error };
		}
	}

	private async processLocalCliJsTarget(targetPath: string) {
		const outPath = this.options.outputPath ?? targetPath;
		const patchPath = this.options.dryRun ? targetPath : outPath;

		if (!this.options.dryRun && outPath !== targetPath) {
			await this.ensureOutputDir(outPath);
			await fs.copyFile(targetPath, patchPath);
		}

		await this.normalizeCliJs(patchPath);
		const patched = await this.patchCliPath(patchPath, false);
		return {
			target: targetPath,
			outputPath: outPath,
			mode: "cli.js",
			...patched,
		};
	}

	private async processNativeTarget(targetPath: string) {
		console.log(chalk.blue(`→ Extracting embedded JS from ${targetPath}`));
		const extractedCliText =
			extractClaudeJsFromNativeBinary(targetPath).toString("utf-8");
		const wrapper = unwrapBunCjsModule(extractedCliText);
		const tempDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "claude-native-patch-"),
		);
		const tempCliPath = path.join(tempDir, "cli.js");

		try {
			await fs.writeFile(
				tempCliPath,
				wrapper ? wrapper.body : extractedCliText,
				"utf-8",
			);
			await this.normalizeCliJs(tempCliPath);
			const previousNativeMode = process.env.CLAUDE_PATCHER_NATIVE_MODE;
			process.env.CLAUDE_PATCHER_NATIVE_MODE = "1";
			let patched: { result?: PatchResult; error?: string };
			try {
				patched = await this.patchCliPath(tempCliPath, true);
			} finally {
				if (previousNativeMode === undefined) {
					delete process.env.CLAUDE_PATCHER_NATIVE_MODE;
				} else {
					process.env.CLAUDE_PATCHER_NATIVE_MODE = previousNativeMode;
				}
			}

			const outputPath = this.options.outputPath ?? targetPath;
			if (!this.options.dryRun && outputPath !== targetPath) {
				await this.ensureOutputDir(outputPath);
			}

			if (
				this.options.patch === false &&
				!this.options.dryRun &&
				outputPath !== targetPath
			) {
				await fs.copyFile(targetPath, outputPath);
			}

			if (
				this.options.patch !== false &&
				!this.options.dryRun &&
				!patched.error
			) {
				const patchedBody = await fs.readFile(tempCliPath, "utf-8");
				const patchedJsText = wrapper
					? wrapBunCjsModule(wrapper, patchedBody)
					: patchedBody;
				console.log(
					chalk.blue(
						`→ Repacking patched JS into native binary ${outputPath === targetPath ? "(in-place)" : ""}`,
					),
				);
				repackNativeBinary(
					targetPath,
					Buffer.from(patchedJsText, "utf-8"),
					outputPath,
				);
			}

			return {
				target: targetPath,
				outputPath,
				mode: "native-linux",
				...patched,
			};
		} finally {
			try {
				await fs.rm(tempDir, { recursive: true, force: true });
			} catch {
				// best-effort cleanup
			}
		}
	}

	async fetchNativeTarget(
		spec: string,
		options?: {
			platform?: string;
			forceDownload?: boolean;
		},
	): Promise<NativeFetchResult> {
		return fetchNativeRelease({
			spec,
			platform: options?.platform,
			forceDownload: options?.forceDownload,
			cacheDir: this.options.nativeCacheDir,
		});
	}

	async processTarget() {
		if (!this.options.target) {
			throw new Error("Target path is required");
		}

		const targetPath = this.options.target;
		try {
			await fs.access(targetPath);
		} catch {
			throw new Error(`Target does not exist: ${targetPath}`);
		}

		const looksLikeCliJs =
			path.basename(targetPath) === "cli.js" ||
			path.extname(targetPath) === ".js";
		const looksLikeNative = isNativeBinary(targetPath);

		if (looksLikeCliJs) {
			console.log(chalk.blue(`→ Patching local cli.js: ${targetPath}`));
			return this.processLocalCliJsTarget(targetPath);
		}

		if (looksLikeNative) {
			console.log(chalk.blue(`→ Patching native binary: ${targetPath}`));
			return this.processNativeTarget(targetPath);
		}

		const stats = fsSync.statSync(targetPath);
		if (stats.isFile() && this.options.target.includes("claude")) {
			throw new Error(
				`Unsupported target format for ${targetPath}. File is not detected as ELF or cli.js.`,
			);
		}
		throw new Error(`Unsupported target: ${targetPath}`);
	}

	async backupTarget(targetPath: string, backupPath?: string) {
		const resolvedTarget = path.resolve(targetPath);
		const resolvedBackup = backupPath
			? path.resolve(backupPath)
			: this.getDefaultBackupPath(resolvedTarget);
		await this.ensureOutputDir(resolvedBackup);
		await fs.copyFile(resolvedTarget, resolvedBackup);
		return { targetPath: resolvedTarget, backupPath: resolvedBackup };
	}

	async restoreTarget(targetPath: string, backupPath?: string) {
		const resolvedTarget = path.resolve(targetPath);
		const resolvedBackup = backupPath
			? path.resolve(backupPath)
			: this.getDefaultBackupPath(resolvedTarget);
		await fs.access(resolvedBackup);
		await this.ensureOutputDir(resolvedTarget);
		let mode: number;
		try {
			mode = fsSync.statSync(resolvedTarget).mode;
		} catch {
			mode = fsSync.statSync(resolvedBackup).mode;
		}
		const tmpPath = `${resolvedTarget}.tmp-restore`;
		await fs.copyFile(resolvedBackup, tmpPath);
		fsSync.chmodSync(tmpPath, mode);
		fsSync.renameSync(tmpPath, resolvedTarget);
		return { targetPath: resolvedTarget, backupPath: resolvedBackup };
	}

	async unpackNativeTarget(targetPath: string, outputJsPath: string) {
		const resolvedTarget = path.resolve(targetPath);
		const resolvedOutput = path.resolve(outputJsPath);
		if (!isNativeBinary(resolvedTarget)) {
			throw new Error(`Target is not a native binary: ${resolvedTarget}`);
		}

		const extractedCliText =
			extractClaudeJsFromNativeBinary(resolvedTarget).toString("utf-8");
		const wrapper = unwrapBunCjsModule(extractedCliText);
		const outputText = wrapper ? wrapper.body : extractedCliText;
		await this.ensureOutputDir(resolvedOutput);
		await fs.writeFile(resolvedOutput, outputText, "utf-8");
		await this.normalizeCliJs(resolvedOutput);
		return { targetPath: resolvedTarget, outputJsPath: resolvedOutput };
	}

	async repackNativeTarget(
		targetPath: string,
		inputJsPath: string,
		outputPath?: string,
	) {
		const resolvedTarget = path.resolve(targetPath);
		const resolvedInput = path.resolve(inputJsPath);
		const resolvedOutput = outputPath
			? path.resolve(outputPath)
			: resolvedTarget;
		if (!isNativeBinary(resolvedTarget)) {
			throw new Error(`Target is not a native binary: ${resolvedTarget}`);
		}

		const sourceCliText =
			extractClaudeJsFromNativeBinary(resolvedTarget).toString("utf-8");
		const wrapper = unwrapBunCjsModule(sourceCliText);
		const inputBody = await fs.readFile(resolvedInput, "utf-8");
		const repackedText = wrapper
			? wrapBunCjsModule(wrapper, inputBody)
			: inputBody;

		if (resolvedOutput !== resolvedTarget) {
			await this.ensureOutputDir(resolvedOutput);
		}
		repackNativeBinary(
			resolvedTarget,
			Buffer.from(repackedText, "utf-8"),
			resolvedOutput,
		);
		return {
			targetPath: resolvedTarget,
			inputJsPath: resolvedInput,
			outputPath: resolvedOutput,
		};
	}

	private logResult(r: PatchResult) {
		const applied = r.appliedTags.join(", ") || "None";
		console.log(chalk.green(`     - Applied: ${applied}`));
		if (r.groupResults && r.groupResults.length > 0) {
			console.log(chalk.gray("     - Groups:"));
			for (const group of r.groupResults) {
				const status =
					group.failed > 0
						? chalk.yellow(`${group.passed}/${group.total} passed`)
						: chalk.green(`${group.passed}/${group.total} passed`);
				console.log(chalk.gray(`       ${group.group}: `) + status);
			}
		}

		if (r.failedTags.length > 0) {
			console.log(chalk.yellow(`     - Failed: ${r.failedTags.join(", ")}`));
			// Print failure reasons
			for (const v of r.verifications) {
				if (!v.passed && v.reason) {
					console.log(chalk.yellow(`       ${v.tag}: ${v.reason}`));
				}
			}
		}

		if (r.limits && Object.keys(r.limits).length > 0) {
			console.log(chalk.green(`     - Limits bumped`));
		}
	}
}
