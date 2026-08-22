export const SELF_HOSTED_WRAPPER_RECEIPT_SCHEMA_VERSION = 1 as const;

const WRAPPER_SCRIPT = `#!/bin/sh
set -eu

: "\${CLAUDE_RUNNER_CLAUDE_BIN:?CLAUDE_RUNNER_CLAUDE_BIN must be set}"
case "$CLAUDE_RUNNER_CLAUDE_BIN" in
/*) ;;
*)
	printf '%s\\n' 'CLAUDE_RUNNER_CLAUDE_BIN must be absolute' >&2
	exit 64
	;;
esac
exec "$CLAUDE_RUNNER_CLAUDE_BIN" "$@"
`;

const SHA256_RE = /^[a-f0-9]{64}$/;
const LOCAL_PATH_RE = /(?:\/home\/|\/Users\/|[A-Za-z]:\\Users\\)/;
const SENSITIVE_VALUE_RE =
	/(?:ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_ENVIRONMENT_KEY|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:password|token|secret|api[_-]?key)\s*[=:])/i;

export interface SelfHostedWrapperStaticChecks {
	shellcheck: { version: string; status: "pass" };
	shfmt: { version: string; status: "pass" };
}

export interface SelfHostedWrapperProbeEvidence {
	kind: "synthetic-posix-helper";
	unsetSourceGuard: "pass";
	relativeSourceGuard: "pass";
	argv: "pass";
	environment: "pass";
	stdin: "pass";
	activityFileDescriptor3: "pass";
	pidExecHandoff: "pass";
	exitCode: "pass";
	signal: "pass";
}

export interface SelfHostedWrapperReceipt {
	schemaVersion: typeof SELF_HOSTED_WRAPPER_RECEIPT_SCHEMA_VERSION;
	surface: "self-hosted-runner";
	wrapper: {
		scriptSha256: string;
		language: "posix-sh";
		binarySource: "CLAUDE_RUNNER_CLAUDE_BIN";
		sourceRequirement: "absolute";
		handoff: "exec";
	};
	staticChecks: SelfHostedWrapperStaticChecks;
	probe: SelfHostedWrapperProbeEvidence;
	boundaries: {
		imageIntegration: "not-run";
		runnerProvidedBinary: "not-run";
		environmentKey: "not-accessed";
		runnerStart: "not-run";
		childSession: "not-run";
		tokenRotation: "not-run";
		sessionAttachment: "not-run";
		controlPlaneTraffic: "not-sent";
		deployment: "not-run";
		endToEnd: "not-run";
		clientProbe: "not-run";
	};
	createdAt: string;
}

export function createSelfHostedWrapperScript(): string {
	return WRAPPER_SCRIPT;
}

export function validateSelfHostedWrapperScript(script: string): string {
	if (script !== WRAPPER_SCRIPT) {
		throw new Error(
			"Self-hosted wrapper does not match the canonical exec form",
		);
	}
	return script;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
	value: Record<string, unknown>,
	expected: readonly string[],
): boolean {
	const keys = Object.keys(value);
	return (
		keys.length === expected.length &&
		expected.every((key) => Object.hasOwn(value, key))
	);
}

function collectStringValues(value: unknown, output: string[]): void {
	if (typeof value === "string") {
		output.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectStringValues(item, output);
		return;
	}
	if (isRecord(value)) {
		for (const item of Object.values(value)) collectStringValues(item, output);
	}
}

function allPass(value: Record<string, unknown>): boolean {
	return Object.values(value).every((status) => status === "pass");
}

export function validateSelfHostedWrapperReceipt(
	value: unknown,
): SelfHostedWrapperReceipt {
	if (!isRecord(value)) {
		throw new Error("Self-hosted wrapper receipt must be an object");
	}
	if (
		!hasExactKeys(value, [
			"schemaVersion",
			"surface",
			"wrapper",
			"staticChecks",
			"probe",
			"boundaries",
			"createdAt",
		])
	) {
		throw new Error("Self-hosted wrapper receipt fields are inconsistent");
	}
	if (value.schemaVersion !== SELF_HOSTED_WRAPPER_RECEIPT_SCHEMA_VERSION) {
		throw new Error("Unsupported self-hosted wrapper receipt schemaVersion");
	}
	if (value.surface !== "self-hosted-runner") {
		throw new Error("Self-hosted wrapper receipt surface is inconsistent");
	}
	const receipt = value as unknown as SelfHostedWrapperReceipt;
	if (
		!isRecord(receipt.wrapper) ||
		!hasExactKeys(receipt.wrapper, [
			"scriptSha256",
			"language",
			"binarySource",
			"sourceRequirement",
			"handoff",
		]) ||
		!SHA256_RE.test(receipt.wrapper.scriptSha256) ||
		receipt.wrapper.language !== "posix-sh" ||
		receipt.wrapper.binarySource !== "CLAUDE_RUNNER_CLAUDE_BIN" ||
		receipt.wrapper.sourceRequirement !== "absolute" ||
		receipt.wrapper.handoff !== "exec"
	) {
		throw new Error("Self-hosted wrapper contract evidence is inconsistent");
	}
	if (
		!isRecord(receipt.staticChecks) ||
		!hasExactKeys(receipt.staticChecks, ["shellcheck", "shfmt"]) ||
		!isRecord(receipt.staticChecks.shellcheck) ||
		!hasExactKeys(receipt.staticChecks.shellcheck, ["version", "status"]) ||
		!isRecord(receipt.staticChecks.shfmt) ||
		!hasExactKeys(receipt.staticChecks.shfmt, ["version", "status"]) ||
		!receipt.staticChecks.shellcheck.version.trim() ||
		!receipt.staticChecks.shfmt.version.trim() ||
		receipt.staticChecks.shellcheck.status !== "pass" ||
		receipt.staticChecks.shfmt.status !== "pass"
	) {
		throw new Error("Self-hosted wrapper static evidence is incomplete");
	}
	if (
		!isRecord(receipt.probe) ||
		!hasExactKeys(receipt.probe, [
			"kind",
			"unsetSourceGuard",
			"relativeSourceGuard",
			"argv",
			"environment",
			"stdin",
			"activityFileDescriptor3",
			"pidExecHandoff",
			"exitCode",
			"signal",
		]) ||
		receipt.probe.kind !== "synthetic-posix-helper" ||
		!allPass({
			unsetSourceGuard: receipt.probe.unsetSourceGuard,
			relativeSourceGuard: receipt.probe.relativeSourceGuard,
			argv: receipt.probe.argv,
			environment: receipt.probe.environment,
			stdin: receipt.probe.stdin,
			activityFileDescriptor3: receipt.probe.activityFileDescriptor3,
			pidExecHandoff: receipt.probe.pidExecHandoff,
			exitCode: receipt.probe.exitCode,
			signal: receipt.probe.signal,
		})
	) {
		throw new Error("Self-hosted wrapper synthetic probe is incomplete");
	}
	if (
		!isRecord(receipt.boundaries) ||
		!hasExactKeys(receipt.boundaries, [
			"imageIntegration",
			"runnerProvidedBinary",
			"environmentKey",
			"runnerStart",
			"childSession",
			"tokenRotation",
			"sessionAttachment",
			"controlPlaneTraffic",
			"deployment",
			"endToEnd",
			"clientProbe",
		]) ||
		receipt.boundaries.imageIntegration !== "not-run" ||
		receipt.boundaries.runnerProvidedBinary !== "not-run" ||
		receipt.boundaries.environmentKey !== "not-accessed" ||
		receipt.boundaries.runnerStart !== "not-run" ||
		receipt.boundaries.childSession !== "not-run" ||
		receipt.boundaries.tokenRotation !== "not-run" ||
		receipt.boundaries.sessionAttachment !== "not-run" ||
		receipt.boundaries.controlPlaneTraffic !== "not-sent" ||
		receipt.boundaries.deployment !== "not-run" ||
		receipt.boundaries.endToEnd !== "not-run" ||
		receipt.boundaries.clientProbe !== "not-run"
	) {
		throw new Error("Self-hosted wrapper live boundaries are inconsistent");
	}
	if (Number.isNaN(Date.parse(receipt.createdAt))) {
		throw new Error(
			"Self-hosted wrapper receipt createdAt must be an ISO timestamp",
		);
	}
	const strings: string[] = [];
	collectStringValues(receipt, strings);
	if (strings.some((item) => LOCAL_PATH_RE.test(item))) {
		throw new Error("Self-hosted wrapper receipt contains a host-local path");
	}
	if (strings.some((item) => SENSITIVE_VALUE_RE.test(item))) {
		throw new Error("Self-hosted wrapper receipt contains sensitive material");
	}
	return receipt;
}
