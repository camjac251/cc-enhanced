import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { promote, rollback } from "./promote.js";

async function writeExecutable(
	filePath: string,
	versionOutput: string,
): Promise<void> {
	await fsp.writeFile(
		filePath,
		`#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(`${versionOutput}\n`)});\n`,
		"utf8",
	);
	await fsp.chmod(filePath, 0o755);
}

test("promote validates the candidate before changing active links", async () => {
	const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "promote-smoke-"));
	const versionsDir = path.join(tempDir, "versions");
	const binLink = path.join(tempDir, "bin", "claude");
	const previousBinary = path.join(tempDir, "previous-binary");
	const candidateBinary = path.join(tempDir, "candidate-binary");
	try {
		await fsp.mkdir(versionsDir, { recursive: true });
		await fsp.mkdir(path.dirname(binLink), { recursive: true });
		await writeExecutable(
			previousBinary,
			"2.1.100 (Claude Code; patched: stable)",
		);
		await writeExecutable(candidateBinary, "unexpected version output");
		await fsp.symlink(previousBinary, path.join(versionsDir, "current"));
		await fsp.symlink(path.join(versionsDir, "current"), binLink);

		assert.throws(
			() =>
				promote(candidateBinary, {
					versionsDir,
					binLink,
					cleanOldBuilds: false,
				}),
			/failed version smoke test/i,
		);
		assert.equal(
			fs.realpathSync(path.join(versionsDir, "current")),
			fs.realpathSync(previousBinary),
		);
		assert.equal(fs.realpathSync(binLink), fs.realpathSync(previousBinary));
	} finally {
		await fsp.rm(tempDir, { recursive: true, force: true });
	}
});

test("promote rejects a parseable unpatched candidate before changing links", async () => {
	const tempDir = await fsp.mkdtemp(
		path.join(os.tmpdir(), "promote-unpatched-"),
	);
	const versionsDir = path.join(tempDir, "versions");
	const binLink = path.join(tempDir, "bin", "claude");
	const previousBinary = path.join(tempDir, "previous-binary");
	const candidateBinary = path.join(tempDir, "candidate-binary");
	try {
		await fsp.mkdir(versionsDir, { recursive: true });
		await fsp.mkdir(path.dirname(binLink), { recursive: true });
		await writeExecutable(
			previousBinary,
			"2.1.100 (Claude Code; patched: stable)",
		);
		await writeExecutable(candidateBinary, "2.1.101 (Claude Code)");
		await fsp.symlink(previousBinary, path.join(versionsDir, "current"));
		await fsp.symlink(path.join(versionsDir, "current"), binLink);

		assert.throws(
			() =>
				promote(candidateBinary, {
					versionsDir,
					binLink,
					cleanOldBuilds: false,
				}),
			/not a patched artifact/i,
		);
		assert.equal(
			fs.realpathSync(path.join(versionsDir, "current")),
			fs.realpathSync(previousBinary),
		);
		assert.equal(fs.realpathSync(binLink), fs.realpathSync(previousBinary));
	} finally {
		await fsp.rm(tempDir, { recursive: true, force: true });
	}
});

test("promote records a successful smoke test and changes active links", async () => {
	const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "promote-success-"));
	const versionsDir = path.join(tempDir, "versions");
	const binLink = path.join(tempDir, "bin", "claude");
	const candidateBinary = path.join(tempDir, "candidate-binary");
	try {
		await writeExecutable(
			candidateBinary,
			"2.1.101 (Claude Code; patched: stable)",
		);

		const result = promote(candidateBinary, {
			versionsDir,
			binLink,
			cleanOldBuilds: false,
		});

		assert.equal(result.smokeTestVersion, "2.1.101 (patched)");
		assert.equal(
			fs.realpathSync(path.join(versionsDir, "current")),
			fs.realpathSync(candidateBinary),
		);
		assert.equal(fs.realpathSync(binLink), fs.realpathSync(candidateBinary));
	} finally {
		await fsp.rm(tempDir, { recursive: true, force: true });
	}
});

test("rollback rejects a parseable unpatched target before changing links", async () => {
	const tempDir = await fsp.mkdtemp(
		path.join(os.tmpdir(), "rollback-unpatched-"),
	);
	const versionsDir = path.join(tempDir, "versions");
	const binLink = path.join(tempDir, "bin", "claude");
	const currentBinary = path.join(tempDir, "current-binary");
	const rollbackBinary = path.join(tempDir, "rollback-binary");
	try {
		await fsp.mkdir(versionsDir, { recursive: true });
		await fsp.mkdir(path.dirname(binLink), { recursive: true });
		await writeExecutable(
			currentBinary,
			"2.1.101 (Claude Code; patched: stable)",
		);
		await writeExecutable(rollbackBinary, "2.1.100 (Claude Code)");
		await fsp.symlink(currentBinary, path.join(versionsDir, "current"));
		await fsp.symlink(rollbackBinary, path.join(versionsDir, "previous"));
		await fsp.symlink(path.join(versionsDir, "current"), binLink);

		assert.throws(
			() => rollback({ versionsDir, binLink }),
			/not a patched artifact/i,
		);
		assert.equal(
			fs.realpathSync(path.join(versionsDir, "current")),
			fs.realpathSync(currentBinary),
		);
		assert.equal(fs.realpathSync(binLink), fs.realpathSync(currentBinary));
		assert.equal(
			fs.realpathSync(path.join(versionsDir, "previous")),
			fs.realpathSync(rollbackBinary),
		);
	} finally {
		await fsp.rm(tempDir, { recursive: true, force: true });
	}
});

test("rollback swaps current and previous after a successful smoke test", async () => {
	const tempDir = await fsp.mkdtemp(
		path.join(os.tmpdir(), "rollback-success-"),
	);
	const versionsDir = path.join(tempDir, "versions");
	const binLink = path.join(tempDir, "bin", "claude");
	const currentBinary = path.join(tempDir, "current-binary");
	const rollbackBinary = path.join(tempDir, "rollback-binary");
	try {
		await fsp.mkdir(versionsDir, { recursive: true });
		await fsp.mkdir(path.dirname(binLink), { recursive: true });
		await writeExecutable(
			currentBinary,
			"2.1.101 (Claude Code; patched: stable)",
		);
		await writeExecutable(
			rollbackBinary,
			"2.1.100 (Claude Code; patched: stable)",
		);
		await fsp.symlink(currentBinary, path.join(versionsDir, "current"));
		await fsp.symlink(rollbackBinary, path.join(versionsDir, "previous"));
		await fsp.symlink(path.join(versionsDir, "current"), binLink);

		const result = rollback({ versionsDir, binLink });

		assert.equal(result.smokeTestVersion, "2.1.100 (patched)");
		assert.equal(
			fs.realpathSync(path.join(versionsDir, "current")),
			fs.realpathSync(rollbackBinary),
		);
		assert.equal(
			fs.realpathSync(path.join(versionsDir, "previous")),
			fs.realpathSync(currentBinary),
		);
		assert.equal(fs.realpathSync(binLink), fs.realpathSync(rollbackBinary));
	} finally {
		await fsp.rm(tempDir, { recursive: true, force: true });
	}
});

test("rollback validates its target before changing active links", async () => {
	const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "rollback-smoke-"));
	const versionsDir = path.join(tempDir, "versions");
	const binLink = path.join(tempDir, "bin", "claude");
	const currentBinary = path.join(tempDir, "current-binary");
	const rollbackBinary = path.join(tempDir, "rollback-binary");
	try {
		await fsp.mkdir(versionsDir, { recursive: true });
		await fsp.mkdir(path.dirname(binLink), { recursive: true });
		await writeExecutable(
			currentBinary,
			"2.1.101 (Claude Code; patched: stable)",
		);
		await writeExecutable(rollbackBinary, "unexpected version output");
		await fsp.symlink(currentBinary, path.join(versionsDir, "current"));
		await fsp.symlink(rollbackBinary, path.join(versionsDir, "previous"));
		await fsp.symlink(path.join(versionsDir, "current"), binLink);

		assert.throws(
			() => rollback({ versionsDir, binLink }),
			/failed version smoke test/i,
		);
		assert.equal(
			fs.realpathSync(path.join(versionsDir, "current")),
			fs.realpathSync(currentBinary),
		);
		assert.equal(fs.realpathSync(binLink), fs.realpathSync(currentBinary));
		assert.equal(
			fs.realpathSync(path.join(versionsDir, "previous")),
			fs.realpathSync(rollbackBinary),
		);
	} finally {
		await fsp.rm(tempDir, { recursive: true, force: true });
	}
});
