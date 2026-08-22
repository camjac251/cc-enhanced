import * as fs from "node:fs/promises";
import * as path from "node:path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import {
	type NativeArtifactMatrixReport,
	type NativeArtifactMatrixRow,
	resolveNativeArtifactPlatforms,
	sanitizeArtifactDiagnostic,
	validatePassingNativeArtifactMatrix,
} from "../src/artifacts/native-evidence.js";
import {
	NATIVE_ARTIFACT_PROFILE_NAMES,
	type NativeArtifactProfileName,
	resolveNativeArtifactPatchSelection,
} from "../src/artifacts/native-profile.js";
import { withHeavyOperationGuard } from "../src/heavy-operation-guard.js";
import { Manager } from "../src/manager.js";
import { forceGarbageCollection } from "../src/profiling.js";
import {
	NATIVE_ARTIFACT_PLATFORMS,
	type NativeArtifactPlatform,
} from "../src/targets/contract.js";

const CONCRETE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

async function writeReport(
	outputPath: string,
	report: NativeArtifactMatrixReport,
): Promise<void> {
	await fs.mkdir(path.dirname(outputPath), { recursive: true });
	const temporaryPath = `${outputPath}.${process.pid}.tmp`;
	try {
		await fs.writeFile(
			temporaryPath,
			`${JSON.stringify(report, null, 2)}\n`,
			"utf8",
		);
		await fs.rename(temporaryPath, outputPath);
	} catch (error) {
		await fs.rm(temporaryPath, { force: true });
		throw error;
	}
}

function createPassingRow(
	platform: NativeArtifactPlatform,
	receipt: NonNullable<
		Awaited<ReturnType<Manager["buildNative"]>>["artifactReceipt"]
	>,
): NativeArtifactMatrixRow {
	return {
		platform,
		receipt,
		checks: {
			manifestEntry: "pass",
			cleanChecksum: "pass",
			binaryFormat: "pass",
			fullProfile: "pass",
			fixedLayout: "pass",
			outsideRange: "pass",
			reextraction: "pass",
			signing: receipt.signingVerification,
			hostExecution: receipt.hostExecution,
		},
	};
}

async function runMatrix(options: {
	version: string;
	outputPath: string;
	cacheDir?: string;
	forceDownload: boolean;
	profile: NativeArtifactProfileName;
	platforms: NativeArtifactPlatform[];
	explicitCoverage: boolean;
}): Promise<void> {
	const patchSelection = resolveNativeArtifactPatchSelection(options.profile);
	const generatedAt = new Date().toISOString();
	let currentPlatform: NativeArtifactPlatform | null = null;
	let currentStage = "initialization";
	let report: NativeArtifactMatrixReport = {
		schemaVersion: 1,
		version: options.version,
		profile: patchSelection.receipt.name,
		status: "running",
		generatedAt,
		...(options.explicitCoverage ? { platforms: [...options.platforms] } : {}),
		rows: [],
	};
	await writeReport(options.outputPath, report);

	try {
		for (const platform of options.platforms) {
			currentPlatform = platform;
			currentStage = "fetch-build-verify";
			console.log(`Verifying ${options.version}/${platform}`);
			const manager = new Manager({
				patchSelection,
				nativeCacheDir: options.cacheDir,
				fastVerify: true,
			});
			const result = await manager.buildNative(options.version, {
				platform,
				forceDownload: options.forceDownload,
			});
			if (result.dryRun || !result.artifactReceipt) {
				throw new Error(
					`${platform} build did not produce an artifact receipt`,
				);
			}
			if (
				result.artifactReceipt.selectedTags.length !==
					patchSelection.receipt.selectedTags.length ||
				result.artifactReceipt.selectedTags.some(
					(tag, index) => tag !== patchSelection.receipt.selectedTags[index],
				)
			) {
				throw new Error(
					`${platform} artifact receipt has an incomplete profile`,
				);
			}

			currentStage = "record";
			report.rows.push(createPassingRow(platform, result.artifactReceipt));
			await writeReport(options.outputPath, report);
			forceGarbageCollection();
		}

		currentPlatform = null;
		currentStage = "final-validation";
		report = { ...report, status: "pass" };
		validatePassingNativeArtifactMatrix(report);
		await writeReport(options.outputPath, report);
		console.log(
			`Verified ${report.rows.length} official artifacts; receipt written to ${options.outputPath}`,
		);
	} catch (error) {
		report = {
			...report,
			status: "fail",
			failure: {
				platform: currentPlatform,
				stage: currentStage,
				diagnostic: sanitizeArtifactDiagnostic(error),
			},
		};
		await writeReport(options.outputPath, report);
		throw error;
	}
}

async function main(): Promise<void> {
	const argv = await yargs(hideBin(process.argv))
		.version(false)
		.strict()
		.option("version", {
			type: "string",
			demandOption: true,
			description: "Concrete upstream version to verify",
		})
		.option("output", {
			type: "string",
			demandOption: true,
			description: "Sanitized JSON receipt output path",
		})
		.option("cache-dir", {
			type: "string",
			description: "Native release cache directory",
		})
		.option("force-download", {
			type: "boolean",
			default: false,
			description: "Redownload checksum-verified official artifacts",
		})
		.option("profile", {
			choices: NATIVE_ARTIFACT_PROFILE_NAMES,
			default: "cli-full" as const,
			description: "Build-only native artifact profile",
		})
		.option("platform", {
			type: "string",
			array: true,
			choices: NATIVE_ARTIFACT_PLATFORMS,
			description:
				"Repeatable canonical-order platform subset; omit for all official artifacts",
		})
		.parse();

	const version = argv.version.trim();
	if (!CONCRETE_VERSION.test(version)) {
		throw new Error(
			`--version must be a concrete release such as 2.1.238, got ${JSON.stringify(version)}`,
		);
	}
	const outputPath = path.resolve(argv.output);
	const cacheDir = argv.cacheDir ? path.resolve(argv.cacheDir) : undefined;
	const platforms = resolveNativeArtifactPlatforms(argv.platform);
	await withHeavyOperationGuard(
		{ operation: `native artifact matrix ${version}` },
		() =>
			runMatrix({
				version,
				outputPath,
				cacheDir,
				forceDownload: argv.forceDownload,
				profile: argv.profile,
				platforms,
				explicitCoverage: argv.platform !== undefined,
			}),
	);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
