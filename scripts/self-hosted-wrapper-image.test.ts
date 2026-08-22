import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

const scriptPath = path.join(
	process.cwd(),
	"scripts",
	"self-hosted-wrapper-image.ts",
);

test("wrapper image CLI exposes only receipt-bound offline inputs", () => {
	const result = spawnSync("bun", [scriptPath, "--help"], {
		cwd: process.cwd(),
		encoding: "utf8",
	});

	assert.equal(result.status, 0, result.stderr);
	for (const option of [
		"--parent-receipt",
		"--wrapper-receipt",
		"--wrapper",
		"--context-dir",
		"--receipt",
		"--json",
	]) {
		assert.match(result.stdout, new RegExp(option));
	}
	assert.doesNotMatch(
		result.stdout,
		/--(?:push|tag|environment-key|organization|start-runner|doctor|deploy)/,
	);
});

test("wrapper image command has package and mise aliases without live aliases", () => {
	const packageJson = JSON.parse(
		readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
	) as { scripts: Record<string, string> };
	const mise = readFileSync(path.join(process.cwd(), "mise.toml"), "utf8");

	assert.equal(
		packageJson.scripts["self-hosted:wrapper-image"],
		"bun scripts/self-hosted-wrapper-image.ts",
	);
	assert.equal(packageJson.scripts["self-hosted:start"], undefined);
	assert.equal(packageJson.scripts["self-hosted:doctor"], undefined);
	assert.equal(packageJson.scripts["self-hosted:deploy"], undefined);
	assert.match(mise, /\[tasks\."self-hosted:wrapper-image"\]/);
	assert.doesNotMatch(mise, /\[tasks\."self-hosted:(?:start|doctor|deploy)"\]/);
});
