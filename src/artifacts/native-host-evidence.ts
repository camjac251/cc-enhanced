import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { extractClaudeJsFromNativeBinary } from "../native.js";
import {
	createNativeSigningPlan,
	finalizeNativeSigning,
	type NativeSigningCommandRunner,
	type NativeSigningPolicy,
	type NativeSigningPolicyName,
} from "../native-signing.js";
import {
	isNativeArtifactPlatform,
	type NativeArtifactPlatform,
} from "../targets/contract.js";
import {
	type NativeArtifactMatrixReport,
	type NativeArtifactMatrixRow,
	sha256File,
	validatePassingNativeArtifactMatrix,
} from "./native-evidence.js";

export const NATIVE_HOST_RECEIPT_SCHEMA_VERSION = 1 as const;

export interface NativeHostReceipt {
	schemaVersion: typeof NATIVE_HOST_RECEIPT_SCHEMA_VERSION;
	targetId: string;
	upstreamVersion: string;
	platform: NativeArtifactPlatform;
	profile: string;
	structuralPatchedSha256: string;
	finalizedSha256: string;
	signingPolicy: NativeSigningPolicyName;
	signingVerification: "pass" | "not-required";
	reextraction: "pass";
	hostExecution: "pass";
	runtimeVersion: string;
	runtimeTags: string[];
	warningCodes: string[];
	createdAt: string;
}

export interface PatchedVersionOutput {
	version: string;
	tags: string[];
}

export interface NativeHostPathSet {
	matrixReceiptPath: string;
	artifactPath: string;
	stagedOutputPath: string;
	receiptPath: string;
}

const PATCHED_VERSION_RE =
	/^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s+\(Claude Code;\s*patched:\s*([^\n)]+)\)$/;

export function parsePatchedVersionOutput(
	output: string,
): PatchedVersionOutput {
	const match = PATCHED_VERSION_RE.exec(output.trim());
	if (!match) {
		throw new Error("Host version output lacks a valid patch signature");
	}
	const tags = match[2]
		.split(",")
		.map((tag) => tag.trim())
		.filter(Boolean);
	if (
		tags.length === 0 ||
		new Set(tags).size !== tags.length ||
		tags.some((tag) => !/^[a-z0-9][a-z0-9-]*$/.test(tag))
	) {
		throw new Error("Host version output has an invalid runtime patch roster");
	}
	return { version: match[1], tags };
}

function expectedRuntimeTags(row: NativeArtifactMatrixRow): string[] {
	const signatureCount = row.receipt.selectedTags.filter(
		(tag) => tag === "signature",
	).length;
	if (signatureCount !== 1) {
		throw new Error("Structural receipt must select the signature patch once");
	}
	return row.receipt.selectedTags.filter((tag) => tag !== "signature");
}

function arraysEqual(
	left: readonly string[],
	right: readonly string[],
): boolean {
	return (
		left.length === right.length &&
		left.every((value, index) => value === right[index])
	);
}

async function canonicalizePotentialPath(filePath: string): Promise<string> {
	let current = path.resolve(filePath);
	const missingSegments: string[] = [];
	for (;;) {
		try {
			const canonicalAncestor = await fs.realpath(current);
			const canonicalPath = path.join(canonicalAncestor, ...missingSegments);
			return process.platform === "win32"
				? canonicalPath.toLowerCase()
				: canonicalPath;
		} catch (error) {
			if (
				typeof error !== "object" ||
				error === null ||
				!("code" in error) ||
				error.code !== "ENOENT"
			) {
				throw error;
			}
			const parent = path.dirname(current);
			if (parent === current) throw error;
			missingSegments.unshift(path.basename(current));
			current = parent;
		}
	}
}

export async function assertDistinctNativeHostPaths(
	paths: NativeHostPathSet,
): Promise<void> {
	const canonicalPaths = await Promise.all(
		Object.values(paths).map((filePath) => canonicalizePotentialPath(filePath)),
	);
	if (new Set(canonicalPaths).size !== canonicalPaths.length) {
		throw new Error("Native host paths must be distinct");
	}
}

function assertSha256(value: string, label: string): void {
	if (!/^[a-f0-9]{64}$/.test(value)) {
		throw new Error(`${label} must be a lowercase SHA-256 digest`);
	}
}

export function validateNativeHostReceipt(receipt: NativeHostReceipt): void {
	if (receipt.schemaVersion !== NATIVE_HOST_RECEIPT_SCHEMA_VERSION) {
		throw new Error("Unsupported native host receipt schema");
	}
	if (!isNativeArtifactPlatform(receipt.platform)) {
		throw new Error("Unsupported native artifact platform");
	}
	if (
		receipt.targetId !==
		`standalone-cli:${receipt.platform}:${receipt.upstreamVersion}`
	) {
		throw new Error("Native host receipt target identity is inconsistent");
	}
	assertSha256(receipt.structuralPatchedSha256, "structural artifact hash");
	assertSha256(receipt.finalizedSha256, "finalized artifact hash");
	if (
		receipt.reextraction !== "pass" ||
		receipt.hostExecution !== "pass" ||
		receipt.runtimeVersion !== receipt.upstreamVersion ||
		receipt.runtimeTags.length === 0 ||
		receipt.runtimeTags.includes("signature") ||
		new Set(receipt.runtimeTags).size !== receipt.runtimeTags.length
	) {
		throw new Error("Native host receipt execution evidence is inconsistent");
	}
	if (
		receipt.platform.startsWith("linux-") &&
		(receipt.signingPolicy !== "not-required" ||
			receipt.signingVerification !== "not-required" ||
			receipt.finalizedSha256 !== receipt.structuralPatchedSha256)
	) {
		throw new Error(
			"Native host receipt Linux signing evidence is inconsistent",
		);
	}
	if (
		receipt.platform.startsWith("darwin-") &&
		((receipt.signingPolicy !== "macos-adhoc" &&
			receipt.signingPolicy !== "macos-identity") ||
			receipt.signingVerification !== "pass")
	) {
		throw new Error("Native host receipt macOS signing evidence is incomplete");
	}
	if (
		receipt.platform.startsWith("win32-") &&
		((receipt.signingPolicy !== "windows-authenticode" &&
			receipt.signingPolicy !== "windows-explicit-unsigned") ||
			receipt.signingVerification !== "pass")
	) {
		throw new Error(
			"Native host receipt Windows signing evidence is incomplete",
		);
	}
	const expectedWarnings =
		receipt.signingPolicy === "macos-adhoc"
			? ["macos-adhoc-identity"]
			: receipt.signingPolicy === "windows-explicit-unsigned"
				? ["windows-unsigned-artifact"]
				: [];
	if (
		!receipt.profile.trim() ||
		!arraysEqual(receipt.warningCodes, expectedWarnings)
	) {
		throw new Error("Native host receipt warning policy is inconsistent");
	}
	if (Number.isNaN(Date.parse(receipt.createdAt))) {
		throw new Error("Native host receipt createdAt must be an ISO timestamp");
	}
}

const MAX_VERSION_OUTPUT_BYTES = 64 * 1024;

async function runVersionCommand(binaryPath: string): Promise<string> {
	return await new Promise((resolve, reject) => {
		const child = spawn(binaryPath, ["--version"], {
			stdio: ["ignore", "pipe", "ignore"],
			windowsHide: true,
		});
		let stdout = "";
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill();
			reject(new Error("Native host version smoke timed out"));
		}, 15_000);
		child.stdout.on("data", (chunk: Buffer) => {
			if (stdout.length >= MAX_VERSION_OUTPUT_BYTES) return;
			stdout = `${stdout}${chunk.toString("utf8")}`.slice(
				0,
				MAX_VERSION_OUTPUT_BYTES,
			);
		});
		child.once("error", () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error("Native host version smoke could not start"));
		});
		child.once("close", (exitCode) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (exitCode !== 0) {
				reject(new Error("Native host version smoke failed"));
				return;
			}
			resolve(stdout);
		});
	});
}

async function assertStagedOutputAbsent(
	stagedOutputPath: string,
): Promise<void> {
	try {
		await fs.lstat(stagedOutputPath);
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "ENOENT"
		) {
			return;
		}
		throw error;
	}
	throw new Error("Staged native output already exists");
}

export async function finalizeNativeHostArtifact(options: {
	matrix: NativeArtifactMatrixReport;
	expectedProfile?: string;
	platform: NativeArtifactPlatform;
	hostPlatform: NativeArtifactPlatform;
	artifactPath: string;
	stagedOutputPath: string;
	policy: NativeSigningPolicy;
	codesignPath?: string;
	signToolPath?: string;
	runSigningCommand?: NativeSigningCommandRunner;
	extractBundle?: (filePath: string) => Buffer;
	runVersion?: (filePath: string) => Promise<string>;
	createdAt?: string;
}): Promise<NativeHostReceipt> {
	validatePassingNativeArtifactMatrix(options.matrix);
	if (
		options.expectedProfile !== undefined &&
		options.matrix.profile !== options.expectedProfile
	) {
		throw new Error(
			`Native artifact matrix does not match expected profile ${options.expectedProfile}`,
		);
	}
	const row = options.matrix.rows.find(
		(candidate) => candidate.platform === options.platform,
	);
	if (!row) throw new Error(`Structural matrix lacks ${options.platform}`);
	if (options.platform !== options.hostPlatform) {
		throw new Error(
			`Native finalization requires a matching host platform for ${options.platform}`,
		);
	}
	if (
		path.resolve(options.artifactPath) ===
		path.resolve(options.stagedOutputPath)
	) {
		throw new Error("Native finalization requires a distinct staged output");
	}
	createNativeSigningPlan({
		artifactPath: options.stagedOutputPath,
		platform: options.platform,
		hostPlatform: options.hostPlatform,
		policy: options.policy,
		codesignPath: options.codesignPath,
		signToolPath: options.signToolPath,
	});

	const inputSha256 = await sha256File(options.artifactPath);
	if (inputSha256 !== row.receipt.patchedSha256) {
		throw new Error(
			`${options.platform} artifact does not match structural receipt`,
		);
	}
	await assertStagedOutputAbsent(options.stagedOutputPath);

	let staged = false;
	try {
		await fs.copyFile(
			options.artifactPath,
			options.stagedOutputPath,
			fsConstants.COPYFILE_EXCL,
		);
		staged = true;
		await fs.chmod(options.stagedOutputPath, 0o755);
		if ((await sha256File(options.stagedOutputPath)) !== inputSha256) {
			throw new Error("Staged artifact changed while copying structural bytes");
		}

		const signing = await finalizeNativeSigning({
			artifactPath: options.stagedOutputPath,
			platform: options.platform,
			hostPlatform: options.hostPlatform,
			policy: options.policy,
			codesignPath: options.codesignPath,
			signToolPath: options.signToolPath,
			runCommand: options.runSigningCommand,
		});

		const extracted = (
			options.extractBundle ?? extractClaudeJsFromNativeBinary
		)(options.stagedOutputPath);
		if (!extracted.includes(Buffer.from("(Claude Code; patched:"))) {
			throw new Error("Finalized artifact re-extraction lacks patch signature");
		}

		const runtime = parsePatchedVersionOutput(
			await (options.runVersion ?? runVersionCommand)(options.stagedOutputPath),
		);
		const expectedTags = expectedRuntimeTags(row);
		if (runtime.version !== row.receipt.upstreamVersion) {
			throw new Error("Host runtime version does not match structural receipt");
		}
		if (!arraysEqual(runtime.tags, expectedTags)) {
			throw new Error(
				"Host runtime patch roster does not match structural receipt",
			);
		}

		const receipt: NativeHostReceipt = {
			schemaVersion: NATIVE_HOST_RECEIPT_SCHEMA_VERSION,
			targetId: row.receipt.targetId,
			upstreamVersion: row.receipt.upstreamVersion,
			platform: row.platform,
			profile: row.receipt.profile,
			structuralPatchedSha256: inputSha256,
			finalizedSha256: await sha256File(options.stagedOutputPath),
			signingPolicy: signing.policyName,
			signingVerification: signing.verification,
			reextraction: "pass",
			hostExecution: "pass",
			runtimeVersion: runtime.version,
			runtimeTags: runtime.tags,
			warningCodes: signing.warningCodes,
			createdAt: options.createdAt ?? new Date().toISOString(),
		};
		validateNativeHostReceipt(receipt);
		return receipt;
	} catch (error) {
		if (staged) await fs.rm(options.stagedOutputPath, { force: true });
		throw error;
	}
}

export function parseNativeArtifactMatrixJson(
	json: string,
): NativeArtifactMatrixReport {
	const parsed = JSON.parse(json) as unknown;
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("rows" in parsed) ||
		!Array.isArray(parsed.rows)
	) {
		throw new Error("Native artifact matrix JSON has an invalid shape");
	}
	const report = parsed as NativeArtifactMatrixReport;
	validatePassingNativeArtifactMatrix(report);
	return report;
}
