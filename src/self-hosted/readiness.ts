import {
	createOperationResult,
	type OperationResult,
} from "../operations/contract.js";
import {
	createPatchSurfaceReadiness,
	type PatchSurfaceReadiness,
} from "../profiles/readiness.js";

export const SELF_HOSTED_READINESS_SCHEMA_VERSION = 1 as const;

export const SELF_HOSTED_READINESS_GATE_IDS = [
	"organization-eligibility",
	"organization-enablement",
	"environment-key-boundary",
	"runner-host",
	"artifact-receipt",
	"image-digest",
	"image-secret-scan",
	"filesystem-isolation",
	"network-egress",
	"git-access",
	"repo-settings-guard",
	"wrapper-control-channel",
	"runner-registration",
	"runner-diagnostics",
	"child-binary-binding",
	"fixed-fleet-lifecycle",
	"on-demand-lifecycle",
	"end-to-end",
] as const;

export type SelfHostedReadinessGateId =
	(typeof SELF_HOSTED_READINESS_GATE_IDS)[number];

export type SelfHostedReadinessGateStatus =
	| "not-attested"
	| "not-provided"
	| "not-built"
	| "not-run";

export interface SelfHostedReadinessGate {
	id: SelfHostedReadinessGateId;
	status: SelfHostedReadinessGateStatus;
	evidenceRequired: string;
}

export interface SelfHostedReadinessPlan {
	schemaVersion: typeof SELF_HOSTED_READINESS_SCHEMA_VERSION;
	surface: "self-hosted-runner";
	profile: PatchSurfaceReadiness;
	hostPolicy: {
		supportedNativeHosts: ["linux", "darwin"];
		windows: "linux-container-required";
		versionLane: "runner-pinned";
		minimumVersion: "2.1.224";
	};
	artifact: {
		profile: "self-hosted-runner";
		status: "not-bound";
		matchingHostExecution: "not-bound";
	};
	image: {
		status: "not-bound";
		immutableDigest: null;
		registryPush: "not-run";
		secretsInImage: "forbidden";
	};
	wrapper: {
		status: "not-bound";
		binarySource: "CLAUDE_RUNNER_CLAUDE_BIN";
		handoff: "exec-required";
		stdin: "preserve-required";
		activityFileDescriptor: 3;
	};
	gates: SelfHostedReadinessGate[];
	clients: {
		web: "not-run";
		mobile: "not-run";
		desktop: "not-run";
		cli: "not-run";
	};
	readyForCandidateConstruction: boolean;
	readyForImageBuild: false;
	readyForDeployment: false;
	readyForSupportedUse: false;
	blockers: SelfHostedReadinessGateId[];
}

const GATE_DEFINITIONS: ReadonlyArray<
	SelfHostedReadinessGate & { status: SelfHostedReadinessGateStatus }
> = [
	{
		id: "organization-eligibility",
		status: "not-attested",
		evidenceRequired:
			"An authorized operator confirms an eligible organization plan.",
	},
	{
		id: "organization-enablement",
		status: "not-attested",
		evidenceRequired:
			"An authorized owner or administrator confirms the feature is enabled.",
	},
	{
		id: "environment-key-boundary",
		status: "not-provided",
		evidenceRequired:
			"A secret-handling design keeps registration material out of durable evidence and session-running images.",
	},
	{
		id: "runner-host",
		status: "not-run",
		evidenceRequired:
			"A matching Linux or macOS host validates the exact pinned runner artifact.",
	},
	{
		id: "artifact-receipt",
		status: "not-provided",
		evidenceRequired:
			"A path-free receipt binds the exact self-hosted profile, version, platform, hash, and runtime roster.",
	},
	{
		id: "image-digest",
		status: "not-provided",
		evidenceRequired:
			"An immutable image digest binds the exact verified runner artifact and declared base image.",
	},
	{
		id: "image-secret-scan",
		status: "not-run",
		evidenceRequired:
			"Image history and layers pass a sensitive-material scan before promotion.",
	},
	{
		id: "filesystem-isolation",
		status: "not-attested",
		evidenceRequired:
			"Per-session filesystem isolation and read-only operator configuration are demonstrated.",
	},
	{
		id: "network-egress",
		status: "not-attested",
		evidenceRequired:
			"Default-deny outbound policy permits only required control, source, and operator-approved destinations.",
	},
	{
		id: "git-access",
		status: "not-attested",
		evidenceRequired:
			"Clone and outcome access use bounded non-interactive authorization appropriate to each session.",
	},
	{
		id: "repo-settings-guard",
		status: "not-attested",
		evidenceRequired:
			"Repository settings cannot weaken the operator's filesystem, environment, sandbox, or hooks posture.",
	},
	{
		id: "wrapper-control-channel",
		status: "not-run",
		evidenceRequired:
			"The wrapper execs the runner-provided binary while preserving stdin and file descriptor 3.",
	},
	{
		id: "runner-registration",
		status: "not-run",
		evidenceRequired:
			"The exact pinned runner registers with an authorized test environment.",
	},
	{
		id: "runner-diagnostics",
		status: "not-run",
		evidenceRequired:
			"Installed-version help, health, metrics, logs, and official diagnostics pass on the matching host.",
	},
	{
		id: "child-binary-binding",
		status: "not-run",
		evidenceRequired:
			"A real session proves the runner and child use the same pinned patched binary and exact roster.",
	},
	{
		id: "fixed-fleet-lifecycle",
		status: "not-run",
		evidenceRequired:
			"Startup, capacity, drain, release, shutdown, restart, and rollback pass for a fixed fleet.",
	},
	{
		id: "on-demand-lifecycle",
		status: "not-run",
		evidenceRequired:
			"Spawn, single-use work order, deduplication, retirement, and cleanup pass for on-demand runners.",
	},
	{
		id: "end-to-end",
		status: "not-run",
		evidenceRequired:
			"A dedicated test environment completes initial prompt, tool, diff, result, follow-up, and resume probes.",
	},
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createSelfHostedReadinessPlan(): SelfHostedReadinessPlan {
	const profile = createPatchSurfaceReadiness("self-hosted-runner");
	const readyForCandidateConstruction =
		profile.profile === "self-hosted-runner" &&
		profile.summary.total === 46 &&
		profile.summary.supported === 0 &&
		profile.summary.probeRequired === 31 &&
		profile.summary.excluded === 15 &&
		profile.summary.notAssessed === 0 &&
		!profile.selectable;
	const gates = GATE_DEFINITIONS.map((gate) => ({ ...gate }));
	return {
		schemaVersion: SELF_HOSTED_READINESS_SCHEMA_VERSION,
		surface: "self-hosted-runner",
		profile,
		hostPolicy: {
			supportedNativeHosts: ["linux", "darwin"],
			windows: "linux-container-required",
			versionLane: "runner-pinned",
			minimumVersion: "2.1.224",
		},
		artifact: {
			profile: "self-hosted-runner",
			status: "not-bound",
			matchingHostExecution: "not-bound",
		},
		image: {
			status: "not-bound",
			immutableDigest: null,
			registryPush: "not-run",
			secretsInImage: "forbidden",
		},
		wrapper: {
			status: "not-bound",
			binarySource: "CLAUDE_RUNNER_CLAUDE_BIN",
			handoff: "exec-required",
			stdin: "preserve-required",
			activityFileDescriptor: 3,
		},
		gates,
		clients: {
			web: "not-run",
			mobile: "not-run",
			desktop: "not-run",
			cli: "not-run",
		},
		readyForCandidateConstruction,
		readyForImageBuild: false,
		readyForDeployment: false,
		readyForSupportedUse: false,
		blockers: gates.map(({ id }) => id),
	};
}

export function validateSelfHostedReadinessEvidence(
	value: unknown,
): SelfHostedReadinessPlan {
	if (!isRecord(value)) {
		throw new Error("Self-hosted readiness evidence must be an object");
	}
	if (value.schemaVersion !== SELF_HOSTED_READINESS_SCHEMA_VERSION) {
		throw new Error("Unsupported self-hosted readiness evidence schemaVersion");
	}
	const expected = createSelfHostedReadinessPlan();
	if (JSON.stringify(value) !== JSON.stringify(expected)) {
		throw new Error(
			"Self-hosted readiness evidence does not match the deterministic plan",
		);
	}
	return value as unknown as SelfHostedReadinessPlan;
}

export function createSelfHostedReadinessResult(
	plan: SelfHostedReadinessPlan,
): OperationResult<SelfHostedReadinessPlan> {
	return createOperationResult({
		operation: "self-hosted-readiness",
		ok: plan.readyForSupportedUse,
		data: plan,
		checks: [
			{
				id: "profile-classified",
				status: plan.profile.summary.notAssessed === 0 ? "pass" : "fail",
			},
			{
				id: "candidate-construction",
				status: plan.readyForCandidateConstruction ? "pass" : "fail",
			},
			{ id: "artifact-receipt", status: "fail" },
			{ id: "image-build", status: "fail" },
			{ id: "wrapper-control-channel", status: "fail" },
			{ id: "organization-eligibility", status: "fail" },
			{ id: "runner-registration", status: "fail" },
			{ id: "runner-child-binding", status: "fail" },
			{ id: "end-to-end", status: "fail" },
			{ id: "client-web", status: "fail" },
			{ id: "client-mobile", status: "fail" },
			{ id: "client-desktop", status: "fail" },
			{ id: "supported-use", status: "fail" },
		],
		warnings: [
			{
				code: "self-hosted-not-supported",
				message:
					"Candidate construction is available, but an image receipt is not bound and deployment, runner-child, and client evidence remain closed.",
			},
		],
	});
}
