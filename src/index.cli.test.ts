import assert from "node:assert/strict";
import { type ExecFileException, execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PROMPT_SURFACE_DRIFT_PATHS } from "./verification/prompt-surface-rules.js";

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

test("--structural-evidence requires --summary-path", async () => {
	try {
		await execFileAsync(
			process.execPath,
			["./src/index.ts", "--structural-evidence"],
			{
				cwd: repoRoot,
				env: { ...process.env, NO_COLOR: "1" },
				encoding: "utf-8",
			},
		);
		assert.fail("expected structural evidence without a summary path to fail");
	} catch (error) {
		const childError = error as ExecFileException & {
			stderr?: string | Buffer;
			stdout?: string | Buffer;
		};
		const combined = `${String(childError.stdout ?? "")}\n${String(
			childError.stderr ?? "",
		)}`;
		assert.notEqual(childError.code, 0);
		// yargs wording differs across releases for implies() violations.
		assert.match(combined, /Implications failed|Missing dependent arguments/);
		assert.match(combined, /structural-evidence -> summary-path/);
	}
});

test("--list resolves environment patch selection overrides at runtime", async () => {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		NO_COLOR: "1",
		CLAUDE_PATCHER_INCLUDE_TAGS: "read-bat,signature",
	};
	delete env.CLAUDE_PATCHER_EXCLUDE_TAGS;

	const { stdout } = await execFileAsync(
		process.execPath,
		["./src/index.ts", "--list"],
		{
			cwd: repoRoot,
			env,
			encoding: "utf-8",
		},
	);

	assert.match(stdout, /read-bat/);
	assert.match(stdout, /signature/);
	assert.doesNotMatch(stdout, /shell-quote-fix/);
	assert.doesNotMatch(stdout, /tools-off-desktop/);
	assert.match(stdout, /Total: 2 patches/);
});

test("--list rejects an unknown environment patch tag", async () => {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		NO_COLOR: "1",
		CLAUDE_PATCHER_INCLUDE_TAGS: "typo",
	};
	delete env.CLAUDE_PATCHER_EXCLUDE_TAGS;

	await assert.rejects(
		execFileAsync(process.execPath, ["./src/index.ts", "--list"], {
			cwd: repoRoot,
			env,
			encoding: "utf-8",
		}),
		(error: ExecFileException & { stderr?: string | Buffer }) => {
			assert.notEqual(error.code, 0);
			assert.match(
				String(error.stderr ?? ""),
				/unknown include override patch tag: typo/i,
			);
			return true;
		},
	);
});

test("--list keeps the cli-full roster at 45 patches", async () => {
	const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
	delete env.CLAUDE_PATCHER_INCLUDE_TAGS;
	delete env.CLAUDE_PATCHER_EXCLUDE_TAGS;

	const { stdout } = await execFileAsync(
		process.execPath,
		["./src/index.ts", "--list"],
		{
			cwd: repoRoot,
			env,
			encoding: "utf-8",
		},
	);

	assert.match(stdout, /tools-off/);
	assert.doesNotMatch(stdout, /tools-off-desktop/);
	assert.match(stdout, /Total: 45 patches/);
});

test("CLI rejects profiles that do not have a verified implementation", async () => {
	try {
		await execFileAsync(
			process.execPath,
			["./src/index.ts", "--profile", "desktop-local", "--list"],
			{
				cwd: repoRoot,
				env: { ...process.env, NO_COLOR: "1" },
				encoding: "utf-8",
			},
		);
		assert.fail("expected an unsupported patch profile to fail");
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
			/Unknown patch profile "desktop-local"\. Available profiles: cli-full/,
		);
	}
});

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
				"--native-fetch-only",
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

test("prompts:drift-baseline keeps the export directory positional", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-drift-cli-"));
	const exportDir = path.join(tempDir, "export");
	const baselinePath = path.join(tempDir, "baseline.json");

	try {
		for (const relativePath of PROMPT_SURFACE_DRIFT_PATHS) {
			const surfacePath = path.join(exportDir, relativePath);
			await fs.mkdir(path.dirname(surfacePath), { recursive: true });
			await fs.writeFile(
				surfacePath,
				`# ${relativePath}\nStable prompt surface.\n`,
				"utf8",
			);
		}

		const { stdout } = await execFileAsync(
			process.execPath,
			[
				"run",
				"prompts:drift-baseline",
				"--",
				"--prompt-drift-baseline",
				baselinePath,
				exportDir,
				"--prompt-drift-version",
				"2.1.test",
			],
			{
				cwd: repoRoot,
				env: { ...process.env, NO_COLOR: "1" },
				encoding: "utf-8",
			},
		);

		assert.match(stdout, /Prompt drift baseline written to/);
		const baseline = JSON.parse(await fs.readFile(baselinePath, "utf8"));
		assert.equal(baseline.version, "2.1.test");
		assert.deepEqual(
			Object.keys(baseline.surfaces).sort(),
			[...PROMPT_SURFACE_DRIFT_PATHS].sort(),
		);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});
