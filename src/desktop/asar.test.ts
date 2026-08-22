import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { readDesktopPackageMetadata } from "./asar.js";

function align4(value: number): number {
	return (value + 3) & ~3;
}

function createAsar(files: Record<string, Buffer>): Buffer {
	let offset = 0;
	const fileNodes: Record<string, { size: number; offset: string }> = {};
	for (const [name, contents] of Object.entries(files)) {
		fileNodes[name] = { size: contents.length, offset: String(offset) };
		offset += contents.length;
	}
	const json = Buffer.from(JSON.stringify({ files: fileNodes }), "utf8");
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
	return Buffer.concat([sizePickle, headerPickle, ...Object.values(files)]);
}

test("ASAR inspection reads only package metadata and keeps the pin unresolved", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-asar-"));
	const asarPath = path.join(tempDir, "app.asar");
	try {
		await fs.writeFile(
			asarPath,
			createAsar({
				"package.json": Buffer.from(
					JSON.stringify({
						name: "synthetic-desktop",
						version: "1.2.3",
						devDependencies: {
							"@anthropic-ai/claude-agent-sdk": "0.3.4",
						},
					}),
				),
				"renderer.js": Buffer.from("const rawVersion = '9.9.9';"),
			}),
		);

		const metadata = await readDesktopPackageMetadata(asarPath);
		assert.deepEqual(metadata, {
			packageVersion: "1.2.3",
			packagedAgentSdk: { status: "resolved", version: "0.3.4" },
			declaredCodePin: { status: "unresolved", version: null },
			memberCount: 2,
		});
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("ASAR inspection resolves only the explicit semantic Code pin", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-pin-"));
	const asarPath = path.join(tempDir, "app.asar");
	try {
		await fs.writeFile(
			asarPath,
			createAsar({
				"package.json": Buffer.from(
					JSON.stringify({
						version: "1.2.3",
						claudeCodeVersion: "2.1.9",
					}),
				),
			}),
		);

		assert.deepEqual(
			(await readDesktopPackageMetadata(asarPath)).declaredCodePin,
			{ status: "resolved", version: "2.1.9" },
		);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("ASAR inspection rejects duplicate semantic JSON fields", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "desktop-duplicate-"),
	);
	const asarPath = path.join(tempDir, "app.asar");
	try {
		await fs.writeFile(
			asarPath,
			createAsar({
				"package.json": Buffer.from(
					'{"version":"1.2.3","claudeCodeVersion":"2.1.8","claudeCodeVersion":"2.1.9"}',
				),
			}),
		);

		await assert.rejects(
			readDesktopPackageMetadata(asarPath),
			/duplicate.*claudeCodeVersion/i,
		);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("ASAR inspection rejects oversized and out-of-range header claims", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-bounds-"));
	const oversizedPath = path.join(tempDir, "oversized.asar");
	const rangePath = path.join(tempDir, "range.asar");
	try {
		const oversized = Buffer.alloc(16);
		oversized.writeUInt32LE(4, 0);
		oversized.writeUInt32LE(32 * 1024 * 1024, 4);
		await fs.writeFile(oversizedPath, oversized);
		await assert.rejects(
			readDesktopPackageMetadata(oversizedPath),
			/header.*limit/i,
		);

		const invalid = createAsar({
			"package.json": Buffer.from('{"version":"1.2.3"}'),
		});
		invalid.write("999999999", 0, "utf8");
		await fs.writeFile(rangePath, invalid);
		await assert.rejects(
			readDesktopPackageMetadata(rangePath),
			/header|archive|range/i,
		);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});
