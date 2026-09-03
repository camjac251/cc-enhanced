import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createSelfHostedReadinessPlan,
	createSelfHostedReadinessResult,
	SELF_HOSTED_READINESS_GATE_IDS,
	validateSelfHostedReadinessEvidence,
} from "./readiness.js";

test("self-hosted readiness separates candidate construction from live support", () => {
	const plan = createSelfHostedReadinessPlan();

	assert.equal(plan.schemaVersion, 1);
	assert.equal(plan.surface, "self-hosted-runner");
	assert.equal(plan.profile.profile, "self-hosted-runner");
	assert.deepEqual(plan.profile.summary, {
		total: 45,
		supported: 0,
		probeRequired: 30,
		excluded: 15,
		notAssessed: 0,
	});
	assert.equal(plan.profile.selectable, false);
	assert.equal(plan.profile.readiness, "blocked");
	assert.equal(plan.readyForCandidateConstruction, true);
	assert.equal(plan.readyForImageBuild, false);
	assert.equal(plan.readyForDeployment, false);
	assert.equal(plan.readyForSupportedUse, false);
	assert.deepEqual(plan.hostPolicy.supportedNativeHosts, ["linux", "darwin"]);
	assert.equal(plan.hostPolicy.windows, "linux-container-required");
	assert.equal(plan.hostPolicy.versionLane, "runner-pinned");
	assert.equal(plan.hostPolicy.minimumVersion, "2.1.224");
	assert.equal(plan.artifact.status, "not-bound");
	assert.equal(plan.artifact.matchingHostExecution, "not-bound");
	assert.equal(plan.image.status, "not-bound");
	assert.equal(plan.image.registryPush, "not-run");
	assert.equal(plan.image.secretsInImage, "forbidden");
	assert.deepEqual(plan.wrapper, {
		status: "not-bound",
		binarySource: "CLAUDE_RUNNER_CLAUDE_BIN",
		handoff: "exec-required",
		stdin: "preserve-required",
		activityFileDescriptor: 3,
	});
	assert.deepEqual(
		plan.gates.map(({ id }) => id),
		SELF_HOSTED_READINESS_GATE_IDS,
	);
	assert.ok(plan.gates.every(({ status }) => status.startsWith("not-")));
	assert.deepEqual(plan.clients, {
		web: "not-run",
		mobile: "not-run",
		desktop: "not-run",
		cli: "not-run",
	});
});

test("self-hosted readiness evidence is deterministic, path-free, and strict", () => {
	const first = createSelfHostedReadinessPlan();
	const second = createSelfHostedReadinessPlan();

	assert.deepEqual(first, second);
	assert.deepEqual(validateSelfHostedReadinessEvidence(first), first);
	assert.doesNotMatch(
		JSON.stringify(first),
		/(?:\/home\/|[A-Z]:\\|https?:\/\/|credential|environmentSecret|sessionId|accountId|organizationId)/i,
	);
	assert.throws(
		() =>
			validateSelfHostedReadinessEvidence({
				...first,
				readyForDeployment: true,
			}),
		/readiness evidence/i,
	);
});

test("self-hosted operation result keeps every live gate closed", () => {
	const result = createSelfHostedReadinessResult(
		createSelfHostedReadinessPlan(),
	);

	assert.equal(result.operation, "self-hosted-readiness");
	assert.equal(result.ok, false);
	assert.deepEqual(
		result.checks.map(({ id, status }) => ({ id, status })),
		[
			{ id: "profile-classified", status: "pass" },
			{ id: "candidate-construction", status: "pass" },
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
	);
});
