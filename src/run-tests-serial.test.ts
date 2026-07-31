import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const sourceRepoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

test("serial runner preserves successful child diagnostics", async (t) => {
	const fixtureRoot = await fs.mkdtemp(
		path.join(os.tmpdir(), "serial-test-runner-"),
	);
	t.after(async () => {
		await fs.rm(fixtureRoot, { recursive: true, force: true });
	});

	const scriptsDir = path.join(fixtureRoot, "scripts");
	const testRoot = path.join(fixtureRoot, "src");
	const binDir = path.join(fixtureRoot, "bin");
	await Promise.all([
		fs.mkdir(scriptsDir, { recursive: true }),
		fs.mkdir(testRoot, { recursive: true }),
		fs.mkdir(binDir, { recursive: true }),
	]);
	await Promise.all([
		fs.copyFile(
			path.join(sourceRepoRoot, "scripts", "run-tests-serial.mjs"),
			path.join(scriptsDir, "run-tests-serial.mjs"),
		),
		fs.writeFile(path.join(testRoot, "alpha.test.ts"), "", "utf8"),
		fs.writeFile(path.join(testRoot, "beta.test.ts"), "", "utf8"),
	]);

	const invocationLog = path.join(fixtureRoot, "invocations.log");
	const fakeBunPath = path.join(binDir, "bun");
	await fs.writeFile(
		fakeBunPath,
		`#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.SERIAL_TEST_INVOCATIONS, process.argv.slice(2).join(" ") + "\\n");
if (process.argv[3].endsWith("alpha.test.ts")) {
  process.stdout.write("SKIP synthetic optional dependency unavailable\\n");
  process.stderr.write("WARN synthetic runtime diagnostic\\n");
}
`,
		{ encoding: "utf8", mode: 0o755 },
	);

	const result = spawnSync(
		"node",
		[path.join(scriptsDir, "run-tests-serial.mjs")],
		{
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
				SERIAL_TEST_INVOCATIONS: invocationLog,
			},
		},
	);

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /SKIP synthetic optional dependency unavailable/);
	assert.match(result.stderr, /WARN synthetic runtime diagnostic/);
	assert.deepEqual(
		(await fs.readFile(invocationLog, "utf8")).trim().split("\n"),
		[
			"test src/alpha.test.ts --parallel=1",
			"test src/beta.test.ts --parallel=1",
		],
	);
});
