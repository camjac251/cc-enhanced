import type { OperationResult } from "../operations/contract.js";
import type { SelfHostedWrapperReceipt } from "../self-hosted/wrapper.js";

export function renderSelfHostedWrapper(
	result: OperationResult<SelfHostedWrapperReceipt>,
): string[] {
	const receipt = result.data;
	return [
		"",
		"Self-hosted Runner Wrapper",
		"",
		`  Script SHA-256:        ${receipt.wrapper.scriptSha256}`,
		`  Binary source:         ${receipt.wrapper.binarySource} (${receipt.wrapper.sourceRequirement})`,
		`  Handoff:               ${receipt.wrapper.handoff}`,
		`  stdin:                 ${receipt.probe.stdin}`,
		`  File descriptor 3:     ${receipt.probe.activityFileDescriptor3}`,
		`  PID/signal:            ${receipt.probe.pidExecHandoff}/${receipt.probe.signal}`,
		`  Exit code:             ${receipt.probe.exitCode}`,
		`  ShellCheck/shfmt:       ${receipt.staticChecks.shellcheck.status}/${receipt.staticChecks.shfmt.status}`,
		"",
		"  Live boundaries:",
		`    Image integration:     ${receipt.boundaries.imageIntegration}`,
		`    Runner-provided binary: ${receipt.boundaries.runnerProvidedBinary}`,
		`    Runner start:           ${receipt.boundaries.runnerStart}`,
		`    Child session:          ${receipt.boundaries.childSession}`,
		"",
	];
}
