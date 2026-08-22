import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { test } from "node:test";
import type { DesktopInventoryEvidence } from "../src/desktop/contract.js";
import type { DesktopSdkContractEvidence } from "../src/desktop/sdk-contract.js";
import { runDesktopSdkContractCommand } from "./desktop-sdk-contract.js";

const scriptPath = path.join(
	process.cwd(),
	"scripts",
	"desktop-sdk-contract.ts",
);

const inventory: DesktopInventoryEvidence = {
	schemaVersion: 1,
	platform: "win32",
	desktop: {
		locatorId: "desktop:1.34493.0",
		layout: "windows-squirrel",
		version: "1.34493.0",
		packagedAgentSdk: { status: "resolved", version: "0.3.235" },
		declaredCodePin: { status: "unresolved", version: null },
		asarMemberCount: 258,
	},
	cachedCode: [],
	selectedCodeLocatorId: null,
	selectedCodeReason: null,
	createdAt: "2026-08-21T01:58:53.418Z",
};

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

test("Desktop SDK CLI requires an explicit inventory receipt", () => {
	const result = spawnSync(process.execPath, [scriptPath, "--evidence"], {
		cwd: process.cwd(),
		encoding: "utf8",
		env: process.env,
	});
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /inventory/i);
});

test("Desktop SDK command renders evidence, shared JSON, and human output", async () => {
	const seenPaths: string[] = [];
	const seenInventories: DesktopInventoryEvidence[] = [];
	const dependencies = {
		readInventory: async (inventoryPath: string) => {
			seenPaths.push(inventoryPath);
			return inventory;
		},
		inspect: async (options: { inventory: DesktopInventoryEvidence }) => {
			seenInventories.push(options.inventory);
			return evidence;
		},
	};
	const evidenceResult = await runDesktopSdkContractCommand(
		{ inventoryPath: "/private-user/inventory.json", format: "evidence" },
		dependencies,
	);
	const jsonResult = await runDesktopSdkContractCommand(
		{ inventoryPath: "/private-user/inventory.json", format: "json" },
		dependencies,
	);
	const humanResult = await runDesktopSdkContractCommand(
		{ inventoryPath: "/private-user/inventory.json", format: "human" },
		dependencies,
	);

	assert.equal(evidenceResult.exitCode, 0);
	assert.deepEqual(JSON.parse(evidenceResult.output), evidence);
	assert.equal(JSON.parse(jsonResult.output).operation, "desktop-sdk-contract");
	assert.match(humanResult.output, /Desktop SDK Public Contract/i);
	for (const result of [evidenceResult, jsonResult, humanResult]) {
		assert.doesNotMatch(result.output, /private-user|inventory[.]json/);
	}
	assert.deepEqual(seenPaths, [
		"/private-user/inventory.json",
		"/private-user/inventory.json",
		"/private-user/inventory.json",
	]);
	assert.deepEqual(seenInventories, [inventory, inventory, inventory]);
});
