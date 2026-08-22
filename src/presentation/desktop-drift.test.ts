import assert from "node:assert/strict";
import { test } from "node:test";
import type { DesktopInventoryDrift } from "../desktop/drift.js";
import { createDesktopDriftResult } from "../desktop/status.js";
import { renderDesktopDrift } from "./desktop-drift.js";

test("human Desktop drift output distinguishes unchanged and replacement states", () => {
	const unchanged: DesktopInventoryDrift = {
		schemaVersion: 1,
		platform: "win32",
		baselineCreatedAt: "2026-08-20T12:00:00.000Z",
		currentCreatedAt: "2026-08-21T12:00:00.000Z",
		status: "unchanged",
		changes: [],
	};
	assert.deepEqual(renderDesktopDrift(createDesktopDriftResult(unchanged)), [
		"",
		"Claude Desktop Drift",
		"",
		"  Platform: win32",
		"  Status:   unchanged",
		"  Changes:  none",
		"",
	]);

	const changed: DesktopInventoryDrift = {
		...unchanged,
		status: "changed",
		changes: [
			{
				kind: "cache-artifact-replaced",
				locatorId: "desktop-code:2.1.9",
				before: "a".repeat(64),
				after: "b".repeat(64),
			},
		],
	};
	const lines = renderDesktopDrift(createDesktopDriftResult(changed));
	assert.match(lines.join("\n"), /cache artifact replaced.*2[.]1[.]9/i);
	assert.doesNotMatch(lines.join("\n"), /Users|AppData|app[.]asar/);
});
