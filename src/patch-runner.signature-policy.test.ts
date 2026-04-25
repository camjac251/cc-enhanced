import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Manager } from "./manager.js";
import { PatchRunner } from "./patch-runner.js";
import { allPatches, signature } from "./patches/index.js";
import type { Patch } from "./types.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

type RunnerInternals = {
	injectSignature: boolean;
	patches: Patch[];
};

function inspectRunner(runner: PatchRunner): RunnerInternals {
	return runner as unknown as RunnerInternals;
}

async function loadPatchTagsWithEnv(
	env: Record<string, string>,
): Promise<string[]> {
	const script = [
		'import { allPatches } from "./src/patches/index.ts";',
		"console.log(JSON.stringify(allPatches.map((p) => p.tag)));",
	].join("");
	const childEnv: NodeJS.ProcessEnv = { ...process.env };
	delete childEnv.CLAUDE_PATCHER_INCLUDE_TAGS;
	delete childEnv.CLAUDE_PATCHER_EXCLUDE_TAGS;
	const { stdout } = await execFileAsync(
		process.execPath,
		["--eval", script],
		{
			cwd: repoRoot,
			env: {
				...childEnv,
				...env,
			},
			encoding: "utf-8",
		},
	);
	const lines = stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	assert.ok(lines.length > 0, "expected subprocess output");
	return JSON.parse(lines.at(-1) ?? "[]") as string[];
}

test("default runner auto-injects signature when signature patch is selected", () => {
	const runner = inspectRunner(new PatchRunner());
	assert.equal(runner.injectSignature, true);
	assert.equal(
		runner.patches.some((patch) => patch.tag === signature.tag),
		false,
	);
});

test("signature policy off disables injection even when signature is selected", () => {
	const runner = inspectRunner(
		new PatchRunner(undefined, { signaturePolicy: "off" }),
	);
	assert.equal(runner.injectSignature, false);
});

test("signature policy force injects even when signature is not selected", () => {
	const patchesWithoutSignature = allPatches.filter(
		(patch) => patch.tag !== signature.tag,
	);
	const runner = inspectRunner(
		new PatchRunner(patchesWithoutSignature, { signaturePolicy: "force" }),
	);
	assert.equal(runner.injectSignature, true);
});

test("signature policy auto follows selected patch set", () => {
	const patchesWithoutSignature = allPatches.filter(
		(patch) => patch.tag !== signature.tag,
	);
	const autoWithoutSignature = inspectRunner(
		new PatchRunner(patchesWithoutSignature, { signaturePolicy: "auto" }),
	);
	assert.equal(autoWithoutSignature.injectSignature, false);

	const withSignatureSelected = inspectRunner(
		new PatchRunner([signature], { signaturePolicy: "auto" }),
	);
	assert.equal(withSignatureSelected.injectSignature, true);
});

test("legacy injectSignature option still maps to force/off policy", () => {
	const patchesWithoutSignature = allPatches.filter(
		(patch) => patch.tag !== signature.tag,
	);
	const forceRunner = inspectRunner(
		new PatchRunner(patchesWithoutSignature, { injectSignature: true }),
	);
	const offRunner = inspectRunner(
		new PatchRunner([signature], { injectSignature: false }),
	);
	assert.equal(forceRunner.injectSignature, true);
	assert.equal(offRunner.injectSignature, false);
});

test("manager forces signature injection in native mode", () => {
	const manager = new Manager({});
	const nativeRunner = inspectRunner(
		(
			manager as unknown as {
				buildRunner: (nativeMode?: boolean) => PatchRunner;
			}
		).buildRunner(true),
	);
	const localRunner = inspectRunner(
		(
			manager as unknown as {
				buildRunner: (nativeMode?: boolean) => PatchRunner;
			}
		).buildRunner(false),
	);

	assert.equal(nativeRunner.injectSignature, true);
	assert.equal(localRunner.injectSignature, true);
	assert.equal(
		nativeRunner.patches.some((patch) => patch.tag === signature.tag),
		false,
	);
});

test("include/exclude env tags keep signature selection deterministic", async () => {
	const includeOnlySignature = await loadPatchTagsWithEnv({
		CLAUDE_PATCHER_INCLUDE_TAGS: "signature",
		CLAUDE_PATCHER_EXCLUDE_TAGS: "",
	});
	assert.deepEqual(includeOnlySignature, ["signature"]);

	const excludeSignature = await loadPatchTagsWithEnv({
		CLAUDE_PATCHER_INCLUDE_TAGS: "",
		CLAUDE_PATCHER_EXCLUDE_TAGS: "signature",
	});
	assert.equal(excludeSignature.includes("signature"), false);
	assert.ok(excludeSignature.length > 0);
});
