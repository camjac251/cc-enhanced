import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createSelfHostedWrapperScript,
	type SelfHostedWrapperReceipt,
	validateSelfHostedWrapperReceipt,
	validateSelfHostedWrapperScript,
} from "./wrapper.js";

const sha = (value: string): string => value.repeat(64);

function sampleReceipt(): SelfHostedWrapperReceipt {
	return {
		schemaVersion: 1,
		surface: "self-hosted-runner",
		wrapper: {
			scriptSha256: sha("a"),
			language: "posix-sh",
			binarySource: "CLAUDE_RUNNER_CLAUDE_BIN",
			sourceRequirement: "absolute",
			handoff: "exec",
		},
		staticChecks: {
			shellcheck: { version: "0.9.0", status: "pass" },
			shfmt: { version: "3.11.0", status: "pass" },
		},
		probe: {
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
		},
		boundaries: {
			imageIntegration: "not-run",
			runnerProvidedBinary: "not-run",
			environmentKey: "not-accessed",
			runnerStart: "not-run",
			childSession: "not-run",
			tokenRotation: "not-run",
			sessionAttachment: "not-run",
			controlPlaneTraffic: "not-sent",
			deployment: "not-run",
			endToEnd: "not-run",
			clientProbe: "not-run",
		},
		createdAt: "2026-08-22T11:00:00.000Z",
	};
}

test("wrapper script has one absolute-source guard and exact exec handoff", () => {
	const script = createSelfHostedWrapperScript();

	assert.equal(validateSelfHostedWrapperScript(script), script);
	assert.match(script, /^#!\/bin\/sh$/m);
	assert.match(script, /CLAUDE_RUNNER_CLAUDE_BIN/);
	assert.match(script, /exec "\$CLAUDE_RUNNER_CLAUDE_BIN" "\$@"/);
	assert.doesNotMatch(
		script,
		/self-hosted-runner|\beval\b|\bsource\b|\btrap\b|<&0|<&3|>&3|\|\||&&.*exec/,
	);

	for (const invalid of [
		script.replace("exec ", ""),
		script.replace('"$@"', '"$1"'),
		script.replace('"$CLAUDE_RUNNER_CLAUDE_BIN"', "claude"),
		`${script}echo unexpected\n`,
	]) {
		assert.throws(() => validateSelfHostedWrapperScript(invalid));
	}
});

test("wrapper receipt is strict, path-free, and synthetic-only", () => {
	const receipt = sampleReceipt();
	assert.deepEqual(validateSelfHostedWrapperReceipt(receipt), receipt);
	assert.doesNotMatch(JSON.stringify(receipt), /\/home\/|[A-Z]:\\|https?:\/\//);

	for (const invalid of [
		{ ...receipt, unexpected: "pass" },
		{ ...receipt, probe: { ...receipt.probe, unexpected: "pass" } },
		{ ...receipt, wrapper: { ...receipt.wrapper, handoff: "spawn" } },
		{
			...receipt,
			probe: { ...receipt.probe, activityFileDescriptor3: "not-run" },
		},
		{
			...receipt,
			boundaries: { ...receipt.boundaries, runnerStart: "pass" },
		},
		{ ...receipt, wrapper: { ...receipt.wrapper, scriptSha256: "/home/x" } },
	]) {
		assert.throws(() => validateSelfHostedWrapperReceipt(invalid));
	}
});
