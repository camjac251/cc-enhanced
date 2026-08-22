import {
	type CpuArchitecture,
	NATIVE_ARTIFACT_PLATFORMS,
	type NativeArtifactPlatform,
	type NativeBinaryFormat,
} from "../targets/contract.js";
import { compareReleaseVersions } from "../version-order.js";

export const DESKTOP_INVENTORY_SCHEMA_VERSION = 1 as const;

export type DesktopPlatform = "linux" | "darwin" | "win32";
export type DesktopApplicationLayout =
	| "windows-squirrel"
	| "windows-msix"
	| "macos-app"
	| "linux-package";
export type DesktopVersionResolution =
	| { status: "resolved"; version: string }
	| { status: "unresolved"; version: null };

export interface DesktopApplicationRecord {
	locatorId: string;
	layout: DesktopApplicationLayout;
	rootPath: string;
	asarPath: string;
	version: string;
	packagedAgentSdk: DesktopVersionResolution;
	declaredCodePin: DesktopVersionResolution;
	asarMemberCount: number;
}

export interface DesktopCacheRootRecord {
	locatorId: string;
	path: string;
}

export interface DesktopCodeArtifactRecord {
	locatorId: string;
	version: string;
	cacheRootPath: string;
	binaryPath: string;
	platform: NativeArtifactPlatform | null;
	binaryFormat: NativeBinaryFormat | "unknown";
	architecture: CpuArchitecture | "unknown";
	size: number;
	sha256: string;
	signatureInspection: "not-inspected";
	patchReceiptInspection: "not-inspected";
}

export interface DesktopInventoryReport {
	schemaVersion: typeof DESKTOP_INVENTORY_SCHEMA_VERSION;
	platform: DesktopPlatform;
	applications: DesktopApplicationRecord[];
	selectedApplicationLocatorId: string | null;
	cacheRoots: DesktopCacheRootRecord[];
	cachedCode: DesktopCodeArtifactRecord[];
	selectedCodeLocatorId: string | null;
	selectedCodeReason: "declared-pin" | "highest-cached" | null;
	observedAt: string;
}

export interface DesktopApplicationEvidence {
	locatorId: string;
	layout: DesktopApplicationLayout;
	version: string;
	packagedAgentSdk: DesktopVersionResolution;
	declaredCodePin: DesktopVersionResolution;
	asarMemberCount: number;
}

export interface DesktopCodeArtifactEvidence {
	locatorId: string;
	version: string;
	platform: NativeArtifactPlatform | null;
	binaryFormat: NativeBinaryFormat | "unknown";
	architecture: CpuArchitecture | "unknown";
	size: number;
	sha256: string;
	signatureInspection: "not-inspected";
	patchReceiptInspection: "not-inspected";
}

export interface DesktopInventoryEvidence {
	schemaVersion: typeof DESKTOP_INVENTORY_SCHEMA_VERSION;
	platform: DesktopPlatform;
	desktop: DesktopApplicationEvidence | null;
	cachedCode: DesktopCodeArtifactEvidence[];
	selectedCodeLocatorId: string | null;
	selectedCodeReason: "declared-pin" | "highest-cached" | null;
	createdAt: string;
}

const VERSION_RE = /^\d+(?:\.\d+){2,3}(?:[-+][0-9A-Za-z.-]+)?$/;
const LOCATOR_ID_RE = /^[a-z0-9][a-z0-9:._-]{0,127}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const APPLICATION_LAYOUTS = new Set<string>([
	"windows-squirrel",
	"windows-msix",
	"macos-app",
	"linux-package",
]);
const NATIVE_PLATFORMS = new Set<string>(NATIVE_ARTIFACT_PLATFORMS);
const BINARY_FORMATS = new Set<string>(["elf", "macho", "pe", "unknown"]);
const ARCHITECTURES = new Set<string>(["x64", "arm64", "unknown"]);
const MAX_BINARY_BYTES = 1024 * 1024 * 1024;

export function compareDesktopVersions(left: string, right: string): number {
	return compareReleaseVersions(left, right);
}

function isCanonicalIsoTimestamp(value: string): boolean {
	const parsed = new Date(value);
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function expectedLayoutPlatform(
	layout: DesktopApplicationLayout,
): DesktopPlatform {
	if (layout === "macos-app") return "darwin";
	if (layout === "linux-package") return "linux";
	return "win32";
}

function expectedArtifactClassification(platform: NativeArtifactPlatform): {
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

function validateResolution(
	resolution: DesktopVersionResolution,
	label: string,
): void {
	if (resolution.status === "resolved") {
		if (
			typeof resolution.version !== "string" ||
			!VERSION_RE.test(resolution.version)
		) {
			throw new Error(`${label} resolved version is invalid`);
		}
		return;
	}
	if (resolution.status === "unresolved") {
		if (resolution.version !== null) {
			throw new Error(
				`${label} unresolved resolution cannot contain a version`,
			);
		}
		return;
	}
	throw new Error(`${label} resolution status is invalid`);
}

function assertLocatorId(value: string, label: string): void {
	if (!LOCATOR_ID_RE.test(value)) {
		throw new Error(`${label} must be a stable path-free locator ID`);
	}
}

export function createDesktopInventoryEvidence(
	report: DesktopInventoryReport,
): DesktopInventoryEvidence {
	const desktop = report.selectedApplicationLocatorId
		? report.applications.find(
				(application) =>
					application.locatorId === report.selectedApplicationLocatorId,
			)
		: null;
	if (report.selectedApplicationLocatorId && !desktop) {
		throw new Error("Selected Desktop application is absent from inventory");
	}
	const evidence: DesktopInventoryEvidence = {
		schemaVersion: DESKTOP_INVENTORY_SCHEMA_VERSION,
		platform: report.platform,
		desktop: desktop
			? {
					locatorId: desktop.locatorId,
					layout: desktop.layout,
					version: desktop.version,
					packagedAgentSdk: desktop.packagedAgentSdk,
					declaredCodePin: desktop.declaredCodePin,
					asarMemberCount: desktop.asarMemberCount,
				}
			: null,
		cachedCode: report.cachedCode.map((artifact) => ({
			locatorId: artifact.locatorId,
			version: artifact.version,
			platform: artifact.platform,
			binaryFormat: artifact.binaryFormat,
			architecture: artifact.architecture,
			size: artifact.size,
			sha256: artifact.sha256,
			signatureInspection: artifact.signatureInspection,
			patchReceiptInspection: artifact.patchReceiptInspection,
		})),
		selectedCodeLocatorId: report.selectedCodeLocatorId,
		selectedCodeReason: report.selectedCodeReason,
		createdAt: report.observedAt,
	};
	validateDesktopInventoryEvidence(evidence);
	return evidence;
}

export function validateDesktopInventoryEvidence(
	evidence: DesktopInventoryEvidence,
): void {
	if (evidence.schemaVersion !== DESKTOP_INVENTORY_SCHEMA_VERSION) {
		throw new Error("Unsupported Desktop inventory evidence schema");
	}
	if (!(["linux", "darwin", "win32"] as const).includes(evidence.platform)) {
		throw new Error("Desktop inventory evidence platform is invalid");
	}
	if (!isCanonicalIsoTimestamp(evidence.createdAt)) {
		throw new Error("Desktop inventory evidence createdAt is invalid");
	}
	if (evidence.desktop) {
		assertLocatorId(evidence.desktop.locatorId, "Desktop application locator");
		if (!APPLICATION_LAYOUTS.has(evidence.desktop.layout)) {
			throw new Error("Desktop application layout is invalid");
		}
		if (expectedLayoutPlatform(evidence.desktop.layout) !== evidence.platform) {
			throw new Error("Desktop application layout does not match its platform");
		}
		if (!VERSION_RE.test(evidence.desktop.version)) {
			throw new Error("Desktop application version is invalid");
		}
		validateResolution(evidence.desktop.packagedAgentSdk, "Packaged Agent SDK");
		validateResolution(evidence.desktop.declaredCodePin, "Declared Code pin");
		if (
			!Number.isSafeInteger(evidence.desktop.asarMemberCount) ||
			evidence.desktop.asarMemberCount < 1 ||
			evidence.desktop.asarMemberCount > 4096
		) {
			throw new Error("Desktop ASAR member count is invalid");
		}
	}
	if (evidence.cachedCode.length > 64) {
		throw new Error("Desktop inventory evidence has too many cache rows");
	}
	const locatorIds = new Set<string>();
	for (const artifact of evidence.cachedCode) {
		assertLocatorId(artifact.locatorId, "Desktop Code locator");
		if (locatorIds.has(artifact.locatorId)) {
			throw new Error("Desktop Code locator IDs must be unique");
		}
		locatorIds.add(artifact.locatorId);
		if (!VERSION_RE.test(artifact.version)) {
			throw new Error("Desktop Code cache version is invalid");
		}
		if (
			!Number.isSafeInteger(artifact.size) ||
			artifact.size < 1 ||
			artifact.size > MAX_BINARY_BYTES
		) {
			throw new Error("Desktop Code artifact size is invalid");
		}
		if (!SHA256_RE.test(artifact.sha256)) {
			throw new Error("Desktop Code artifact SHA-256 is invalid");
		}
		if (
			artifact.platform !== null &&
			!NATIVE_PLATFORMS.has(artifact.platform)
		) {
			throw new Error("Desktop Code artifact platform is invalid");
		}
		if (!BINARY_FORMATS.has(artifact.binaryFormat)) {
			throw new Error("Desktop Code artifact binary format is invalid");
		}
		if (!ARCHITECTURES.has(artifact.architecture)) {
			throw new Error("Desktop Code artifact architecture is invalid");
		}
		if (artifact.platform !== null) {
			const expected = expectedArtifactClassification(artifact.platform);
			if (
				expected.desktopPlatform !== evidence.platform ||
				expected.format !== artifact.binaryFormat ||
				expected.architecture !== artifact.architecture
			) {
				throw new Error(
					"Desktop Code platform classification is inconsistent with its format or architecture",
				);
			}
		}
		if (
			artifact.signatureInspection !== "not-inspected" ||
			artifact.patchReceiptInspection !== "not-inspected"
		) {
			throw new Error("Desktop Code inspection state is invalid");
		}
	}
	if (
		evidence.selectedCodeReason !== null &&
		evidence.selectedCodeReason !== "declared-pin" &&
		evidence.selectedCodeReason !== "highest-cached"
	) {
		throw new Error("Desktop Code selection reason is invalid");
	}
	if (evidence.selectedCodeLocatorId === null) {
		if (evidence.selectedCodeReason !== null) {
			throw new Error("Desktop Code selection reason requires a selected row");
		}
		return;
	}
	assertLocatorId(
		evidence.selectedCodeLocatorId,
		"Selected Desktop Code locator",
	);
	const selected = evidence.cachedCode.find(
		(artifact) => artifact.locatorId === evidence.selectedCodeLocatorId,
	);
	if (!selected || evidence.selectedCodeReason === null) {
		throw new Error("Selected Desktop Code row is absent from evidence");
	}
	if (evidence.selectedCodeReason === "declared-pin") {
		if (
			evidence.desktop?.declaredCodePin.status !== "resolved" ||
			evidence.desktop.declaredCodePin.version !== selected.version
		) {
			throw new Error("Declared-pin selection does not match package metadata");
		}
	}
	if (evidence.selectedCodeReason === "highest-cached") {
		const highest = [...evidence.cachedCode].sort((left, right) =>
			compareDesktopVersions(right.version, left.version),
		)[0];
		if (highest?.locatorId !== selected.locatorId) {
			throw new Error(
				"Highest-cached selection does not select the highest version",
			);
		}
	}
}
