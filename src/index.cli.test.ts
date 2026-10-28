import assert from "node:assert/strict";
import { type ExecFileException, execFile } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

test("CLI rejects unknown options", async () => {
	try {
		await execFileAsync(
			process.execPath,
			["./src/index.ts", "--definitely-unknown-flag"],
			{
				cwd: repoRoot,
				env: { ...process.env, NO_COLOR: "1" },
				encoding: "utf-8",
			},
		);
		assert.fail("expected CLI invocation to fail on unknown option");
	} catch (error) {
		const childError = error as ExecFileException & {
			stderr?: string | Buffer;
			stdout?: string | Buffer;
		};
		const stderr = String(childError.stderr ?? "");
		const stdout = String(childError.stdout ?? "");
		const combined = `${stdout}\n${stderr}`;
		assert.notEqual(childError.code, 0);
		assert.match(combined, /Unknown argument[s]?: definitely-unknown-flag/);
	}
});

test("CLI shows stock download and extraction usage without an action", async () => {
	const { stdout } = await execFileAsync(process.execPath, ["./src/index.ts"], {
		cwd: repoRoot,
		env: { ...process.env, NO_COLOR: "1" },
		encoding: "utf-8",
	});
	assert.match(stdout, /--native-fetch/);
	assert.match(stdout, /--native-pull/);
	assert.match(stdout, /--native-unpack/);
});

for (const scenario of [
	{
		name: "multiple explicit actions",
		args: ["--native-fetch", "--native-pull"],
		message: /Choose exactly one action/,
	},
	{
		name: "missing unpack paths",
		args: ["--native-unpack"],
		message: /requires exactly two positional paths/,
	},
	{
		name: "extra unpack paths",
		args: ["--native-unpack", "input", "output", "extra"],
		message: /requires exactly two positional paths/,
	},
	{
		name: "unexpected fetch positional input",
		args: ["--native-fetch", "1.2.3", "extra"],
		message: /Unexpected positional arguments/,
	},
	{
		name: "download options during unpack",
		args: ["--native-unpack", "input", "output", "--native-force-download"],
		message: /Download options require --native-fetch or --native-pull/,
	},
	{
		name: "pull output override during fetch",
		args: ["--native-fetch", "--native-pull-output-dir", "output"],
		message: /--native-pull-output-dir requires --native-pull/,
	},
	{
		name: "removed fetch-only alias",
		args: ["--native-fetch-only"],
		message: /Unknown argument[s]?: native-fetch-only/,
	},
]) {
	test(`CLI rejects ${scenario.name}`, async () => {
		await assert.rejects(
			execFileAsync(process.execPath, ["./src/index.ts", ...scenario.args], {
				cwd: repoRoot,
				env: { ...process.env, NO_COLOR: "1" },
				encoding: "utf-8",
			}),
			(error: ExecFileException & { stderr?: string | Buffer }) => {
				assert.notEqual(error.code, 0);
				assert.match(String(error.stderr ?? ""), scenario.message);
				return true;
			},
		);
	});
}

test("CLI rejects legacy native platform aliases before fetching", async () => {
	try {
		await execFileAsync(
			process.execPath,
			[
				"./src/index.ts",
				"--native-fetch",
				"1.2.3",
				"--native-platform",
				"windows-x64",
			],
			{
				cwd: repoRoot,
				env: { ...process.env, NO_COLOR: "1" },
				encoding: "utf-8",
			},
		);
		assert.fail("expected a legacy native platform alias to fail");
	} catch (error) {
		const childError = error as ExecFileException & {
			stderr?: string | Buffer;
			stdout?: string | Buffer;
		};
		const combined = `${String(childError.stdout ?? "")}\n${String(
			childError.stderr ?? "",
		)}`;
		assert.notEqual(childError.code, 0);
		assert.match(
			combined,
			/Unsupported native artifact platform "windows-x64"/,
		);
	}
});
