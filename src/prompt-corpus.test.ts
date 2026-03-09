import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildPromptCorpusDebug,
	buildPromptCorpusIdMap,
	buildPromptDataset,
	buildPromptDatasetFilename,
	buildPromptHashIndex,
	dedupeCorpusByRange,
	encodePlaceholderExpressions,
	isValidPromptText,
	type PromptCorpusEntry,
} from "./prompt-corpus.js";

test("isValidPromptText rejects short and accepts policy-style long text", () => {
	assert.equal(isValidPromptText("short text"), false);

	const longPrompt = `
You are an assistant that should always follow user instructions carefully.
You must explain what you are doing and should include enough detail for the user.
This sentence exists to ensure there are enough words and punctuation for validation.
`.repeat(12);
	assert.equal(isValidPromptText(longPrompt), true);
});

test("dedupeCorpusByRange removes nested subset ranges", () => {
	const entries: PromptCorpusEntry[] = [
		{
			kind: "string",
			text: "outer",
			pieces: ["outer"],
			placeholderExpressions: [],
			start: 10,
			end: 100,
		},
		{
			kind: "string",
			text: "inner",
			pieces: ["inner"],
			placeholderExpressions: [],
			start: 20,
			end: 80,
		},
		{
			kind: "string",
			text: "independent",
			pieces: ["independent"],
			placeholderExpressions: [],
			start: 120,
			end: 180,
		},
	];

	const deduped = dedupeCorpusByRange(entries);
	assert.equal(deduped.length, 2);
	assert.equal(
		deduped.some((entry) => entry.text === "outer"),
		true,
	);
	assert.equal(
		deduped.some((entry) => entry.text === "independent"),
		true,
	);
});

test("encodePlaceholderExpressions dedupes identical expressions and suffixes collisions", () => {
	const encoded = encodePlaceholderExpressions([
		"value_1()",
		"value_1()",
		"value 1()",
		"123bad",
	]);

	assert.deepEqual(encoded.identifiers, [0, 0, 1, 2]);
	assert.equal(encoded.identifierMap["0"], "VALUE_1");
	assert.equal(encoded.identifierMap["1"], "VALUE_1_2");
	assert.equal(encoded.identifierMap["2"], "EXPR_123BAD");
});

test("buildPromptDataset produces stable ids and compatible structure", () => {
	const baseEntry: PromptCorpusEntry = {
		kind: "template",
		text: "# Tone and style\nUse ${value_1()} and ${value_2}.",
		pieces: ["# Tone and style\nUse ", " and ", "."],
		placeholderExpressions: ["value_1()", "value_2"],
		start: 1,
		end: 200,
	};

	const duplicateEntry: PromptCorpusEntry = {
		...baseEntry,
		start: 300,
		end: 500,
	};

	const first = buildPromptDataset("2.1.63", [baseEntry, duplicateEntry]);
	const second = buildPromptDataset("2.1.63", [{ ...baseEntry, start: 999 }]);

	assert.equal(first.prompts.length, 1);
	assert.equal(first.prompts[0]?.id, second.prompts[0]?.id);
	assert.equal(first.prompts[0]?.name, "Tone and style");
	assert.deepEqual(first.prompts[0]?.identifiers, [0, 1]);
	assert.equal(first.prompts[0]?.identifierMap["0"], "VALUE_1");
	assert.equal(first.prompts[0]?.identifierMap["1"], "VALUE_2");
});

test("buildPromptHashIndex and debug output are deterministic", () => {
	const entries: PromptCorpusEntry[] = [
		{
			kind: "string",
			text: "You should always write tests and you must avoid regressions. ".repeat(
				20,
			),
			pieces: [
				"You should always write tests and you must avoid regressions. ".repeat(
					20,
				),
			],
			placeholderExpressions: [],
			start: 1,
			end: 500,
		},
		{
			kind: "string",
			text: "You should always write tests and you must avoid regressions. ".repeat(
				20,
			),
			pieces: [
				"You should always write tests and you must avoid regressions. ".repeat(
					20,
				),
			],
			placeholderExpressions: [],
			start: 700,
			end: 1200,
		},
	];

	const dataset = buildPromptDataset("2.1.63", entries);
	const idMap = buildPromptCorpusIdMap(entries);
	const hashIndexA = buildPromptHashIndex("2.1.63", dataset, idMap);
	const hashIndexB = buildPromptHashIndex("2.1.63", dataset, idMap);
	assert.equal(dataset.prompts.length, 1);
	assert.equal(hashIndexA.prompts.length, 1);
	assert.equal(idMap.size, 1);
	assert.equal(hashIndexA.datasetHash, hashIndexB.datasetHash);
	assert.equal(
		hashIndexA.prompts[0]?.textHash,
		hashIndexB.prompts[0]?.textHash,
	);

	const debug = buildPromptCorpusDebug(dataset, idMap);
	assert.equal(debug.length, 1);
	assert.equal(debug[0]?.id, dataset.prompts[0]?.id);
	assert.equal(buildPromptDatasetFilename("2.1.63"), "prompts-2-1-63.json");
});
