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

test("stock release matrix compares baseline and candidate exports and dependencies", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-matrix-"));
	const baselineExportDir = path.join(tempDir, "baseline");
	const candidateExportDir = path.join(tempDir, "candidate");
	const etcClaudeDir = path.join(tempDir, "etc-claude");
	try {
		await writeExport(baselineExportDir, "1.0.0", "baseline surface", [
			{
				id: "prompt-baseline",
				identifiers: [0],
				identifierMap: { "0": "USER_NAME" },
				expressionHashMap: { "0": EXPRESSION_HASH_A },
			},
		]);
		await writeExport(candidateExportDir, "1.1.0", "candidate surface", [
			{
				id: "prompt-candidate",
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
			baselineExportDir,
			candidateExportDir,
			etcClaudeDir,
			watchPaths: ["surface.md"],
		});

		assert.deepEqual(result.paths, {
			baselineExportDir,
			candidateExportDir,
			etcClaudeDir,
		});
		assert.equal(result.comparison.files.changed, 2);
		assert.equal(result.comparison.watchedSurfaces.changed, 1);
		assert.equal(result.dependencies.baseline.slotCount, 1);
		assert.equal(result.dependencies.candidate.slotCount, 2);
		assert.deepEqual(result.dependencyParity, {
			exactMultisetParity: false,
			coverageComplete: true,
			promptDelta: 0,
			templatedPromptDelta: 0,
			slotDelta: 1,
			addedSignatureCount: 1,
			removedSignatureCount: 1,
		});

		const markdown = formatPromptExportMatrixMarkdown(result);
		assert.match(markdown, /^# Stock Release Prompt Export Matrix/m);
		assert.match(markdown, /Baseline export:/);
		assert.match(markdown, /Candidate export:/);
		assert.match(
			markdown,
			/Stock release drift \| 2 \| 0 \| 0 \| 1 \| changed \| \+1 \| 1 \| 1/,
		);
		assert.doesNotMatch(markdown, /USER_NAME|TOOL_NAME/);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("dependency analysis reports invalid references without exposing expressions", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "prompt-matrix-invalid-"),
	);
	const baselineExportDir = path.join(tempDir, "baseline");
	const candidateExportDir = path.join(tempDir, "candidate");
	const etcClaudeDir = path.join(tempDir, "etc-claude");
	try {
		for (const exportDir of [baselineExportDir, candidateExportDir]) {
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
			baselineExportDir,
			candidateExportDir,
			etcClaudeDir,
		});

		for (const stats of [
			result.dependencies.baseline,
			result.dependencies.candidate,
		]) {
			assert.equal(stats.invalidReferenceCount, 1);
			assert.equal(stats.unusedMappingCount, 1);
		}
		assert.doesNotMatch(JSON.stringify(result), /PRIVATE_EXPRESSION/);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("dependency parity distinguishes expressions with the same display token", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "prompt-matrix-hash-collision-"),
	);
	const baselineExportDir = path.join(tempDir, "baseline");
	const candidateExportDir = path.join(tempDir, "candidate");
	const etcClaudeDir = path.join(tempDir, "etc-claude");
	try {
		for (const [exportDir, version, expressionHash] of [
			[baselineExportDir, "1.0.0", EXPRESSION_HASH_A],
			[candidateExportDir, "1.1.0", EXPRESSION_HASH_B],
		] as const) {
			await writeExport(exportDir, version, "stable surface", [
				{
					id: "prompt-collision",
					identifiers: [0],
					identifierMap: { "0": "ALPHA_BETA" },
					expressionHashMap: { "0": expressionHash },
				},
			]);
		}
		await fs.mkdir(etcClaudeDir, { recursive: true });

		const result = await comparePromptExportMatrix({
			baselineExportDir,
			candidateExportDir,
			etcClaudeDir,
		});

		assert.equal(result.dependencyParity.exactMultisetParity, false);
		assert.equal(result.dependencyParity.coverageComplete, true);
		assert.equal(result.dependencyParity.slotDelta, 0);
		assert.equal(result.dependencyParity.addedSignatureCount, 1);
		assert.equal(result.dependencyParity.removedSignatureCount, 1);
		assert.doesNotMatch(JSON.stringify(result), /ALPHA_BETA/);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("prompt export comparison rejects corpora without expression hashes", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "prompt-matrix-hashless-corpus-"),
	);
	const baselineExportDir = path.join(tempDir, "baseline");
	const candidateExportDir = path.join(tempDir, "candidate");
	const etcClaudeDir = path.join(tempDir, "etc-claude");
	try {
		await writeExport(baselineExportDir, "1.0.0", "stable surface", [
			{
				id: "prompt-hashless",
				identifiers: [0],
				identifierMap: { "0": "ALPHA_BETA" },
			},
		]);
		await writeExport(candidateExportDir, "1.1.0", "stable surface", [
			{
				id: "prompt-candidate",
				identifiers: [0],
				identifierMap: { "0": "ALPHA_BETA" },
				expressionHashMap: { "0": EXPRESSION_HASH_A },
			},
		]);
		await fs.mkdir(etcClaudeDir, { recursive: true });

		await assert.rejects(
			() =>
				comparePromptExportMatrix({
					baselineExportDir,
					candidateExportDir,
					etcClaudeDir,
				}),
			/missing expressionHashMap/,
		);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("dependency parity preserves signature multiplicity without depending on display labels", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "prompt-matrix-parity-"),
	);
	const baselineExportDir = path.join(tempDir, "baseline");
	const candidateExportDir = path.join(tempDir, "candidate");
	const etcClaudeDir = path.join(tempDir, "etc-claude");
	try {
		for (const [exportDir, displayToken] of [
			[baselineExportDir, "BASELINE_LABEL"],
			[candidateExportDir, "CANDIDATE_LABEL"],
		] as const) {
			await writeExport(
				exportDir,
				"1.0.0",
				"stable surface",
				["first", "second"].map((id) => ({
					id,
					identifiers: [0],
					identifierMap: { "0": displayToken },
					expressionHashMap: { "0": EXPRESSION_HASH_A },
				})),
			);
		}
		await fs.mkdir(etcClaudeDir, { recursive: true });

		const result = await comparePromptExportMatrix({
			baselineExportDir,
			candidateExportDir,
			etcClaudeDir,
		});

		assert.equal(result.dependencyParity.exactMultisetParity, true);
		assert.equal(result.dependencyParity.coverageComplete, true);
		assert.equal(result.dependencies.baseline.uniqueSignatureCount, 1);
		assert.deepEqual(
			Object.values(result.dependencies.baseline.signatureCounts),
			[2],
		);
		assert.deepEqual(
			result.dependencies.baseline.signatureCounts,
			result.dependencies.candidate.signatureCounts,
		);
		assert.match(
			formatPromptExportMatrixMarkdown(result),
			/Stock release drift \| 1 \| 0 \| 0 \| 0 \| exact \| 0 \| 0 \| 0/,
		);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("matrix rejects invalid corpus schemas and expression hash mappings", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "prompt-matrix-schema-"),
	);
	const baselineExportDir = path.join(tempDir, "baseline");
	const candidateExportDir = path.join(tempDir, "candidate");
	const etcClaudeDir = path.join(tempDir, "etc-claude");
	const invalidCases: { corpus: unknown; message: RegExp }[] = [
		{
			corpus: { prompts: null },
			message: /Invalid prompt corpus schema/,
		},
		{
			corpus: {
				prompts: [
					{
						identifiers: [0],
						identifierMap: { "0": "VALUE" },
						expressionHashMap: { "0": "invalid-hash" },
					},
				],
			},
			message: /invalid expression hash/,
		},
		{
			corpus: {
				prompts: [
					{
						identifiers: [0],
						identifierMap: { "0": "VALUE" },
						expressionHashMap: {},
					},
				],
			},
			message: /identifier and expression hash mappings differ/,
		},
	];
	try {
		await writeExport(baselineExportDir, "1.0.0", "surface", []);
		await writeExport(candidateExportDir, "1.1.0", "surface", []);
		await fs.mkdir(etcClaudeDir, { recursive: true });
		for (const { corpus, message } of invalidCases) {
			await fs.writeFile(
				path.join(candidateExportDir, "prompt-corpus.json"),
				JSON.stringify(corpus),
				"utf8",
			);
			await assert.rejects(
				() =>
					comparePromptExportMatrix({
						baselineExportDir,
						candidateExportDir,
						etcClaudeDir,
					}),
				message,
			);
		}
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("missing prompt corpora report unknown dependency parity instead of exact parity", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "prompt-matrix-missing-"),
	);
	const baselineExportDir = path.join(tempDir, "baseline");
	const candidateExportDir = path.join(tempDir, "candidate");
	const etcClaudeDir = path.join(tempDir, "etc-claude");
	try {
		await writeExport(baselineExportDir, "1.0.0", "surface", []);
		await writeExport(candidateExportDir, "1.1.0", "surface", []);
		await fs.rm(path.join(candidateExportDir, "prompt-corpus.json"));
		await fs.mkdir(etcClaudeDir, { recursive: true });

		const result = await comparePromptExportMatrix({
			baselineExportDir,
			candidateExportDir,
			etcClaudeDir,
		});

		assert.equal(result.dependencies.baseline.hashCoverageComplete, true);
		assert.equal(result.dependencies.candidate.present, false);
		assert.equal(result.dependencies.candidate.hashCoverageComplete, false);
		assert.equal(result.dependencyParity.coverageComplete, false);
		assert.equal(result.dependencyParity.exactMultisetParity, false);
		assert.match(
			formatPromptExportMatrixMarkdown(result),
			/Stock release drift \| 0 \| 0 \| 1 \| 0 \| unknown \| 0 \| 0 \| 0/,
		);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});
