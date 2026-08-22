import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { test } from "node:test";
import { validatePatchSupportEvidence } from "../src/profiles/readiness.js";

const scriptPath = path.join(process.cwd(), "scripts", "profile-support.ts");

test("profile support CLI emits deterministic Desktop evidence", () => {
	const result = spawnSync(
		process.execPath,
		[scriptPath, "--surface", "desktop-local", "--evidence"],
		{ cwd: process.cwd(), encoding: "utf8", env: process.env },
	);
	assert.equal(result.status, 1, result.stderr);
	const evidence = JSON.parse(result.stdout) as Record<string, unknown>;
	assert.equal(evidence.schemaVersion, 1);
	assert.equal(evidence.surface, "desktop-local");
	assert.equal(evidence.selectable, false);
	assert.deepEqual(evidence.summary, {
		total: 46,
		supported: 0,
		probeRequired: 31,
		excluded: 15,
		notAssessed: 0,
	});
	assert.doesNotMatch(
		result.stdout,
		/(?:\/home\/|[A-Z]:\\|binaryPath|cacheRoot|processId|sessionId)/,
	);
});

test("Desktop evidence is deterministic and Remote evidence remains blocked", () => {
	const desktop = spawnSync(
		process.execPath,
		[scriptPath, "--surface", "desktop-local", "--evidence"],
		{ cwd: process.cwd(), encoding: "utf8", env: process.env },
	);
	const desktopAgain = spawnSync(
		process.execPath,
		[scriptPath, "--surface", "desktop-local", "--evidence"],
		{ cwd: process.cwd(), encoding: "utf8", env: process.env },
	);
	assert.equal(desktop.status, 1, desktop.stderr);
	assert.equal(desktopAgain.status, 1, desktopAgain.stderr);
	assert.equal(desktop.stdout, desktopAgain.stdout);

	const remote = spawnSync(
		process.execPath,
		[scriptPath, "--surface", "remote-control", "--evidence"],
		{ cwd: process.cwd(), encoding: "utf8", env: process.env },
	);
	assert.equal(remote.status, 1, remote.stderr);
	const evidence = validatePatchSupportEvidence(JSON.parse(remote.stdout));
	assert.equal(evidence.surface, "remote-control");
	assert.equal(evidence.profile, "remote-control");
	assert.equal(evidence.readiness, "blocked");
	assert.equal(evidence.selectable, false);
	assert.deepEqual(evidence.summary, {
		total: 46,
		supported: 0,
		probeRequired: 31,
		excluded: 15,
		notAssessed: 0,
	});
	assert.equal(evidence.requiredProbes.length, 16);
	assert.ok(
		evidence.requiredProbes.every(({ status }) => status === "not-run"),
	);
});

test("self-hosted evidence is complete, blocked, and path-free", () => {
	const generated = spawnSync(
		process.execPath,
		[scriptPath, "--surface", "self-hosted-runner", "--evidence"],
		{ cwd: process.cwd(), encoding: "utf8", env: process.env },
	);
	assert.equal(generated.status, 1, generated.stderr);
	const evidence = validatePatchSupportEvidence(JSON.parse(generated.stdout));
	assert.equal(evidence.surface, "self-hosted-runner");
	assert.equal(evidence.profile, "self-hosted-runner");
	assert.equal(evidence.readiness, "blocked");
	assert.equal(evidence.selectable, false);
	assert.deepEqual(evidence.summary, {
		total: 46,
		supported: 0,
		probeRequired: 31,
		excluded: 15,
		notAssessed: 0,
	});
	assert.equal(evidence.requiredProbes.length, 16);
	assert.ok(
		evidence.requiredProbes.every(({ status }) => status === "not-run"),
	);
	assert.doesNotMatch(
		generated.stdout,
		/(?:\/home\/|[A-Z]:\\|https?:\/\/|credential|environmentSecret|sessionId)/i,
	);
});

test("profile support CLI emits the shared operation envelope for cli-full", () => {
	const result = spawnSync(
		process.execPath,
		[scriptPath, "--surface", "cli", "--json"],
		{ cwd: process.cwd(), encoding: "utf8", env: process.env },
	);
	assert.equal(result.status, 0, result.stderr);
	const operation = JSON.parse(result.stdout) as Record<string, unknown>;
	assert.equal(operation.operation, "profile-support");
	assert.equal(operation.ok, true);
	assert.equal((operation.data as Record<string, unknown>).profile, "cli-full");
});

test("profile support CLI rejects an unknown surface", () => {
	const result = spawnSync(process.execPath, [scriptPath, "--surface", "gui"], {
		cwd: process.cwd(),
		encoding: "utf8",
		env: process.env,
	});
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /surface|choices/i);
});
