import assert from "node:assert/strict";
import { test } from "node:test";
import { createOperationResult } from "../operations/contract.js";
import { createPatchSurfaceReadiness } from "../profiles/readiness.js";
import { renderProfileSupport } from "./profile-support.js";

test("human profile support output makes Desktop blockers explicit", () => {
	const result = createOperationResult({
		operation: "profile-support",
		ok: false,
		data: createPatchSurfaceReadiness("desktop-local"),
	});
	const rendered = renderProfileSupport(result).join("\n");

	assert.match(rendered, /Desktop Local Patch Support/);
	assert.match(rendered, /not selectable/i);
	assert.match(rendered, /31 probe-required/);
	assert.match(rendered, /15 excluded/);
	assert.match(rendered, /desktop-edit-batch-approval/);
	assert.match(rendered, /desktop-read-card: not-run \(1 patch\)/);
	assert.doesNotMatch(rendered, /\(1 patches\)/);
	assert.match(rendered, /tools-off.*conflicting-tool-policy/);
	assert.doesNotMatch(rendered, /supported on Desktop/i);
});

test("human profile support output reports cli-full ready", () => {
	const result = createOperationResult({
		operation: "profile-support",
		ok: true,
		data: createPatchSurfaceReadiness("cli"),
	});
	const rendered = renderProfileSupport(result).join("\n");

	assert.match(rendered, /CLI Full Patch Support/);
	assert.match(rendered, /ready and selectable/i);
	assert.match(rendered, /45 supported/);
});
