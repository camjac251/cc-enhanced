import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	comparePromptExportMatrix,
	formatPromptExportMatrixMarkdown,
} from "./prompt-export-matrix.js";

interface SyntheticPrompt {
	id: string;
	identifiers: number[];
	identifierMap: Record<string, string>;
	expressionHashMap?: Record<string, string>;
}

const EXPRESSION_HASH_A = "a".repeat(64);
const EXPRESSION_HASH_B = "b".repeat(64);

async function writeExport(
	root: string,
	version: string,
	surface: string,
	prompts: SyntheticPrompt[],
): Promise<void> {
	await fs.mkdir(root, { recursive: true });
	await fs.writeFile(path.join(root, "surface.md"), `${surface}\n`, "utf8");
	await fs.writeFile(
		path.join(root, "manifest.json"),
		`${JSON.stringify({ counts: { prompts: prompts.length } }, null, 2)}\n`,
		"utf8",
	);
	await fs.writeFile(
		path.join(root, "prompt-corpus.json"),
		`${JSON.stringify(
			{
				version,
				prompts: prompts.map((prompt) => ({
					name: "Synthetic prompt",
					id: prompt.id,
					description: "Synthetic prompt fixture",
					pieces: ["before", "after"],
					identifiers: prompt.identifiers,
					identifierMap: prompt.identifierMap,
					...(prompt.expressionHashMap
						? { expressionHashMap: prompt.expressionHashMap }
						: {}),
					version,
				})),
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
}

test("four-way prompt report distinguishes release drift from patch impact", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-matrix-"));
	const previousClean = path.join(tempDir, "previous-clean");
	const previousPatched = path.join(tempDir, "previous-patched");
	const currentClean = path.join(tempDir, "current-clean");
	const currentPatched = path.join(tempDir, "current-patched");
	const etcClaudeDir = path.join(tempDir, "etc-claude");
	const stableDependency = [
		{
			id: "prompt-stable",
			identifiers: [0],
			identifierMap: { "0": "USER_NAME" },
			expressionHashMap: { "0": EXPRESSION_HASH_A },
		},
	];
	try {
		await writeExport(
			previousClean,
			"1.0.0",
			"previous clean",
			stableDependency,
		);
		await writeExport(
			previousPatched,
			"1.0.0",
			"previous patched",
			stableDependency,
		);
		await writeExport(currentClean, "1.1.0", "current clean", stableDependency);
		await writeExport(currentPatched, "1.1.0", "current patched", [
			{
				id: "prompt-current",
				identifiers: [0, 1],
				identifierMap: { "0": "USER_NAME", "1": "TOOL_NAME" },
				expressionHashMap: {
					"0": EXPRESSION_HASH_A,
					"1": EXPRESSION_HASH_B,
				},
			},
		]);
		await fs.mkdir(etcClaudeDir, { recursive: true });
		await fs.writeFile(
			path.join(etcClaudeDir, "system-prompt.md"),
			"Runtime policy fixture.\n",
			"utf8",
		);

		const result = await comparePromptExportMatrix({
			previousCleanExportDir: previousClean,
			previousPatchedExportDir: previousPatched,
			currentCleanExportDir: currentClean,
			currentPatchedExportDir: currentPatched,
			etcClaudeDir,
			watchPaths: ["surface.md"],
		});

		assert.equal(result.comparisons.cleanRelease.files.changed >= 1, true);
		assert.equal(
			result.dependencyParity.cleanRelease.exactMultisetParity,
			true,
		);
		assert.equal(
			result.dependencyParity.previousPatchImpact.exactMultisetParity,
			true,
		);
		assert.equal(
			result.dependencyParity.currentPatchImpact.exactMultisetParity,
			false,
		);
		assert.equal(result.dependencyParity.currentPatchImpact.slotDelta, 1);
		assert.equal(
			result.dependencyParity.currentPatchImpact.addedSignatureCount,
			1,
		);
		assert.equal(
			result.dependencyParity.currentPatchImpact.removedSignatureCount,
			1,
		);

		const markdown = formatPromptExportMatrixMarkdown(result);
		assert.match(markdown, /^# Four-Way Prompt Export Comparison/m);
		assert.match(markdown, /Current patch impact/);
		assert.doesNotMatch(markdown, /USER_NAME|TOOL_NAME/);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("dependency analysis reports invalid references without exposing expressions", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "prompt-matrix-invalid-"),
	);
	const exports = [
		"previous-clean",
		"previous-patched",
		"current-clean",
		"current-patched",
	].map((name) => path.join(tempDir, name));
	const etcClaudeDir = path.join(tempDir, "etc-claude");
	try {
		for (const exportDir of exports) {
			await writeExport(exportDir, "1.0.0", "surface", [
				{
					id: "prompt-invalid",
					identifiers: [1],
					identifierMap: { "0": "PRIVATE_EXPRESSION" },
					expressionHashMap: { "0": EXPRESSION_HASH_A },
				},
			]);
		}
		await fs.mkdir(etcClaudeDir, { recursive: true });

		const result = await comparePromptExportMatrix({
			previousCleanExportDir: exports[0],
			previousPatchedExportDir: exports[1],
			currentCleanExportDir: exports[2],
			currentPatchedExportDir: exports[3],
			etcClaudeDir,
			watchPaths: ["surface.md"],
		});

		assert.equal(result.dependencies.previousClean.invalidReferenceCount, 1);
		assert.equal(result.dependencies.previousClean.unusedMappingCount, 1);
		assert.doesNotMatch(JSON.stringify(result), /PRIVATE_EXPRESSION/);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("dependency parity distinguishes expressions with the same display token", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "prompt-matrix-hash-collision-"),
	);
	const previousClean = path.join(tempDir, "previous-clean");
	const previousPatched = path.join(tempDir, "previous-patched");
	const currentClean = path.join(tempDir, "current-clean");
	const currentPatched = path.join(tempDir, "current-patched");
	const etcClaudeDir = path.join(tempDir, "etc-claude");
	const previousDependency = [
		{
			id: "prompt-collision",
			identifiers: [0],
			identifierMap: { "0": "ALPHA_BETA" },
			expressionHashMap: { "0": EXPRESSION_HASH_A },
		},
	];
	const currentDependency = [
		{
			id: "prompt-collision",
			identifiers: [0],
			identifierMap: { "0": "ALPHA_BETA" },
			expressionHashMap: { "0": EXPRESSION_HASH_B },
		},
	];
	try {
		await writeExport(
			previousClean,
			"1.0.0",
			"stable surface",
			previousDependency,
		);
		await writeExport(
			previousPatched,
			"1.0.0",
			"stable surface",
			previousDependency,
		);
		await writeExport(
			currentClean,
			"1.1.0",
			"stable surface",
			currentDependency,
		);
		await writeExport(
			currentPatched,
			"1.1.0",
			"stable surface",
			currentDependency,
		);
		await fs.mkdir(etcClaudeDir, { recursive: true });

		const result = await comparePromptExportMatrix({
			previousCleanExportDir: previousClean,
			previousPatchedExportDir: previousPatched,
			currentCleanExportDir: currentClean,
			currentPatchedExportDir: currentPatched,
			etcClaudeDir,
			watchPaths: ["surface.md"],
		});

		assert.equal(
			result.dependencyParity.cleanRelease.exactMultisetParity,
			false,
		);
		assert.equal(
			result.dependencyParity.previousPatchImpact.exactMultisetParity,
			true,
		);
		assert.equal(
			result.dependencyParity.currentPatchImpact.exactMultisetParity,
			true,
		);
		assert.doesNotMatch(JSON.stringify(result), /ALPHA_BETA/);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("legacy exports without expression hashes report unknown dependency parity", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "prompt-matrix-legacy-hashes-"),
	);
	const previousClean = path.join(tempDir, "previous-clean");
	const previousPatched = path.join(tempDir, "previous-patched");
	const currentClean = path.join(tempDir, "current-clean");
	const currentPatched = path.join(tempDir, "current-patched");
	const etcClaudeDir = path.join(tempDir, "etc-claude");
	const legacyDependency = [
		{
			id: "prompt-legacy",
			identifiers: [0],
			identifierMap: { "0": "ALPHA_BETA" },
		},
	];
	const currentDependency = [
		{
			id: "prompt-current",
			identifiers: [0],
			identifierMap: { "0": "ALPHA_BETA" },
			expressionHashMap: { "0": EXPRESSION_HASH_A },
		},
	];
	try {
		await writeExport(
			previousClean,
			"1.0.0",
			"stable surface",
			legacyDependency,
		);
		await writeExport(
			previousPatched,
			"1.0.0",
			"stable surface",
			legacyDependency,
		);
		await writeExport(
			currentClean,
			"1.1.0",
			"stable surface",
			currentDependency,
		);
		await writeExport(
			currentPatched,
			"1.1.0",
			"stable surface",
			currentDependency,
		);
		await fs.mkdir(etcClaudeDir, { recursive: true });

		const result = await comparePromptExportMatrix({
			previousCleanExportDir: previousClean,
			previousPatchedExportDir: previousPatched,
			currentCleanExportDir: currentClean,
			currentPatchedExportDir: currentPatched,
			etcClaudeDir,
			watchPaths: ["surface.md"],
		});

		assert.equal(result.dependencies.previousClean.hashCoverageComplete, false);
		assert.equal(result.dependencies.currentClean.hashCoverageComplete, true);
		assert.equal(result.dependencyParity.cleanRelease.coverageComplete, false);
		assert.equal(
			result.dependencyParity.cleanRelease.exactMultisetParity,
			false,
		);
		assert.match(formatPromptExportMatrixMarkdown(result), /\| unknown \|/);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});
