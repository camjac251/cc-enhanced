import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

const scriptPath = path.join(
	process.cwd(),
	"scripts",
	"self-hosted-wrapper.ts",
);

test("wrapper CLI exposes only candidate and receipt outputs", () => {
	const result = spawnSync("bun", [scriptPath, "--help"], {
		cwd: process.cwd(),
		encoding: "utf8",
	});

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /--wrapper-output/);
	assert.match(result.stdout, /--receipt/);
	assert.match(result.stdout, /--json/);
	assert.doesNotMatch(
		result.stdout,
		/--(?:binary|environment-key|image|runner|deploy|client)/,
	);
});

test("wrapper command has package and mise aliases without a runner start", () => {
	const packageJson = JSON.parse(
		readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
	) as { scripts: Record<string, string> };
	const mise = readFileSync(path.join(process.cwd(), "mise.toml"), "utf8");

	assert.equal(
		packageJson.scripts["self-hosted:wrapper"],
		"bun scripts/self-hosted-wrapper.ts",
	);
	assert.equal(packageJson.scripts["self-hosted:start"], undefined);
	assert.match(mise, /\[tasks\."self-hosted:wrapper"\]/);
	assert.doesNotMatch(mise, /\[tasks\."self-hosted:start"\]/);
});
