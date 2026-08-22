import * as fs from "node:fs/promises";
import {
	compareDesktopVersions,
	type DesktopInventoryEvidence,
	type DesktopPlatform,
	validateDesktopInventoryEvidence,
} from "./contract.js";

export const DESKTOP_DRIFT_SCHEMA_VERSION = 1 as const;

export type DesktopDriftKind =
	| "desktop-added"
	| "desktop-removed"
	| "desktop-version-changed"
	| "desktop-layout-changed"
	| "desktop-agent-sdk-changed"
	| "desktop-code-pin-changed"
	| "desktop-package-content-changed"
	| "cache-row-removed"
	| "cache-artifact-replaced"
	| "cache-row-added"
	| "selected-code-changed"
	| "selection-reason-changed";

export type DesktopDriftValue = string | number | null;

export interface DesktopDriftChange {
	kind: DesktopDriftKind;
	locatorId?: string;
	before: DesktopDriftValue;
	after: DesktopDriftValue;
}

export interface DesktopInventoryDrift {
	schemaVersion: typeof DESKTOP_DRIFT_SCHEMA_VERSION;
	platform: DesktopPlatform;
	baselineCreatedAt: string;
	currentCreatedAt: string;
	status: "unchanged" | "changed";
	changes: DesktopDriftChange[];
}

const MAX_EVIDENCE_BYTES = 1024 * 1024;
const LOCATOR_ID_RE = /^[a-z0-9][a-z0-9:._-]{0,127}$/;
const DRIFT_KINDS = new Set<string>([
	"desktop-added",
	"desktop-removed",
	"desktop-version-changed",
	"desktop-layout-changed",
	"desktop-agent-sdk-changed",
	"desktop-code-pin-changed",
	"desktop-package-content-changed",
	"cache-row-removed",
	"cache-artifact-replaced",
	"cache-row-added",
	"selected-code-changed",
	"selection-reason-changed",
]);

function resolutionValue(resolution: {
	status: "resolved" | "unresolved";
	version: string | null;
}): string {
	return resolution.status === "resolved"
		? (resolution.version ?? "unresolved")
		: "unresolved";
}

function pushChange(
	changes: DesktopDriftChange[],
	kind: DesktopDriftKind,
	before: DesktopDriftValue,
	after: DesktopDriftValue,
	locatorId?: string,
): void {
	changes.push({ kind, ...(locatorId ? { locatorId } : {}), before, after });
}

function compareDesktopPackage(
	before: DesktopInventoryEvidence["desktop"],
	after: DesktopInventoryEvidence["desktop"],
	changes: DesktopDriftChange[],
): void {
	if (!before && !after) return;
	if (!before && after) {
		pushChange(changes, "desktop-added", null, after.version, after.locatorId);
		return;
	}
	if (before && !after) {
		pushChange(
			changes,
			"desktop-removed",
			before.version,
			null,
			before.locatorId,
		);
		return;
	}
	if (!before || !after) return;
	if (before.version !== after.version) {
		pushChange(
			changes,
			"desktop-version-changed",
			before.version,
			after.version,
		);
	}
	if (before.layout !== after.layout) {
		pushChange(changes, "desktop-layout-changed", before.layout, after.layout);
	}
	const beforeSdk = resolutionValue(before.packagedAgentSdk);
	const afterSdk = resolutionValue(after.packagedAgentSdk);
	if (beforeSdk !== afterSdk) {
		pushChange(changes, "desktop-agent-sdk-changed", beforeSdk, afterSdk);
	}
	const beforePin = resolutionValue(before.declaredCodePin);
	const afterPin = resolutionValue(after.declaredCodePin);
	if (beforePin !== afterPin) {
		pushChange(changes, "desktop-code-pin-changed", beforePin, afterPin);
	}
	if (before.asarMemberCount !== after.asarMemberCount) {
		pushChange(
			changes,
			"desktop-package-content-changed",
			before.asarMemberCount,
			after.asarMemberCount,
		);
	}
}

function sortedCache(
	evidence: DesktopInventoryEvidence,
): DesktopInventoryEvidence["cachedCode"] {
	return [...evidence.cachedCode].sort((left, right) =>
		compareDesktopVersions(left.version, right.version),
	);
}

function compareCache(
	before: DesktopInventoryEvidence,
	after: DesktopInventoryEvidence,
	changes: DesktopDriftChange[],
): void {
	const beforeByLocator = new Map(
		before.cachedCode.map((artifact) => [artifact.locatorId, artifact]),
	);
	const afterByLocator = new Map(
		after.cachedCode.map((artifact) => [artifact.locatorId, artifact]),
	);
	for (const artifact of sortedCache(before)) {
		if (!afterByLocator.has(artifact.locatorId)) {
			pushChange(
				changes,
				"cache-row-removed",
				artifact.version,
				null,
				artifact.locatorId,
			);
		}
	}
	for (const artifact of sortedCache(before)) {
		const current = afterByLocator.get(artifact.locatorId);
		if (current && current.sha256 !== artifact.sha256) {
			pushChange(
				changes,
				"cache-artifact-replaced",
				artifact.sha256,
				current.sha256,
				artifact.locatorId,
			);
		}
	}
	for (const artifact of sortedCache(after)) {
		if (!beforeByLocator.has(artifact.locatorId)) {
			pushChange(
				changes,
				"cache-row-added",
				null,
				artifact.version,
				artifact.locatorId,
			);
		}
	}
}

export function compareDesktopInventoryEvidence(
	baseline: DesktopInventoryEvidence,
	current: DesktopInventoryEvidence,
): DesktopInventoryDrift {
	validateDesktopInventoryEvidence(baseline);
	validateDesktopInventoryEvidence(current);
	if (baseline.platform !== current.platform) {
		throw new Error("Desktop inventory evidence platforms do not match");
	}
	const changes: DesktopDriftChange[] = [];
	compareDesktopPackage(baseline.desktop, current.desktop, changes);
	compareCache(baseline, current, changes);
	if (baseline.selectedCodeLocatorId !== current.selectedCodeLocatorId) {
		pushChange(
			changes,
			"selected-code-changed",
			baseline.selectedCodeLocatorId,
			current.selectedCodeLocatorId,
		);
	}
	if (baseline.selectedCodeReason !== current.selectedCodeReason) {
		pushChange(
			changes,
			"selection-reason-changed",
			baseline.selectedCodeReason,
			current.selectedCodeReason,
		);
	}
	const drift: DesktopInventoryDrift = {
		schemaVersion: DESKTOP_DRIFT_SCHEMA_VERSION,
		platform: baseline.platform,
		baselineCreatedAt: baseline.createdAt,
		currentCreatedAt: current.createdAt,
		status: changes.length === 0 ? "unchanged" : "changed",
		changes,
	};
	validateDesktopInventoryDrift(drift);
	return drift;
}

function isCanonicalIsoTimestamp(value: string): boolean {
	const parsed = new Date(value);
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

export function validateDesktopInventoryDrift(
	drift: DesktopInventoryDrift,
): void {
	if (drift.schemaVersion !== DESKTOP_DRIFT_SCHEMA_VERSION) {
		throw new Error("Unsupported Desktop inventory drift schema");
	}
	if (!(["linux", "darwin", "win32"] as const).includes(drift.platform)) {
		throw new Error("Desktop inventory drift platform is invalid");
	}
	if (
		!isCanonicalIsoTimestamp(drift.baselineCreatedAt) ||
		!isCanonicalIsoTimestamp(drift.currentCreatedAt)
	) {
		throw new Error("Desktop inventory drift timestamps are invalid");
	}
	if (drift.changes.length > 256) {
		throw new Error("Desktop inventory drift change count exceeds limit");
	}
	if (drift.status !== "unchanged" && drift.status !== "changed") {
		throw new Error("Desktop inventory drift status is invalid");
	}
	if (
		(drift.status === "unchanged" && drift.changes.length !== 0) ||
		(drift.status === "changed" && drift.changes.length === 0)
	) {
		throw new Error("Desktop inventory drift status is inconsistent");
	}
	for (const change of drift.changes) {
		if (!DRIFT_KINDS.has(change.kind)) {
			throw new Error("Desktop inventory drift kind is invalid");
		}
		if (change.locatorId && !LOCATOR_ID_RE.test(change.locatorId)) {
			throw new Error("Desktop inventory drift locator is invalid");
		}
		for (const value of [change.before, change.after]) {
			if (
				value !== null &&
				typeof value !== "string" &&
				typeof value !== "number"
			) {
				throw new Error("Desktop inventory drift value is invalid");
			}
		}
	}
}

function hasSameFileIdentity(
	left: Awaited<ReturnType<fs.FileHandle["stat"]>>,
	right: Awaited<ReturnType<fs.FileHandle["stat"]>>,
): boolean {
	return (
		left.size === right.size &&
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs
	);
}

export async function readDesktopInventoryEvidenceFile(
	filePath: string,
): Promise<DesktopInventoryEvidence> {
	const pathStat = await fs.lstat(filePath);
	if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
		throw new Error(
			"Desktop inventory evidence input must be a real regular file",
		);
	}
	if (pathStat.size < 2 || pathStat.size > MAX_EVIDENCE_BYTES) {
		throw new Error("Desktop inventory evidence input size exceeds limit");
	}
	const handle = await fs.open(filePath, "r");
	try {
		const before = await handle.stat();
		if (!hasSameFileIdentity(pathStat, before)) {
			throw new Error("Desktop inventory evidence changed before reading");
		}
		const contents = await handle.readFile({ encoding: "utf8" });
		const after = await handle.stat();
		if (!hasSameFileIdentity(before, after)) {
			throw new Error("Desktop inventory evidence changed while reading");
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(contents);
		} catch (error) {
			throw new Error("Desktop inventory evidence JSON is invalid", {
				cause: error,
			});
		}
		const evidence = parsed as DesktopInventoryEvidence;
		validateDesktopInventoryEvidence(evidence);
		return evidence;
	} finally {
		await handle.close();
	}
}
