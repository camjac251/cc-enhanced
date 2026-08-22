import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { test } from "node:test";

const scriptPath = path.join(
	process.cwd(),
	"scripts",
	"verify-native-artifact-matrix.ts",
);

test("native artifact matrix help exposes explicit repeatable platform coverage", () => {
	const result = spawnSync(process.execPath, [scriptPath, "--help"], {
		cwd: process.cwd(),
		encoding: "utf8",
		env: process.env,
	});

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /--platform/);
	assert.match(result.stdout, /repeatable|subset/i);
	assert.match(result.stdout, /self-hosted-runner/);
});
