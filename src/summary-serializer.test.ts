import assert from "node:assert/strict";
import { test } from "node:test";
import { stringifySummary } from "./summary-serializer.js";

test("summary serialization preserves shared overlap records without marking them circular", () => {
	const overlap = {
		pass: "mutate",
		nodeType: "Program",
		tags: ["first", "second"],
		count: 1,
	};
	const report = {
		result: {
			evidence: {
				patches: [
					{ tag: "first", overlaps: [overlap] },
					{ tag: "second", overlaps: [overlap] },
				],
			},
		},
	};

	const parsed = JSON.parse(stringifySummary(report));
	assert.deepEqual(parsed.result.evidence.patches[0].overlaps[0], overlap);
	assert.deepEqual(parsed.result.evidence.patches[1].overlaps[0], overlap);
});

test("summary serialization still bounds actual circular references", () => {
	const circular: Record<string, unknown> = {};
	circular.self = circular;

	const parsed = JSON.parse(stringifySummary(circular));
	assert.equal(parsed.self, "[Circular]");
});
