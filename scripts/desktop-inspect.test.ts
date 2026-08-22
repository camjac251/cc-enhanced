import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { DesktopInventoryEvidence } from "../src/desktop/contract.js";

const scriptPath = path.join(process.cwd(), "scripts", "desktop-inspect.ts");

function createPeFixture(): Buffer {
	const binary = Buffer.alloc(512);
	binary.write("MZ", 0, "ascii");
	binary.writeUInt32LE(0x80, 0x3c);
	binary.write("PE\0\0", 0x80, "binary");
	binary.writeUInt16LE(0x8664, 0x80 + 4);
	binary.writeUInt16LE(0xf0, 0x80 + 4 + 16);
	const optional = 0x80 + 4 + 20;
	binary.writeUInt16LE(0x20b, optional);
	binary.writeUInt32LE(16, optional + 108);
	return binary;
}

test("Desktop artifact CLI emits inspection-only path-free evidence", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-inspect-"));
	const cacheRoot = path.join(tempDir, "private-user", "cache");
	const versionRoot = path.join(cacheRoot, "2.1.235");
	const inventoryPath = path.join(tempDir, "inventory.json");
	const binary = createPeFixture();
	const evidence: DesktopInventoryEvidence = {
		schemaVersion: 1,
		platform: "win32",
		desktop: null,
		cachedCode: [
			{
				locatorId: "desktop-code:2.1.235",
				version: "2.1.235",
				platform: "win32-x64",
				binaryFormat: "pe",
				architecture: "x64",
				size: binary.length,
				sha256: createHash("sha256").update(binary).digest("hex"),
				signatureInspection: "not-inspected",
				patchReceiptInspection: "not-inspected",
			},
		],
		selectedCodeLocatorId: "desktop-code:2.1.235",
		selectedCodeReason: "highest-cached",
		createdAt: "2026-08-20T12:00:00.000Z",
	};
	try {
		await fs.mkdir(versionRoot, { recursive: true });
		const binaryPath = path.join(versionRoot, "claude.exe");
		await fs.writeFile(binaryPath, binary);
		await fs.writeFile(inventoryPath, JSON.stringify(evidence));
		const before = createHash("sha256")
			.update(await fs.readFile(binaryPath))
			.digest("hex");
		const result = spawnSync(
			process.execPath,
			[
				scriptPath,
				"--inventory",
				inventoryPath,
				"--cache-root",
				cacheRoot,
				"--evidence",
			],
			{ cwd: process.cwd(), encoding: "utf8", env: process.env },
		);
		assert.equal(result.status, 0, result.stderr);
		const inspected = JSON.parse(result.stdout) as {
			provenance: { status: string };
			platformSignature: { presence: string; validity: string };
			patchReceipt: { status: string };
			patchAuthorization: string;
		};
		assert.equal(inspected.provenance.status, "not-run");
		assert.equal(inspected.platformSignature.presence, "absent");
		assert.equal(inspected.platformSignature.validity, "not-run");
		assert.equal(inspected.patchReceipt.status, "not-run");
		assert.equal(inspected.patchAuthorization, "not-authorized");
		assert.doesNotMatch(
			result.stdout,
			/private-user|claude[.]exe|inventory[.]json/,
		);
		const after = createHash("sha256")
			.update(await fs.readFile(binaryPath))
			.digest("hex");
		assert.equal(after, before);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});
