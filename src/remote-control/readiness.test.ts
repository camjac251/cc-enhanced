import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { NativeHostReceipt } from "../artifacts/native-host-evidence.js";
import { REMOTE_CONTROL_CANDIDATE_TAGS } from "../profiles/remote-control.js";
import {
	createRemoteControlReadinessPlan,
	inspectRemoteControlConfiguration,
	readRemoteControlHostReceipt,
	validateRemoteControlReadinessEvidence,
} from "./readiness.js";

const runtimeTags = REMOTE_CONTROL_CANDIDATE_TAGS.filter(
	(tag) => tag !== "signature",
);

function validHostReceipt(): NativeHostReceipt {
	return {
		schemaVersion: 1,
		targetId: "standalone-cli:linux-x64:2.1.238",
		upstreamVersion: "2.1.238",
		platform: "linux-x64",
		profile: "remote-control",
		structuralPatchedSha256: "1".repeat(64),
		finalizedSha256: "1".repeat(64),
		signingPolicy: "not-required",
		signingVerification: "not-required",
		reextraction: "pass",
		hostExecution: "pass",
		runtimeVersion: "2.1.238",
		runtimeTags: [...runtimeTags],
		warningCodes: [],
		createdAt: "2026-08-22T00:00:00.000Z",
	};
}

test("Remote Control plan is deterministic, path-free, and live-blocked", () => {
	const first = createRemoteControlReadinessPlan();
	const second = createRemoteControlReadinessPlan();

	assert.deepEqual(first, second);
	assert.deepEqual(validateRemoteControlReadinessEvidence(first), first);
	assert.equal(first.kind, "plan");
	assert.equal(first.profile.name, "remote-control");
	assert.equal(first.profile.selectable, false);
	assert.deepEqual(first.profile.summary, {
		total: 46,
		supported: 0,
		probeRequired: 31,
		excluded: 15,
		notAssessed: 0,
	});
	assert.equal(first.readyForProbeLaunch, false);
	assert.equal(first.readyForSupportedUse, false);
	assert.deepEqual(first.clients, {
		web: "not-run",
		mobile: "not-run",
		desktop: "not-run",
	});
	assert.deepEqual(first.boundaries, {
		transport: "upstream-owned",
		network: "outbound-https-only",
		protocolInterception: "forbidden",
		sessionUrlPersistence: "forbidden",
		liveLaunch: "not-authorized",
		accountChanges: "not-authorized",
		desktopActivation: "closed",
		selfHostedExecution: "closed",
	});
	assert.doesNotMatch(
		JSON.stringify(first),
		/(?:\/home\/|[A-Z]:\\|"(?:sessionId|sessionUrl|credential|transcript|apiKeyValue)"\s*:)/i,
	);
});

test("known configuration blockers are exhaustive and value-free", async () => {
	const sentinel = "private-value-must-not-escape";
	const blockerCases = [
		["ANTHROPIC_API_KEY", "auth-api-key"],
		["ANTHROPIC_AUTH_TOKEN", "auth-token"],
		["CLAUDE_CODE_USE_BEDROCK", "provider-bedrock"],
		["CLAUDE_CODE_USE_VERTEX", "provider-vertex"],
		["CLAUDE_CODE_USE_FOUNDRY", "provider-foundry"],
		["CLAUDE_CODE_USE_GATEWAY", "provider-gateway"],
		["ANTHROPIC_BASE_URL", "custom-base-url"],
		["DISABLE_TELEMETRY", "feature-disable-telemetry"],
		["DO_NOT_TRACK", "feature-do-not-track"],
		[
			"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
			"feature-disable-nonessential-traffic",
		],
		["DISABLE_GROWTHBOOK", "feature-disable-growthbook"],
	] as const;

	for (const [key, blocker] of blockerCases) {
		const inspection = await inspectRemoteControlConfiguration({
			env: { [key]: sentinel },
			settingsFiles: [],
		});
		assert.deepEqual(inspection.blockers, [blocker]);
		assert.doesNotMatch(JSON.stringify(inspection), new RegExp(sentinel));
	}

	const officialEndpoint = await inspectRemoteControlConfiguration({
		env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
		settingsFiles: [],
	});
	assert.deepEqual(officialEndpoint.blockers, []);
});

test("settings inspection is explicit, bounded, stable, and path-free", async () => {
	const temporaryRoot = await mkdtemp(
		path.join(tmpdir(), "cc-enhanced-remote-readiness-"),
	);
	try {
		const implicitSettings = path.join(temporaryRoot, "settings.json");
		await writeFile(implicitSettings, '{"disableRemoteControl":true}');
		const implicit = await inspectRemoteControlConfiguration({
			env: { HOME: temporaryRoot },
			settingsFiles: [],
		});
		assert.equal(implicit.settingsFilesInspected, 0);
		assert.deepEqual(implicit.blockers, []);

		const explicitSettings = path.join(temporaryRoot, "explicit.json");
		await writeFile(
			explicitSettings,
			'{"disableRemoteControl":true,"env":{"DISABLE_TELEMETRY":"secret-setting-value"}}',
		);
		const explicit = await inspectRemoteControlConfiguration({
			env: {},
			settingsFiles: [explicitSettings],
		});
		assert.equal(explicit.settingsFilesInspected, 1);
		assert.deepEqual(explicit.blockers, [
			"feature-disable-telemetry",
			"settings-disable-remote-control",
		]);
		assert.doesNotMatch(
			JSON.stringify(explicit),
			/(?:secret-setting-value|explicit\.json|cc-enhanced-remote-readiness)/,
		);

		const duplicateSettings = path.join(temporaryRoot, "duplicate.json");
		await writeFile(
			duplicateSettings,
			'{"disableRemoteControl":false,"disableRemoteControl":true}',
		);
		await assert.rejects(
			inspectRemoteControlConfiguration({
				env: {},
				settingsFiles: [duplicateSettings],
			}),
			/duplicate key disableRemoteControl/i,
		);

		const linkedSettings = path.join(temporaryRoot, "linked.json");
		await symlink(explicitSettings, linkedSettings);
		await assert.rejects(
			inspectRemoteControlConfiguration({
				env: {},
				settingsFiles: [linkedSettings],
			}),
			/regular file/i,
		);

		const oversizedSettings = path.join(temporaryRoot, "oversized.json");
		await writeFile(oversizedSettings, Buffer.alloc(1024 * 1024 + 1, 32));
		await assert.rejects(
			inspectRemoteControlConfiguration({
				env: {},
				settingsFiles: [oversizedSettings],
			}),
			/size exceeds limit/i,
		);

		const hostReceipt = path.join(temporaryRoot, "host-receipt.json");
		await writeFile(hostReceipt, JSON.stringify(validHostReceipt()));
		assert.deepEqual(
			await readRemoteControlHostReceipt(hostReceipt),
			validHostReceipt(),
		);
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true });
	}
});

test("server choices are explicit, bounded, and match upstream flag constraints", () => {
	const session = createRemoteControlReadinessPlan({
		server: {
			spawn: "session",
			capacity: null,
			sandbox: "disabled",
			createSessionInDir: false,
		},
	});
	assert.deepEqual(session.server.argv, [
		"<verified-binary>",
		"remote-control",
		"--spawn",
		"session",
		"--no-sandbox",
		"--no-create-session-in-dir",
	]);
	assert.throws(
		() =>
			createRemoteControlReadinessPlan({
				server: {
					spawn: "session",
					capacity: 1,
					sandbox: "enabled",
					createSessionInDir: true,
				},
			}),
		/session.*capacity/i,
	);
	for (const capacity of [0, 1.5, 33, Number.POSITIVE_INFINITY]) {
		assert.throws(
			() =>
				createRemoteControlReadinessPlan({
					server: {
						spawn: "worktree",
						capacity,
						sandbox: "enabled",
						createSessionInDir: true,
					},
				}),
			/capacity/i,
		);
	}
});

test("probe-launch readiness binds the exact Remote host without claiming support", async () => {
	const configuration = await inspectRemoteControlConfiguration({
		env: {},
		settingsFiles: [],
	});
	const plan = createRemoteControlReadinessPlan({
		configuration,
		hostReceipt: validHostReceipt(),
		eligibility: {
			subscription: "confirmed",
			organizationEnablement: "not-required",
			workspaceTrust: "confirmed",
			workspaceKind: "git",
		},
		server: {
			spawn: "worktree",
			capacity: 1,
			sandbox: "enabled",
			createSessionInDir: true,
		},
	});

	assert.deepEqual(validateRemoteControlReadinessEvidence(plan), plan);
	assert.equal(plan.readyForProbeLaunch, true);
	assert.equal(plan.readyForSupportedUse, false);
	assert.equal(plan.profile.readiness, "blocked");
	assert.equal(plan.profile.selectable, false);
	assert.equal(plan.profile.summary.supported, 0);
	assert.deepEqual(plan.clients, {
		web: "not-run",
		mobile: "not-run",
		desktop: "not-run",
	});
	assert.equal(plan.launchPolicy.transcriptStorage, "acknowledge-at-start");
	assert.equal(plan.launchPolicy.liveStart, "separate-explicit-action");

	assert.throws(
		() =>
			createRemoteControlReadinessPlan({
				configuration,
				hostReceipt: { ...validHostReceipt(), profile: "cli-full" },
				eligibility: plan.eligibility,
				server: {
					spawn: plan.server.spawn,
					capacity: plan.server.capacity,
					sandbox: plan.server.sandbox,
					createSessionInDir: plan.server.createSessionInDir,
				},
			}),
		/profile/i,
	);
	assert.throws(
		() =>
			createRemoteControlReadinessPlan({
				configuration,
				hostReceipt: {
					...validHostReceipt(),
					runtimeTags: runtimeTags.slice(1),
				},
				eligibility: plan.eligibility,
				server: {
					spawn: plan.server.spawn,
					capacity: plan.server.capacity,
					sandbox: plan.server.sandbox,
					createSessionInDir: plan.server.createSessionInDir,
				},
			}),
		/runtime.*roster/i,
	);

	const defaultPlan = createRemoteControlReadinessPlan();
	assert.throws(
		() =>
			validateRemoteControlReadinessEvidence({
				...defaultPlan,
				readyForProbeLaunch: true,
			}),
		/deterministic policy|readiness/i,
	);
});
