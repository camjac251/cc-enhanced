import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { test } from "node:test";
import type { DesktopPermissionProbePlanEvidence } from "../src/desktop/permission-probe.js";
import { createDesktopPermissionProbePlan } from "../src/desktop/permission-probe.js";
import type { DesktopSdkContractEvidence } from "../src/desktop/sdk-contract.js";
import { runDesktopPermissionProbeCommand } from "./desktop-permission-probe.js";
import { createSyntheticDesktopSdkContract } from "./test-fixtures/desktop.js";

const scriptPath = path.join(
	process.cwd(),
	"scripts",
	"desktop-permission-probe.ts",
);

test("Desktop permission probe CLI requires an explicit SDK contract receipt", () => {
	const result = spawnSync(process.execPath, [scriptPath, "--evidence"], {
		cwd: process.cwd(),
		encoding: "utf8",
		env: process.env,
	});
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /sdk-contract/i);
});

test("Desktop permission probe command renders evidence, shared JSON, and human output", async () => {
	const sdk = createSyntheticDesktopSdkContract();
	const evidence = createDesktopPermissionProbePlan(sdk);
	const seenPaths: string[] = [];
	const seenContracts: DesktopSdkContractEvidence[] = [];
	const dependencies = {
		readSdkContract: async (contractPath: string) => {
			seenPaths.push(contractPath);
			return sdk;
		},
		createPlan: (contract: DesktopSdkContractEvidence) => {
			seenContracts.push(contract);
			return evidence;
		},
	};
	const evidenceResult = await runDesktopPermissionProbeCommand(
		{ sdkContractPath: "/private-user/sdk.json", format: "evidence" },
		dependencies,
	);
	const jsonResult = await runDesktopPermissionProbeCommand(
		{ sdkContractPath: "/private-user/sdk.json", format: "json" },
		dependencies,
	);
	const humanResult = await runDesktopPermissionProbeCommand(
		{ sdkContractPath: "/private-user/sdk.json", format: "human" },
		dependencies,
	);

	assert.equal(evidenceResult.exitCode, 0);
	assert.deepEqual(
		JSON.parse(evidenceResult.output) as DesktopPermissionProbePlanEvidence,
		evidence,
	);
	assert.equal(
		JSON.parse(jsonResult.output).operation,
		"desktop-permission-probe-plan",
	);
	assert.match(humanResult.output, /Read\/Edit\/Write Probe Plan/i);
	for (const result of [evidenceResult, jsonResult, humanResult]) {
		assert.doesNotMatch(result.output, /private-user|sdk[.]json/);
	}
	assert.deepEqual(seenPaths, [
		"/private-user/sdk.json",
		"/private-user/sdk.json",
		"/private-user/sdk.json",
	]);
	assert.deepEqual(seenContracts, [sdk, sdk, sdk]);
});
