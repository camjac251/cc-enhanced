import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const verifierPath = new URL("./verify-cache-efficiency.ts", import.meta.url)
	.pathname;

function verifierEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.ANTHROPIC_API_KEY;
	return env;
}

test("cache request-mode dry runs validate every diagnostic graph without credentials", {
	timeout: 30_000,
}, () => {
	for (const preset of ["main", "fork", "normal-agent", "workflow", "all"]) {
		const result = spawnSync(
			process.execPath,
			[verifierPath, "--preset", preset, "--cache-diagnostics", "--dry-run"],
			{
				cwd: process.cwd(),
				env: verifierEnv(),
				encoding: "utf-8",
			},
		);

		assert.equal(
			result.status,
			0,
			`${preset} failed:\nstdout=${result.stdout}\nstderr=${result.stderr}`,
		);
		assert.match(result.stdout, new RegExp(`Preset:\\s+${preset}`));
		assert.match(result.stdout, /cache-diagnosis-2026-04-07/);
		if (preset === "normal-agent") {
			assert.match(
				result.stdout,
				/TTL:\s+normal-agent\(stock=5m,patched=1h\)/,
				"the normal-agent preset must keep its public scenario name",
			);
		}
		if (preset === "all") {
			assert.match(
				result.stdout,
				/TTL:\s+main\(stock=1h,patched=1h\)/,
				"the all preset must include the main-agent scenario",
			);
		}
		assert.match(
			result.stdout,
			/PLAN OK: request graph and breakpoint preflight passed; efficiency was not measured/,
		);
		assert.doesNotMatch(result.stdout, /PASS: cache efficiency gate satisfied/);
	}
});

test("request-mode presets reject legacy TTL overrides instead of ignoring them", {
	timeout: 30_000,
}, () => {
	for (const [flag, value] of [
		["--ttl", "1h"],
		["--baseline-ttl", "1h"],
		["--patched-ttl", "5m"],
	]) {
		const result = spawnSync(
			process.execPath,
			[verifierPath, "--preset", "normal-agent", flag, value, "--dry-run"],
			{
				cwd: process.cwd(),
				env: verifierEnv(),
				encoding: "utf-8",
			},
		);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /TTL overrides are not supported/);
	}
});

test("workflow reports preserve schema lanes separately from conversation lineages", {
	timeout: 30_000,
}, async (t) => {
	const tempDir = await mkdtemp(path.join(os.tmpdir(), "cache-report-"));
	t.after(async () => rm(tempDir, { recursive: true, force: true }));
	const reportPath = path.join(tempDir, "report.json");
	const result = spawnSync(
		process.execPath,
		[
			verifierPath,
			"--preset",
			"workflow",
			"--dry-run",
			"--output-json",
			reportPath,
		],
		{
			cwd: process.cwd(),
			env: verifierEnv(),
			encoding: "utf-8",
		},
	);
	assert.equal(
		result.status,
		0,
		`stdout=${result.stdout}\nstderr=${result.stderr}`,
	);
	const report = JSON.parse(await readFile(reportPath, "utf8")) as any;
	assert.equal(report.options.ttl, null);
	assert.equal(report.options.baselineTtl, null);
	assert.equal(report.options.patchedTtl, null);
	assert.deepEqual(report.options.scenarioTtls.workflow, {
		stock: "5m",
		patched: "1h",
	});
	for (const policy of report.policies) {
		assert.deepEqual(
			policy.turns.map((turn: any) => turn.schemaLane),
			["unit", "unit", "surface"],
		);
		assert.equal(
			new Set(policy.turns.map((turn: any) => turn.lineage)).size,
			3,
		);
	}
});
