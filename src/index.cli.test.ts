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
			["--import", "tsx", "./src/index.ts", "--definitely-unknown-flag"],
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
