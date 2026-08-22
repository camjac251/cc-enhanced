import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const scriptPath = path.join(process.cwd(), "scripts", "desktop-status.ts");

function align4(value: number): number {
	return (value + 3) & ~3;
}

function createAsar(): Buffer {
	const contents = Buffer.from(
		JSON.stringify({
			version: "1.2.3",
			devDependencies: {
				"@anthropic-ai/claude-agent-sdk": "0.3.4",
			},
		}),
	);
	const json = Buffer.from(
		JSON.stringify({
			files: {
				"package.json": { size: contents.length, offset: "0" },
			},
		}),
	);
	const stringSize = json.length;
	const headerPayload = Buffer.alloc(4 + align4(stringSize));
	headerPayload.writeUInt32LE(stringSize, 0);
	json.copy(headerPayload, 4);
	const headerPickle = Buffer.alloc(4 + headerPayload.length);
	headerPickle.writeUInt32LE(headerPayload.length, 0);
	headerPayload.copy(headerPickle, 4);
	const sizePickle = Buffer.alloc(8);
	sizePickle.writeUInt32LE(4, 0);
	sizePickle.writeUInt32LE(headerPickle.length, 4);
	return Buffer.concat([sizePickle, headerPickle, contents]);
}

function createPe(): Buffer {
	const binary = Buffer.alloc(96);
	binary.write("MZ", 0, "ascii");
	binary.writeUInt32LE(64, 0x3c);
	binary.write("PE\0\0", 64, "binary");
	binary.writeUInt16LE(0x8664, 68);
	return binary;
}

test("Desktop status CLI requires explicit bounded roots", () => {
	const result = spawnSync(
		process.execPath,
		[scriptPath, "--platform", "win32", "--json"],
		{ cwd: process.cwd(), encoding: "utf8", env: process.env },
	);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /app-root|cache-root/i);
});

test("Desktop status CLI emits a path-free evidence document", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-cli-"));
	const appRoot = path.join(tempDir, "private-user", "app-1.2.3");
	const cacheRoot = path.join(tempDir, "private-user", "cache");
	try {
		await fs.mkdir(path.join(appRoot, "resources"), { recursive: true });
		await fs.writeFile(
			path.join(appRoot, "resources", "app.asar"),
			createAsar(),
		);
		await fs.mkdir(path.join(cacheRoot, "2.1.9"), { recursive: true });
		await fs.writeFile(path.join(cacheRoot, "2.1.9", "claude.exe"), createPe());

		const result = spawnSync(
			process.execPath,
			[
				scriptPath,
				"--platform",
				"win32",
				"--app-root",
				appRoot,
				"--cache-root",
				cacheRoot,
				"--evidence",
			],
			{ cwd: process.cwd(), encoding: "utf8", env: process.env },
		);
		assert.equal(result.status, 0, result.stderr);
		const evidence = JSON.parse(result.stdout) as Record<string, unknown>;
		assert.equal(evidence.schemaVersion, 1);
		assert.doesNotMatch(result.stdout, /private-user|app[.]asar|claude[.]exe/);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});
