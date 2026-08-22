import { createHash } from "node:crypto";
import type { DesktopArtifactInspectionEvidence } from "../../src/desktop/artifact-inspection.js";
import type { DesktopInventoryEvidence } from "../../src/desktop/contract.js";
import type { DesktopPermissionPreflightInputs } from "../../src/desktop/permission-preflight.js";
import { createDesktopPermissionProbePlan } from "../../src/desktop/permission-probe.js";
import type { DesktopSdkContractEvidence } from "../../src/desktop/sdk-contract.js";
import { DEFAULT_NATIVE_BUCKET } from "../../src/native-release.js";
import { createPatchSurfaceReadiness } from "../../src/profiles/readiness.js";

const DESKTOP_VERSION = "1.2.3";
const SDK_VERSION = "0.3.4";
const CODE_VERSION = "2.1.9";
const CODE_SHA256 = "a".repeat(64);
const CODE_SIZE = 96;
const CREATED_AT = "2026-01-01T00:00:00.000Z";

function canonicalJson(value: unknown): string {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean" ||
		typeof value === "number"
	) {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	}
	if (typeof value === "object") {
		const object = value as Record<string, unknown>;
		return `{${Object.keys(object)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
			.join(",")}}`;
	}
	throw new Error("Synthetic fixture contains an unsupported value");
}

function canonicalSha256(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function createSyntheticDesktopInventory(): DesktopInventoryEvidence {
	return {
		schemaVersion: 1,
		platform: "win32",
		desktop: {
			locatorId: `desktop:${DESKTOP_VERSION}`,
			layout: "windows-squirrel",
			version: DESKTOP_VERSION,
			packagedAgentSdk: { status: "resolved", version: SDK_VERSION },
			declaredCodePin: { status: "unresolved", version: null },
			asarMemberCount: 12,
		},
		cachedCode: [
			{
				locatorId: `desktop-code:${CODE_VERSION}`,
				version: CODE_VERSION,
				platform: "win32-x64",
				binaryFormat: "pe",
				architecture: "x64",
				size: CODE_SIZE,
				sha256: CODE_SHA256,
				signatureInspection: "not-inspected",
				patchReceiptInspection: "not-inspected",
			},
		],
		selectedCodeLocatorId: `desktop-code:${CODE_VERSION}`,
		selectedCodeReason: "highest-cached",
		createdAt: CREATED_AT,
	};
}

export function createSyntheticDesktopSdkContract(
	inventory = createSyntheticDesktopInventory(),
): DesktopSdkContractEvidence {
	return {
		schemaVersion: 1,
		inventoryBinding: {
			sha256: canonicalSha256(inventory),
			platform: "win32",
			desktopLocatorId: `desktop:${DESKTOP_VERSION}`,
			desktopVersion: DESKTOP_VERSION,
			packagedAgentSdkVersion: SDK_VERSION,
		},
		registry: {
			packageName: "@anthropic-ai/claude-agent-sdk",
			version: SDK_VERSION,
			metadataOrigin: "https://registry.npmjs.org",
			tarballOrigin: "https://registry.npmjs.org",
			integrityAlgorithm: "sha512",
			integrityVerified: true,
			signaturePresence: "present-unverified",
			signatureCount: 1,
			compressedBytes: 128_000,
			archiveMembers: 12,
			declarationMembers: 4,
			declarationBytes: 64_000,
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
	};
}

export function createSyntheticDesktopArtifact(): DesktopArtifactInspectionEvidence {
	return {
		schemaVersion: 1,
		platform: "win32",
		locatorId: `desktop-code:${CODE_VERSION}`,
		version: CODE_VERSION,
		nativePlatform: "win32-x64",
		binaryFormat: "pe",
		architecture: "x64",
		size: CODE_SIZE,
		sha256: CODE_SHA256,
		selectionReason: "highest-cached",
		patchAuthorization: "not-authorized",
		artifactBinding: "verified",
		provenance: {
			status: "verified",
			manifestUrl: `${DEFAULT_NATIVE_BUCKET}/${CODE_VERSION}/manifest.json`,
			manifestSha256: CODE_SHA256,
			manifestSize: CODE_SIZE,
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
		inspectedAt: CREATED_AT,
	};
}

export function createSyntheticDesktopPermissionInputs(): DesktopPermissionPreflightInputs {
	const inventory = createSyntheticDesktopInventory();
	const sdkContract = createSyntheticDesktopSdkContract(inventory);
	return {
		inventory,
		artifact: createSyntheticDesktopArtifact(),
		sdkContract,
		probePlan: createDesktopPermissionProbePlan(sdkContract),
		profileSupport: createPatchSurfaceReadiness("desktop-local"),
	};
}
