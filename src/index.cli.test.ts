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
