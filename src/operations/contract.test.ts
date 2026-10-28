import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createOperationResult,
	OPERATION_RESULT_SCHEMA_VERSION,
} from "./contract.js";

test("native pull results expose a minimal versioned contract", () => {
	const data = { outputJsPath: "/tmp/clean/cli.js" };
	const result = createOperationResult({
		operation: "native-pull",
		ok: true,
		data,
	});

	assert.equal(OPERATION_RESULT_SCHEMA_VERSION, 1);
	assert.deepEqual(result, {
		schemaVersion: 1,
		operation: "native-pull",
		ok: true,
		data,
	});
});
