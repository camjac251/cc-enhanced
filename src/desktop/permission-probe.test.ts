import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createDesktopPermissionProbePlan,
	validateDesktopPermissionProbePlanEvidence,
} from "./permission-probe.js";
import type { DesktopSdkContractEvidence } from "./sdk-contract.js";
import { createDesktopPermissionProbePlanResult } from "./status.js";

function sdkContract(): DesktopSdkContractEvidence {
	return {
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
			signatureCount: 2,
			compressedBytes: 1_258_308,
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
	};
}

test("Desktop permission probe plan binds the SDK receipt without selecting a target", () => {
	const sdk = sdkContract();
	const plan = createDesktopPermissionProbePlan(sdk);

	assert.equal(plan.schemaVersion, 1);
	assert.match(plan.sdkContractBinding.sha256, /^[a-f0-9]{64}$/);
	assert.equal(plan.sdkContractBinding.inventorySha256, "a".repeat(64));
	assert.equal(plan.sdkContractBinding.platform, "win32");
	assert.equal(plan.sdkContractBinding.desktopVersion, "1.34493.0");
	assert.equal(plan.sdkContractBinding.packagedAgentSdkVersion, "0.3.235");
	assert.deepEqual(
		plan.facets.map((facet) => facet.id),
		[
			"read-permission-input",
			"read-runtime-semantics",
			"read-desktop-presentation",
			"edit-permission-input",
			"edit-runtime-semantics",
			"edit-desktop-presentation",
			"write-permission-input",
			"write-runtime-semantics",
			"write-desktop-presentation",
			"permission-mode-coverage",
			"restart-resume",
		],
	);
	assert.deepEqual(
		plan.scenarios.map((scenario) => scenario.id),
		[
			"read-range",
			"read-show-whitespace",
			"read-bounded-large-file",
			"read-stock-media",
			"edit-single",
			"edit-batch",
			"write-create",
			"write-overwrite",
			"write-modified-since-read",
		],
	);
	assert.deepEqual(plan.permissionModes.declaredSdkModes, [
		"default",
		"acceptEdits",
		"bypassPermissions",
		"plan",
		"dontAsk",
		"auto",
	]);
	assert.equal(plan.permissionModes.availability, "live-observation-required");
	assert.equal(plan.permissionModes.requiredCoverage, "every-offered-mode");
	assert.equal(
		plan.permissionModes.callbackNotInvokedHandling,
		"record-without-satisfying-permission-input",
	);
	assert.deepEqual(plan.protocol.lanes, [
		"stock-baseline",
		"patched-candidate",
	]);
	assert.equal(plan.boundaries.targetSelection, "required");
	assert.equal(plan.boundaries.consent, "required");
	assert.equal(plan.boundaries.mutationAuthorization, "not-authorized");
	assert.equal(plan.boundaries.execution, "not-run");
	assert.equal(plan.boundaries.profileSelection, "blocked");
	assert.equal(plan.boundaries.bundledRuntimeIdentity, "not-proven");
	assert.equal(plan.boundaries.uiProjection, "not-run");
	validateDesktopPermissionProbePlanEvidence(plan, sdk);
	assert.deepEqual(createDesktopPermissionProbePlan(sdk), plan);
	assert.doesNotMatch(
		JSON.stringify(plan),
		/\/home\/|[A-Z]:\\\\|desktop-code:2[.]1[.]235|processId|sessionId/,
	);
});

test("Desktop permission probe scenarios keep input, semantics, and presentation evidence separate", () => {
	const plan = createDesktopPermissionProbePlan(sdkContract());
	const layersByTool = new Map<string, Set<string>>();
	for (const facet of plan.facets) {
		for (const tool of facet.tools) {
			const layers = layersByTool.get(tool) ?? new Set<string>();
			layers.add(facet.layer);
			layersByTool.set(tool, layers);
		}
	}
	for (const tool of ["Read", "Edit", "Write"]) {
		const layers = layersByTool.get(tool) ?? new Set<string>();
		assert.equal(layers.has("permission-input"), true);
		assert.equal(layers.has("runtime-semantics"), true);
		assert.equal(layers.has("desktop-presentation"), true);
	}

	const readWhitespace = plan.scenarios.find(
		(scenario) => scenario.id === "read-show-whitespace",
	);
	assert.equal(readWhitespace?.comparison, "extension-delta");
	assert.deepEqual(readWhitespace?.inputFields, [
		"file_path",
		"show_whitespace",
	]);
	assert.deepEqual(readWhitespace?.evidenceChannels, [
		"tool-use-event",
		"permission-callback-observation",
		"tool-result",
		"desktop-card",
		"fixture-state",
	]);

	const batch = plan.scenarios.find((scenario) => scenario.id === "edit-batch");
	assert.equal(batch?.comparison, "extension-delta");
	assert.deepEqual(batch?.inputFields, [
		"file_path",
		"edits[]",
		"edits[].old_string",
		"edits[].new_string",
		"edits[].replace_all",
	]);
	assert.equal(batch?.assertions.includes("all-batch-diffs-complete"), true);
	assert.equal(batch?.evidenceChannels.includes("desktop-diff"), true);

	const staleWrite = plan.scenarios.find(
		(scenario) => scenario.id === "write-modified-since-read",
	);
	assert.equal(staleWrite?.comparison, "safety-rejection");
	assert.equal(
		staleWrite?.assertions.includes("modified-since-read-rejected"),
		true,
	);
});

test("Desktop permission probe validator fails closed on drift and SDK mismatch", () => {
	const sdk = sdkContract();
	const plan = createDesktopPermissionProbePlan(sdk);

	const unknown = structuredClone(plan) as unknown as Record<string, unknown>;
	unknown.extra = true;
	assert.throws(
		() => validateDesktopPermissionProbePlanEvidence(unknown, sdk),
		/contract|field|shape/i,
	);

	const missingFacet = structuredClone(plan);
	missingFacet.facets.pop();
	assert.throws(
		() => validateDesktopPermissionProbePlanEvidence(missingFacet, sdk),
		/facet|contract|shape/i,
	);

	const weakened = structuredClone(plan) as unknown as {
		boundaries: { mutationAuthorization: string };
	};
	weakened.boundaries.mutationAuthorization = "authorized";
	assert.throws(
		() => validateDesktopPermissionProbePlanEvidence(weakened, sdk),
		/boundar|contract|shape/i,
	);

	const otherSdk = sdkContract();
	otherSdk.inventoryBinding.desktopVersion = "1.34494.0";
	assert.throws(
		() => validateDesktopPermissionProbePlanEvidence(plan, otherSdk),
		/SDK contract binding/i,
	);

	const promotedSdk = sdkContract();
	(
		promotedSdk.boundaries as unknown as Record<string, string>
	).bundledRuntimeIdentity = "proven";
	assert.throws(
		() => createDesktopPermissionProbePlan(promotedSdk),
		/bundledRuntimeIdentity/i,
	);
});

test("Desktop permission probe operation reports a valid plan without claiming live readiness", () => {
	const result = createDesktopPermissionProbePlanResult(
		createDesktopPermissionProbePlan(sdkContract()),
	);

	assert.equal(result.operation, "desktop-permission-probe-plan");
	assert.equal(result.ok, true);
	assert.equal(result.target, null);
	assert.equal(result.profile, null);
	assert.deepEqual(
		result.checks.map((check) => [check.id, check.status]),
		[
			["sdk-contract-binding", "pass"],
			["facet-coverage", "pass"],
			["scenario-coverage", "pass"],
			["target-selection", "skipped"],
			["explicit-consent", "skipped"],
			["live-execution", "skipped"],
			["profile-readiness", "skipped"],
		],
	);
	assert.deepEqual(
		result.warnings.map((warning) => warning.code),
		[
			"desktop-probe-target-selection-required",
			"desktop-probe-consent-required",
			"desktop-probe-execution-not-run",
			"desktop-probe-profile-still-blocked",
		],
	);
});
