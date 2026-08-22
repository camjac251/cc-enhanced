import assert from "node:assert/strict";
import { test } from "node:test";
import type { OperationResult } from "../operations/contract.js";
import type { SelfHostedWrapperReceipt } from "../self-hosted/wrapper.js";
import { renderSelfHostedWrapper } from "./self-hosted-wrapper.js";

test("wrapper renderer reports synthetic proof without a runner claim", () => {
	const result = {
		operation: "self-hosted-wrapper-probe",
		ok: true,
		data: {
			wrapper: {
				scriptSha256: "a".repeat(64),
				binarySource: "CLAUDE_RUNNER_CLAUDE_BIN",
				sourceRequirement: "absolute",
				handoff: "exec",
			},
			probe: {
				kind: "synthetic-posix-helper",
				stdin: "pass",
				activityFileDescriptor3: "pass",
				pidExecHandoff: "pass",
				signal: "pass",
				exitCode: "pass",
			},
			staticChecks: {
				shellcheck: { status: "pass" },
				shfmt: { status: "pass" },
			},
			boundaries: {
				imageIntegration: "not-run",
				runnerProvidedBinary: "not-run",
				runnerStart: "not-run",
				childSession: "not-run",
			},
		},
	} as unknown as OperationResult<SelfHostedWrapperReceipt>;
	const output = renderSelfHostedWrapper(result).join("\n");

	assert.match(output, /Self-hosted Runner Wrapper/);
	assert.match(output, /Handoff:\s+exec/);
	assert.match(output, /stdin:\s+pass/i);
	assert.match(output, /file descriptor 3:\s+pass/i);
	assert.match(output, /PID\/signal:\s+pass\/pass/i);
	assert.match(output, /Runner-provided binary:\s+not-run/i);
	assert.match(output, /Runner start:\s+not-run/i);
});
