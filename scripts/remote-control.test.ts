import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { validateRemoteControlReadinessEvidence } from "../src/remote-control/readiness.js";

const scriptPath = path.join(process.cwd(), "scripts", "remote-control.ts");
const blockerKeys = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX",
	"CLAUDE_CODE_USE_FOUNDRY",
	"CLAUDE_CODE_USE_GATEWAY",
	"ANTHROPIC_BASE_URL",
	"DISABLE_TELEMETRY",
	"DO_NOT_TRACK",
	"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
	"DISABLE_GROWTHBOOK",
] as const;

function controlledEnv(
	extra: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
	const env = { ...process.env, ...extra };
	for (const key of blockerKeys) {
		if (!(key in extra)) delete env[key];
	}
	return env;
}

function run(args: readonly string[], env = controlledEnv()) {
	return spawnSync(process.execPath, [scriptPath, ...args], {
		cwd: process.cwd(),
		encoding: "utf8",
		env,
	});
}

test("Remote Control CLI defaults to a deterministic inspection-only plan", () => {
	const human = run([]);
	assert.equal(human.status, 1, human.stderr);
	assert.match(human.stdout, /Remote Control Probe Readiness/i);
	assert.match(human.stdout, /Live execution:\s+not run/i);

	const first = run(["--evidence"]);
	const second = run(["--evidence"]);
	assert.equal(first.status, 1, first.stderr);
	assert.equal(second.status, 1, second.stderr);
	assert.equal(first.stdout, second.stdout);
	const evidence = validateRemoteControlReadinessEvidence(
		JSON.parse(first.stdout),
	);
	assert.equal(evidence.readyForProbeLaunch, false);
	assert.equal(evidence.readyForSupportedUse, false);
	assert.doesNotMatch(
		first.stdout,
		/(?:\/home\/|[A-Z]:\\|"(?:settingsPath|binaryPath|processId|sessionId|sessionUrl|credential)"\s*:|https?:\/\/)/i,
	);

	const json = run(["--json"]);
	assert.equal(json.status, 1, json.stderr);
	const operation = JSON.parse(json.stdout) as Record<string, unknown>;
	assert.equal(operation.operation, "remote-control-readiness");
	assert.equal(operation.ok, false);
});

test("doctor reports blocker IDs without exposing environment values", () => {
	const sentinel = "private-doctor-value";
	const result = run(
		["--doctor", "--json"],
		controlledEnv({ DISABLE_TELEMETRY: sentinel }),
	);
	assert.equal(result.status, 1, result.stderr);
	assert.match(result.stdout, /feature-disable-telemetry/);
	assert.doesNotMatch(result.stdout, new RegExp(sentinel));
});

test("start refuses missing invocation-time consent before any live launch", () => {
	const result = run(["--doctor", "--start", "--authorize-live-start"]);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /transcript storage acknowledgement/i);
	assert.doesNotMatch(result.stdout, /https?:\/\//i);
});

test("Remote Control CLI keeps evidence and operation JSON mutually exclusive", () => {
	const result = run(["--evidence", "--json"]);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /evidence|json|conflict/i);
});

test("package and task aliases keep planning default and live start explicit", async () => {
	const packageJson = JSON.parse(
		await readFile(path.join(process.cwd(), "package.json"), "utf8"),
	) as { scripts: Record<string, string> };
	assert.equal(
		packageJson.scripts["remote:plan"],
		"bun scripts/remote-control.ts",
	);
	assert.equal(
		packageJson.scripts["remote:doctor"],
		"bun scripts/remote-control.ts --doctor",
	);
	assert.equal(
		packageJson.scripts["remote:start"],
		"bun scripts/remote-control.ts --doctor --start",
	);
	assert.equal(
		packageJson.scripts["remote:artifacts"],
		"bun scripts/verify-native-artifact-matrix.ts --profile remote-control",
	);
	assert.equal(
		packageJson.scripts["remote:host"],
		"bun scripts/verify-native-host.ts --expected-profile remote-control",
	);
	const mise = await readFile(path.join(process.cwd(), "mise.toml"), "utf8");
	assert.match(mise, /\[tasks\."remote:plan"\]/);
	assert.match(mise, /\[tasks\."remote:doctor"\]/);
	assert.match(mise, /\[tasks\."remote:start"\]/);
	assert.match(mise, /\[tasks\."remote:artifacts"\]/);
	assert.match(mise, /\[tasks\."remote:host"\]/);
});
