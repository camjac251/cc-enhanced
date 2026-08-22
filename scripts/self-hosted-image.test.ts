import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

const scriptPath = path.join(process.cwd(), "scripts", "self-hosted-image.ts");

test("self-hosted image CLI exposes only offline-base construction inputs", () => {
	const result = spawnSync("bun", [scriptPath, "--help"], {
		cwd: process.cwd(),
		encoding: "utf8",
	});

	assert.equal(result.status, 0, result.stderr);
	for (const option of [
		"--matrix-receipt",
		"--host-receipt",
		"--artifact",
		"--context-dir",
		"--base-image",
		"--receipt",
		"--json",
	]) {
		assert.match(result.stdout, new RegExp(option));
	}
	assert.doesNotMatch(
		result.stdout,
		/--(?:push|tag|environment-key|organization|start-runner|deploy)/,
	);
});

test("self-hosted image command has package and mise aliases without a start alias", () => {
	const packageJson = JSON.parse(
		readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
	) as { scripts: Record<string, string> };
	const mise = readFileSync(path.join(process.cwd(), "mise.toml"), "utf8");

	assert.equal(
		packageJson.scripts["self-hosted:image"],
		"bun scripts/self-hosted-image.ts",
	);
	assert.equal(packageJson.scripts["self-hosted:start"], undefined);
	assert.equal(packageJson.scripts["self-hosted:deploy"], undefined);
	assert.match(mise, /\[tasks\."self-hosted:image"\]/);
	assert.doesNotMatch(mise, /\[tasks\."self-hosted:(?:start|deploy)"\]/);
});
