import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	acquireHeavyOperationGuard,
	withHeavyOperationGuard,
} from "./heavy-operation-guard.js";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

test("heavy operation guard refuses an independent overlapping operation", async () => {
	const first = await acquireHeavyOperationGuard({
		operation: "first-test-operation",
		port: 0,
		env: {},
	});

	try {
		await assert.rejects(
			acquireHeavyOperationGuard({
				operation: "second-test-operation",
				port: first.port,
				env: {},
			}),
			/first-test-operation.*already running/,
		);
	} finally {
		await first.release();
	}
});

test("nested heavy operations reuse the inherited guard lease", async () => {
	const env: NodeJS.ProcessEnv = {};
	const outer = await acquireHeavyOperationGuard({
		operation: "outer-test-operation",
		port: 0,
		env,
	});

	try {
		const nested = await acquireHeavyOperationGuard({
			operation: "nested-test-operation",
			port: outer.port,
			env,
		});
		await nested.release();
		assert.equal(nested.port, outer.port);
	} finally {
		await outer.release();
	}
});

test("an unrecognized inherited token is replaced by a real lease", async () => {
	const env: NodeJS.ProcessEnv = {
		CC_ENHANCED_HEAVY_OPERATION_TOKEN: "stale-or-forged-token",
	};

	const lease = await acquireHeavyOperationGuard({
		operation: "token-validation-test-operation",
		port: 0,
		env,
	});
	try {
		assert.notEqual(
			env.CC_ENHANCED_HEAVY_OPERATION_TOKEN,
			"stale-or-forged-token",
		);
	} finally {
		await lease.release();
	}
	assert.equal(env.CC_ENHANCED_HEAVY_OPERATION_TOKEN, undefined);
});

test("guarded work releases its lease when the operation fails", async () => {
	let port = 0;
	await assert.rejects(
		withHeavyOperationGuard(
			{
				operation: "failing-test-operation",
				port: 0,
				env: {},
			},
			(lease) => {
				port = lease.port;
				throw new Error("expected test failure");
			},
		),
		/expected test failure/,
	);

	const next = await acquireHeavyOperationGuard({
		operation: "follow-up-test-operation",
		port,
		env: {},
	});
	await next.release();
});

test("bundle diff entrypoint refuses overlap with another heavy operation", async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "heavy-guard-cli-"));
	const oldBundle = path.join(tempDir, "old.js");
	const newBundle = path.join(tempDir, "new.js");
	fs.writeFileSync(oldBundle, 'const state = "old fixture";\n');
	fs.writeFileSync(newBundle, 'const state = "new fixture";\n');

	const lease = await acquireHeavyOperationGuard({
		operation: "integration-test-operation",
		env: {},
	});
	try {
		const result = spawnSync(
			process.execPath,
			["src/diff.ts", oldBundle, newBundle, "--json"],
			{
				cwd: repoRoot,
				encoding: "utf8",
				env: process.env,
			},
		);
		assert.notEqual(result.status, 0);
		assert.match(
			`${result.stderr}${result.stdout}`,
			/integration-test-operation.*already running.*bundle diff/,
		);
	} finally {
		await lease.release();
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});
