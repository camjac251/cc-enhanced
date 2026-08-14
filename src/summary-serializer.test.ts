import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { PatchRunner } from "./patch-runner.js";
import { stringifySummary } from "./summary-serializer.js";
import type { Patch } from "./types.js";
import { extractPatchEvidence } from "./verification/patch-evidence.js";

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

test("PatchRunner shared overlap evidence survives serialization and extraction", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "summary-contract-"));
	const targetPath = path.join(tempDir, "cli.js");
	await fs.writeFile(targetPath, 'const marker = "before";\n', "utf8");
	const patches: Patch[] = ["first-contract", "second-contract"].map((tag) => ({
		tag,
		astPasses: () => [
			{
				pass: "mutate",
				visitor: {
					StringLiteral() {},
				},
			},
		],
		verify: () => true,
	}));

	try {
		const result = await new PatchRunner(patches, {
			signaturePolicy: "off",
			telemetryLevel: "deep",
		}).run(targetPath, { dryRun: true });
		const evidence = extractPatchEvidence(
			JSON.parse(stringifySummary({ result })),
		);
		const expectedOverlap = {
			pass: "mutate",
			nodeType: "StringLiteral",
			tags: ["first-contract", "second-contract"],
			count: 1,
		};

		assert.deepEqual(
			evidence.patches.map((patch) => patch.tag),
			["first-contract", "second-contract"],
		);
		assert.deepEqual(evidence.patches[0]?.overlaps, [expectedOverlap]);
		assert.deepEqual(evidence.patches[1]?.overlaps, [expectedOverlap]);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});
