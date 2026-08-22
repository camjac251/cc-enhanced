import * as fs from "node:fs/promises";
import * as path from "node:path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { sanitizeArtifactDiagnostic } from "../src/artifacts/native-evidence.js";
import {
	assertDistinctNativeHostPaths,
	finalizeNativeHostArtifact,
	type NativeHostReceipt,
	parseNativeArtifactMatrixJson,
} from "../src/artifacts/native-host-evidence.js";
import { NATIVE_ARTIFACT_PROFILE_NAMES } from "../src/artifacts/native-profile.js";
import { withHeavyOperationGuard } from "../src/heavy-operation-guard.js";
import { detectNativeReleasePlatform } from "../src/native-release.js";
import type { NativeSigningPolicy } from "../src/native-signing.js";
import { parseNativeArtifactPlatform } from "../src/targets/contract.js";

const SIGNING_POLICIES = [
	"not-required",
	"macos-adhoc",
	"macos-identity",
	"windows-authenticode",
	"windows-explicit-unsigned",
] as const;

function rejectUnexpectedOption(value: string | boolean | undefined): void {
	if (value !== undefined && value !== false) {
		throw new Error("Signing policy received an incompatible option");
	}
}

function resolveSigningPolicy(options: {
	kind: (typeof SIGNING_POLICIES)[number];
	macosIdentity?: string;
	windowsCertificateThumbprint?: string;
	timestampUrl?: string;
	acknowledgeUnsignedWindows: boolean;
}): NativeSigningPolicy {
	switch (options.kind) {
		case "not-required":
		case "macos-adhoc":
			rejectUnexpectedOption(options.macosIdentity);
			rejectUnexpectedOption(options.windowsCertificateThumbprint);
			rejectUnexpectedOption(options.timestampUrl);
			rejectUnexpectedOption(options.acknowledgeUnsignedWindows);
			return { kind: options.kind };
		case "macos-identity":
			rejectUnexpectedOption(options.windowsCertificateThumbprint);
			rejectUnexpectedOption(options.timestampUrl);
			rejectUnexpectedOption(options.acknowledgeUnsignedWindows);
			return { kind: options.kind, identity: options.macosIdentity ?? "" };
		case "windows-authenticode":
			rejectUnexpectedOption(options.macosIdentity);
			rejectUnexpectedOption(options.acknowledgeUnsignedWindows);
			return {
				kind: options.kind,
				certificateThumbprint: options.windowsCertificateThumbprint ?? "",
				timestampUrl: options.timestampUrl ?? "",
			};
		case "windows-explicit-unsigned":
			rejectUnexpectedOption(options.macosIdentity);
			rejectUnexpectedOption(options.windowsCertificateThumbprint);
			rejectUnexpectedOption(options.timestampUrl);
			return {
				kind: options.kind,
				acknowledged: options.acknowledgeUnsignedWindows,
			};
	}
}

async function writeReceipt(
	receiptPath: string,
	receipt: NativeHostReceipt,
): Promise<void> {
	await fs.mkdir(path.dirname(receiptPath), { recursive: true });
	const temporaryPath = `${receiptPath}.${process.pid}.tmp`;
	try {
		await fs.writeFile(
			temporaryPath,
			`${JSON.stringify(receipt, null, 2)}\n`,
			"utf8",
		);
		await fs.rename(temporaryPath, receiptPath);
	} catch (error) {
		await fs.rm(temporaryPath, { force: true });
		throw error;
	}
}

async function main(): Promise<void> {
	const argv = await yargs(hideBin(process.argv))
		.version(false)
		.strict()
		.option("matrix-receipt", {
			type: "string",
			demandOption: true,
			description: "Structural native artifact matrix receipt",
		})
		.option("platform", {
			type: "string",
			demandOption: true,
			description: "Exact canonical artifact platform",
		})
		.option("artifact", {
			type: "string",
			demandOption: true,
			description: "Structural candidate to copy and finalize",
		})
		.option("staged-output", {
			type: "string",
			demandOption: true,
			description: "New path for the non-activated finalized copy",
		})
		.option("receipt", {
			type: "string",
			demandOption: true,
			description: "Sanitized host receipt output path",
		})
		.option("signing-policy", {
			choices: SIGNING_POLICIES,
			demandOption: true,
			description: "Explicit host signing policy",
		})
		.option("expected-profile", {
			choices: NATIVE_ARTIFACT_PROFILE_NAMES,
			description: "Require the structural matrix to use this build profile",
		})
		.option("macos-identity", {
			type: "string",
			description: "Configured keychain identity for macOS signing",
		})
		.option("windows-certificate-thumbprint", {
			type: "string",
			description: "Certificate-store thumbprint for Authenticode",
		})
		.option("timestamp-url", {
			type: "string",
			description: "HTTPS RFC 3161 timestamp service",
		})
		.option("acknowledge-unsigned-windows", {
			type: "boolean",
			default: false,
			description: "Acknowledge the explicit unsigned Windows warning",
		})
		.option("signtool-path", {
			type: "string",
			description: "Windows SDK signtool.exe path",
		})
		.parse();

	const platform = parseNativeArtifactPlatform(argv.platform);
	const hostPlatform = detectNativeReleasePlatform();
	const policy = resolveSigningPolicy({
		kind: argv.signingPolicy,
		macosIdentity: argv.macosIdentity,
		windowsCertificateThumbprint: argv.windowsCertificateThumbprint,
		timestampUrl: argv.timestampUrl,
		acknowledgeUnsignedWindows: argv.acknowledgeUnsignedWindows,
	});
	if (argv.signtoolPath !== undefined && !platform.startsWith("win32-")) {
		throw new Error("Signing policy received an incompatible option");
	}

	const matrixPath = path.resolve(argv.matrixReceipt);
	const artifactPath = path.resolve(argv.artifact);
	const stagedOutputPath = path.resolve(argv.stagedOutput);
	const receiptPath = path.resolve(argv.receipt);
	await assertDistinctNativeHostPaths({
		matrixReceiptPath: matrixPath,
		artifactPath,
		stagedOutputPath,
		receiptPath,
	});
	const matrix = parseNativeArtifactMatrixJson(
		await fs.readFile(matrixPath, "utf8"),
	);
	let finalized = false;
	try {
		const receipt = await finalizeNativeHostArtifact({
			matrix,
			expectedProfile: argv.expectedProfile,
			platform,
			hostPlatform,
			artifactPath,
			stagedOutputPath,
			policy,
			signToolPath: argv.signtoolPath,
		});
		finalized = true;
		await writeReceipt(receiptPath, receipt);
		for (const warningCode of receipt.warningCodes) {
			if (warningCode === "macos-adhoc-identity") {
				console.warn(
					"WARNING: the finalized macOS artifact has an ad-hoc signature with no stable publisher identity",
				);
			}
			if (warningCode === "windows-unsigned-artifact") {
				console.warn(
					"WARNING: the finalized Windows artifact is unsigned and may be blocked by local application-control policy",
				);
			}
		}
		console.log(
			`Verified ${receipt.platform} host artifact ${receipt.runtimeVersion} with ${receipt.signingPolicy}`,
		);
	} catch (error) {
		if (finalized) await fs.rm(stagedOutputPath, { force: true });
		throw error;
	}
}

withHeavyOperationGuard({ operation: "native host finalization" }, main).catch(
	(error) => {
		console.error(sanitizeArtifactDiagnostic(error));
		process.exitCode = 1;
	},
);
