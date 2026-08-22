import assert from "node:assert/strict";
import { test } from "node:test";
import { Manager } from "./manager.js";
import type { ResolvedPatchSelection } from "./patching/selection.js";
import type { Patch } from "./types.js";

type RunnerInternals = {
	injectSignature: boolean;
	patches: Patch[];
};

function inspectRunner(manager: Manager, nativeMode: boolean): RunnerInternals {
	return (
		manager as unknown as {
			buildRunner(nativeMode?: boolean): RunnerInternals;
		}
	).buildRunner(nativeMode);
}

test("manager builds runners from its explicit patch selection", () => {
	const selectedPatch: Patch = { tag: "selected", verify: () => true };
	const selection: ResolvedPatchSelection = {
		patches: [selectedPatch],
		receipt: {
			name: "cli-full",
			surface: "cli",
			selectedTags: [selectedPatch.tag],
			exclusions: [],
			requiredProbes: [],
		},
	};
	const manager = new Manager({ patchSelection: selection });

	const localRunner = inspectRunner(manager, false);
	const nativeRunner = inspectRunner(manager, true);

	assert.deepEqual(
		localRunner.patches.map((patch) => patch.tag),
		["selected"],
	);
	assert.equal(localRunner.injectSignature, false);
	assert.deepEqual(
		nativeRunner.patches.map((patch) => patch.tag),
		["selected"],
	);
	assert.equal(nativeRunner.injectSignature, true);
});
