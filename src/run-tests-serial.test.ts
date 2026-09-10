import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
const isWindows = process.platform === "win32";
const exe = isWindows ? ".exe" : "";
const noLinkDirectoryOnWindows = {
	skip: isWindows
		? "the runner creates no bun link directory on Windows"
		: false,
};

interface RunnerFixture {
	root: string;
	binDir: string;
	invocationLog: string;
}

interface Invocation {
	bun: string;
	args: string;
	pathHead: string;
	pathHeadBun: string;
}

interface FakeConfig {
	role: "bun" | "mise";
	version?: string;
	bunPath?: string;
	failFile?: string;
	interruptRunner?: boolean;
}

let compiledFake: string | undefined;

// One native executable plays every fake bun and mise, compiled once per test
// process. Hardlinked copies share the binary and differ only in their config.
function compileFake(): string {
	if (compiledFake) return compiledFake;
	const directory = mkdtempSync(path.join(os.tmpdir(), "serial-test-fake-"));
	process.once("exit", () => {
		rmSync(directory, { recursive: true, force: true });
	});
	const output = path.join(directory, `fake${exe}`);
	const result = spawnSync(
		process.execPath,
		[
			"build",
			"--compile",
			path.join(sourceRepoRoot, "src", "run-tests-serial.fake-bun.ts"),
			"--outfile",
			output,
		],
		{ encoding: "utf8" },
	);
	if (result.status !== 0) {
		throw new Error(`bun build --compile failed: ${result.stderr}`);
	}
	compiledFake = output;
	return output;
}

async function installFake(file: string, config: FakeConfig): Promise<string> {
	const target = `${file}${exe}`;
	await fs.mkdir(path.dirname(target), { recursive: true });
	await fs.link(compileFake(), target);
	await fs.writeFile(`${target}.json`, JSON.stringify(config), "utf8");
	return target;
}

function writeFakeBun(
	file: string,
	version: string,
	options: { failFile?: string; interruptRunner?: boolean } = {},
): Promise<string> {
	return installFake(file, { role: "bun", version, ...options });
}

function writeFakeMise(binDir: string, bunPath: string): Promise<string> {
	return installFake(path.join(binDir, "mise"), { role: "mise", bunPath });
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
		["scripts", "src", "bin"].map((directory) =>
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
	]);
	return {
		root,
		binDir: path.join(root, "bin"),
		invocationLog: path.join(root, "invocations.log"),
	};
}

// The runner gets a minimal environment: PATH holds only the fixture's fakes,
// so the real PATH, mise, and the outer `bun run` launcher cannot leak into
// candidate selection. Windows also needs its system and temp variables.
function runRunner(fixture: RunnerFixture, env: Record<string, string> = {}) {
	const windowsEssentials = isWindows
		? Object.fromEntries(
				["SystemRoot", "windir", "TEMP", "TMP", "PATHEXT", "ComSpec"].flatMap(
					(name) => {
						const value = process.env[name];
						return value === undefined ? [] : [[name, value]];
					},
				),
			)
		: {};
	return spawnSync(
		nodePath,
		[path.join(fixture.root, "scripts", "run-tests-serial.mjs")],
		{
			encoding: "utf8",
			env: {
				...windowsEssentials,
				PATH: fixture.binDir,
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

test("serial runner runs every file and lists the failures at the end", async (t) => {
	const fixture = await makeRunnerFixture(t);
	await writeFakeBun(path.join(fixture.binDir, "bun"), "1.4.0", {
		failFile: "alpha.test.ts",
	});

	const result = runRunner(fixture);

	assert.notEqual(result.status, 0);
	assert.deepEqual(
		(await readInvocations(fixture)).map(({ args }) => args),
		[
			"test src/alpha.test.ts --parallel=1",
			"test src/beta.test.ts --parallel=1",
		],
	);
	assert.match(result.stdout, /FAIL 1\/2 src\/alpha\.test\.ts/);
	assert.match(result.stdout, /PASS 2\/2 src\/beta\.test\.ts/);
	assert.match(
		result.stderr,
		/1 of 2 test files failed in [0-9.]+s:\r?\n {2}src\/alpha\.test\.ts/,
	);
});

test("serial runner runs tests with the bun that launched bun run", async (t) => {
	const fixture = await makeRunnerFixture(t);
	const launcher = await writeFakeBun(
		path.join(fixture.root, "launcher", "bun"),
		"1.4.2",
	);
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
	const npmCli = await writeFakeBun(
		path.join(fixture.root, "npm", "npm-cli.js"),
		"11.0.0",
	);
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
	const launcher = await writeFakeBun(
		path.join(fixture.root, "launcher", "bun"),
		"1.3.11",
	);
	await writeFakeBun(path.join(fixture.binDir, "bun"), "1.3.11");
	const miseBun = await writeFakeBun(
		path.join(fixture.root, "mise-bun", "bun"),
		"1.4.0",
	);
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
	await writeFakeBun(path.join(fixture.binDir, "bun"), "1.5.0");
	const miseBun = await writeFakeBun(
		path.join(fixture.root, "mise-bun", "bun"),
		"1.4.0",
	);
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

test(
	"serial runner removes its bun shim directory when it finishes",
	noLinkDirectoryOnWindows,
	async (t) => {
		const fixture = await makeRunnerFixture(t);
		await writeFakeBun(path.join(fixture.binDir, "bun"), "1.4.0");

		const result = runRunner(fixture);

		assert.equal(result.status, 0, result.stderr);
		const [first] = await readInvocations(fixture);
		assert.ok(first, "the runner did not start a test file");
		assert.notEqual(first.pathHead, fixture.binDir);
		await assert.rejects(fs.access(first.pathHead));
	},
);

test(
	"serial runner removes its bun shim directory when interrupted",
	noLinkDirectoryOnWindows,
	async (t) => {
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
	},
);

test("serial runner stops before running tests when no bun meets the pin", async (t) => {
	const fixture = await makeRunnerFixture(t);
	await writeFakeBun(path.join(fixture.binDir, "bun"), "1.3.11");

	const result = runRunner(fixture);

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /No bun 1\.4 or newer/);
	assert.match(
		result.stderr,
		/PATH \(.+[\\/]bin[\\/]bun(?:\.exe)?\): 1\.3\.11 is older than 1\.4/,
	);
	assert.match(result.stderr, /mise \(mise which bun\): mise not found/);
	assert.match(result.stderr, /Install the pinned release with `mise install`/);
	await assert.rejects(fs.access(fixture.invocationLog));
});

test("serial runner points at the mise config when the mise bun is older than the pin", async (t) => {
	const fixture = await makeRunnerFixture(t, "bun@1.5.0");
	const miseBun = await writeFakeBun(
		path.join(fixture.root, "mise-bun", "bun"),
		"1.4.0",
	);
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
