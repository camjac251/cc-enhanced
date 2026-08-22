import { createHash } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import {
	detectNativeBinaryKind,
	extractClaudeJsFromNativeBinary,
} from "../native.js";
import { locateLiefBunSection } from "../native-lief.js";
import { extractClaudeJsFromNativeLinux } from "../native-linux.js";
import type { PatchProfileReceipt } from "../profiles/contract.js";
import {
	ARTIFACT_RECEIPT_SCHEMA_VERSION,
	type ArtifactEvidenceStatus,
	type ArtifactReceipt,
	NATIVE_ARTIFACT_PLATFORMS,
	type NativeArtifactPlatform,
	type NativeBinaryFormat,
} from "../targets/contract.js";

export const NATIVE_ARTIFACT_MATRIX_SCHEMA_VERSION = 1 as const;

export interface NativeArtifactMatrixChecks {
	manifestEntry: ArtifactEvidenceStatus;
	cleanChecksum: ArtifactEvidenceStatus;
	binaryFormat: ArtifactEvidenceStatus;
	fullProfile: ArtifactEvidenceStatus;
	fixedLayout: ArtifactEvidenceStatus;
	outsideRange: ArtifactEvidenceStatus;
	reextraction: ArtifactEvidenceStatus;
	signing: ArtifactEvidenceStatus;
	hostExecution: ArtifactEvidenceStatus;
}

export interface NativeArtifactMatrixRow {
	platform: NativeArtifactPlatform;
	receipt: ArtifactReceipt;
	checks: NativeArtifactMatrixChecks;
}

export interface NativeArtifactMatrixFailure {
	platform: NativeArtifactPlatform | null;
	stage: string;
	diagnostic: string;
}

export interface NativeArtifactMatrixReport {
	schemaVersion: typeof NATIVE_ARTIFACT_MATRIX_SCHEMA_VERSION;
	version: string;
	profile: string;
	status: "running" | "pass" | "fail";
	generatedAt: string;
	platforms?: NativeArtifactPlatform[];
	rows: NativeArtifactMatrixRow[];
	failure?: NativeArtifactMatrixFailure;
}

export interface NativeArtifactMutableRange {
	offset: number;
	size: number;
}

export interface NativeArtifactStructuralEvidence {
	binaryFormat: NativeBinaryFormat;
	cleanSha256: string;
	patchedSha256: string;
	sameLength: true;
	sameLayout: true;
	outsideRange: true;
	reextraction: true;
}

export interface NativeManifestEntryEvidence {
	binary: string;
	size: number;
	signature: "not-provided";
}

export function expectedNativeBinaryFormat(
	platform: NativeArtifactPlatform,
): NativeBinaryFormat {
	if (platform.startsWith("linux-")) return "elf";
	if (platform.startsWith("darwin-")) return "macho";
	return "pe";
}

export function resolveNativeArtifactPlatforms(
	requested?: readonly string[],
): NativeArtifactPlatform[] {
	if (requested === undefined) return [...NATIVE_ARTIFACT_PLATFORMS];
	if (requested.length === 0) {
		throw new Error("Native artifact coverage requires at least one platform");
	}
	const seen = new Set<string>();
	for (const platform of requested) {
		if (
			!NATIVE_ARTIFACT_PLATFORMS.includes(platform as NativeArtifactPlatform)
		) {
			throw new Error(`unknown platform ${platform}`);
		}
		if (seen.has(platform)) {
			throw new Error(`duplicate platform ${platform}`);
		}
		seen.add(platform);
	}
	const canonical = NATIVE_ARTIFACT_PLATFORMS.filter((platform) =>
		seen.has(platform),
	);
	if (requested.some((platform, index) => canonical[index] !== platform)) {
		throw new Error("Native artifact platforms must use canonical order");
	}
	return canonical;
}

function assertSha256(value: string, label: string): void {
	if (!/^[a-f0-9]{64}$/.test(value)) {
		throw new Error(`${label} must be a lowercase SHA-256 digest`);
	}
}

export function createStructuralArtifactReceipt(options: {
	version: string;
	platform: NativeArtifactPlatform;
	upstreamChecksum: string;
	cleanSha256: string;
	patchedSha256: string;
	profile: PatchProfileReceipt;
	patcherRevision: string;
	createdAt: string;
}): ArtifactReceipt {
	assertSha256(options.upstreamChecksum, "upstream checksum");
	assertSha256(options.cleanSha256, "clean artifact checksum");
	assertSha256(options.patchedSha256, "patched artifact checksum");
	if (options.cleanSha256 !== options.upstreamChecksum) {
		throw new Error(
			"clean artifact checksum does not match the manifest entry",
		);
	}
	if (options.cleanSha256 === options.patchedSha256) {
		throw new Error("patched artifact checksum matches the clean artifact");
	}
	if (options.profile.selectedTags.length === 0) {
		throw new Error(
			"artifact receipt requires at least one selected patch tag",
		);
	}
	if (!options.patcherRevision.trim()) {
		throw new Error("artifact receipt requires a patcher revision");
	}
	if (Number.isNaN(Date.parse(options.createdAt))) {
		throw new Error("artifact receipt createdAt must be an ISO timestamp");
	}

	const binaryFormat = expectedNativeBinaryFormat(options.platform);
	const signingRequired = binaryFormat !== "elf";
	return {
		schemaVersion: ARTIFACT_RECEIPT_SCHEMA_VERSION,
		targetId: `standalone-cli:${options.platform}:${options.version}`,
		upstreamVersion: options.version,
		upstreamPlatform: options.platform,
		upstreamChecksum: options.upstreamChecksum,
		upstreamManifestChecksumVerified: true,
		upstreamManifestSignature: "not-provided",
		cleanSha256: options.cleanSha256,
		patchedSha256: options.patchedSha256,
		profile: options.profile.name,
		selectedTags: [...options.profile.selectedTags],
		patcherRevision: options.patcherRevision,
		binaryFormat,
		structuralVerification: "pass",
		signingPolicy: signingRequired ? "unconfigured" : "not-required",
		signingVerification: signingRequired ? "not-run" : "not-required",
		hostExecution: "not-run",
		createdAt: options.createdAt,
	};
}

export async function sha256File(filePath: string): Promise<string> {
	const hash = createHash("sha256");
	const stream = fsSync.createReadStream(filePath);
	for await (const chunk of stream) hash.update(chunk);
	return hash.digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MANIFEST_SIGNATURE_KEYS = [
	"signature",
	"signatures",
	"signed",
	"publicKey",
	"publicKeyId",
] as const;

export async function verifyNativeManifestEntry(options: {
	manifestPath: string;
	version: string;
	platform: NativeArtifactPlatform;
	checksum: string;
}): Promise<NativeManifestEntryEvidence> {
	const parsed = JSON.parse(
		await fs.readFile(options.manifestPath, "utf8"),
	) as unknown;
	if (!isRecord(parsed) || parsed.version !== options.version) {
		throw new Error("native manifest version or top-level schema is invalid");
	}
	const platforms = parsed.platforms;
	if (!isRecord(platforms)) {
		throw new Error("native manifest platforms map is invalid");
	}
	const entry = platforms[options.platform];
	if (!isRecord(entry)) {
		throw new Error(`native manifest lacks platform ${options.platform}`);
	}
	if (
		MANIFEST_SIGNATURE_KEYS.some(
			(key) => Object.hasOwn(parsed, key) || Object.hasOwn(entry, key),
		)
	) {
		throw new Error(
			"manifest signature fields require an explicit verifier before receipts can claim them",
		);
	}
	if (
		typeof entry.checksum !== "string" ||
		entry.checksum.toLowerCase() !== options.checksum
	) {
		throw new Error(
			`${options.platform} manifest checksum entry is inconsistent`,
		);
	}
	const expectedBinary = options.platform.startsWith("win32-")
		? "claude.exe"
		: "claude";
	if (entry.binary !== expectedBinary) {
		throw new Error(`${options.platform} manifest binary name is inconsistent`);
	}
	if (
		typeof entry.size !== "number" ||
		!Number.isSafeInteger(entry.size) ||
		entry.size <= 0
	) {
		throw new Error(`${options.platform} manifest artifact size is invalid`);
	}
	return {
		binary: expectedBinary,
		size: entry.size,
		signature: "not-provided",
	};
}

async function hashFileRange(
	filePath: string,
	start: number,
	endExclusive: number,
): Promise<string> {
	const hash = createHash("sha256");
	if (start === endExclusive) return hash.digest("hex");
	const stream = fsSync.createReadStream(filePath, {
		start,
		end: endExclusive - 1,
	});
	for await (const chunk of stream) hash.update(chunk);
	return hash.digest("hex");
}

export async function outsideMutableRangeMatches(options: {
	cleanPath: string;
	patchedPath: string;
	cleanRange: NativeArtifactMutableRange;
	patchedRange: NativeArtifactMutableRange;
}): Promise<boolean> {
	const cleanStat = await fs.stat(options.cleanPath);
	const patchedStat = await fs.stat(options.patchedPath);
	if (
		cleanStat.size !== patchedStat.size ||
		options.cleanRange.offset !== options.patchedRange.offset ||
		options.cleanRange.size !== options.patchedRange.size
	) {
		return false;
	}
	const { offset, size } = options.cleanRange;
	if (offset < 0 || size <= 0 || offset + size > cleanStat.size) return false;
	const rangeEnd = offset + size;
	const cleanPrefix = await hashFileRange(options.cleanPath, 0, offset);
	const patchedPrefix = await hashFileRange(options.patchedPath, 0, offset);
	const cleanSuffix = await hashFileRange(
		options.cleanPath,
		rangeEnd,
		cleanStat.size,
	);
	const patchedSuffix = await hashFileRange(
		options.patchedPath,
		rangeEnd,
		patchedStat.size,
	);
	return cleanPrefix === patchedPrefix && cleanSuffix === patchedSuffix;
}

function serializeLayout(value: unknown): string {
	return JSON.stringify(value, (_key, item) =>
		typeof item === "bigint" ? item.toString() : item,
	);
}

function inspectArtifactLayout(
	filePath: string,
	binaryFormat: NativeBinaryFormat,
): { range: NativeArtifactMutableRange; fingerprint: string } {
	if (binaryFormat === "elf") {
		const extracted = extractClaudeJsFromNativeLinux(filePath);
		return {
			range: {
				offset: extracted.bunBlobStart,
				size: extracted.bunBlob.length,
			},
			fingerprint: serializeLayout({
				bunBlobStart: extracted.bunBlobStart,
				bunBlobSize: extracted.bunBlob.length,
				tailValue: extracted.tailValue,
			}),
		};
	}

	const layout = locateLiefBunSection(filePath);
	return {
		range: { offset: layout.fileOffset, size: layout.fileSize },
		fingerprint: serializeLayout(layout),
	};
}

export async function verifyNativeArtifactStructure(options: {
	platform: NativeArtifactPlatform;
	cleanPath: string;
	patchedPath: string;
}): Promise<NativeArtifactStructuralEvidence> {
	const expectedFormat = expectedNativeBinaryFormat(options.platform);
	const cleanKind = detectNativeBinaryKind(options.cleanPath);
	const patchedKind = detectNativeBinaryKind(options.patchedPath);
	if (cleanKind !== expectedFormat || patchedKind !== expectedFormat) {
		throw new Error(
			`${options.platform} binary format mismatch: expected ${expectedFormat}, got clean=${cleanKind} patched=${patchedKind}`,
		);
	}

	const cleanStat = await fs.stat(options.cleanPath);
	const patchedStat = await fs.stat(options.patchedPath);
	if (cleanStat.size !== patchedStat.size) {
		throw new Error(`${options.platform} patched artifact changed file length`);
	}

	const cleanLayout = inspectArtifactLayout(options.cleanPath, expectedFormat);
	const patchedLayout = inspectArtifactLayout(
		options.patchedPath,
		expectedFormat,
	);
	if (cleanLayout.fingerprint !== patchedLayout.fingerprint) {
		throw new Error(
			`${options.platform} patched artifact changed native layout`,
		);
	}
	if (
		!(await outsideMutableRangeMatches({
			cleanPath: options.cleanPath,
			patchedPath: options.patchedPath,
			cleanRange: cleanLayout.range,
			patchedRange: patchedLayout.range,
		}))
	) {
		throw new Error(
			`${options.platform} patched artifact changed bytes outside the Bun range`,
		);
	}

	const extracted = extractClaudeJsFromNativeBinary(options.patchedPath);
	if (!extracted.includes(Buffer.from("(Claude Code; patched:"))) {
		throw new Error(
			`${options.platform} re-extracted bundle lacks the patch signature`,
		);
	}

	const cleanSha256 = await sha256File(options.cleanPath);
	const patchedSha256 = await sha256File(options.patchedPath);
	if (cleanSha256 === patchedSha256) {
		throw new Error(`${options.platform} patched artifact is byte-identical`);
	}

	return {
		binaryFormat: expectedFormat,
		cleanSha256,
		patchedSha256,
		sameLength: true,
		sameLayout: true,
		outsideRange: true,
		reextraction: true,
	};
}

const REQUIRED_PASS_CHECKS = [
	"manifestEntry",
	"cleanChecksum",
	"binaryFormat",
	"fullProfile",
	"fixedLayout",
	"outsideRange",
	"reextraction",
] as const satisfies readonly (keyof NativeArtifactMatrixChecks)[];

export function validatePassingNativeArtifactMatrix(
	report: NativeArtifactMatrixReport,
): void {
	if (report.schemaVersion !== NATIVE_ARTIFACT_MATRIX_SCHEMA_VERSION) {
		throw new Error(
			`unsupported native artifact matrix schema ${report.schemaVersion}`,
		);
	}
	if (report.status !== "pass") {
		throw new Error(
			`native artifact matrix status must be pass, got ${report.status}`,
		);
	}
	if (report.failure) {
		throw new Error("passing native artifact matrix cannot include a failure");
	}
	const expectedPlatforms = resolveNativeArtifactPlatforms(report.platforms);
	const expectedPlatformSet = new Set(expectedPlatforms);

	const rows = new Map<NativeArtifactPlatform, NativeArtifactMatrixRow>();
	let selectedTags: readonly string[] | null = null;
	for (const row of report.rows) {
		if (rows.has(row.platform)) {
			throw new Error(`duplicate platform ${row.platform}`);
		}
		if (!expectedPlatformSet.has(row.platform)) {
			throw new Error(`unexpected platform ${row.platform}`);
		}
		if (
			!Array.isArray(row.receipt.selectedTags) ||
			row.receipt.selectedTags.length === 0 ||
			row.receipt.selectedTags.some(
				(tag) => typeof tag !== "string" || tag.trim().length === 0,
			) ||
			new Set(row.receipt.selectedTags).size !== row.receipt.selectedTags.length
		) {
			throw new Error(`${row.platform} ordered patch roster is invalid`);
		}
		if (selectedTags === null) {
			selectedTags = row.receipt.selectedTags;
		} else if (
			row.receipt.selectedTags.length !== selectedTags.length ||
			row.receipt.selectedTags.some(
				(tag, index) => tag !== selectedTags?.[index],
			)
		) {
			throw new Error(
				`${row.platform} ordered patch roster does not match the matrix`,
			);
		}
		rows.set(row.platform, row);
	}

	for (const platform of expectedPlatforms) {
		const row = rows.get(platform);
		if (!row) throw new Error(`missing platform ${platform}`);
		if (row.receipt.upstreamPlatform !== platform) {
			throw new Error(`${platform} receipt platform does not match its row`);
		}
		if (row.receipt.upstreamVersion !== report.version) {
			throw new Error(`${platform} receipt version does not match the matrix`);
		}
		if (row.receipt.profile !== report.profile) {
			throw new Error(`${platform} receipt profile does not match the matrix`);
		}
		if (row.receipt.binaryFormat !== expectedNativeBinaryFormat(platform)) {
			throw new Error(`${platform} receipt binary format is incorrect`);
		}
		if (row.receipt.structuralVerification !== "pass") {
			throw new Error(`${platform} structural verification must pass`);
		}
		for (const check of REQUIRED_PASS_CHECKS) {
			if (row.checks[check] !== "pass") {
				throw new Error(`${platform} ${check} must pass`);
			}
		}

		const signingRequired = row.receipt.binaryFormat !== "elf";
		const expectedSigning = signingRequired ? "not-run" : "not-required";
		const expectedPolicy = signingRequired ? "unconfigured" : "not-required";
		if (
			row.receipt.signingPolicy !== expectedPolicy ||
			row.receipt.signingVerification !== expectedSigning ||
			row.checks.signing !== expectedSigning
		) {
			throw new Error(`${platform} signing evidence is inconsistent`);
		}
		if (
			row.receipt.hostExecution !== "not-run" ||
			row.checks.hostExecution !== "not-run"
		) {
			throw new Error(`${platform} host execution must remain not-run`);
		}
	}

	if (rows.size !== expectedPlatforms.length) {
		throw new Error("native artifact matrix contains a non-canonical platform");
	}
}

const POSIX_LOCAL_PATH = /\/(?:home|tmp|var|run|private|Users)\/[^\s"'`]+/g;
const WINDOWS_LOCAL_PATH = /\b[A-Za-z]:\\(?:[^\\\s"'`]+\\)*[^\\\s"'`]+/g;

export function sanitizeArtifactDiagnostic(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const sanitized = message
		.replace(POSIX_LOCAL_PATH, "<local-path>")
		.replace(WINDOWS_LOCAL_PATH, "<local-path>")
		.replace(/\s+/g, " ")
		.trim();
	return sanitized.length <= 320
		? sanitized
		: `${sanitized.slice(0, 317).trimEnd()}...`;
}
