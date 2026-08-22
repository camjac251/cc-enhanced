import assert from "node:assert/strict";
import { test } from "node:test";
import { createOperationResult } from "../operations/contract.js";
import { renderOperationJson } from "./json.js";

test("JSON presentation serializes the versioned operation envelope", () => {
	const result = createOperationResult({
		operation: "native-build",
		ok: true,
		data: { outputPath: "/tmp/example-build" },
		checks: [{ id: "patch-verification", status: "pass" }],
	});

	const rendered = renderOperationJson(result);

	assert.equal(rendered, JSON.stringify(result, null, 2));
	assert.deepEqual(JSON.parse(rendered), result);
});
