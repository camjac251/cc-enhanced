import { constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withHeavyOperationGuard } from "../heavy-operation-guard.js";
import { extractClaudeJsFromNativeBinary } from "../native.js";
import { DEFAULT_NATIVE_BUCKET } from "../native-release.js";
import {
	inspectNativeSignaturePresence,
	type NativeSignatureMechanism,
	type NativeSignaturePresence,
} from "../native-signature-presence.js";
import type {
	CpuArchitecture,
	NativeArtifactPlatform,
	NativeBinaryFormat,
} from "../targets/contract.js";
import { isNativeArtifactPlatform } from "../targets/contract.js";
import {
	type DesktopInventoryEvidence,
	type DesktopPlatform,
	validateDesktopInventoryEvidence,
} from "./contract.js";
import { inspectDesktopCodeSnapshotFromHandle } from "./inventory.js";
import {
	fetchOfficialDesktopCodeManifestEntry,
	type OfficialDesktopCodeManifestEntry,
} from "./provenance.js";

export const DESKTOP_ARTIFACT_INSPECTION_SCHEMA_VERSION = 1 as const;

export type DesktopArtifactProvenanceStatus =
	| "verified"
	| "mismatch"
	| "not-run";
export type DesktopPatchReceiptStatus = "present" | "absent" | "not-run";

export interface DesktopArtifactProvenanceEvidence {
	status: DesktopArtifactProvenanceStatus;
	manifestUrl: string | null;
	manifestSha256: string | null;
	manifestSize: number | null;
	manifestSignature: "not-provided" | "not-run";
}

export interface DesktopPlatformSignatureEvidence {
	presence: NativeSignaturePresence;
	mechanism: NativeSignatureMechanism;
	validity: "not-run";
}

export interface DesktopPatchReceiptEvidence {
	status: DesktopPatchReceiptStatus;
	tags: string[];
}

export interface DesktopArtifactInspectionEvidence {
	schemaVersion: typeof DESKTOP_ARTIFACT_INSPECTION_SCHEMA_VERSION;
	platform: DesktopPlatform;
	locatorId: string;
	version: string;
	nativePlatform: NativeArtifactPlatform;
	binaryFormat: NativeBinaryFormat;
	architecture: CpuArchitecture;
	size: number;
	sha256: string;
	selectionReason: "declared-pin" | "highest-cached";
	patchAuthorization: "not-authorized";
	artifactBinding: "verified";
	provenance: DesktopArtifactProvenanceEvidence;
	platformSignature: DesktopPlatformSignatureEvidence;
	patchReceipt: DesktopPatchReceiptEvidence;
	versionExecution: "not-run";
	surfaceCompatibility: "not-evaluated";
	inspectedAt: string;
}

export type DesktopHeavyOperationRunner = <T>(
	work: () => T | Promise<T>,
) => Promise<T>;

export interface DesktopArtifactInspectionOptions {
	inventory: DesktopInventoryEvidence;
	cacheRoot: string;
	locatorId?: string;
	verifyProvenance?: boolean;
	inspectPatchReceipt?: boolean;
	fetchManifestEntry?: (options: {
		version: string;
		platform: NativeArtifactPlatform;
	}) => Promise<OfficialDesktopCodeManifestEntry>;
	extractBundle?: (filePath: string) => Buffer;
	runHeavyOperation?: DesktopHeavyOperationRunner;
	inspectedAt?: string;
}

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const LOCATOR_ID_RE = /^[a-z0-9][a-z0-9:._-]{0,127}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const PATCH_TAG_RE = /^[a-z0-9][a-z0-9-]*$/;
const PATCH_MARKER = Buffer.from("(Claude Code; patched:");
const PATCH_ROSTER_LIMIT = 4096;
const PATCH_MARKER_LIMIT = 32;

function isCanonicalIsoTimestamp(value: string): boolean {
	const parsed = new Date(value);
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function hasSameIdentity(left: Stats, right: Stats): boolean {
	return (
		left.size === right.size &&
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs
	);
}

function isPathWithin(rootPath: string, candidatePath: string): boolean {
	const relative = path.relative(rootPath, candidatePath);
	return (
		relative === "" ||
		(!relative.startsWith(`..${path.sep}`) &&
			relative !== ".." &&
			!path.isAbsolute(relative))
	);
}

function expectedClassification(platform: NativeArtifactPlatform): {
	desktopPlatform: DesktopPlatform;
	format: NativeBinaryFormat;
	architecture: CpuArchitecture;
} {
	const architecture = platform.includes("arm64") ? "arm64" : "x64";
	if (platform.startsWith("win32-")) {
		return { desktopPlatform: "win32", format: "pe", architecture };
	}
	if (platform.startsWith("darwin-")) {
		return { desktopPlatform: "darwin", format: "macho", architecture };
	}
	return { desktopPlatform: "linux", format: "elf", architecture };
}

function assertSnapshotMatches(
	row: DesktopInventoryEvidence["cachedCode"][number],
	snapshot: Awaited<ReturnType<typeof inspectDesktopCodeSnapshotFromHandle>>,
): asserts row is typeof row & {
	platform: NativeArtifactPlatform;
	binaryFormat: NativeBinaryFormat;
	architecture: CpuArchitecture;
} {
	if (
		row.platform === null ||
		row.binaryFormat === "unknown" ||
		row.architecture === "unknown" ||
		snapshot.platform !== row.platform ||
		snapshot.binaryFormat !== row.binaryFormat ||
		snapshot.architecture !== row.architecture ||
		snapshot.size !== row.size ||
		snapshot.sha256 !== row.sha256
	) {
		throw new Error(
			"Desktop Code artifact does not rebind to its inventory evidence",
		);
	}
}

export function inspectEmbeddedPatchReceipt(
	bundle: Buffer,
): DesktopPatchReceiptEvidence {
	const rosters: string[][] = [];
	let searchOffset = 0;
	for (;;) {
		const markerOffset = bundle.indexOf(PATCH_MARKER, searchOffset);
		if (markerOffset < 0) break;
		if (rosters.length >= PATCH_MARKER_LIMIT) {
			throw new Error("Embedded patch marker count exceeds inspection limit");
		}
		const rosterStart = markerOffset + PATCH_MARKER.length;
		const rosterEnd = bundle.indexOf(0x29, rosterStart);
		if (
			rosterEnd < 0 ||
			rosterEnd - rosterStart < 1 ||
			rosterEnd - rosterStart > PATCH_ROSTER_LIMIT
		) {
			throw new Error("Embedded patch roster is malformed");
		}
		const tags = bundle
			.subarray(rosterStart, rosterEnd)
			.toString("utf8")
			.split(",")
			.map((tag) => tag.trim())
			.filter(Boolean);
		if (
			tags.length === 0 ||
			tags.length > 256 ||
			new Set(tags).size !== tags.length ||
			tags.some((tag) => !PATCH_TAG_RE.test(tag))
		) {
			throw new Error("Embedded patch roster is invalid");
		}
		rosters.push(tags);
		searchOffset = rosterEnd + 1;
	}
	if (rosters.length === 0) return { status: "absent", tags: [] };
	const expected = JSON.stringify(rosters[0]);
	if (rosters.some((roster) => JSON.stringify(roster) !== expected)) {
		throw new Error("Embedded patch rosters are inconsistent");
	}
	return { status: "present", tags: [...(rosters[0] ?? [])] };
}

async function runDefaultHeavyOperation<T>(
	work: () => T | Promise<T>,
): Promise<T> {
	return await withHeavyOperationGuard(
		{ operation: "Desktop Code deep patch-receipt inspection" },
		async () => await work(),
	);
}

function createNotRunProvenance(): DesktopArtifactProvenanceEvidence {
	return {
		status: "not-run",
		manifestUrl: null,
		manifestSha256: null,
		manifestSize: null,
		manifestSignature: "not-run",
	};
}

export function validateDesktopArtifactInspectionEvidence(
	evidence: DesktopArtifactInspectionEvidence,
): void {
	if (evidence.schemaVersion !== DESKTOP_ARTIFACT_INSPECTION_SCHEMA_VERSION) {
		throw new Error("Unsupported Desktop artifact inspection schema");
	}
	if (!(["linux", "darwin", "win32"] as const).includes(evidence.platform)) {
		throw new Error("Desktop artifact inspection platform is invalid");
	}
	if (
		!LOCATOR_ID_RE.test(evidence.locatorId) ||
		evidence.locatorId !== `desktop-code:${evidence.version}` ||
		!VERSION_RE.test(evidence.version)
	) {
		throw new Error("Desktop artifact inspection identity is invalid");
	}
	if (!isNativeArtifactPlatform(evidence.nativePlatform)) {
		throw new Error("Desktop artifact native platform is invalid");
	}
	const expected = expectedClassification(evidence.nativePlatform);
	if (
		expected.desktopPlatform !== evidence.platform ||
		expected.format !== evidence.binaryFormat ||
		expected.architecture !== evidence.architecture
	) {
		throw new Error(
			"Desktop artifact inspection classification is inconsistent",
		);
	}
	if (
		!Number.isSafeInteger(evidence.size) ||
		evidence.size < 1 ||
		evidence.size > 1024 * 1024 * 1024 ||
		!SHA256_RE.test(evidence.sha256)
	) {
		throw new Error("Desktop artifact inspection byte identity is invalid");
	}
	if (
		(evidence.selectionReason !== "declared-pin" &&
			evidence.selectionReason !== "highest-cached") ||
		evidence.patchAuthorization !== "not-authorized" ||
		evidence.artifactBinding !== "verified"
	) {
		throw new Error("Desktop artifact patch authorization is invalid");
	}
	const provenance = evidence.provenance;
	if (
		provenance.status !== "not-run" &&
		provenance.status !== "verified" &&
		provenance.status !== "mismatch"
	) {
		throw new Error("Desktop artifact provenance status is invalid");
	}
	if (provenance.status === "not-run") {
		if (
			provenance.manifestUrl !== null ||
			provenance.manifestSha256 !== null ||
			provenance.manifestSize !== null ||
			provenance.manifestSignature !== "not-run"
		) {
			throw new Error(
				"Desktop artifact uninspected provenance is inconsistent",
			);
		}
	} else {
		const expectedUrl = `${DEFAULT_NATIVE_BUCKET}/${evidence.version}/manifest.json`;
		if (
			provenance.manifestUrl !== expectedUrl ||
			provenance.manifestSha256 === null ||
			!SHA256_RE.test(provenance.manifestSha256) ||
			provenance.manifestSize === null ||
			!Number.isSafeInteger(provenance.manifestSize) ||
			provenance.manifestSize < 1 ||
			provenance.manifestSize > 1024 * 1024 * 1024 ||
			provenance.manifestSignature !== "not-provided"
		) {
			throw new Error("Desktop artifact provenance evidence is invalid");
		}
		const matches =
			provenance.manifestSha256 === evidence.sha256 &&
			provenance.manifestSize === evidence.size;
		if (
			(provenance.status === "verified" && !matches) ||
			(provenance.status === "mismatch" && matches)
		) {
			throw new Error("Desktop artifact provenance status is inconsistent");
		}
	}
	if (evidence.platformSignature.validity !== "not-run") {
		throw new Error("Desktop platform signature validity was not verified");
	}
	if (evidence.platform.startsWith("linux")) {
		if (
			evidence.platformSignature.presence !== "not-applicable" ||
			evidence.platformSignature.mechanism !== "not-applicable"
		) {
			throw new Error("Linux platform signature presence is inconsistent");
		}
	} else {
		const expectedMechanism =
			evidence.platform === "win32"
				? "pe-certificate-table"
				: "macho-code-signature-command";
		if (
			(evidence.platformSignature.presence !== "present" &&
				evidence.platformSignature.presence !== "absent") ||
			evidence.platformSignature.mechanism !== expectedMechanism
		) {
			throw new Error("Desktop platform signature presence is inconsistent");
		}
	}
	if (
		evidence.patchReceipt.status !== "present" &&
		evidence.patchReceipt.status !== "absent" &&
		evidence.patchReceipt.status !== "not-run"
	) {
		throw new Error("Desktop patch receipt status is invalid");
	}
	if (
		evidence.patchReceipt.status === "present" &&
		(evidence.patchReceipt.tags.length === 0 ||
			evidence.patchReceipt.tags.length > 256 ||
			new Set(evidence.patchReceipt.tags).size !==
				evidence.patchReceipt.tags.length ||
			evidence.patchReceipt.tags.some((tag) => !PATCH_TAG_RE.test(tag)))
	) {
		throw new Error("Desktop patch receipt tags are invalid");
	}
	if (
		evidence.patchReceipt.status !== "present" &&
		evidence.patchReceipt.tags.length !== 0
	) {
		throw new Error("Desktop patch receipt state is inconsistent");
	}
	if (
		evidence.versionExecution !== "not-run" ||
		evidence.surfaceCompatibility !== "not-evaluated"
	) {
		throw new Error("Desktop artifact runtime evidence is overstated");
	}
	if (!isCanonicalIsoTimestamp(evidence.inspectedAt)) {
		throw new Error("Desktop artifact inspection timestamp is invalid");
	}
}

export async function inspectDesktopCodeArtifact(
	options: DesktopArtifactInspectionOptions,
): Promise<DesktopArtifactInspectionEvidence> {
	validateDesktopInventoryEvidence(options.inventory);
	const locatorId =
		options.locatorId ?? options.inventory.selectedCodeLocatorId;
	if (!locatorId || locatorId !== options.inventory.selectedCodeLocatorId) {
		throw new Error(
			"Desktop artifact inspection requires the inventory-selected Code row",
		);
	}
	const row = options.inventory.cachedCode.find(
		(candidate) => candidate.locatorId === locatorId,
	);
	if (!row || !options.inventory.selectedCodeReason) {
		throw new Error(
			"Selected Desktop Code row is absent from inventory evidence",
		);
	}
	if (row.locatorId !== `desktop-code:${row.version}`) {
		throw new Error(
			"Desktop Code locator does not match its direct version row",
		);
	}

	const rootStat = await fs.lstat(options.cacheRoot);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
		throw new Error("Desktop Code cache root must be a real directory");
	}
	const canonicalRoot = await fs.realpath(options.cacheRoot);
	const versionRoot = path.join(options.cacheRoot, row.version);
	const versionStat = await fs.lstat(versionRoot);
	if (!versionStat.isDirectory() || versionStat.isSymbolicLink()) {
		throw new Error("Desktop Code version row must be a real directory");
	}
	const canonicalVersionRoot = await fs.realpath(versionRoot);
	if (
		!isPathWithin(canonicalRoot, canonicalVersionRoot) ||
		path.dirname(canonicalVersionRoot) !== canonicalRoot
	) {
		throw new Error("Desktop Code version row escaped its explicit cache root");
	}
	const binaryName =
		options.inventory.platform === "win32" ? "claude.exe" : "claude";
	const binaryPath = path.join(versionRoot, binaryName);
	const pathStat = await fs.lstat(binaryPath);
	if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
		throw new Error("Desktop Code artifact must be a real regular file");
	}
	const canonicalBinaryPath = await fs.realpath(binaryPath);
	if (
		!isPathWithin(canonicalVersionRoot, canonicalBinaryPath) ||
		path.dirname(canonicalBinaryPath) !== canonicalVersionRoot
	) {
		throw new Error("Desktop Code artifact escaped its direct version row");
	}

	const handle = await fs.open(canonicalBinaryPath, fsConstants.O_RDONLY);
	let nativePlatform: NativeArtifactPlatform;
	let binaryFormat: NativeBinaryFormat;
	let architecture: CpuArchitecture;
	let platformSignature: DesktopPlatformSignatureEvidence;
	let patchReceipt: DesktopPatchReceiptEvidence = {
		status: "not-run",
		tags: [],
	};
	try {
		const snapshot = await inspectDesktopCodeSnapshotFromHandle(
			handle,
			options.inventory.platform,
			pathStat,
		);
		assertSnapshotMatches(row, snapshot);
		nativePlatform = row.platform;
		binaryFormat = row.binaryFormat;
		architecture = row.architecture;
		platformSignature = {
			...(await inspectNativeSignaturePresence(
				handle,
				nativePlatform,
				snapshot.size,
			)),
			validity: "not-run",
		};

		if (options.inspectPatchReceipt) {
			patchReceipt = await (
				options.runHeavyOperation ?? runDefaultHeavyOperation
			)(async () => {
				const bundle = (
					options.extractBundle ?? extractClaudeJsFromNativeBinary
				)(canonicalBinaryPath);
				const receipt = inspectEmbeddedPatchReceipt(bundle);
				const rebound = await inspectDesktopCodeSnapshotFromHandle(
					handle,
					options.inventory.platform,
					await handle.stat(),
				);
				assertSnapshotMatches(row, rebound);
				return receipt;
			});
		}
		const pathAfter = await fs.lstat(canonicalBinaryPath);
		if (!hasSameIdentity(pathStat, pathAfter)) {
			throw new Error("Desktop Code cache path changed during inspection");
		}
	} finally {
		await handle.close();
	}

	let provenance = createNotRunProvenance();
	if (options.verifyProvenance) {
		const manifest = await (
			options.fetchManifestEntry ?? fetchOfficialDesktopCodeManifestEntry
		)({ version: row.version, platform: nativePlatform });
		const matches =
			manifest.version === row.version &&
			manifest.platform === nativePlatform &&
			manifest.sha256 === row.sha256 &&
			manifest.size === row.size;
		provenance = {
			status: matches ? "verified" : "mismatch",
			manifestUrl: manifest.manifestUrl,
			manifestSha256: manifest.sha256,
			manifestSize: manifest.size,
			manifestSignature: manifest.manifestSignature,
		};
	}

	const evidence: DesktopArtifactInspectionEvidence = {
		schemaVersion: DESKTOP_ARTIFACT_INSPECTION_SCHEMA_VERSION,
		platform: options.inventory.platform,
		locatorId: row.locatorId,
		version: row.version,
		nativePlatform,
		binaryFormat,
		architecture,
		size: row.size,
		sha256: row.sha256,
		selectionReason: options.inventory.selectedCodeReason,
		patchAuthorization: "not-authorized",
		artifactBinding: "verified",
		provenance,
		platformSignature,
		patchReceipt,
		versionExecution: "not-run",
		surfaceCompatibility: "not-evaluated",
		inspectedAt: options.inspectedAt ?? new Date().toISOString(),
	};
	validateDesktopArtifactInspectionEvidence(evidence);
	return evidence;
}
