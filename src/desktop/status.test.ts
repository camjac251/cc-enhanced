import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_NATIVE_BUCKET } from "../native-release.js";
import type { DesktopArtifactInspectionEvidence } from "./artifact-inspection.js";
import type { DesktopInventoryReport } from "./contract.js";
import type { DesktopInventoryDrift } from "./drift.js";
import type { DesktopSdkContractEvidence } from "./sdk-contract.js";
import {
	createDesktopArtifactInspectionResult,
	createDesktopDriftResult,
	createDesktopSdkContractResult,
	createDesktopStatusResult,
} from "./status.js";

test("Desktop status exposes a desktop-local target without overstating inspection", () => {
	const report: DesktopInventoryReport = {
		schemaVersion: 1,
		platform: "win32",
		applications: [
			{
				locatorId: "desktop:1.2.3",
				layout: "windows-squirrel",
				rootPath: "C:\\synthetic\\app-1.2.3",
				asarPath: "C:\\synthetic\\app-1.2.3\\resources\\app.asar",
				version: "1.2.3",
				packagedAgentSdk: { status: "resolved", version: "0.3.4" },
				declaredCodePin: { status: "unresolved", version: null },
				asarMemberCount: 12,
			},
		],
		selectedApplicationLocatorId: "desktop:1.2.3",
		cacheRoots: [{ locatorId: "desktop-code-cache", path: "C:\\cache" }],
		cachedCode: [
			{
				locatorId: "desktop-code:2.1.9",
				version: "2.1.9",
				cacheRootPath: "C:\\cache",
				binaryPath: "C:\\cache\\2.1.9\\claude.exe",
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
		observedAt: "2026-08-20T12:00:00.000Z",
	};

	const result = createDesktopStatusResult(report);
	assert.equal(result.operation, "desktop-status");
	assert.equal(result.ok, true);
	assert.deepEqual(result.target, {
		id: "desktop-local:win32-x64:2.1.9",
		kind: "desktop-local",
		surface: "desktop-local",
		platform: "win32-x64",
		versionLane: "desktop-current",
	});
	assert.deepEqual(
		result.warnings.map((warning) => warning.code),
		[
			"desktop-code-pin-unresolved",
			"desktop-code-signature-not-inspected",
			"desktop-code-patch-receipt-not-inspected",
		],
	);
});

test("Desktop drift uses the shared operation envelope and fails on replacement", () => {
	const drift: DesktopInventoryDrift = {
		schemaVersion: 1,
		platform: "win32",
		baselineCreatedAt: "2026-08-20T12:00:00.000Z",
		currentCreatedAt: "2026-08-21T12:00:00.000Z",
		status: "changed",
		changes: [
			{
				kind: "cache-artifact-replaced",
				locatorId: "desktop-code:2.1.9",
				before: "a".repeat(64),
				after: "b".repeat(64),
			},
		],
	};

	const result = createDesktopDriftResult(drift);
	assert.equal(result.operation, "desktop-compare");
	assert.equal(result.ok, false);
	assert.equal(result.checks[0]?.id, "desktop-update-drift");
	assert.equal(result.checks[0]?.status, "fail");
	assert.equal(result.warnings[0]?.code, "desktop-update-drift-detected");
});

test("Desktop artifact inspection exposes evidence without authorizing activation", () => {
	const evidence = {
		schemaVersion: 1,
		platform: "win32",
		locatorId: "desktop-code:2.1.235",
		version: "2.1.235",
		nativePlatform: "win32-x64",
		binaryFormat: "pe",
		architecture: "x64",
		size: 512,
		sha256: "a".repeat(64),
		selectionReason: "highest-cached",
		patchAuthorization: "not-authorized",
		artifactBinding: "verified",
		provenance: {
			status: "verified",
			manifestUrl: `${DEFAULT_NATIVE_BUCKET}/2.1.235/manifest.json`,
			manifestSha256: "a".repeat(64),
			manifestSize: 512,
			manifestSignature: "not-provided",
		},
		platformSignature: {
			presence: "present",
			mechanism: "pe-certificate-table",
			validity: "not-run",
		},
		patchReceipt: { status: "absent", tags: [] },
		versionExecution: "not-run",
		surfaceCompatibility: "not-evaluated",
		inspectedAt: "2026-08-20T13:00:00.000Z",
	} satisfies DesktopArtifactInspectionEvidence;
	const result = createDesktopArtifactInspectionResult(evidence);
	assert.equal(result.operation, "desktop-inspect");
	assert.equal(result.ok, true);
	assert.equal(result.profile, null);
	assert.equal(result.artifact, null);
	assert.equal(
		result.checks.find((check) => check.id === "signature-validity")?.status,
		"skipped",
	);
	assert.equal(
		result.checks.find((check) => check.id === "surface-compatibility")?.status,
		"skipped",
	);
	assert.equal(
		result.warnings.some(
			(warning) => warning.code === "desktop-highest-cache-not-pin",
		),
		true,
	);
});

test("Desktop SDK contract result keeps live and UI claims skipped", () => {
	const evidence = {
		schemaVersion: 1,
		inventoryBinding: {
			sha256: "a".repeat(64),
			platform: "win32",
			desktopLocatorId: "desktop:1.34493.0",
			desktopVersion: "1.34493.0",
			packagedAgentSdkVersion: "0.3.235",
		},
		registry: {
			packageName: "@anthropic-ai/claude-agent-sdk",
			version: "0.3.235",
			metadataOrigin: "https://registry.npmjs.org",
			tarballOrigin: "https://registry.npmjs.org",
			integrityAlgorithm: "sha512",
			integrityVerified: true,
			signaturePresence: "present-unverified",
			signatureCount: 1,
			compressedBytes: 1024,
			archiveMembers: 15,
			declarationMembers: 6,
			declarationBytes: 554_054,
		},
		permissionContract: {
			callback: {
				typeName: "CanUseTool",
				parameters: [
					{ name: "toolName", type: "string" },
					{ name: "input", type: "Record<string, unknown>" },
					{ name: "options", type: "context" },
				],
				contextFields: [
					{ name: "signal", required: true, type: "AbortSignal" },
					{
						name: "suggestions",
						required: false,
						type: "PermissionUpdate[]",
					},
					{ name: "blockedPath", required: false, type: "string" },
					{ name: "decisionReason", required: false, type: "string" },
					{ name: "title", required: false, type: "string" },
					{ name: "displayName", required: false, type: "string" },
					{ name: "description", required: false, type: "string" },
					{ name: "toolUseID", required: true, type: "string" },
					{ name: "agentID", required: false, type: "string" },
					{ name: "requestId", required: true, type: "string" },
					{
						name: "matchedAskRule",
						required: false,
						type: "{ source: string; toolName: string; ruleContent?: string }",
					},
				],
				returnType: "Promise<PermissionResult | null>",
			},
			result: {
				typeName: "PermissionResult",
				allowUpdatedInput: "optional-record",
				denyMessage: "required-string",
			},
			mode: {
				typeName: "PermissionMode",
				values: [
					"default",
					"acceptEdits",
					"bypassPermissions",
					"plan",
					"dontAsk",
					"auto",
				],
			},
		},
		boundaries: {
			bundledRuntimeIdentity: "not-proven",
			liveCallbackExecution: "not-run",
			uiProjection: "not-run",
		},
	} satisfies DesktopSdkContractEvidence;

	const result = createDesktopSdkContractResult(evidence);
	assert.equal(result.operation, "desktop-sdk-contract");
	assert.equal(result.ok, true);
	assert.deepEqual(
		result.checks.map((check) => [check.id, check.status]),
		[
			["inventory-binding", "pass"],
			["registry-origin", "pass"],
			["tarball-integrity", "pass"],
			["public-declaration-contract", "pass"],
			["registry-signature-validity", "skipped"],
			["bundled-runtime-identity", "skipped"],
			["live-callback-execution", "skipped"],
			["ui-projection", "skipped"],
		],
	);
	assert.deepEqual(
		result.warnings.map((warning) => warning.code),
		[
			"desktop-sdk-registry-signature-validity-not-run",
			"desktop-sdk-bundled-runtime-identity-not-proven",
			"desktop-sdk-live-callback-not-run",
			"desktop-sdk-ui-projection-not-run",
		],
	);

	const withoutRegistrySignatures: DesktopSdkContractEvidence =
		structuredClone(evidence);
	withoutRegistrySignatures.registry.signaturePresence = "not-provided";
	withoutRegistrySignatures.registry.signatureCount = 0;
	assert.equal(
		createDesktopSdkContractResult(withoutRegistrySignatures).warnings[0]?.code,
		"desktop-sdk-registry-signature-not-provided",
	);
});
