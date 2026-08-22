import assert from "node:assert/strict";
import { test } from "node:test";
import { createSyntheticDesktopPermissionInputs } from "../../scripts/test-fixtures/desktop.js";
import { createDesktopPermissionPreflight } from "../desktop/permission-preflight.js";
import { createDesktopPermissionPreflightResult } from "../desktop/status.js";
import { renderDesktopPermissionPreflight } from "./desktop-permission-preflight.js";

test("Desktop permission preflight presenter distinguishes proven stock state from live blockers", () => {
	const inputs = createSyntheticDesktopPermissionInputs();
	const output = renderDesktopPermissionPreflight(
		createDesktopPermissionPreflightResult(
			createDesktopPermissionPreflight(inputs),
		),
	).join("\n");

	assert.match(output, /Desktop Read\/Edit\/Write Stock Preflight/);
	assert.match(output, /not ready/i);
	assert.match(output, /official stock identity:\s+pass/i);
	assert.match(output, /highest-cached/i);
	assert.match(output, /matching-host.*signature validity/i);
	assert.match(output, /owner.*target selection/i);
	assert.match(output, /owner.*stock-baseline consent/i);
	assert.match(output, /no Desktop launch or managed-artifact mutation/i);
	assert.doesNotMatch(output, /docs\/evidence|\/home\/|[A-Z]:\\\\/);
});
