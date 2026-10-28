import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	comparePromptExports,
	formatPromptExportComparisonMarkdown,
} from "./prompt-export-compare.js";

async function writeFile(
	root: string,
	relativePath: string,
	content: string,
): Promise<void> {
	const fullPath = path.join(root, relativePath);
	await fs.mkdir(path.dirname(fullPath), { recursive: true });
	await fs.writeFile(fullPath, content, "utf8");
}

test("comparePromptExports reports inventory, manifests, watched surfaces, and /etc overlap", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-compare-"));
	const baselineDir = path.join(tempDir, "baseline");
	const candidateDir = path.join(tempDir, "candidate");
	const etcDir = path.join(tempDir, "etc");
	try {
		await writeFile(
			baselineDir,
			"manifest.json",
			JSON.stringify({
				counts: {
					agents: 1,
					builtInTools: 4,
					nested: { promptCorpus: 10 },
				},
			}),
		);
		await writeFile(
			candidateDir,
			"manifest.json",
			JSON.stringify({
				counts: {
					agents: 2,
					builtInTools: 3,
					nested: { promptCorpus: 10 },
				},
			}),
		);
		await writeFile(baselineDir, "agents/explore.md", "baseline explore\n");
		await writeFile(
			baselineDir,
			"agents/dream.md",
			"Perform a dream — prune memories from the last 1–3 days.\n",
		);
		await writeFile(
			candidateDir,
			"agents/explore.md",
			"Serena and ChunkHound provide code context.\nShared managed policy line for overlap.\n",
		);
		await writeFile(
			baselineDir,
			"system/sections/using-your-tools.md",
			"same\n",
		);
		await writeFile(
			candidateDir,
			"system/sections/using-your-tools.md",
			"same\n",
		);
		await writeFile(baselineDir, "tools/builtin/bash.md", "removed\n");
		await writeFile(candidateDir, "system/builder-outline.md", "added\n");
		await writeFile(
			etcDir,
			"system-prompt.md",
			"Shared managed policy line for overlap.\nUnique runtime policy line that stays out of exports.\n",
		);
		await writeFile(
			etcDir,
			".claude/rules/mcp-reference.md",
			"Probe and MCP routing live here.\n",
		);

		const result = await comparePromptExports({
			baselineExportDir: baselineDir,
			candidateExportDir: candidateDir,
			etcClaudeDir: etcDir,
			watchPaths: [
				"agents/explore.md",
				"system/sections/using-your-tools.md",
				"tools/builtin/bash.md",
				"system/builder-outline.md",
				"missing.md",
			],
			minOverlapLineLength: 20,
		});

		assert.equal(result.baselineExportDir, baselineDir);
		assert.equal(result.candidateExportDir, candidateDir);
		assert.equal(result.files.baselineFiles, 5);
		assert.equal(result.files.candidateFiles, 4);
		assert.equal(result.files.changed, 2);
		assert.equal(result.files.added, 1);
		assert.equal(result.files.removed, 2);
		assert.equal(result.files.changedByTopLevel.agents, 1);
		assert.equal(result.files.addedByTopLevel.system, 1);
		assert.equal(result.files.removedByTopLevel.agents, 1);
		assert.equal(result.files.removedByTopLevel.tools, 1);

		assert.deepEqual(
			result.manifest.countDeltas.map((delta) => [
				delta.key,
				delta.baseline,
				delta.candidate,
				delta.delta,
			]),
			[
				["counts.agents", 1, 2, 1],
				["counts.builtInTools", 4, 3, -1],
			],
		);

		assert.equal(result.watchedSurfaces.changed, 1);
		assert.equal(result.watchedSurfaces.unchanged, 1);
		assert.equal(result.watchedSurfaces.removed, 1);
		assert.equal(result.watchedSurfaces.added, 1);
		assert.equal(result.watchedSurfaces.missing, 1);

		assert.equal(result.unicodeDashStyle.baseline.filesWithDashes, 1);
		assert.equal(result.unicodeDashStyle.baseline.enDash, 1);
		assert.equal(result.unicodeDashStyle.baseline.emDash, 1);
		assert.equal(result.unicodeDashStyle.baseline.total, 2);
		assert.equal(result.unicodeDashStyle.candidate.total, 0);
		assert.deepEqual(result.unicodeDashStyle.changedFiles, [
			{
				file: "agents/dream.md",
				baseline: { enDash: 1, emDash: 1, total: 2 },
				candidate: { enDash: 0, emDash: 0, total: 0 },
				delta: { enDash: -1, emDash: -1, total: -2 },
			},
		]);

		assert.equal(result.etcLayer.files.length, 2);
		assert.equal(result.etcLayer.totalExactLinesInCandidateExport, 1);
		assert.ok(
			result.policyTerms.some(
				(term) => term.id === "serena" && term.candidateExportFiles === 1,
			),
		);
		assert.ok(
			result.policyTerms.some(
				(term) => term.id === "probe" && term.etcFiles === 1,
			),
		);

		const markdown = formatPromptExportComparisonMarkdown(result, {
			sampleLimit: 5,
		});
		assert.match(markdown, /# Prompt Export Comparison/);
		assert.match(markdown, /Baseline export:/);
		assert.match(markdown, /Candidate export:/);
		assert.match(markdown, /Unicode Dash Style/);
		assert.match(markdown, /En dash characters \| 1 \| 0 \| -1/);
		assert.match(markdown, /Em dash characters \| 1 \| 0 \| -1/);
		assert.match(markdown, /Total Unicode dash punctuation \| 2 \| 0 \| -2/);
		assert.match(markdown, /`agents\/dream\.md` \| 2 \| 0 \| -2/);
		assert.match(markdown, /Exact \/etc lines found in candidate export: 1\./);
		assert.match(markdown, /Watched Prompt Surfaces/);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("comparePromptExports discovers stock Markdown watch paths in both exports", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-watch-"));
	const baselineExportDir = path.join(tempDir, "baseline");
	const candidateExportDir = path.join(tempDir, "candidate");
	const etcClaudeDir = path.join(tempDir, "etc");
	try {
		await writeFile(baselineExportDir, "agents/stable.md", "same\n");
		await writeFile(candidateExportDir, "agents/stable.md", "same\n");
		await writeFile(baselineExportDir, "new-category/changed.md", "first\n");
		await writeFile(candidateExportDir, "new-category/changed.md", "other\n");
		await writeFile(baselineExportDir, "system/removed.md", "removed\n");
		await writeFile(candidateExportDir, "tools/added.MD", "added\n");
		await writeFile(baselineExportDir, "metadata.json", '{"value":1}');
		await writeFile(candidateExportDir, "metadata.json", '{"value":2}');
		await fs.mkdir(etcClaudeDir, { recursive: true });

		const result = await comparePromptExports({
			baselineExportDir,
			candidateExportDir,
			etcClaudeDir,
		});

		assert.deepEqual(result.watchedSurfaces, {
			total: 4,
			unchanged: 1,
			changed: 1,
			added: 1,
			removed: 1,
			missing: 0,
			surfaces: [
				{ file: "agents/stable.md", status: "unchanged" },
				{ file: "new-category/changed.md", status: "changed" },
				{ file: "system/removed.md", status: "removed" },
				{ file: "tools/added.MD", status: "added" },
			],
		});
		assert.deepEqual(result.files.changedFiles, [
			"metadata.json",
			"new-category/changed.md",
		]);
		assert.equal(result.manifest.baselinePresent, false);
		assert.equal(result.manifest.candidatePresent, false);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("comparePromptExports honors an explicitly empty watch list", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-no-watch-"));
	const baselineExportDir = path.join(tempDir, "baseline");
	const candidateExportDir = path.join(tempDir, "candidate");
	const etcClaudeDir = path.join(tempDir, "etc");
	try {
		await writeFile(baselineExportDir, "surface.md", "before\n");
		await writeFile(candidateExportDir, "surface.md", "after\n");
		await fs.mkdir(etcClaudeDir, { recursive: true });

		const result = await comparePromptExports({
			baselineExportDir,
			candidateExportDir,
			etcClaudeDir,
			watchPaths: [],
		});

		assert.equal(result.files.changed, 1);
		assert.equal(result.watchedSurfaces.total, 0);
		assert.deepEqual(result.watchedSurfaces.surfaces, []);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});
