import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { DesktopInventoryEvidence } from "../src/desktop/contract.js";

const scriptPath = path.join(process.cwd(), "scripts", "desktop-compare.ts");

function evidence(sha256 = "a".repeat(64)): DesktopInventoryEvidence {
	return {
		schemaVersion: 1,
		platform: "win32",
		desktop: {
			locatorId: "desktop:1.2.3",
			layout: "windows-squirrel",
			version: "1.2.3",
			packagedAgentSdk: { status: "resolved", version: "0.3.4" },
			declaredCodePin: { status: "unresolved", version: null },
			asarMemberCount: 12,
		},
		cachedCode: [
			{
				locatorId: "desktop-code:2.1.9",
				version: "2.1.9",
				platform: "win32-x64",
				binaryFormat: "pe",
				architecture: "x64",
				size: 96,
				sha256,
				signatureInspection: "not-inspected",
				patchReceiptInspection: "not-inspected",
			},
		],
		selectedCodeLocatorId: "desktop-code:2.1.9",
		selectedCodeReason: "highest-cached",
		createdAt: "2026-08-20T12:00:00.000Z",
	};
}

test("Desktop comparison CLI emits bounded path-free evidence and exits on drift", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-compare-"));
	const baselinePath = path.join(tempDir, "baseline.json");
	const currentPath = path.join(tempDir, "current.json");
	try {
		await fs.writeFile(baselinePath, JSON.stringify(evidence()));
		await fs.writeFile(currentPath, JSON.stringify(evidence("b".repeat(64))));
		const result = spawnSync(
			process.execPath,
			[
				scriptPath,
				"--baseline",
				baselinePath,
				"--current",
				currentPath,
				"--evidence",
			],
			{ cwd: process.cwd(), encoding: "utf8", env: process.env },
		);

		assert.equal(result.status, 1, result.stderr);
		const drift = JSON.parse(result.stdout) as {
			status: string;
			changes: Array<{ kind: string }>;
		};
		assert.equal(drift.status, "changed");
		assert.deepEqual(
			drift.changes.map((change) => change.kind),
			["cache-artifact-replaced"],
		);
		assert.doesNotMatch(result.stdout, /desktop-compare-|baseline[.]json/);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("Desktop comparison CLI rejects linked and oversized evidence inputs", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "desktop-compare-bounds-"),
	);
	const evidencePath = path.join(tempDir, "evidence.json");
	const linkedPath = path.join(tempDir, "linked.json");
	const oversizedPath = path.join(tempDir, "oversized.json");
	try {
		await fs.writeFile(evidencePath, JSON.stringify(evidence()));
		await fs.symlink(evidencePath, linkedPath);
		let result = spawnSync(
			process.execPath,
			[
				scriptPath,
				"--baseline",
				linkedPath,
				"--current",
				evidencePath,
				"--evidence",
			],
			{ cwd: process.cwd(), encoding: "utf8", env: process.env },
		);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /regular file|symbolic link/i);

		await fs.writeFile(oversizedPath, Buffer.alloc(1024 * 1024 + 1));
		result = spawnSync(
			process.execPath,
			[
				scriptPath,
				"--baseline",
				oversizedPath,
				"--current",
				evidencePath,
				"--evidence",
			],
			{ cwd: process.cwd(), encoding: "utf8", env: process.env },
		);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /size|limit/i);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});
