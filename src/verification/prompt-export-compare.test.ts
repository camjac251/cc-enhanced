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
	const baseDir = path.join(tempDir, "base");
	const patchedDir = path.join(tempDir, "patched");
	const etcDir = path.join(tempDir, "etc");
	try {
		await writeFile(
			baseDir,
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
			patchedDir,
			"manifest.json",
			JSON.stringify({
				counts: {
					agents: 2,
					builtInTools: 3,
					nested: { promptCorpus: 10 },
				},
			}),
		);
		await writeFile(baseDir, "agents/explore.md", "legacy explore\n");
		await writeFile(
			baseDir,
			"agents/dream.md",
			"Perform a dream — prune memories from the last 1–3 days.\n",
		);
		await writeFile(
			patchedDir,
			"agents/explore.md",
			"Use Serena and ChunkHound before rg for code.\nShared managed policy line for overlap.\n",
		);
		await writeFile(baseDir, "system/sections/using-your-tools.md", "same\n");
		await writeFile(
			patchedDir,
			"system/sections/using-your-tools.md",
			"same\n",
		);
		await writeFile(baseDir, "tools/builtin/bash.md", "removed\n");
		await writeFile(patchedDir, "system/builder-outline.md", "added\n");
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
			baseExportDir: baseDir,
			patchedExportDir: patchedDir,
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

		assert.equal(result.files.baseFiles, 5);
		assert.equal(result.files.patchedFiles, 4);
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
				delta.base,
				delta.patched,
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

		assert.equal(result.unicodeDashStyle.base.filesWithDashes, 1);
		assert.equal(result.unicodeDashStyle.base.enDash, 1);
		assert.equal(result.unicodeDashStyle.base.emDash, 1);
		assert.equal(result.unicodeDashStyle.base.total, 2);
		assert.equal(result.unicodeDashStyle.patched.total, 0);
		assert.deepEqual(result.unicodeDashStyle.changedFiles, [
			{
				file: "agents/dream.md",
				base: { enDash: 1, emDash: 1, total: 2 },
				patched: { enDash: 0, emDash: 0, total: 0 },
				delta: { enDash: -1, emDash: -1, total: -2 },
			},
		]);

		assert.equal(result.etcLayer.files.length, 2);
		assert.equal(result.etcLayer.totalExactLinesInPatchedExport, 1);
		assert.ok(
			result.policyTerms.some(
				(term) => term.id === "serena" && term.patchedExportFiles === 1,
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
		assert.match(markdown, /Unicode Dash Style/);
		assert.match(markdown, /En dash characters \| 1 \| 0 \| -1/);
		assert.match(markdown, /Em dash characters \| 1 \| 0 \| -1/);
		assert.match(markdown, /Total Unicode dash punctuation \| 2 \| 0 \| -2/);
		assert.match(markdown, /`agents\/dream\.md` \| 2 \| 0 \| -2/);
		assert.match(markdown, /Exact \/etc lines found in patched export: 1\./);
		assert.match(markdown, /Watched Prompt Surfaces/);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});
