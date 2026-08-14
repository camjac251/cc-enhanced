import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "../loader.js";
import { allPatches } from "./index.js";
import {
	generateSharedVisitorPairInventory,
	SHARED_VISITOR_FAMILIES,
} from "./patch-scenario.js";

// Drift sentinel for the maintainer reference's "Shared visitor kinds" table.
// It records the top-level visitor node kinds each patch exposes per pass to the
// combined-pass engine. Program-hook work is folded into a single "Program"
// marker because a patch that traverses inside Program.exit runs its own private
// traversal and does not collide through merged per-node dispatch. When this
// snapshot changes, update the shared-visitor rows in the same change: the table
// is only trustworthy if it mirrors what the engine actually merges.

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

// Each row is a node-kind family (the Babel `Function` alias fires on every
// function node, so a `Function` visitor and a `FunctionDeclaration` visitor
// collide on the same node) mapped to the patches whose mutate-pass visitor
// object exposes a key in that family. Mirrors the maintainer reference table.
// Patches that only touch these kinds inside Program.exit are absent.
const MUTATE_SHARED_KINDS: { row: string; keys: string[]; tags: string[] }[] = [
	{
		row: "IfStatement",
		keys: ["IfStatement"],
		tags: [
			"plan-diff-ui",
			"plan-compact-execute",
			"session-mem",
			"no-collapse",
			"sys-prompt-file",
			"effort-stack",
		],
	},
	{
		row: "Function family",
		keys: ["Function", "FunctionDeclaration", "FunctionExpression"],
		tags: [
			"bash-prompt",
			"cache-tail-policy",
			"effort-stack",
			"no-autoupdate",
			"agents-off",
			"skill-paths-invoke",
			"skill-activation-notice",
			"plan-compact-execute",
		],
	},
	{
		row: "ObjectExpression",
		keys: ["ObjectExpression"],
		tags: [
			"tools-off",
			"commands-off",
			"image-limits",
			"plan-compact-execute",
			"taskout-ext",
			"effort-stack",
			"skill-global-paths",
		],
	},
];

test("shared mutate-pass visitor rows match live patch registrations", async () => {
	const registry = await collectVisitorKinds();
	for (const { row, keys, tags } of MUTATE_SHARED_KINDS) {
		const wanted = new Set(keys.map((key) => `mutate:${key}`));
		const actual = Object.entries(registry)
			.filter(([, kinds]) => kinds.some((kind) => wanted.has(kind)))
			.map(([tag]) => tag)
			.sort();
		assert.deepEqual(
			actual,
			[...tags].sort(),
			`Patches registering a mutate-pass ${row} visitor changed. Update MUTATE_SHARED_KINDS here and the maintainer reference Shared visitor kinds table together. Live set: ${actual.join(", ")}`,
		);
	}
});

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
