import { spawn } from "node:child_process";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { sha256File } from "../artifacts/native-evidence.js";
import type { NativeHostReceipt } from "../artifacts/native-host-evidence.js";
import {
	createRemoteControlReadinessPlan,
	type RemoteControlConfigurationInspection,
	type RemoteControlReadinessPlan,
	validateRemoteControlReadinessEvidence,
} from "./readiness.js";

export interface RemoteControlSpawnOptions {
	cwd: string;
	stdio: "inherit";
	shell: false;
	detached: false;
}

export interface RemoteControlChildProcess {
	once(event: "error", listener: (error: Error) => void): this;
	once(
		event: "close",
		listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void,
	): this;
}

export type RemoteControlSpawnRunner = (
	executable: string,
	argv: readonly string[],
	options: RemoteControlSpawnOptions,
) => RemoteControlChildProcess;

export interface RemoteControlServerLaunchPlan {
	executable: "<verified-binary>";
	argv: string[];
	spawnOptions: {
		stdio: "inherit";
		shell: false;
		detached: false;
	};
}

export interface RemoteControlServerExit {
	status: "exited" | "signaled" | "unknown";
	successful: boolean;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
}

export type RemoteControlBinaryVerifier = (
	binaryPath: string,
	expectedSha256: string,
) => Promise<void>;

export interface SuperviseRemoteControlServerOptions {
	readiness: RemoteControlReadinessPlan;
	hostReceipt: NativeHostReceipt;
	binaryPath: string;
	cwd: string;
	acknowledgeTranscriptStorage: boolean;
	authorizeLiveStart: boolean;
	spawnProcess?: RemoteControlSpawnRunner;
	verifyBinary?: RemoteControlBinaryVerifier;
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
	return (
		left.size === right.size &&
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs
	);
}

async function verifyBinary(
	binaryPath: string,
	expectedSha256: string,
): Promise<void> {
	let before: Stats;
	try {
		before = await fs.lstat(binaryPath);
	} catch {
		throw new Error("Remote Control host binary could not be inspected");
	}
	if (!before.isFile() || before.isSymbolicLink()) {
		throw new Error("Remote Control host binary must be a real regular file");
	}
	let digest: string;
	try {
		digest = await sha256File(binaryPath);
	} catch {
		throw new Error("Remote Control host binary could not be hashed");
	}
	let after: Stats;
	try {
		after = await fs.lstat(binaryPath);
	} catch {
		throw new Error("Remote Control host binary changed while hashing");
	}
	if (!sameFileIdentity(before, after)) {
		throw new Error("Remote Control host binary changed while hashing");
	}
	if (digest !== expectedSha256) {
		throw new Error("Remote Control host binary does not match its receipt");
	}
}

const spawnProcess: RemoteControlSpawnRunner = (executable, argv, options) =>
	spawn(executable, [...argv], options) as RemoteControlChildProcess;

export function createRemoteControlServerLaunchPlan(
	readiness: RemoteControlReadinessPlan,
): RemoteControlServerLaunchPlan {
	validateRemoteControlReadinessEvidence(readiness);
	if (readiness.server.argv[0] !== "<verified-binary>") {
		throw new Error(
			"Remote Control server plan lacks a verified binary boundary",
		);
	}
	return {
		executable: "<verified-binary>",
		argv: readiness.server.argv.slice(1),
		spawnOptions: {
			stdio: "inherit",
			shell: false,
			detached: false,
		},
	};
}

function assertCurrentHostReceipt(
	readiness: RemoteControlReadinessPlan,
	hostReceipt: NativeHostReceipt,
): void {
	if (readiness.environment.status !== "inspected") {
		throw new Error("Remote Control configuration has not been inspected");
	}
	const rebound = createRemoteControlReadinessPlan({
		configuration:
			readiness.environment as RemoteControlConfigurationInspection,
		hostReceipt,
		eligibility: readiness.eligibility,
		server: {
			spawn: readiness.server.spawn,
			capacity: readiness.server.capacity,
			sandbox: readiness.server.sandbox,
			createSessionInDir: readiness.server.createSessionInDir,
		},
	});
	if (JSON.stringify(rebound.host) !== JSON.stringify(readiness.host)) {
		throw new Error("Remote Control host receipt does not match readiness");
	}
}

function waitForExit(
	child: RemoteControlChildProcess,
): Promise<RemoteControlServerExit> {
	return new Promise((resolve, reject) => {
		let settled = false;
		child.once("error", () => {
			if (settled) return;
			settled = true;
			reject(new Error("Remote Control server could not start"));
		});
		child.once("close", (exitCode, signal) => {
			if (settled) return;
			settled = true;
			resolve({
				status:
					exitCode !== null
						? "exited"
						: signal !== null
							? "signaled"
							: "unknown",
				successful: exitCode === 0,
				exitCode,
				signal,
			});
		});
	});
}

export async function superviseRemoteControlServer(
	options: SuperviseRemoteControlServerOptions,
): Promise<RemoteControlServerExit> {
	validateRemoteControlReadinessEvidence(options.readiness);
	if (!options.readiness.readyForProbeLaunch) {
		throw new Error("Remote Control is not ready for a probe launch");
	}
	if (options.acknowledgeTranscriptStorage !== true) {
		throw new Error(
			"Remote Control start requires transcript storage acknowledgement",
		);
	}
	if (options.authorizeLiveStart !== true) {
		throw new Error(
			"Remote Control live start requires explicit authorization",
		);
	}
	if (!path.isAbsolute(options.binaryPath) || !path.isAbsolute(options.cwd)) {
		throw new Error(
			"Remote Control start requires absolute binary and workspace paths",
		);
	}
	assertCurrentHostReceipt(options.readiness, options.hostReceipt);
	if (options.readiness.host.receipt !== "verified") {
		throw new Error("Remote Control readiness lacks a verified host receipt");
	}
	await (options.verifyBinary ?? verifyBinary)(
		options.binaryPath,
		options.readiness.host.finalizedSha256,
	);
	const plan = createRemoteControlServerLaunchPlan(options.readiness);
	let child: RemoteControlChildProcess;
	try {
		child = (options.spawnProcess ?? spawnProcess)(
			options.binaryPath,
			plan.argv,
			{
				cwd: options.cwd,
				...plan.spawnOptions,
			},
		);
	} catch {
		throw new Error("Remote Control server could not start");
	}
	return await waitForExit(child);
}
