import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";

const sourceRepoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const nodePath = execFileSync("node", ["-p", "process.execPath"], {
	encoding: "utf8",
}).trim();

interface RunnerFixture {
	root: string;
	binDir: string;
	nodeDir: string;
	invocationLog: string;
}

interface Invocation {
	bun: string;
	args: string;
	pathHead: string;
	pathHeadBun: string;
}

async function makeRunnerFixture(
	t: TestContext,
	packageManager = "bun@1.4.0",
): Promise<RunnerFixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "serial-test-runner-"));
	t.after(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});
	await Promise.all(
		["scripts", "src", "bin", "node-bin"].map((directory) =>
			fs.mkdir(path.join(root, directory), { recursive: true }),
		),
	);
	await Promise.all([
		fs.copyFile(
			path.join(sourceRepoRoot, "scripts", "run-tests-serial.mjs"),
			path.join(root, "scripts", "run-tests-serial.mjs"),
		),
		fs.writeFile(
			path.join(root, "package.json"),
			JSON.stringify({ packageManager }),
			"utf8",
		),
		fs.writeFile(path.join(root, "src", "alpha.test.ts"), "", "utf8"),
		fs.writeFile(path.join(root, "src", "beta.test.ts"), "", "utf8"),
		fs.symlink(nodePath, path.join(root, "node-bin", "node")),
	]);
	return {
		root,
		binDir: path.join(root, "bin"),
		nodeDir: path.join(root, "node-bin"),
		invocationLog: path.join(root, "invocations.log"),
	};
}

// Fake Bun that reports `version` and logs each test invocation as JSON. It
// names itself, and the `bun` first on its PATH, by their real parent directory.
async function writeFakeBun(
	file: string,
	version: string,
	options: { interruptRunner?: boolean } = {},
): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(
		file,
		`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
if (process.argv[2] === "--version") {
  process.stdout.write(${JSON.stringify(`${version}\n`)});
  process.exit(0);
}
const label = (file) => path.basename(path.dirname(fs.realpathSync(file)));
const pathHead = process.env.PATH.split(path.delimiter)[0];
fs.appendFileSync(process.env.SERIAL_TEST_INVOCATIONS, JSON.stringify({
  bun: label(__filename),
  args: process.argv.slice(2).join(" "),
  pathHead,
  pathHeadBun: label(path.join(pathHead, "bun")),
}) + "\\n");
if (process.argv[3].endsWith("alpha.test.ts")) {
  process.stdout.write("SKIP synthetic optional dependency unavailable\\n");
  process.stderr.write("WARN synthetic runtime diagnostic\\n");
}
${options.interruptRunner ? 'process.kill(process.ppid, "SIGINT");\nsetTimeout(() => process.exit(0), 500);\n' : ""}`,
		{ encoding: "utf8", mode: 0o755 },
	);
}

async function writeFakeMise(binDir: string, bunPath: string): Promise<void> {
	await fs.writeFile(
		path.join(binDir, "mise"),
		`#!/usr/bin/env node
if (process.argv[2] === "which" && process.argv[3] === "bun") {
  process.stdout.write(${JSON.stringify(`${bunPath}\n`)});
  process.exit(0);
}
process.stderr.write("unexpected mise arguments\\n");
process.exit(2);
`,
		{ encoding: "utf8", mode: 0o755 },
	);
}

// The runner gets a minimal environment: PATH holds only the fixture's fakes
// and a directory with a single `node` link, so the real PATH, mise, and the
// outer `bun run` launcher cannot leak into candidate selection.
function runRunner(fixture: RunnerFixture, env: Record<string, string> = {}) {
	return spawnSync(
		nodePath,
		[path.join(fixture.root, "scripts", "run-tests-serial.mjs")],
		{
			encoding: "utf8",
			env: {
				PATH: [fixture.binDir, fixture.nodeDir].join(path.delimiter),
				SERIAL_TEST_INVOCATIONS: fixture.invocationLog,
				...env,
			},
		},
	);
}

async function readInvocations(fixture: RunnerFixture): Promise<Invocation[]> {
	const log = await fs.readFile(fixture.invocationLog, "utf8");
	return log
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Invocation);
}

test("serial runner preserves successful child diagnostics", async (t) => {
	const fixture = await makeRunnerFixture(t);
	await writeFakeBun(path.join(fixture.binDir, "bun"), "1.4.0");

	const result = runRunner(fixture);

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /SKIP synthetic optional dependency unavailable/);
	assert.match(result.stderr, /WARN synthetic runtime diagnostic/);
	assert.deepEqual(
		(await readInvocations(fixture)).map(({ bun, args }) => `${bun}: ${args}`),
		[
			"bin: test src/alpha.test.ts --parallel=1",
			"bin: test src/beta.test.ts --parallel=1",
		],
	);
});

test("serial runner runs tests with the bun that launched bun run", async (t) => {
	const fixture = await makeRunnerFixture(t);
	const launcher = path.join(fixture.root, "launcher", "bun");
	await writeFakeBun(launcher, "1.4.2");
	await writeFakeBun(path.join(fixture.binDir, "bun"), "1.4.0");

	const result = runRunner(fixture, { npm_execpath: launcher });

	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(
		(await readInvocations(fixture)).map(({ bun, pathHeadBun }) => ({
			bun,
			pathHeadBun,
		})),
		[
			{ bun: "launcher", pathHeadBun: "launcher" },
			{ bun: "launcher", pathHeadBun: "launcher" },
		],
	);
});

test("serial runner ignores an npm_execpath that is not bun", async (t) => {
	const fixture = await makeRunnerFixture(t);
	const npmCli = path.join(fixture.root, "npm", "npm-cli.js");
	await writeFakeBun(npmCli, "11.0.0");
	await writeFakeBun(path.join(fixture.binDir, "bun"), "1.4.0");

	const result = runRunner(fixture, { npm_execpath: npmCli });

	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(
		(await readInvocations(fixture)).map(({ bun }) => bun),
		["bin", "bin"],
	);
});

test("serial runner falls back to the mise bun when other candidates are older than the pin", async (t) => {
	const fixture = await makeRunnerFixture(t);
	const launcher = path.join(fixture.root, "launcher", "bun");
	const miseBun = path.join(fixture.root, "mise-bun", "bun");
	await writeFakeBun(launcher, "1.3.11");
	await writeFakeBun(path.join(fixture.binDir, "bun"), "1.3.11");
	await writeFakeBun(miseBun, "1.4.0");
	await writeFakeMise(fixture.binDir, miseBun);

	const result = runRunner(fixture, { npm_execpath: launcher });

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /with bun 1\.4\.0 \(mise: /);
	assert.deepEqual(
		(await readInvocations(fixture)).map(({ bun, pathHeadBun }) => ({
			bun,
			pathHeadBun,
		})),
		[
			{ bun: "mise-bun", pathHeadBun: "mise-bun" },
			{ bun: "mise-bun", pathHeadBun: "mise-bun" },
		],
	);
});

test("serial runner prefers a qualifying PATH bun over the mise bun", async (t) => {
	const fixture = await makeRunnerFixture(t);
	const miseBun = path.join(fixture.root, "mise-bun", "bun");
	await writeFakeBun(path.join(fixture.binDir, "bun"), "1.5.0");
	await writeFakeBun(miseBun, "1.4.0");
	await writeFakeMise(fixture.binDir, miseBun);

	const result = runRunner(fixture);

	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(
		(await readInvocations(fixture)).map(({ bun }) => bun),
		["bin", "bin"],
	);
});

test("serial runner accepts an older patch on the pinned minor line", async (t) => {
	const fixture = await makeRunnerFixture(t, "bun@1.4.2");
	await writeFakeBun(path.join(fixture.binDir, "bun"), "1.4.0");

	const result = runRunner(fixture);

	assert.equal(result.status, 0, result.stderr);
	assert.equal((await readInvocations(fixture)).length, 2);
});

test("serial runner accepts a newer major version than the pin", async (t) => {
	const fixture = await makeRunnerFixture(t);
	await writeFakeBun(path.join(fixture.binDir, "bun"), "2.0.0");

	const result = runRunner(fixture);

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /with bun 2\.0\.0 \(PATH: /);
});

test("serial runner removes its bun shim directory when it finishes", async (t) => {
	const fixture = await makeRunnerFixture(t);
	await writeFakeBun(path.join(fixture.binDir, "bun"), "1.4.0");

	const result = runRunner(fixture);

	assert.equal(result.status, 0, result.stderr);
	const [first] = await readInvocations(fixture);
	assert.ok(first, "the runner did not start a test file");
	assert.notEqual(first.pathHead, fixture.binDir);
	await assert.rejects(fs.access(first.pathHead));
});

test("serial runner removes its bun shim directory when interrupted", async (t) => {
	const fixture = await makeRunnerFixture(t);
	await writeFakeBun(path.join(fixture.binDir, "bun"), "1.4.0", {
		interruptRunner: true,
	});

	const result = runRunner(fixture);

	assert.equal(result.signal, "SIGINT", result.stderr);
	const [first] = await readInvocations(fixture);
	assert.ok(first, "the runner did not start a test file");
	assert.notEqual(first.pathHead, fixture.binDir);
	await assert.rejects(fs.access(first.pathHead));
});

test("serial runner stops before running tests when no bun meets the pin", async (t) => {
	const fixture = await makeRunnerFixture(t);
	await writeFakeBun(path.join(fixture.binDir, "bun"), "1.3.11");

	const result = runRunner(fixture);

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /No bun 1\.4 or newer/);
	assert.match(
		result.stderr,
		/PATH \(.+\/bin\/bun\): 1\.3\.11 is older than 1\.4/,
	);
	assert.match(result.stderr, /mise \(mise which bun\): mise not found/);
	assert.match(result.stderr, /Install the pinned release with `mise install`/);
	await assert.rejects(fs.access(fixture.invocationLog));
});

test("serial runner points at the mise config when the mise bun is older than the pin", async (t) => {
	const fixture = await makeRunnerFixture(t, "bun@1.5.0");
	const miseBun = path.join(fixture.root, "mise-bun", "bun");
	await writeFakeBun(miseBun, "1.4.0");
	await writeFakeMise(fixture.binDir, miseBun);

	const result = runRunner(fixture);

	assert.notEqual(result.status, 0);
	assert.match(
		result.stderr,
		/mise resolves bun 1\.4\.0 for this checkout, older than the bun@1\.5\.0 pin/,
	);
	assert.match(result.stderr, /mise config to 1\.5 or newer/);
	await assert.rejects(fs.access(fixture.invocationLog));
});
