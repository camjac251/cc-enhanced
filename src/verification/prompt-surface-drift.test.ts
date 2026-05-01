import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	createPromptSurfaceDriftBaseline,
	hashPromptSurfaceContent,
	normalizePromptSurfaceContent,
	verifyPromptSurfaceDrift,
} from "./prompt-surface-drift.js";
import {
	PROMPT_SURFACE_DRIFT_PATHS,
	PROMPT_SURFACE_REVIEW_PATHS,
} from "./prompt-surface-rules.js";

async function writeSurface(
	root: string,
	relativePath: string,
	content: string,
): Promise<void> {
	const fullPath = path.join(root, relativePath);
	await fs.mkdir(path.dirname(fullPath), { recursive: true });
	await fs.writeFile(fullPath, content, "utf8");
}

test("normalizePromptSurfaceContent ignores generated symbol and placeholder churn", () => {
	const first = [
		"# Tool: Bash",
		"- source_symbol: a",
		"Use ${value_861} and ${expr_22}.",
	].join("\n");
	const second = [
		"# Tool: Bash",
		"- source_symbol: z9",
		"Use ${value_12} and ${expr_90}.",
	].join("\n");

	assert.equal(
		normalizePromptSurfaceContent(first),
		normalizePromptSurfaceContent(second),
	);
	assert.equal(
		hashPromptSurfaceContent(first),
		hashPromptSurfaceContent(second),
	);
});

test("verifyPromptSurfaceDrift detects watched surface changes and missing files", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-drift-"));
	const exportDir = path.join(tempDir, "export");
	const watchPaths = ["tools/builtin/bash.md", "agents/explore.md"];
	try {
		await writeSurface(
			exportDir,
			"tools/builtin/bash.md",
			"# Tool: Bash\n- source_symbol: a\nUse ${value_1}.",
		);
		await writeSurface(
			exportDir,
			"agents/explore.md",
			"# Agent: explore\nUse Serena first.",
		);

		const baseline = await createPromptSurfaceDriftBaseline({
			exportDir,
			version: "2.1.test",
			watchPaths,
		});
		const clean = await verifyPromptSurfaceDrift({
			exportDir,
			baseline,
			watchPaths,
		});
		assert.equal(clean.ok, true);

		await writeSurface(
			exportDir,
			"agents/explore.md",
			"# Agent: explore\nUse broad text search first.",
		);
		const drifted = await verifyPromptSurfaceDrift({
			exportDir,
			baseline,
			watchPaths,
		});
		assert.equal(drifted.ok, false);
		assert.ok(
			drifted.failures.some(
				(failure) =>
					failure.file === "agents/explore.md" &&
					failure.id === "surface-drift",
			),
		);

		await fs.rm(path.join(exportDir, "tools", "builtin", "bash.md"));
		const missing = await verifyPromptSurfaceDrift({
			exportDir,
			baseline,
			watchPaths,
		});
		assert.equal(missing.ok, false);
		assert.ok(
			missing.failures.some(
				(failure) =>
					failure.file === "tools/builtin/bash.md" &&
					failure.id === "surface-not-readable",
			),
		);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("verifyPromptSurfaceDrift uses the central watch list by default", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "prompt-drift-default-watch-"),
	);
	const exportDir = path.join(tempDir, "export");
	try {
		for (const relativePath of PROMPT_SURFACE_DRIFT_PATHS) {
			await writeSurface(
				exportDir,
				relativePath,
				`# ${relativePath}\nStable prompt surface.`,
			);
		}

		const baseline = await createPromptSurfaceDriftBaseline({
			exportDir,
			version: "2.1.test",
		});
		const [removedPath] = PROMPT_SURFACE_DRIFT_PATHS;
		assert.ok(removedPath, "expected at least one watched prompt surface");
		delete baseline.surfaces[removedPath];

		const result = await verifyPromptSurfaceDrift({ exportDir, baseline });
		assert.equal(result.ok, false);
		assert.ok(
			result.failures.some(
				(failure) =>
					failure.file === removedPath &&
					failure.id === "baseline-missing-surface",
			),
		);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("default drift paths exclude optional surfaces that review reports still track", () => {
	assert.ok(PROMPT_SURFACE_REVIEW_PATHS.includes("tools/builtin/read.md"));
	assert.ok(
		PROMPT_SURFACE_REVIEW_PATHS.includes("agents/claude-code-guide.md"),
	);
	assert.ok(!PROMPT_SURFACE_DRIFT_PATHS.includes("tools/builtin/read.md"));
	assert.ok(
		!PROMPT_SURFACE_DRIFT_PATHS.includes("agents/claude-code-guide.md"),
	);
	assert.ok(PROMPT_SURFACE_DRIFT_PATHS.includes("agents/explore.md"));
});
