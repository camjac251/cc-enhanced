import assert from "node:assert/strict";
import { test } from "node:test";
import { createSyntheticDesktopSdkContract } from "../../scripts/test-fixtures/desktop.js";
import { createDesktopPermissionProbePlan } from "../desktop/permission-probe.js";
import { createDesktopPermissionProbePlanResult } from "../desktop/status.js";
import { renderDesktopPermissionProbePlan } from "./desktop-permission-probe.js";

test("Desktop permission probe presenter makes the safety boundary explicit", () => {
	const result = createDesktopPermissionProbePlanResult(
		createDesktopPermissionProbePlan(createSyntheticDesktopSdkContract()),
	);
	const output = renderDesktopPermissionProbePlan(result).join("\n");

	assert.match(output, /Desktop Read\/Edit\/Write Probe Plan/);
	assert.match(output, /11/);
	assert.match(output, /9/);
	assert.match(output, /every offered mode/i);
	assert.match(output, /target selection:\s+required/i);
	assert.match(output, /consent:\s+required/i);
	assert.match(output, /mutation authorization:\s+not-authorized/i);
	assert.match(output, /execution:\s+not-run/i);
	assert.match(output, /profile selection:\s+blocked/i);
	assert.doesNotMatch(output, /docs\/goals|\/home\/|[A-Z]:\\\\/);
});
