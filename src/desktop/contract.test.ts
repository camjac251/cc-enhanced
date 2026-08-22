import assert from "node:assert/strict";
import { test } from "node:test";
import {
	compareDesktopVersions,
	createDesktopInventoryEvidence,
	DESKTOP_INVENTORY_SCHEMA_VERSION,
	type DesktopInventoryEvidence,
	type DesktopInventoryReport,
	validateDesktopInventoryEvidence,
} from "./contract.js";

test("Desktop version ordering follows release and prerelease precedence", () => {
	assert.ok(compareDesktopVersions("1.2.3", "1.2.3-beta.1") > 0);
	assert.ok(compareDesktopVersions("1.2.3-beta.10", "1.2.3-beta.2") > 0);
	assert.ok(compareDesktopVersions("1.2.3-beta.1", "1.2.3-rc.1") < 0);
	assert.ok(compareDesktopVersions("1.2.3.10", "1.2.3.2") > 0);
	assert.equal(compareDesktopVersions("1.2.3+first", "1.2.3+second"), 0);
});

function createValidEvidence(): DesktopInventoryEvidence {
	return {
		schemaVersion: 1,
		platform: "win32",
		desktop: {
			locatorId: "desktop:1.2.3",
			layout: "windows-squirrel",
			version: "1.2.3",
			packagedAgentSdk: { status: "resolved", version: "0.3.4" },
			declaredCodePin: { status: "unresolved", version: null },
			asarMemberCount: 12,
		},
		cachedCode: [
			{
				locatorId: "desktop-code:2.1.9",
				version: "2.1.9",
				platform: "win32-x64",
				binaryFormat: "pe",
				architecture: "x64",
				size: 96,
				sha256: "a".repeat(64),
				signatureInspection: "not-inspected",
				patchReceiptInspection: "not-inspected",
			},
		],
		selectedCodeLocatorId: "desktop-code:2.1.9",
		selectedCodeReason: "highest-cached",
		createdAt: "2026-08-20T12:00:00.000Z",
	};
}

function firstArtifact(evidence: DesktopInventoryEvidence) {
	const artifact = evidence.cachedCode[0];
	assert.ok(artifact);
	return artifact;
}

test("Desktop inventory evidence preserves cache facts without local paths", () => {
	const report: DesktopInventoryReport = {
		schemaVersion: DESKTOP_INVENTORY_SCHEMA_VERSION,
		platform: "win32",
		applications: [
			{
				locatorId: "desktop:1.2.3",
				layout: "windows-squirrel",
				rootPath: "C:\\Users\\example\\AppData\\Local\\App\\app-1.2.3",
				asarPath:
					"C:\\Users\\example\\AppData\\Local\\App\\app-1.2.3\\resources\\app.asar",
				version: "1.2.3",
				packagedAgentSdk: {
					status: "resolved",
					version: "0.3.4",
				},
				declaredCodePin: { status: "unresolved", version: null },
				asarMemberCount: 12,
			},
		],
		selectedApplicationLocatorId: "desktop:1.2.3",
		cacheRoots: [
			{
				locatorId: "desktop-code-cache",
				path: "C:\\Users\\example\\AppData\\Roaming\\App\\claude-code",
			},
		],
		cachedCode: [
			{
				locatorId: "desktop-code:2.1.9",
				version: "2.1.9",
				cacheRootPath: "C:\\Users\\example\\AppData\\Roaming\\App\\claude-code",
				binaryPath:
					"C:\\Users\\example\\AppData\\Roaming\\App\\claude-code\\2.1.9\\claude.exe",
				platform: "win32-x64",
				binaryFormat: "pe",
				architecture: "x64",
				size: 1234,
				sha256: "a".repeat(64),
				signatureInspection: "not-inspected",
				patchReceiptInspection: "not-inspected",
			},
		],
		selectedCodeLocatorId: "desktop-code:2.1.9",
		selectedCodeReason: "highest-cached",
		observedAt: "2026-08-20T12:00:00.000Z",
	};

	const evidence = createDesktopInventoryEvidence(report);
	validateDesktopInventoryEvidence(evidence);

	assert.equal(evidence.schemaVersion, 1);
	assert.equal(evidence.desktop?.declaredCodePin.status, "unresolved");
	assert.equal(evidence.cachedCode[0]?.version, "2.1.9");
	assert.equal(evidence.selectedCodeReason, "highest-cached");
	const serialized = JSON.stringify(evidence);
	assert.doesNotMatch(serialized, /Users|AppData|app[.]asar|claude[.]exe/);
});

test("Desktop evidence rejects a cache version promoted into an unresolved pin", () => {
	const report: DesktopInventoryReport = {
		schemaVersion: 1,
		platform: "linux",
		applications: [],
		selectedApplicationLocatorId: null,
		cacheRoots: [],
		cachedCode: [],
		selectedCodeLocatorId: null,
		selectedCodeReason: null,
		observedAt: "2026-08-20T12:00:00.000Z",
	};
	const evidence = createDesktopInventoryEvidence(report);
	evidence.desktop = {
		locatorId: "desktop:synthetic",
		layout: "linux-package",
		version: "1.2.3",
		packagedAgentSdk: { status: "unresolved", version: null },
		declaredCodePin: { status: "unresolved", version: "2.1.9" },
		asarMemberCount: 1,
	} as unknown as NonNullable<typeof evidence.desktop>;

	assert.throws(
		() => validateDesktopInventoryEvidence(evidence),
		/unresolved.*version/i,
	);
});

test("Desktop evidence rejects an unknown resolution status", () => {
	const evidence = createValidEvidence();
	if (!evidence.desktop) assert.fail("expected Desktop evidence");
	evidence.desktop.packagedAgentSdk = {
		status: "invented",
		version: "0.3.4",
	} as unknown as typeof evidence.desktop.packagedAgentSdk;

	assert.throws(
		() => validateDesktopInventoryEvidence(evidence),
		/resolution status is invalid/i,
	);
});

test("Desktop evidence rejects unsupported binary classifications", () => {
	const evidence = {
		schemaVersion: 1,
		platform: "win32",
		desktop: null,
		cachedCode: [
			{
				locatorId: "desktop-code:2.1.9",
				version: "2.1.9",
				platform: "win32-x64",
				binaryFormat: "zip",
				architecture: "x64",
				size: 96,
				sha256: "a".repeat(64),
				signatureInspection: "not-inspected",
				patchReceiptInspection: "not-inspected",
			},
		],
		selectedCodeLocatorId: "desktop-code:2.1.9",
		selectedCodeReason: "highest-cached",
		createdAt: "2026-08-20T12:00:00.000Z",
	} as unknown as Parameters<typeof validateDesktopInventoryEvidence>[0];

	assert.throws(
		() => validateDesktopInventoryEvidence(evidence),
		/binary format/i,
	);
});

test("Desktop evidence rejects incoherent platform, size, and selection claims", () => {
	const wrongFormat = createValidEvidence();
	wrongFormat.cachedCode[0] = {
		...firstArtifact(wrongFormat),
		binaryFormat: "elf",
	};
	assert.throws(
		() => validateDesktopInventoryEvidence(wrongFormat),
		/classification|platform.*format/i,
	);

	const oversized = createValidEvidence();
	oversized.cachedCode[0] = {
		...firstArtifact(oversized),
		size: 1024 * 1024 * 1024 + 1,
	};
	assert.throws(() => validateDesktopInventoryEvidence(oversized), /size/i);

	const wrongLayout = createValidEvidence();
	assert.ok(wrongLayout.desktop);
	wrongLayout.desktop = {
		...wrongLayout.desktop,
		layout: "linux-package",
	};
	assert.throws(
		() => validateDesktopInventoryEvidence(wrongLayout),
		/layout.*platform|platform.*layout/i,
	);

	const notHighest = createValidEvidence();
	notHighest.cachedCode.push({
		...firstArtifact(notHighest),
		locatorId: "desktop-code:2.1.10",
		version: "2.1.10",
		sha256: "b".repeat(64),
	});
	assert.throws(() => validateDesktopInventoryEvidence(notHighest), /highest/i);
});

test("Desktop evidence requires canonical ISO observation timestamps", () => {
	const evidence = createValidEvidence();
	evidence.createdAt = "08/20/2026 12:00:00";
	assert.throws(() => validateDesktopInventoryEvidence(evidence), /createdAt/i);
});

test("Desktop evidence accepts canonical ARM64 musl artifact classification", () => {
	const evidence = createValidEvidence();
	evidence.platform = "linux";
	evidence.desktop = null;
	evidence.cachedCode[0] = {
		...firstArtifact(evidence),
		platform: "linux-arm64-musl",
		binaryFormat: "elf",
		architecture: "arm64",
	};

	assert.doesNotThrow(() => validateDesktopInventoryEvidence(evidence));
});
