import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const repoRoot = process.cwd();
const verifierPath = path.join(repoRoot, "scripts", "verify-native-host.ts");

function runVerifier(options: {
	matrixPath: string;
	artifactPath: string;
	stagedPath: string;
	receiptPath: string;
}) {
	return spawnSync(
		process.execPath,
		[
			verifierPath,
			"--matrix-receipt",
			options.matrixPath,
			"--platform",
			"linux-x64",
			"--artifact",
			options.artifactPath,
			"--staged-output",
			options.stagedPath,
			"--receipt",
			options.receiptPath,
			"--signing-policy",
			"not-required",
		],
		{
			cwd: repoRoot,
			encoding: "utf8",
			env: process.env,
		},
	);
}

test("native host CLI rejects a receipt that aliases the structural artifact", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "native-host-paths-"),
	);
	const matrixPath = path.join(tempDir, "matrix.json");
	const artifactPath = path.join(tempDir, "candidate");
	const stagedPath = path.join(tempDir, "staged");
	try {
		await fs.writeFile(matrixPath, "{}\n", "utf8");
		await fs.writeFile(artifactPath, "structural candidate", "utf8");
		const result = runVerifier({
			matrixPath,
			artifactPath,
			stagedPath,
			receiptPath: artifactPath,
		});

		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /native host paths must be distinct/i);
		assert.equal(
			await fs.readFile(artifactPath, "utf8"),
			"structural candidate",
		);
		await assert.rejects(fs.stat(stagedPath));
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("native host CLI rejects path aliases through a symlinked parent", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "native-host-alias-"),
	);
	const realDir = path.join(tempDir, "real");
	const aliasDir = path.join(tempDir, "alias");
	const matrixPath = path.join(tempDir, "matrix.json");
	const artifactPath = path.join(realDir, "candidate");
	const stagedPath = path.join(tempDir, "staged");
	try {
		await fs.mkdir(realDir);
		await fs.symlink(
			realDir,
			aliasDir,
			process.platform === "win32" ? "junction" : "dir",
		);
		await fs.writeFile(matrixPath, "{}\n", "utf8");
		await fs.writeFile(artifactPath, "structural candidate", "utf8");
		const result = runVerifier({
			matrixPath,
			artifactPath,
			stagedPath,
			receiptPath: path.join(aliasDir, "candidate"),
		});

		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /native host paths must be distinct/i);
		assert.equal(
			await fs.readFile(artifactPath, "utf8"),
			"structural candidate",
		);
		await assert.rejects(fs.stat(stagedPath));
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});
