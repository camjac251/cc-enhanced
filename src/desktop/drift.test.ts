import assert from "node:assert/strict";
import { test } from "node:test";
import type { DesktopInventoryEvidence } from "./contract.js";
import {
	compareDesktopInventoryEvidence,
	validateDesktopInventoryDrift,
} from "./drift.js";

function evidence(
	options: {
		createdAt?: string;
		desktopVersion?: string;
		agentSdk?: string;
		declaredPin?: string | null;
		memberCount?: number;
		cache?: Array<{ version: string; sha256: string }>;
		selectedVersion?: string | null;
		selectedReason?: "declared-pin" | "highest-cached" | null;
	} = {},
): DesktopInventoryEvidence {
	const cache = options.cache ?? [
		{ version: "2.1.9", sha256: "a".repeat(64) },
		{ version: "2.1.8", sha256: "b".repeat(64) },
	];
	const selectedVersion =
		options.selectedVersion === undefined ? "2.1.9" : options.selectedVersion;
	return {
		schemaVersion: 1,
		platform: "win32",
		desktop: {
			locatorId: `desktop:${options.desktopVersion ?? "1.2.3"}`,
			layout: "windows-squirrel",
			version: options.desktopVersion ?? "1.2.3",
			packagedAgentSdk: options.agentSdk
				? { status: "resolved", version: options.agentSdk }
				: { status: "resolved", version: "0.3.4" },
			declaredCodePin:
				options.declaredPin === undefined || options.declaredPin === null
					? { status: "unresolved", version: null }
					: { status: "resolved", version: options.declaredPin },
			asarMemberCount: options.memberCount ?? 12,
		},
		cachedCode: cache.map((artifact) => ({
			locatorId: `desktop-code:${artifact.version}`,
			version: artifact.version,
			platform: "win32-x64",
			binaryFormat: "pe",
			architecture: "x64",
			size: 96,
			sha256: artifact.sha256,
			signatureInspection: "not-inspected",
			patchReceiptInspection: "not-inspected",
		})),
		selectedCodeLocatorId: selectedVersion
			? `desktop-code:${selectedVersion}`
			: null,
		selectedCodeReason:
			options.selectedReason === undefined
				? selectedVersion
					? "highest-cached"
					: null
				: options.selectedReason,
		createdAt: options.createdAt ?? "2026-08-20T12:00:00.000Z",
	};
}

test("Desktop drift ignores observation time and validates unchanged evidence", () => {
	const before = evidence();
	const after = evidence({ createdAt: "2026-08-21T12:00:00.000Z" });
	const drift = compareDesktopInventoryEvidence(before, after);

	validateDesktopInventoryDrift(drift);
	assert.equal(drift.status, "unchanged");
	assert.deepEqual(drift.changes, []);
	assert.equal(drift.baselineCreatedAt, before.createdAt);
	assert.equal(drift.currentCreatedAt, after.createdAt);
});

test("Desktop drift deterministically classifies package, cache, replacement, and selection changes", () => {
	const before = evidence();
	const after = evidence({
		desktopVersion: "1.2.4",
		agentSdk: "0.3.5",
		declaredPin: "2.1.10",
		memberCount: 13,
		cache: [
			{ version: "2.1.10", sha256: "d".repeat(64) },
			{ version: "2.1.9", sha256: "c".repeat(64) },
		],
		selectedVersion: "2.1.10",
		selectedReason: "declared-pin",
	});

	const drift = compareDesktopInventoryEvidence(before, after);

	assert.equal(drift.status, "changed");
	assert.deepEqual(
		drift.changes.map((change) => change.kind),
		[
			"desktop-version-changed",
			"desktop-agent-sdk-changed",
			"desktop-code-pin-changed",
			"desktop-package-content-changed",
			"cache-row-removed",
			"cache-artifact-replaced",
			"cache-row-added",
			"selected-code-changed",
			"selection-reason-changed",
		],
	);
	assert.deepEqual(drift.changes[4], {
		kind: "cache-row-removed",
		locatorId: "desktop-code:2.1.8",
		before: "2.1.8",
		after: null,
	});
	assert.deepEqual(drift.changes[5], {
		kind: "cache-artifact-replaced",
		locatorId: "desktop-code:2.1.9",
		before: "a".repeat(64),
		after: "c".repeat(64),
	});
	validateDesktopInventoryDrift(drift);
	assert.doesNotMatch(JSON.stringify(drift), /Users|AppData|app[.]asar/);
});

test("Desktop drift rejects incompatible platforms before comparison", () => {
	const after = evidence();
	after.platform = "linux";
	after.desktop = after.desktop
		? { ...after.desktop, layout: "linux-package" }
		: null;
	after.cachedCode = after.cachedCode.map((artifact) => ({
		...artifact,
		platform: "linux-x64",
		binaryFormat: "elf",
	}));

	assert.throws(
		() => compareDesktopInventoryEvidence(evidence(), after),
		/platform/i,
	);
});

test("Desktop drift validator rejects unknown status values", () => {
	const drift = compareDesktopInventoryEvidence(evidence(), evidence());
	(drift as { status: string }).status = "unknown";
	assert.throws(() => validateDesktopInventoryDrift(drift), /status/i);
});
