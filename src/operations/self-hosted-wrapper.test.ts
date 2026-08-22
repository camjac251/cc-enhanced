import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	createAndProbeSelfHostedWrapper,
	runSyntheticWrapperControlChannelProbe,
	type SelfHostedWrapperProbeExecutor,
} from "./self-hosted-wrapper.js";

const successfulExecutor: SelfHostedWrapperProbeExecutor = {
	async runStaticChecks() {
		return {
			shellcheck: { version: "0.9.0", status: "pass" },
			shfmt: { version: "3.11.0", status: "pass" },
		};
	},
	async runControlChannelProbe() {
		return {
			kind: "synthetic-posix-helper",
			unsetSourceGuard: "pass",
			relativeSourceGuard: "pass",
			argv: "pass",
			environment: "pass",
			stdin: "pass",
			activityFileDescriptor3: "pass",
			pidExecHandoff: "pass",
			exitCode: "pass",
			signal: "pass",
		};
	},
};

test("wrapper operation writes one new executable and emits a path-free receipt", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "cc-enhanced-wrapper-"));
	try {
		const wrapperOutput = path.join(root, "exec-claude");
		const result = await createAndProbeSelfHostedWrapper(
			{ wrapperOutput, allowedOutputRoot: root },
			{
				executor: successfulExecutor,
				now: () => "2026-08-22T11:00:00.000Z",
			},
		);

		assert.equal(result.operation, "self-hosted-wrapper-probe");
		assert.equal(result.ok, true);
		assert.equal(result.data.wrapper.handoff, "exec");
		assert.equal(result.data.probe.activityFileDescriptor3, "pass");
		assert.equal(result.data.boundaries.runnerStart, "not-run");
		assert.equal((await fs.stat(wrapperOutput)).mode & 0o777, 0o755);
		assert.match(
			await fs.readFile(wrapperOutput, "utf8"),
			/exec "\$CLAUDE_RUNNER_CLAUDE_BIN" "\$@"/,
		);
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});

test("wrapper operation refuses an existing output before probing", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "cc-enhanced-wrapper-"));
	try {
		const wrapperOutput = path.join(root, "exec-claude");
		await fs.writeFile(wrapperOutput, "existing");
		await assert.rejects(
			createAndProbeSelfHostedWrapper(
				{ wrapperOutput, allowedOutputRoot: root },
				{ executor: successfulExecutor },
			),
			/already exists/i,
		);
		assert.equal(await fs.readFile(wrapperOutput, "utf8"), "existing");
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});

test("synthetic wrapper probe preserves every declared control channel", async () => {
	if (process.platform === "win32") return;
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "cc-enhanced-wrapper-"));
	try {
		const wrapperOutput = path.join(root, "exec-claude");
		const result = await createAndProbeSelfHostedWrapper(
			{ wrapperOutput, allowedOutputRoot: root },
			{ executor: successfulExecutor },
		);
		assert.equal(result.ok, true);
		assert.deepEqual(
			await runSyntheticWrapperControlChannelProbe(wrapperOutput),
			await successfulExecutor.runControlChannelProbe(wrapperOutput),
		);
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});
