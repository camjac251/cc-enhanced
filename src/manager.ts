import * as fs from "node:fs/promises";
import * as path from "node:path";
import chalk from "chalk";
import { isNativeBinary, unwrapBunCjsModule } from "./native.js";
import {
	type ExtractedNativeJavaScript,
	extractJavaScriptFromNativeBinary,
} from "./native-rebundle.js";
import {
	fetchNativeRelease,
	type NativeFetchResult,
} from "./native-release.js";
import { normalize } from "./normalizer.js";
import type { NativePullResult } from "./operations/contract.js";
import { forceGarbageCollection } from "./profiling.js";
import type { NativeArtifactPlatform } from "./targets/contract.js";

export interface ManagerOptions {
	nativeCacheDir?: string;
}

export class Manager {
	constructor(private options: ManagerOptions = {}) {}

	private async ensureOutputDir(filePath: string) {
		await fs.mkdir(path.dirname(filePath), { recursive: true });
	}

	private async normalizeCliJs(cliPath: string) {
		console.log(chalk.gray(`   Formatting ${path.basename(cliPath)}...`));
		const raw = await fs.readFile(cliPath, "utf-8");
		let formatted: string;
		try {
			formatted = await normalize(raw, { filepath: cliPath });
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Formatting ${path.basename(cliPath)} failed: ${detail}\n` +
					"Run `bun install` to restore the bundled formatter for this platform.",
			);
		}
		await fs.writeFile(cliPath, formatted, "utf-8");
	}

	async fetchNativeTarget(
		spec: string,
		options?: {
			platform?: NativeArtifactPlatform;
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

	async pullNativeCleanJs(
		spec: string,
		options: {
			platform?: NativeArtifactPlatform;
			forceDownload?: boolean;
			outputRoot?: string;
		} = {},
	): Promise<NativePullResult> {
		const fetchResult = await this.fetchNativeTarget(spec, {
			platform: options.platform,
			forceDownload: options.forceDownload,
		});
		const outputRoot = path.resolve(options.outputRoot ?? "versions_clean");
		const outputJsPath = path.join(outputRoot, fetchResult.version, "cli.js");
		await this.unpackNativeTarget(fetchResult.binaryPath, outputJsPath);
		return { fetchResult, outputJsPath };
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
		const targetStat = await fs.stat(resolvedTarget);
		const outputStat = await fs.stat(resolvedOutput).catch((error: unknown) => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		});
		if (
			outputStat &&
			targetStat.dev === outputStat.dev &&
			targetStat.ino === outputStat.ino
		) {
			throw new Error("Extraction output must not overwrite the native binary");
		}

		let extraction: ExtractedNativeJavaScript | null =
			await extractJavaScriptFromNativeBinary(resolvedTarget);
		const extractedCliText = extraction.code.toString("utf-8");
		extraction = null;
		forceGarbageCollection();
		const wrapper = unwrapBunCjsModule(extractedCliText);
		const outputText = wrapper ? wrapper.body : extractedCliText;
		await this.ensureOutputDir(resolvedOutput);
		await fs.writeFile(resolvedOutput, outputText, "utf-8");
		if (options?.normalize !== false) {
			await this.normalizeCliJs(resolvedOutput);
		}
		return { targetPath: resolvedTarget, outputJsPath: resolvedOutput };
	}
}
