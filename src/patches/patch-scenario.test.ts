import assert from "node:assert/strict";
import { test } from "node:test";
import type { Patch } from "../types.js";
import {
	generateSharedVisitorPairInventory,
	PATCH_SCENARIO_KINDS,
	runPatchScenarioPair,
	runPatchScenarioSuite,
	validatePatchScenarioSuite,
} from "./patch-scenario.js";

function functionVisitorPatch(tag: string): Patch {
	return {
		tag,
		astPasses: () => [
			{
				pass: "mutate",
				visitor: { Function() {} },
			},
		],
		verify: () => true,
	};
}

test("scenario suites require every standardized case with bounded diagnostics", () => {
	const scenarios = PATCH_SCENARIO_KINDS.filter(
		(kind) => kind !== "sibling-mutation",
	).map((kind) => ({
		kind,
		source: "const fixture = true;",
		expected: { verifications: {} },
	}));

	assert.throws(
		() =>
			validatePatchScenarioSuite({
				name: "example interaction",
				patchTags: ["first-patch", "second-patch"],
				scenarios,
			}),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /example interaction/);
			assert.match(error.message, /missing sibling-mutation/);
			assert.match(error.message, /first-patch, second-patch/);
			assert.ok(error.message.length <= 240);
			assert.equal(error.message.includes("const fixture"), false);
			return true;
		},
	);
});

test("complete scenario suites accept all standardized cases", () => {
	assert.doesNotThrow(() =>
		validatePatchScenarioSuite({
			name: "complete interaction",
			patchTags: ["first-patch", "second-patch"],
			scenarios: PATCH_SCENARIO_KINDS.map((kind) => ({
				kind,
				source: "const fixture = true;",
				expected: {
					verifications: {
						"first-patch": "pass",
						"second-patch": "pass",
					},
				},
			})),
		}),
	);
});

test("shared visitor pairs require explicit interaction declarations", async () => {
	await assert.rejects(
		generateSharedVisitorPairInventory(
			[
				functionVisitorPatch("first-patch"),
				functionVisitorPatch("second-patch"),
			],
			[
				{
					name: "example functions",
					visitorKeys: ["Function"],
					patchTags: ["first-patch", "second-patch"],
					pairs: [],
				},
			],
		),
		/lacks an interaction declaration for first-patch, second-patch/,
	);
});

test("canonical-only pairs require a semantic order reason", async () => {
	await assert.rejects(
		generateSharedVisitorPairInventory(
			[
				functionVisitorPatch("first-patch"),
				functionVisitorPatch("second-patch"),
			],
			[
				{
					name: "example functions",
					visitorKeys: ["Function"],
					patchTags: ["first-patch", "second-patch"],
					pairs: [
						{
							patchTags: ["first-patch", "second-patch"],
							order: "canonical-only",
						},
					],
				},
			],
		),
		/intentional order dependency without a reason/,
	);
});

test("scenario suite runner executes every standardized case", async () => {
	let executions = 0;
	const patches = [
		{
			...functionVisitorPatch("first-patch"),
			astPasses: () => {
				executions += 1;
				return [];
			},
		},
		functionVisitorPatch("second-patch"),
	];
	const result = await runPatchScenarioSuite(
		{
			name: "executable interaction",
			patchTags: patches.map(({ tag }) => tag),
			scenarios: PATCH_SCENARIO_KINDS.map((kind) => ({
				kind,
				source: `const fixture = "${kind}";`,
				expected: {
					verifications: {
						"first-patch": "pass",
						"second-patch": "pass",
					},
					outputIncludes: [kind],
				},
			})),
		},
		patches,
	);

	assert.equal(executions, PATCH_SCENARIO_KINDS.length);
	assert.deepEqual(
		result.cases.map(({ kind }) => kind),
		PATCH_SCENARIO_KINDS,
	);
});

test("scenario suite runner rejects a wrong expected outcome", async () => {
	const failingPatch: Patch = {
		...functionVisitorPatch("second-patch"),
		verify: () => "synthetic verification failure",
	};
	await assert.rejects(
		runPatchScenarioSuite(
			{
				name: "mismatched interaction",
				patchTags: ["first-patch", "second-patch"],
				scenarios: PATCH_SCENARIO_KINDS.map((kind) => ({
					kind,
					source: "const fixture = true;",
					expected: {
						verifications: {
							"first-patch": "pass",
							"second-patch": "pass",
						},
					},
				})),
			},
			[functionVisitorPatch("first-patch"), failingPatch],
		),
		/mismatched interaction case positive expected second-patch pass but got fail/,
	);
});

test("pair results never expose raw verifier failures", async () => {
	const sensitive = "internalIdentifier42 from private/source/module.ts";
	const failingPatch: Patch = {
		...functionVisitorPatch("second-patch"),
		verify: () => sensitive,
	};
	const result = await runPatchScenarioPair({
		name: "sanitized interaction",
		source: "const fixture = true;",
		patches: [functionVisitorPatch("first-patch"), failingPatch],
	});

	assert.deepEqual(result.verifications, [
		{ tag: "first-patch", status: "pass" },
		{ tag: "second-patch", status: "fail" },
	]);
	assert.match(result.diagnostic, /sanitized interaction/);
	assert.match(result.diagnostic, /second-patch failed/);
	assert.equal(JSON.stringify(result).includes(sensitive), false);
	assert.equal(JSON.stringify(result).includes("fixture"), false);
});
