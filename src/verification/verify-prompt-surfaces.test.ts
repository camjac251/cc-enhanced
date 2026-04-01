import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { verifyPromptSurfaces } from "./verify-prompt-surfaces.js";

async function writeSurface(
	root: string,
	relativePath: string,
	content: string,
): Promise<void> {
	const fullPath = path.join(root, relativePath);
	await fs.mkdir(path.dirname(fullPath), { recursive: true });
	await fs.writeFile(fullPath, content, "utf8");
}

async function createValidSurfaceFixture(root: string): Promise<void> {
	await writeSurface(
		root,
		"tools/builtin/read.md",
		[
			"Range parameter (for text files only, supported bat-style forms):",
			"`show_whitespace: true`",
		].join("\n"),
	);
	await writeSurface(
		root,
		"tools/builtin/edit.md",
		"For regex/pattern replacement, use Bash: `sd 'pattern' 'replacement' file.ts`",
	);
	await writeSurface(
		root,
		"agents/explore.md",
		[
			"Use Bash ONLY for modern read-only operations (eza, git status, git log, git diff, fd, sg, rg, bat)",
			"Prefer sg for structural code search, rg only for exact text/config/logs, fd over find, eza over ls, and bat over cat/head/tail",
		].join("\n"),
	);
	await writeSurface(
		root,
		"agents/plan.md",
		"Concrete plan guidance only. Literal template examples like ${PLAN_NAME} are allowed when rendered intentionally.",
	);
	await writeSurface(
		root,
		"system/sections/using-your-tools.md",
		[
			"For shell-native file discovery use `fd` and `eza`.",
			"For text search use `rg`; use `sg` for structural code search when available.",
		].join("\n"),
	);
	await writeSurface(
		root,
		"agents/claude-code-guide.md",
		[
			"Fetch the appropriate docs map URL using MCP doc tools (context7, docfork, or ref)",
			"Use MCP search (perplexity) if official docs don't cover the topic",
		].join("\n"),
	);
}

test("verifyPromptSurfaces reports unreadable surface files", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "verify-prompt-surfaces-missing-"),
	);
	try {
		const result = await verifyPromptSurfaces({ exportDir: tempDir });
		assert.equal(result.ok, false);
		assert.ok(
			result.failures.some((failure) => failure.id === "surface-not-readable"),
		);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("verifyPromptSurfaces allows dynamic Read prompt exports", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "verify-prompt-surfaces-dynamic-read-"),
	);
	try {
		await createValidSurfaceFixture(tempDir);
		await writeSurface(
			tempDir,
			"tools/builtin/read.md",
			"# Tool: Read\n\n## Prompt\n\n(Dynamic prompt: not statically resolved from cli.js AST.)",
		);
		const result = await verifyPromptSurfaces({ exportDir: tempDir });
		assert.equal(result.ok, true);
		assert.deepEqual(result.failures, []);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("verifyPromptSurfaces passes for patched live prompt surfaces", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "verify-prompt-surfaces-valid-"),
	);
	try {
		await createValidSurfaceFixture(tempDir);
		const result = await verifyPromptSurfaces({ exportDir: tempDir });
		assert.equal(result.ok, true);
		assert.deepEqual(result.failures, []);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("verifyPromptSurfaces rejects legacy live prompt guidance", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "verify-prompt-surfaces-legacy-"),
	);
	try {
		await createValidSurfaceFixture(tempDir);
		await writeSurface(
			tempDir,
			"tools/builtin/read.md",
			[
				"Range parameter (for text files only, supported bat-style forms):",
				"`show_whitespace: true`",
				"You can optionally specify a line offset and limit",
				"Results are returned using cat -n format",
			].join("\n"),
		);
		await writeSurface(
			tempDir,
			"agents/claude-code-guide.md",
			[
				"Fetch the appropriate docs map URL using MCP doc tools (context7, docfork, or ref)",
				"Use WebFetch to fetch the appropriate docs map",
			].join("\n"),
		);
		await writeSurface(
			tempDir,
			"agents/explore.md",
			[
				"Use Bash ONLY for modern read-only operations (eza, git status, git log, git diff, fd, sg, rg, bat)",
				"Prefer sg for structural code search, rg only for exact text/config/logs, fd over find, eza over ls, and bat over cat/head/tail",
				"${value_22}",
				"npm view ${object.PACKAGE_URL}@${value_1} version",
			].join("\n"),
		);
		await writeSurface(
			tempDir,
			"agents/plan.md",
			[
				"Find existing patterns using ${conditional(template | template)}",
				"Then inspect ${value_22} for drift",
			].join("\n"),
		);

		const result = await verifyPromptSurfaces({ exportDir: tempDir });
		assert.equal(result.ok, false);
		assert.ok(
			result.failures.some((failure) => failure.id === "read-offset-limit"),
		);
		assert.ok(result.failures.some((failure) => failure.id === "read-cat-n"));
		assert.ok(
			result.failures.some((failure) => failure.id === "guide-webfetch"),
		);
		assert.ok(
			result.failures.some((failure) => failure.id === "explore-placeholder"),
		);
		assert.ok(
			result.failures.some((failure) => failure.id === "explore-stray-command"),
		);
		assert.ok(
			result.failures.some(
				(failure) => failure.id === "plan-broken-helper-render",
			),
		);
		assert.ok(
			result.failures.some(
				(failure) => failure.id === "plan-unresolved-placeholder",
			),
		);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});
