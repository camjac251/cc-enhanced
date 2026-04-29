import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function withFixture(fn: (filePath: string) => void): void {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "inspector-test-"));
	const filePath = path.join(tempDir, "fixture.js");
	fs.writeFileSync(
		filePath,
		[
			"const noisy = { getTotalCacheReadInputTokens: () => 1 };",
			"const tool = {",
			'  name: "Read",',
			'  description: "Read file content from disk",',
			'  inputSchema: { type: "object", properties: { file_path: { type: "string" } } },',
			"};",
			"",
		].join("\n"),
	);
	try {
		fn(filePath);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}

function inspectJson(args: string[]): any {
	return JSON.parse(
		execFileSync("bun", ["src/inspector.ts", ...args], {
			cwd: repoRoot,
			encoding: "utf8",
		}),
	);
}

test("inspector ranks exact strings above incidental identifier substrings", () => {
	withFixture((filePath) => {
		const result = inspectJson([
			"search",
			filePath,
			"Read",
			"--json",
			"--limit",
			"3",
			"--object",
		]);
		const first = result.runs[0].matches[0];
		assert.equal(first.field, "string");
		assert.equal(first.matchedValue, "Read");
		assert.equal(first.object.labels.name, "Read");
	});
});

test("inspector supports field-filtered regex search", () => {
	withFixture((filePath) => {
		const result = inspectJson([
			"search",
			filePath,
			"^read$",
			"--regex",
			"--ignore-case",
			"--field",
			"string",
			"--json",
		]);
		assert.ok(result.runs[0].matches.length >= 1);
		assert.equal(result.runs[0].matches[0].matchedValue, "Read");
		assert.equal(result.runs[0].matches[0].field, "string");
	});
});
