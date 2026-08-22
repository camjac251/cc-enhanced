import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createRemoteControlReadinessPlan,
	createRemoteControlReadinessResult,
} from "../remote-control/readiness.js";
import { renderRemoteControlReadiness } from "./remote-control.js";

test("Remote Control presentation separates probe launch from support and clients", () => {
	const result = createRemoteControlReadinessResult(
		createRemoteControlReadinessPlan(),
	);
	const lines = renderRemoteControlReadiness(result);
	const output = lines.join("\n");

	assert.equal(result.operation, "remote-control-readiness");
	assert.equal(result.ok, false);
	assert.deepEqual(
		result.checks.map(({ id }) => id),
		[
			"configuration-inspected",
			"configuration-blockers",
			"host-receipt",
			"subscription",
			"organization-policy",
			"workspace-trust",
			"workspace-kind",
			"server-choice",
			"probe-launch-readiness",
			"profile-support",
			"client-web",
			"client-mobile",
			"client-desktop",
			"start-consent",
		],
	);
	assert.match(output, /Probe launch:\s+blocked/i);
	assert.match(output, /Profile support:\s+blocked.*non-selectable/i);
	assert.match(output, /0 supported; 31 probe-required; 15 excluded/i);
	assert.match(output, /Live execution:\s+not run/i);
	assert.match(output, /transcript storage.*required at start/i);
	assert.match(output, /Web:\s+not-run/i);
	assert.match(output, /Mobile:\s+not-run/i);
	assert.match(output, /Desktop:\s+not-run.*probe-required/i);
	assert.match(output, /Read\/Edit.*probe-required/i);
	assert.match(output, /upstream-owned.*inherited stdio/i);
	assert.doesNotMatch(output, /ready and selectable|fully compatible/i);
});
