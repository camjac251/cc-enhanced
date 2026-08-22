import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Readable } from "node:stream";
import { sha256File } from "../artifacts/native-evidence.js";
import {
	createSelfHostedWrapperScript,
	type SelfHostedWrapperProbeEvidence,
	type SelfHostedWrapperReceipt,
	type SelfHostedWrapperStaticChecks,
	validateSelfHostedWrapperReceipt,
	validateSelfHostedWrapperScript,
} from "../self-hosted/wrapper.js";
import { createOperationResult, type OperationResult } from "./contract.js";

export interface SelfHostedWrapperProbeExecutor {
	runStaticChecks(wrapperPath: string): Promise<SelfHostedWrapperStaticChecks>;
	runControlChannelProbe(
		wrapperPath: string,
	): Promise<SelfHostedWrapperProbeEvidence>;
}

export interface SelfHostedWrapperOptions {
	wrapperOutput: string;
	allowedOutputRoot: string;
}

export interface SelfHostedWrapperDependencies {
	executor?: SelfHostedWrapperProbeExecutor;
	now?: () => string;
}

interface CapturedProcess {
	pid: number;
	stdout: string;
	stderr: string;
	fd3: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
}

const MAX_PROBE_OUTPUT_BYTES = 64 * 1024;
const PROBE_TIMEOUT_MS = 10_000;

const SYNTHETIC_HELPER_SCRIPT = `#!/bin/sh
set -eu

mode="\${1:?mode required}"
shift
if [ "$mode" = normal ]; then
	IFS= read -r first
	IFS= read -r second
	printf 'pid=%s\\n' "$$"
	printf 'arg1=%s\\n' "$1"
	printf 'arg2=%s\\n' "$2"
	printf 'marker=%s\\n' "$CC_ENHANCED_WRAPPER_PROBE"
	printf 'input1=%s\\n' "$first"
	printf 'input2=%s\\n' "$second"
	printf 'activity=normal\\n' >&3
	exit 37
fi
if [ "$mode" = signal ]; then
	trap 'printf "activity=signal\\n" >&3; exit 43' TERM
	printf 'ready=%s\\n' "$$"
	while :; do :; done
fi
exit 65
`;

function appendBounded(current: string, chunk: Buffer): string {
	const next = current + chunk.toString("utf8");
	if (Buffer.byteLength(next) > MAX_PROBE_OUTPUT_BYTES) {
		throw new Error("Wrapper probe output exceeded the safety limit");
	}
	return next;
}

async function captureProcess(options: {
	file: string;
	args?: readonly string[];
	env: NodeJS.ProcessEnv;
	stdin?: string;
	killOnReady?: boolean;
}): Promise<CapturedProcess> {
	return await new Promise((resolve, reject) => {
		const child = spawn(options.file, [...(options.args ?? [])], {
			env: options.env,
			stdio: ["pipe", "pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		if (child.pid === undefined) {
			reject(new Error("Wrapper probe did not receive a process ID"));
			return;
		}
		const pid = child.pid;
		let stdout = "";
		let stderr = "";
		let fd3 = "";
		let killed = false;
		let settled = false;
		const finish = (error?: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
		};
		const append = (
			stream: "stdout" | "stderr" | "fd3",
			chunk: Buffer,
		): void => {
			try {
				if (stream === "stdout") stdout = appendBounded(stdout, chunk);
				else if (stream === "stderr") stderr = appendBounded(stderr, chunk);
				else fd3 = appendBounded(fd3, chunk);
				if (
					stream === "stdout" &&
					options.killOnReady &&
					!killed &&
					stdout.includes("\n")
				) {
					killed = true;
					if (!child.kill("SIGTERM")) {
						finish(new Error("Wrapper signal probe could not send SIGTERM"));
					}
				}
			} catch (error) {
				child.kill();
				finish(error as Error);
			}
		};
		const timer = setTimeout(() => {
			child.kill();
			finish(new Error("Wrapper control-channel probe timed out"));
		}, PROBE_TIMEOUT_MS);
		child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
		child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
		(child.stdio[3] as Readable).on("data", (chunk: Buffer) =>
			append("fd3", chunk),
		);
		child.once("error", () =>
			finish(new Error("Wrapper control-channel probe could not start")),
		);
		child.once("close", (exitCode, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ pid, stdout, stderr, fd3, exitCode, signal });
		});
		if (options.stdin === undefined) child.stdin.end();
		else child.stdin.end(options.stdin);
	});
}

function parseFields(output: string): Map<string, string> {
	const fields = new Map<string, string>();
	for (const line of output.trim().split("\n")) {
		if (!line) continue;
		const separator = line.indexOf("=");
		if (separator < 1)
			throw new Error("Synthetic wrapper probe output is invalid");
		const key = line.slice(0, separator);
		if (fields.has(key)) {
			throw new Error("Synthetic wrapper probe output has duplicate fields");
		}
		fields.set(key, line.slice(separator + 1));
	}
	return fields;
}

export async function runSyntheticWrapperControlChannelProbe(
	wrapperPath: string,
): Promise<SelfHostedWrapperProbeEvidence> {
	if (process.platform === "win32") {
		throw new Error("POSIX wrapper probes require Linux or macOS");
	}
	const scratch = await fs.mkdtemp(
		path.join(os.tmpdir(), "cc-enhanced-wrapper-probe-"),
	);
	try {
		const helperPath = path.join(scratch, "synthetic-helper");
		await fs.writeFile(helperPath, SYNTHETIC_HELPER_SCRIPT, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o755,
		});
		const pathOnly = { PATH: "/usr/bin:/bin" };
		const unset = await captureProcess({ file: wrapperPath, env: pathOnly });
		if (unset.exitCode === 0 || unset.fd3 || unset.signal !== null) {
			throw new Error("Wrapper accepted a missing binary source");
		}
		const relative = await captureProcess({
			file: wrapperPath,
			env: {
				...pathOnly,
				CLAUDE_RUNNER_CLAUDE_BIN: "synthetic-helper",
			},
		});
		if (relative.exitCode !== 64 || relative.fd3 || relative.signal !== null) {
			throw new Error("Wrapper accepted a relative binary source");
		}

		const probeEnvironment = {
			...pathOnly,
			CLAUDE_RUNNER_CLAUDE_BIN: helperPath,
			CC_ENHANCED_WRAPPER_PROBE: "synthetic-marker",
		};
		const normal = await captureProcess({
			file: wrapperPath,
			args: ["normal", "alpha", "two words"],
			env: probeEnvironment,
			stdin: "first-record\nsecond record\n",
		});
		const normalFields = parseFields(normal.stdout);
		if (
			normal.stderr ||
			normal.signal !== null ||
			normal.exitCode !== 37 ||
			normal.fd3 !== "activity=normal\n" ||
			normalFields.get("pid") !== String(normal.pid) ||
			normalFields.get("arg1") !== "alpha" ||
			normalFields.get("arg2") !== "two words" ||
			normalFields.get("marker") !== "synthetic-marker" ||
			normalFields.get("input1") !== "first-record" ||
			normalFields.get("input2") !== "second record"
		) {
			throw new Error("Wrapper normal control-channel probe failed");
		}

		const signal = await captureProcess({
			file: wrapperPath,
			args: ["signal"],
			env: probeEnvironment,
			killOnReady: true,
		});
		const signalFields = parseFields(signal.stdout);
		if (
			signal.stderr ||
			signal.signal !== null ||
			signal.exitCode !== 43 ||
			signal.fd3 !== "activity=signal\n" ||
			signalFields.get("ready") !== String(signal.pid)
		) {
			throw new Error("Wrapper signal control-channel probe failed");
		}

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
	} finally {
		await fs.rm(scratch, { force: true, recursive: true });
	}
}

async function runStaticCommand(
	command: string,
	args: readonly string[],
): Promise<string> {
	return await new Promise((resolve, reject) => {
		const environment: NodeJS.ProcessEnv = {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
		};
		if (process.env.HOME) environment.HOME = process.env.HOME;
		const child = spawn(command, [...args], {
			env: environment,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (error?: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
			else resolve(stdout);
		};
		const timer = setTimeout(() => {
			child.kill();
			finish(new Error(`${command} timed out`));
		}, 30_000);
		child.stdout.on("data", (chunk: Buffer) => {
			try {
				stdout = appendBounded(stdout, chunk);
			} catch (error) {
				child.kill();
				finish(error as Error);
			}
		});
		child.stderr.on("data", (chunk: Buffer) => {
			try {
				stderr = appendBounded(stderr, chunk);
			} catch (error) {
				child.kill();
				finish(error as Error);
			}
		});
		child.once("error", () => finish(new Error(`${command} could not start`)));
		child.once("close", (exitCode) => {
			if (exitCode !== 0) {
				finish(new Error(`${command} failed${stderr ? " validation" : ""}`));
				return;
			}
			finish();
		});
	});
}

export function createDefaultSelfHostedWrapperProbeExecutor(): SelfHostedWrapperProbeExecutor {
	return {
		async runStaticChecks(wrapperPath) {
			const shellcheckOutput = await runStaticCommand("shellcheck", [
				"--shell=sh",
				wrapperPath,
			]);
			const shellcheckVersionOutput = await runStaticCommand("shellcheck", [
				"--version",
			]);
			const shellcheckVersion = /^version:\s*(\S+)$/m.exec(
				shellcheckVersionOutput,
			)?.[1];
			if (!shellcheckVersion || shellcheckOutput) {
				throw new Error("ShellCheck wrapper validation was not clean");
			}
			await runStaticCommand("shfmt", ["-d", "-ln", "posix", wrapperPath]);
			const shfmtVersion = (
				await runStaticCommand("shfmt", ["--version"])
			).trim();
			if (!shfmtVersion) throw new Error("shfmt did not report a version");
			return {
				shellcheck: { version: shellcheckVersion, status: "pass" },
				shfmt: { version: shfmtVersion.replace(/^v/, ""), status: "pass" },
			};
		},
		runControlChannelProbe: runSyntheticWrapperControlChannelProbe,
	};
}

async function canonicalizePotentialPath(filePath: string): Promise<string> {
	let current = path.resolve(filePath);
	const missing: string[] = [];
	for (;;) {
		try {
			return path.join(await fs.realpath(current), ...missing);
		} catch (error) {
			if (
				typeof error !== "object" ||
				error === null ||
				!("code" in error) ||
				error.code !== "ENOENT"
			) {
				throw error;
			}
			const parent = path.dirname(current);
			if (parent === current) throw error;
			missing.unshift(path.basename(current));
			current = parent;
		}
	}
}

async function assertSafeWrapperOutput(options: SelfHostedWrapperOptions) {
	const [output, allowedRoot] = await Promise.all([
		canonicalizePotentialPath(options.wrapperOutput),
		canonicalizePotentialPath(options.allowedOutputRoot),
	]);
	const relative = path.relative(allowedRoot, output);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error(
			"Self-hosted wrapper output must be inside the allowed root",
		);
	}
	try {
		await fs.lstat(options.wrapperOutput);
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "ENOENT"
		) {
			return;
		}
		throw error;
	}
	throw new Error("Self-hosted wrapper output already exists");
}

export async function createAndProbeSelfHostedWrapper(
	options: SelfHostedWrapperOptions,
	dependencies: SelfHostedWrapperDependencies = {},
): Promise<OperationResult<SelfHostedWrapperReceipt>> {
	await assertSafeWrapperOutput(options);
	await fs.mkdir(path.dirname(options.wrapperOutput), { recursive: true });
	await fs.writeFile(options.wrapperOutput, createSelfHostedWrapperScript(), {
		encoding: "utf8",
		flag: "wx",
		mode: 0o755,
	});
	await fs.chmod(options.wrapperOutput, 0o755);
	validateSelfHostedWrapperScript(
		await fs.readFile(options.wrapperOutput, "utf8"),
	);
	const executor =
		dependencies.executor ?? createDefaultSelfHostedWrapperProbeExecutor();
	const staticChecks = await executor.runStaticChecks(options.wrapperOutput);
	const probe = await executor.runControlChannelProbe(options.wrapperOutput);
	const receipt = validateSelfHostedWrapperReceipt({
		schemaVersion: 1,
		surface: "self-hosted-runner",
		wrapper: {
			scriptSha256: await sha256File(options.wrapperOutput),
			language: "posix-sh",
			binarySource: "CLAUDE_RUNNER_CLAUDE_BIN",
			sourceRequirement: "absolute",
			handoff: "exec",
		},
		staticChecks,
		probe,
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
		createdAt: (dependencies.now ?? (() => new Date().toISOString()))(),
	});
	return createOperationResult({
		operation: "self-hosted-wrapper-probe",
		ok: true,
		data: receipt,
		checks: [
			{ id: "canonical-wrapper", status: "pass" },
			{ id: "shellcheck", status: "pass" },
			{ id: "shfmt", status: "pass" },
			{ id: "source-guards", status: "pass" },
			{ id: "argv-environment-stdin", status: "pass" },
			{ id: "fd3-pid-signal-exit", status: "pass" },
		],
	});
}
