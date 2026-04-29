import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createUniqueSlug, writeArtifact } from "./prompt-export-utils.js";

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
