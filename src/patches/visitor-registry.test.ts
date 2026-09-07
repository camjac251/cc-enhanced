import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "../loader.js";
import { allPatches } from "./index.js";
import {
	generateSharedVisitorPairInventory,
	SHARED_VISITOR_FAMILIES,
} from "./patch-scenario.js";

// Validate supported pass names and the generated behavioral interaction cases.
// Concrete visitor placements remain implementation details.

async function collectVisitorKinds(): Promise<Record<string, string[]>> {
	const ast = parse("const x = 1;");
	const registry: Record<string, string[]> = {};
	for (const patch of allPatches) {
		if (!patch.astPasses) continue;
		const passes = (await patch.astPasses(ast)) ?? [];
		const kinds = new Set<string>();
		for (const { pass, visitor } of passes) {
			for (const key of Object.keys(visitor ?? {})) {
				kinds.add(key === "Program" ? `${pass}:Program` : `${pass}:${key}`);
			}
		}
		registry[patch.tag] = [...kinds].sort();
	}
	return registry;
}

test("no patch registers a visitor for a retired or renamed pass", async () => {
	const registry = await collectVisitorKinds();
	const validPasses = new Set(["discover", "mutate", "finalize"]);
	for (const [tag, kinds] of Object.entries(registry)) {
		for (const kind of kinds) {
			const pass = kind.split(":")[0];
			assert.ok(
				validPasses.has(pass),
				`Patch ${tag} registers a visitor in unknown pass "${pass}"`,
			);
		}
	}
});

test("selected shared families generate canonical pairs and declared reverse cases only", async () => {
	const inventory = await generateSharedVisitorPairInventory(
		allPatches,
		SHARED_VISITOR_FAMILIES,
	);
	assert.deepEqual(
		inventory.map(({ patchTags, order }) => ({ patchTags, order })),
		[
			{
				patchTags: ["skill-paths-invoke", "skill-activation-notice"],
				order: "canonical",
			},
			{
				patchTags: ["skill-activation-notice", "skill-paths-invoke"],
				order: "reverse",
			},
		],
	);
});
