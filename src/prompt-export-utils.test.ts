import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	buildFrontmatterPromptMap,
	createUniqueSlug,
	extractFrontmatterName,
	writeArtifact,
} from "./prompt-export-utils.js";

test("createUniqueSlug suffixes duplicates", () => {
	const seen = new Set<string>();
	assert.equal(createUniqueSlug("agent", seen), "agent");
	assert.equal(createUniqueSlug("agent", seen), "agent-2");
	assert.equal(createUniqueSlug("", seen), "artifact");
});

test("writeArtifact rejects duplicate manifest paths", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "prompt-export-utils-"),
	);
	try {
		const written = new Set<string>();
		writeArtifact(tempDir, written, "agents/plan.md", "first");
		assert.throws(
			() => writeArtifact(tempDir, written, "agents/plan.md", "second"),
			/duplicate artifact/,
		);
		assert.deepEqual([...written], ["agents/plan.md"]);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("extractFrontmatterName reads unquoted and quoted names", () => {
	assert.equal(
		extractFrontmatterName("---\nname: design-sync\n---\nbody"),
		"design-sync",
	);
	assert.equal(
		extractFrontmatterName('---\nname: "run-skill"\n---\nbody'),
		"run-skill",
	);
	assert.equal(extractFrontmatterName("name: missing-frontmatter"), null);
});

test("buildFrontmatterPromptMap keeps the longest prompt per name", () => {
	const shortPrompt = "---\nname: design-sync\n---\nshort";
	const longPrompt =
		"---\nname: design-sync\n---\nfull prompt body with more detail";
	const quotedPrompt = "---\nname: 'verify'\n---\nverify prompt";

	const prompts = buildFrontmatterPromptMap([
		{ text: shortPrompt },
		{ text: "not frontmatter" },
		{ text: quotedPrompt },
		{ text: longPrompt },
	]);

	assert.equal(prompts.get("design-sync"), longPrompt);
	assert.equal(prompts.get("verify"), quotedPrompt);
	assert.equal(prompts.has("not frontmatter"), false);
});
