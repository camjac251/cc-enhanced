import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	buildFrontmatterPromptMap,
	createFilesystemSlug,
	createUniqueSlug,
	extractFrontmatterName,
	selectPromptCorpusText,
	writeArtifact,
} from "./prompt-export-utils.js";

test("createUniqueSlug suffixes duplicates", () => {
	const seen = new Set<string>();
	assert.equal(createUniqueSlug("agent", seen), "agent");
	assert.equal(createUniqueSlug("agent", seen), "agent-2");
	assert.equal(createUniqueSlug("", seen), "artifact");
});
test("createFilesystemSlug keeps long artifact names writable and distinct", async () => {
	const sharedPrefix = "long prompt section ".repeat(40);
	const first = createFilesystemSlug(`${sharedPrefix}alpha`);
	const second = createFilesystemSlug(`${sharedPrefix}beta`);
	assert.notEqual(first, second);

	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "prompt-export-slug-"),
	);
	try {
		const written = new Set<string>();
		writeArtifact(
			tempDir,
			written,
			path.join("system", "sections", `${first}.md`),
			"first",
		);
		writeArtifact(
			tempDir,
			written,
			path.join("system", "sections", `${second}.md`),
			"second",
		);
		assert.equal(written.size, 2);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
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

test("selectPromptCorpusText prefers the least dynamic current surface", () => {
	const selected = selectPromptCorpusText(
		[
			{ text: "Current surface ${value_1} with stable anchor and extra text." },
			{ text: "Current surface with stable anchor." },
			{ text: "Unrelated surface." },
		],
		["Current surface", "stable anchor"],
	);

	assert.equal(selected, "Current surface with stable anchor.");
	assert.equal(
		selectPromptCorpusText([{ text: "Unrelated surface." }], ["missing"]),
		null,
	);
});
