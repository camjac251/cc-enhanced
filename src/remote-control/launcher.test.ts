import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { NativeHostReceipt } from "../artifacts/native-host-evidence.js";
import { REMOTE_CONTROL_CANDIDATE_TAGS } from "../profiles/remote-control.js";
import {
	createRemoteControlServerLaunchPlan,
	type RemoteControlChildProcess,
	type RemoteControlSpawnRunner,
	superviseRemoteControlServer,
} from "./launcher.js";
import {
	createRemoteControlReadinessPlan,
	inspectRemoteControlConfiguration,
} from "./readiness.js";

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
		runtimeTags: REMOTE_CONTROL_CANDIDATE_TAGS.filter(
			(tag) => tag !== "signature",
		),
		warningCodes: [],
		createdAt: "2026-08-22T00:00:00.000Z",
	};
}

async function readyPlan() {
	return createRemoteControlReadinessPlan({
		configuration: await inspectRemoteControlConfiguration({
			env: {},
			settingsFiles: [],
		}),
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
}

test("server launch plan preserves the exact upstream inherited-stdio boundary", async () => {
	const plan = createRemoteControlServerLaunchPlan(await readyPlan());

	assert.deepEqual(plan, {
		executable: "<verified-binary>",
		argv: [
			"remote-control",
			"--spawn",
			"worktree",
			"--capacity",
			"1",
			"--sandbox",
			"--create-session-in-dir",
		],
		spawnOptions: {
			stdio: "inherit",
			shell: false,
			detached: false,
		},
	});
	assert.equal("command" in plan, false);
});

test("supervisor waits in the foreground without touching child output", async () => {
	const child = new EventEmitter();
	Object.defineProperties(child, {
		stdout: {
			get: () => {
				throw new Error("stdout must not be inspected");
			},
		},
		stderr: {
			get: () => {
				throw new Error("stderr must not be inspected");
			},
		},
	});
	const calls: Array<{
		executable: string;
		argv: readonly string[];
		options: unknown;
	}> = [];
	const spawnProcess: RemoteControlSpawnRunner = (
		executable,
		argv,
		options,
	) => {
		calls.push({ executable, argv, options });
		return child as RemoteControlChildProcess;
	};
	let settled = false;
	const execution = superviseRemoteControlServer({
		readiness: await readyPlan(),
		hostReceipt: validHostReceipt(),
		binaryPath: "/private/verified/claude",
		cwd: "/private/workspace",
		acknowledgeTranscriptStorage: true,
		authorizeLiveStart: true,
		spawnProcess,
		verifyBinary: async (_binaryPath, expectedSha256) => {
			assert.equal(expectedSha256, "1".repeat(64));
		},
	}).then((result) => {
		settled = true;
		return result;
	});
	await Promise.resolve();
	assert.equal(settled, false);
	assert.deepEqual(calls, [
		{
			executable: "/private/verified/claude",
			argv: [
				"remote-control",
				"--spawn",
				"worktree",
				"--capacity",
				"1",
				"--sandbox",
				"--create-session-in-dir",
			],
			options: {
				cwd: "/private/workspace",
				stdio: "inherit",
				shell: false,
				detached: false,
			},
		},
	]);
	child.emit("close", 0, null);
	const result = await execution;
	assert.deepEqual(result, {
		status: "exited",
		successful: true,
		exitCode: 0,
		signal: null,
	});
	assert.doesNotMatch(
		JSON.stringify(result),
		/(?:private|stdout|stderr|https?:\/\/|sessionUrl|processId|transcript)/i,
	);
});

test("supervisor fails closed before spawning on readiness, consent, or host drift", async () => {
	let spawnCalls = 0;
	const spawnProcess: RemoteControlSpawnRunner = () => {
		spawnCalls += 1;
		throw new Error("must not spawn");
	};
	const common = {
		hostReceipt: validHostReceipt(),
		binaryPath: "/private/verified/claude",
		cwd: "/private/workspace",
		spawnProcess,
		verifyBinary: async () => {},
	};

	await assert.rejects(
		superviseRemoteControlServer({
			...common,
			readiness: createRemoteControlReadinessPlan(),
			acknowledgeTranscriptStorage: true,
			authorizeLiveStart: true,
		}),
		/not ready for a probe launch/i,
	);
	await assert.rejects(
		superviseRemoteControlServer({
			...common,
			readiness: await readyPlan(),
			acknowledgeTranscriptStorage: false,
			authorizeLiveStart: true,
		}),
		/transcript storage acknowledgement/i,
	);
	await assert.rejects(
		superviseRemoteControlServer({
			...common,
			readiness: await readyPlan(),
			hostReceipt: { ...validHostReceipt(), profile: "cli-full" },
			acknowledgeTranscriptStorage: true,
			authorizeLiveStart: true,
		}),
		/profile|receipt/i,
	);
	assert.equal(spawnCalls, 0);
});
