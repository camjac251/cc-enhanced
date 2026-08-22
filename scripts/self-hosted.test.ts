import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { validateSelfHostedReadinessEvidence } from "../src/self-hosted/readiness.js";

const scriptPath = path.join(process.cwd(), "scripts", "self-hosted.ts");

function run(args: readonly string[]) {
	return spawnSync(process.execPath, [scriptPath, ...args], {
		cwd: process.cwd(),
		encoding: "utf8",
		env: process.env,
	});
}

test("self-hosted CLI defaults to a deterministic planning-only surface", () => {
	const human = run([]);
	assert.equal(human.status, 1, human.stderr);
	assert.match(human.stdout, /Self-hosted Runner Readiness/i);
	assert.match(human.stdout, /candidate construction:\s+ready/i);
	assert.match(human.stdout, /runner registration:\s+not-run/i);

	const first = run(["--evidence"]);
	const second = run(["--evidence"]);
	assert.equal(first.status, 1, first.stderr);
	assert.equal(second.status, 1, second.stderr);
	assert.equal(first.stdout, second.stdout);
	const evidence = validateSelfHostedReadinessEvidence(
		JSON.parse(first.stdout),
	);
	assert.equal(evidence.readyForCandidateConstruction, true);
	assert.equal(evidence.readyForImageBuild, false);
	assert.equal(evidence.readyForDeployment, false);
	assert.equal(evidence.readyForSupportedUse, false);
	assert.doesNotMatch(
		first.stdout,
		/(?:\/home\/|[A-Z]:\\|https?:\/\/|credential|environmentSecret|sessionId|accountId|organizationId)/i,
	);

	const json = run(["--json"]);
	assert.equal(json.status, 1, json.stderr);
	const operation = JSON.parse(json.stdout) as Record<string, unknown>;
	assert.equal(operation.operation, "self-hosted-readiness");
	assert.equal(operation.ok, false);
});

test("self-hosted CLI keeps evidence and operation JSON mutually exclusive", () => {
	const result = run(["--evidence", "--json"]);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /evidence|json|conflict/i);
});

test("package and task aliases expose planning without a runner start", async () => {
	const packageJson = JSON.parse(
		await readFile(path.join(process.cwd(), "package.json"), "utf8"),
	) as { scripts: Record<string, string> };
	assert.equal(
		packageJson.scripts["self-hosted:plan"],
		"bun scripts/self-hosted.ts",
	);
	assert.equal(
		packageJson.scripts["self-hosted:artifacts"],
		"bun scripts/verify-native-artifact-matrix.ts --profile self-hosted-runner --platform linux-x64 --platform linux-arm64 --platform linux-x64-musl --platform linux-arm64-musl --platform darwin-x64 --platform darwin-arm64",
	);
	assert.equal(
		packageJson.scripts["self-hosted:host"],
		"bun scripts/verify-native-host.ts --expected-profile self-hosted-runner",
	);
	assert.equal(
		packageJson.scripts["self-hosted:image"],
		"bun scripts/self-hosted-image.ts",
	);
	assert.equal(
		packageJson.scripts["self-hosted:wrapper"],
		"bun scripts/self-hosted-wrapper.ts",
	);
	assert.equal(
		packageJson.scripts["self-hosted:wrapper-image"],
		"bun scripts/self-hosted-wrapper-image.ts",
	);
	assert.equal(packageJson.scripts["self-hosted:start"], undefined);
	assert.equal(packageJson.scripts["self-hosted:deploy"], undefined);
	const mise = await readFile(path.join(process.cwd(), "mise.toml"), "utf8");
	assert.match(mise, /\[tasks\."self-hosted:plan"\]/);
	assert.match(mise, /\[tasks\."self-hosted:artifacts"\]/);
	assert.match(mise, /\[tasks\."self-hosted:host"\]/);
	assert.match(mise, /\[tasks\."self-hosted:image"\]/);
	assert.match(mise, /\[tasks\."self-hosted:wrapper"\]/);
	assert.match(mise, /\[tasks\."self-hosted:wrapper-image"\]/);
	assert.doesNotMatch(mise, /\[tasks\."self-hosted:(?:start|deploy)"\]/);
});
