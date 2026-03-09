import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
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
import { getPatchMetadata } from "./patch-metadata.js";
import { PatchRunner } from "./patch-runner.js";
import { allPatches } from "./patches/index.js";
import {
	status as getStatus,
	type PromoteOptions,
	type PromoteResult,
	promote as promoteTarget,
	type RollbackOptions,
	type RollbackResult,
	rollback as rollbackTarget,
	type StatusInfo,
	type StatusOptions,
} from "./promote.js";
import type { PatchResult } from "./types.js";
import { verifyCliAnchors } from "./verification/verify-cli-anchors.js";

interface ManagerOptions {
	target?: string;
	outputPath?: string;
	backupDir?: string;

	patch?: boolean;
	dryRun?: boolean;
	showDiff?: boolean;
	fastVerify?: boolean;
	force?: boolean;
	summaryPath?: string;
	nativeCacheDir?: string;
}

interface PatchedBuildMetadata {
	cacheKey: string;
	version: string;
	platform: string;
	cleanSha256: string;
	selectedTags: string[];
	patcherRevision: string;
	createdAt: string;
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

	private async sha256File(filePath: string): Promise<string> {
		const hash = createHash("sha256");
		const file = await fs.open(filePath, "r");
		try {
			const buffer = Buffer.allocUnsafe(1024 * 1024);
			while (true) {
				const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
				if (bytesRead === 0) break;
				hash.update(buffer.subarray(0, bytesRead));
			}
		} finally {
			await file.close();
		}
		return hash.digest("hex");
	}

	private computeLocalRevisionFingerprint(): string | null {
		try {
			const hash = createHash("sha256");
			const managerSource = fsSync.readFileSync(
				fileURLToPath(import.meta.url),
				"utf-8",
			);
			hash.update(managerSource);
			for (const patch of [...allPatches].sort((a, b) =>
				a.tag.localeCompare(b.tag),
			)) {
				hash.update(patch.tag);
				hash.update(patch.string?.toString() ?? "");
				hash.update(patch.astPasses?.toString() ?? "");
				hash.update(patch.verify.toString());
				hash.update(patch.postApply?.toString() ?? "");
			}
			return hash.digest("hex").slice(0, 12);
		} catch {
			return null;
		}
	}

	private resolvePatcherRevision(): string {
		if (process.env.CLAUDE_PATCHER_REVISION) {
			return process.env.CLAUDE_PATCHER_REVISION.trim();
		}
		try {
			const head = execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: process.cwd(),
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 500,
			}).trim();
			const dirtyState = execFileSync(
				"git",
				["status", "--porcelain", "--untracked-files=no"],
				{
					cwd: process.cwd(),
					encoding: "utf-8",
					stdio: ["ignore", "pipe", "ignore"],
					timeout: 500,
				},
			).trim();
			if (dirtyState.length === 0) return head;
			const fingerprint = this.computeLocalRevisionFingerprint();
			if (!fingerprint) return `${head}-dirty`;
			return `${head}-dirty-${fingerprint}`;
		} catch {
			const fingerprint = this.computeLocalRevisionFingerprint();
			if (!fingerprint) return "unknown";
			return `local-${fingerprint}`;
		}
	}

	private getSelectedPatchTags(): string[] {
		return allPatches.map((patch) => patch.tag).sort();
	}

	private buildPatchedBuildMetaPath(buildPath: string): string {
		return `${buildPath}.patch-meta.json`;
	}

	private async computePatchedBuildCacheKey(
		fetchResult: NativeFetchResult,
	): Promise<{
		key: string;
		cleanSha256: string;
		selectedTags: string[];
		revision: string;
	}> {
		const cleanSha256 = await this.sha256File(fetchResult.binaryPath);
		const selectedTags = this.getSelectedPatchTags();
		const revision = this.resolvePatcherRevision();
		const rawKey = JSON.stringify({
			version: fetchResult.version,
			platform: fetchResult.platform,
			cleanSha256,
			selectedTags,
			revision,
		});
		const key = createHash("sha256").update(rawKey).digest("hex");
		return { key, cleanSha256, selectedTags, revision };
	}

	private async readPatchedBuildMetadata(
		buildPath: string,
	): Promise<PatchedBuildMetadata | null> {
		const metaPath = this.buildPatchedBuildMetaPath(buildPath);
		try {
			const raw = await fs.readFile(metaPath, "utf-8");
			const parsed = JSON.parse(raw) as Partial<PatchedBuildMetadata>;
			if (
				typeof parsed.cacheKey !== "string" ||
				typeof parsed.version !== "string" ||
				typeof parsed.platform !== "string" ||
				typeof parsed.cleanSha256 !== "string" ||
				!Array.isArray(parsed.selectedTags) ||
				typeof parsed.patcherRevision !== "string" ||
				typeof parsed.createdAt !== "string"
			) {
				return null;
			}
			return {
				cacheKey: parsed.cacheKey,
				version: parsed.version,
				platform: parsed.platform,
				cleanSha256: parsed.cleanSha256,
				selectedTags: parsed.selectedTags.filter(
					(value): value is string => typeof value === "string",
				),
				patcherRevision: parsed.patcherRevision,
				createdAt: parsed.createdAt,
			};
		} catch {
			return null;
		}
	}

	private async writePatchedBuildMetadata(
		buildPath: string,
		metadata: PatchedBuildMetadata,
	): Promise<void> {
		const metaPath = this.buildPatchedBuildMetaPath(buildPath);
		await fs.writeFile(metaPath, JSON.stringify(metadata, null, 2), "utf-8");
	}

	private async findReusablePatchedBuild(
		buildsDir: string,
		cacheKey: string,
	): Promise<string | null> {
		try {
			const entries = await fs.readdir(buildsDir);
			const candidates: Array<{ path: string; mtimeMs: number }> = [];
			for (const entry of entries) {
				if (entry.endsWith(".patch-meta.json")) continue;
				const fullPath = path.join(buildsDir, entry);
				let stat: fsSync.Stats;
				try {
					stat = fsSync.statSync(fullPath);
				} catch {
					continue;
				}
				if (!stat.isFile()) continue;
				if (!isNativeBinary(fullPath)) continue;
				const metadata = await this.readPatchedBuildMetadata(fullPath);
				if (!metadata || metadata.cacheKey !== cacheKey) continue;
				candidates.push({ path: fullPath, mtimeMs: stat.mtimeMs });
			}
			if (candidates.length === 0) return null;
			candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
			return candidates[0].path;
		} catch {
			return null;
		}
	}

	private buildRunner(nativeMode = false): PatchRunner {
		if (!nativeMode) {
			return new PatchRunner(undefined, { signaturePolicy: "auto" });
		}
		const patches = allPatches.filter((p) => p.tag !== "signature");
		return new PatchRunner(patches, { signaturePolicy: "force" });
	}

	private async normalizeCliJs(cliPath: string) {
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
			if (result.failedTags.length > 0) {
				return {
					error: `Patch verification failed: ${result.failedTags.join(", ")}`,
				};
			}
			return { result };
		} catch (e) {
			const error = String(e);
			console.error(chalk.red(`   Patch error: ${error}`));
			return { error };
		}
	}

	private isAlreadyPatched(code: string): boolean {
		return code.includes("(Claude Code;") && code.includes("patched:");
	}

	private async processLocalCliJsTarget(targetPath: string) {
		const code = await fs.readFile(targetPath, "utf-8");
		if (this.isAlreadyPatched(code) && !this.options.force) {
			console.log(
				chalk.yellow(
					"   Target already contains patch signature. Use --force to re-patch, or start from a clean binary.",
				),
			);
			return { target: targetPath, outputPath: targetPath, mode: "cli.js" };
		}

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
		const bodyToCheck = wrapper ? wrapper.body : extractedCliText;
		if (this.isAlreadyPatched(bodyToCheck) && !this.options.force) {
			console.log(
				chalk.yellow(
					"   Target already contains patch signature. Use --force to re-patch, or start from a clean binary.",
				),
			);
			const outputPath = this.options.outputPath ?? targetPath;
			return { target: targetPath, outputPath, mode: "native" };
		}
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

	async unpackNativeTarget(
		targetPath: string,
		outputJsPath: string,
		options?: { normalize?: boolean },
	) {
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
		if (options?.normalize !== false) {
			await this.normalizeCliJs(resolvedOutput);
		}
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

	// ── Static promote/rollback/status (no Manager instance needed) ────────

	static promote(target: string, options?: PromoteOptions): PromoteResult {
		return promoteTarget(target, options);
	}

	static rollback(options?: RollbackOptions): RollbackResult {
		return rollbackTarget(options);
	}

	static status(options?: StatusOptions): StatusInfo {
		return getStatus(options);
	}

	// ── Combined update flow ────────────────────────────────────────────────

	async updateNative(
		spec: string,
		options: {
			platform?: string;
			forceDownload?: boolean;
			promoteOptions?: PromoteOptions;
		} = {},
	): Promise<{
		fetchResult: NativeFetchResult;
		patchOutputPath: string;
		patchResult?: PatchResult;
		promoteResult?: PromoteResult;
		dryRun: boolean;
	}> {
		// Step 1: Fetch
		const fetchResult = await this.fetchNativeTarget(spec, {
			platform: options.platform,
			forceDownload: options.forceDownload,
		});

		// Step 2: Compute output path
		const ts = new Date()
			.toISOString()
			.replace(/[-:]/g, "")
			.replace(/\.\d+Z$/, "");
		const buildsDir = path.join(path.dirname(fetchResult.binaryPath), "builds");
		let patchOutputPath = path.join(buildsDir, `${ts}-claude`);
		let patchResult: PatchResult | undefined;
		const shouldUsePatchedBuildCache =
			this.options.patch !== false && !this.options.force;
		let patchCacheMeta:
			| {
					key: string;
					cleanSha256: string;
					selectedTags: string[];
					revision: string;
			  }
			| undefined;
		let reusedPatchedBuild = false;

		if (shouldUsePatchedBuildCache) {
			patchCacheMeta = await this.computePatchedBuildCacheKey(fetchResult);
			const reusableBuild = await this.findReusablePatchedBuild(
				buildsDir,
				patchCacheMeta.key,
			);
			if (reusableBuild) {
				patchOutputPath = reusableBuild;
				reusedPatchedBuild = true;
				console.log(
					chalk.gray(`→ Reusing cached patched build: ${reusableBuild}`),
				);
			}
		}

		if (!reusedPatchedBuild) {
			// Step 3: Patch
			const patchManager = new Manager({
				...this.options,
				target: fetchResult.binaryPath,
				outputPath: patchOutputPath,
			});
			const report = await patchManager.processTarget();
			if (report?.error) {
				throw new Error(`Patch step failed before promote: ${report.error}`);
			}
			patchResult = report?.result;

			if (
				!this.options.dryRun &&
				this.options.patch !== false &&
				patchCacheMeta
			) {
				await this.writePatchedBuildMetadata(patchOutputPath, {
					cacheKey: patchCacheMeta.key,
					version: fetchResult.version,
					platform: fetchResult.platform,
					cleanSha256: patchCacheMeta.cleanSha256,
					selectedTags: patchCacheMeta.selectedTags,
					patcherRevision: patchCacheMeta.revision,
					createdAt: new Date().toISOString(),
				});
			}
		}

		if (!this.options.dryRun && this.options.patch !== false) {
			const tempDir = await fs.mkdtemp(
				path.join(os.tmpdir(), "claude-anchor-check-"),
			);
			const cleanCliPath = path.join(tempDir, "clean-cli.js");
			const patchedCliPath = path.join(tempDir, "patched-cli.js");
			try {
				await Promise.all([
					this.unpackNativeTarget(fetchResult.binaryPath, cleanCliPath, {
						normalize: false,
					}),
					this.unpackNativeTarget(patchOutputPath, patchedCliPath, {
						normalize: false,
					}),
				]);
				const anchorResult = await verifyCliAnchors({
					patchedCliPath,
					cleanCliPath,
					skipPatchVerifiers: this.options.fastVerify === true,
					signatureExpectation: "allow-forced",
				});
				if (!anchorResult.ok) {
					const formattedFailures = anchorResult.failures
						.map(
							(failure) =>
								`[${failure.scope}] ${failure.id}: ${failure.reason}`,
						)
						.join("; ");
					throw new Error(
						`Refusing to promote patched build. Anchor verification failed: ${formattedFailures}`,
					);
				}
			} finally {
				await fs.rm(tempDir, { recursive: true, force: true });
			}
		}

		if (this.options.dryRun) {
			return {
				fetchResult,
				patchOutputPath,
				patchResult,
				dryRun: true,
			};
		}

		// Step 4: Promote
		const promoteResult = promoteTarget(
			patchOutputPath,
			options.promoteOptions,
		);

		return {
			fetchResult,
			patchOutputPath,
			patchResult,
			promoteResult,
			dryRun: false,
		};
	}

	private logResult(r: PatchResult) {
		const applied =
			r.appliedTags.map((tag) => getPatchMetadata(tag).label).join(", ") ||
			"None";
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
			const failedLabels = r.failedTags
				.map((tag) => getPatchMetadata(tag).label)
				.join(", ");
			console.log(chalk.yellow(`     - Failed: ${failedLabels}`));
			// Print failure reasons
			for (const v of r.verifications) {
				if (!v.passed && v.reason) {
					const label = getPatchMetadata(v.tag).label;
					console.log(chalk.yellow(`       ${label}: ${v.reason}`));
				}
			}
		}

		if (r.limits && Object.keys(r.limits).length > 0) {
			console.log(chalk.green("     - Limits bumped"));
		}
	}
}
