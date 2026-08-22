import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { test } from "node:test";
import { createDesktopPermissionPreflight } from "../src/desktop/permission-preflight.js";
import { runDesktopPermissionPreflightCommand } from "./desktop-permission-preflight.js";
import { createSyntheticDesktopPermissionInputs } from "./test-fixtures/desktop.js";

const scriptPath = path.join(
	process.cwd(),
	"scripts",
	"desktop-permission-preflight.ts",
);
test("Desktop permission preflight CLI requires every evidence input", () => {
	const result = spawnSync(process.execPath, [scriptPath, "--evidence"], {
		cwd: process.cwd(),
		encoding: "utf8",
		env: process.env,
	});
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /inventory|artifact|sdk-contract|probe-plan/i);
});

test("Desktop permission preflight command renders blocked evidence, shared JSON, and human output", async () => {
	const inputs = createSyntheticDesktopPermissionInputs();
	const evidence = createDesktopPermissionPreflight(inputs);
	const privatePaths = {
		inventoryPath: "/private-user/inventory.json",
		artifactPath: "/private-user/artifact.json",
		sdkContractPath: "/private-user/sdk.json",
		probePlanPath: "/private-user/plan.json",
		profileSupportPath: "/private-user/profile.json",
	};
	const seenPaths: Array<typeof privatePaths> = [];
	const dependencies = {
		readInputs: async (paths: typeof privatePaths) => {
			seenPaths.push(paths);
			return inputs;
		},
		createPreflight: () => evidence,
	};
	const evidenceResult = await runDesktopPermissionPreflightCommand(
		{ paths: privatePaths, format: "evidence" },
		dependencies,
	);
	const jsonResult = await runDesktopPermissionPreflightCommand(
		{ paths: privatePaths, format: "json" },
		dependencies,
	);
	const humanResult = await runDesktopPermissionPreflightCommand(
		{ paths: privatePaths, format: "human" },
		dependencies,
	);

	for (const result of [evidenceResult, jsonResult, humanResult]) {
		assert.equal(result.exitCode, 1);
		assert.doesNotMatch(result.output, /private-user|inventory[.]json/);
	}
	assert.deepEqual(JSON.parse(evidenceResult.output), evidence);
	assert.equal(
		JSON.parse(jsonResult.output).operation,
		"desktop-permission-preflight",
	);
	assert.match(humanResult.output, /Stock Preflight/i);
	assert.equal(seenPaths.length, 3);
});
