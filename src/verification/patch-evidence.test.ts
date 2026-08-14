import assert from "node:assert/strict";
import { test } from "node:test";
import type { PatchEvidenceManifest } from "../types.js";
import {
	comparePatchEvidence,
	extractPatchEvidence,
	formatPatchEvidenceComparisonMarkdown,
} from "./patch-evidence.js";

function manifest(
	overrides: Partial<PatchEvidenceManifest> = {},
): PatchEvidenceManifest {
	return {
		schemaVersion: 1,
		sourceSha256: "a".repeat(64),
		outputSha256: "b".repeat(64),
		patches: [
			{
				tag: "first",
				passed: true,
				coverage: "semantic",
				outcomes: {
					matched: 2,
					mutated: 2,
					alreadySatisfied: 0,
					verified: 1,
					issues: [],
				},
				handlerCalls: { discover: 1, mutate: 2, finalize: 0 },
				structuralHashes: {
					mutate: {
						beforeSha256: "c".repeat(64),
						afterSha256: "d".repeat(64),
					},
				},
				witness: { matchedTargets: 2 },
				overlaps: [],
			},
			{
				tag: "second",
				passed: true,
				coverage: "structural",
				handlerCalls: { discover: 0, mutate: 1, finalize: 0 },
				overlaps: [],
			},
		],
		...overrides,
	};
}

test("extractPatchEvidence accepts direct manifests and dry-run summaries", () => {
	const direct = manifest();
	assert.deepEqual(extractPatchEvidence(direct), direct);
	assert.deepEqual(
		extractPatchEvidence({ result: { evidence: direct } }),
		direct,
	);
});

test("extractPatchEvidence rejects malformed and duplicate patch evidence", () => {
	assert.throws(
		() => extractPatchEvidence({ result: {} }),
		/does not contain patch evidence/i,
	);
	assert.throws(
		() =>
			extractPatchEvidence(
				manifest({
					patches: [manifest().patches[0], manifest().patches[0]],
				}),
			),
		/duplicate patch evidence tag/i,
	);
});

test("extractPatchEvidence validates bounded structured outcomes", () => {
	const direct = manifest();
	assert.deepEqual(extractPatchEvidence(direct).patches[0]?.outcomes, {
		matched: 2,
		mutated: 2,
		alreadySatisfied: 0,
		verified: 1,
		issues: [],
	});

	const malformed = manifest();
	malformed.patches[0] = {
		...malformed.patches[0],
		outcomes: {
			matched: 1,
			mutated: 1,
			alreadySatisfied: 1,
			verified: 1,
			issues: [],
		},
	};
	assert.throws(
		() => extractPatchEvidence(malformed),
		/mutated plus alreadySatisfied cannot exceed matched/,
	);
});

test("extractPatchEvidence accepts full-registry shared-node overlaps", () => {
	const overlapTags = Array.from(
		{ length: 29 },
		(_value, index) => `patch-${index}`,
	);
	const input = manifest({
		patches: [
			{
				...manifest().patches[0],
				overlaps: [
					{
						pass: "mutate",
						nodeType: "Program",
						tags: overlapTags,
						count: 1,
					},
				],
			},
		],
	});

	assert.deepEqual(
		extractPatchEvidence(input).patches[0]?.overlaps[0]?.tags,
		[...overlapTags].sort(),
	);
});

test("comparePatchEvidence reports bounded field-level release drift", () => {
	const previous = manifest();
	const current = manifest({
		sourceSha256: "c".repeat(64),
		outputSha256: "d".repeat(64),
		patches: [
			{
				tag: "first",
				passed: false,
				coverage: "semantic",
				handlerCalls: { discover: 1, mutate: 3, finalize: 0 },
				structuralHashes: {
					mutate: {
						beforeSha256: "e".repeat(64),
						afterSha256: "f".repeat(64),
					},
				},
				witness: { matchedTargets: 3, fallbackUsed: false },
				overlaps: [
					{
						pass: "mutate",
						nodeType: "CallExpression",
						tags: ["first", "third"],
						count: 1,
					},
				],
			},
			{
				tag: "third",
				passed: true,
				coverage: "verification",
				handlerCalls: { discover: 0, mutate: 0, finalize: 0 },
				overlaps: [],
			},
		],
	});

	const result = comparePatchEvidence(previous, current);

	assert.equal(result.sourceChanged, true);
	assert.equal(result.outputChanged, true);
	assert.equal(result.unchangedPatchCount, 0);
	assert.deepEqual(
		result.deltas.map((delta) => [delta.tag, delta.status]),
		[
			["first", "changed"],
			["second", "removed"],
			["third", "added"],
		],
	);
	assert.deepEqual(
		result.deltas[0]?.changes.map((change) => change.field),
		[
			"passed",
			"outcomes.matched",
			"outcomes.mutated",
			"outcomes.alreadySatisfied",
			"outcomes.verified",
			"outcomes.issues",
			"handlerCalls.mutate",
			"structuralHashes.mutate.beforeSha256",
			"structuralHashes.mutate.afterSha256",
			"witness.fallbackUsed",
			"witness.matchedTargets",
			"overlaps",
		],
	);
	assert.deepEqual(result.deltas[0]?.changes[0], {
		field: "passed",
		previous: true,
		current: false,
	});
	assert.match(
		String(
			result.deltas[0]?.changes.find((change) => change.field === "overlaps")
				?.current,
		),
		/^sha256:[a-f0-9]{64};count=1$/,
	);
});

test("comparePatchEvidence counts unchanged patches without emitting rows", () => {
	const result = comparePatchEvidence(manifest(), manifest());
	assert.equal(result.sourceChanged, false);
	assert.equal(result.outputChanged, false);
	assert.equal(result.unchangedPatchCount, 2);
	assert.deepEqual(result.deltas, []);
});

test("markdown comparison is deterministic and contains no raw source payload", () => {
	const previous = manifest();
	const current = manifest({
		patches: [
			{
				...manifest().patches[0],
				handlerCalls: { discover: 1, mutate: 3, finalize: 0 },
			},
			manifest().patches[1],
		],
	});
	const report = formatPatchEvidenceComparisonMarkdown(
		comparePatchEvidence(previous, current),
	);

	assert.match(report, /^# Patch Evidence Comparison/m);
	assert.match(report, /\| `first` \| changed \| `handlerCalls\.mutate` \|/);
	assert.doesNotMatch(report, /function\s*\(|raw source|bundle snippet/i);
});
