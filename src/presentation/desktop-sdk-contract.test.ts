import assert from "node:assert/strict";
import { test } from "node:test";
import type { DesktopSdkContractEvidence } from "../desktop/sdk-contract.js";
import { createDesktopSdkContractResult } from "../desktop/status.js";
import { renderDesktopSdkContract } from "./desktop-sdk-contract.js";

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

test("human SDK output names proven contract and unproven live boundaries", () => {
	const rendered = renderDesktopSdkContract(
		createDesktopSdkContractResult(evidence),
	).join("\n");
	assert.match(rendered, /Desktop SDK Public Contract/i);
	assert.match(rendered, /0[.]3[.]235/);
	assert.match(rendered, /sha512.*verified/i);
	assert.match(rendered, /updatedInput.*optional/i);
	assert.match(rendered, /deny message.*required/i);
	assert.match(rendered, /bundled identity.*not-proven/i);
	assert.match(rendered, /callback execution.*not-run/i);
	assert.match(rendered, /UI projection.*not-run/i);
	assert.doesNotMatch(rendered, /Users|AppData|private-user|sdk[.]d[.]ts/);
});
