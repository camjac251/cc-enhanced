import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { inspectNativeSignaturePresence } from "./native-signature-presence.js";
import type { NativeArtifactPlatform } from "./targets/contract.js";

export type NativeSigningPolicy =
	| { kind: "not-required" }
	| { kind: "macos-adhoc" }
	| { kind: "macos-identity"; identity: string }
	| {
			kind: "windows-authenticode";
			certificateThumbprint: string;
			timestampUrl: string;
	  }
	| { kind: "windows-explicit-unsigned"; acknowledged: boolean };

export type NativeSigningPolicyName = NativeSigningPolicy["kind"];

export type NativeSigningCommandStage =
	| "sign"
	| "verify"
	| "inspect"
	| "remove";

export interface NativeSigningCommand {
	stage: NativeSigningCommandStage;
	executable: string;
	args: string[];
}

export interface NativeSigningCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export type NativeSigningCommandRunner = (
	command: NativeSigningCommand,
) => Promise<NativeSigningCommandResult>;

export interface NativeSigningPlan {
	policyName: NativeSigningPolicyName;
	commands: NativeSigningCommand[];
}

export interface NativeSigningResult {
	policyName: NativeSigningPolicyName;
	verification: "pass" | "not-required";
	warningCodes: string[];
}

function assertMatchingHost(
	platform: NativeArtifactPlatform,
	hostPlatform: NativeArtifactPlatform,
): void {
	if (platform !== hostPlatform) {
		throw new Error(
			`Native finalization requires a matching host platform for ${platform}`,
		);
	}
}

function assertMacIdentity(identity: string): string {
	const trimmed = identity.trim();
	if (
		!trimmed ||
		trimmed === "-" ||
		trimmed.includes("\0") ||
		/[\r\n]/.test(trimmed)
	) {
		throw new Error(
			"macOS configured identity must name one keychain identity",
		);
	}
	return trimmed;
}

function normalizeCertificateThumbprint(value: string): string {
	const normalized = value.replace(/\s+/g, "").toUpperCase();
	if (!/^[A-F0-9]{40}$/.test(normalized)) {
		throw new Error(
			"Windows certificate selector must be one SHA-1 certificate thumbprint",
		);
	}
	return normalized;
}

function assertHttpsTimestampUrl(value: string): string {
	const trimmed = value.trim();
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error("Windows timestamp service must be one HTTPS URL");
	}
	if (
		parsed.protocol !== "https:" ||
		parsed.username ||
		parsed.password ||
		parsed.hash
	) {
		throw new Error("Windows timestamp service must be one HTTPS URL");
	}
	return trimmed;
}

function assertWindowsSignToolPath(value: string): string {
	const trimmed = value.trim();
	const baseName = path.win32.basename(trimmed.replaceAll("/", "\\"));
	const isPathLookup = trimmed.toLowerCase() === "signtool.exe";
	if (
		!trimmed ||
		baseName.toLowerCase() !== "signtool.exe" ||
		(!isPathLookup && !path.win32.isAbsolute(trimmed))
	) {
		throw new Error(
			"Windows finalization requires the Windows SDK signtool.exe executable",
		);
	}
	return trimmed;
}

export function createNativeSigningPlan(options: {
	artifactPath: string;
	platform: NativeArtifactPlatform;
	hostPlatform: NativeArtifactPlatform;
	policy: NativeSigningPolicy;
	codesignPath?: string;
	signToolPath?: string;
}): NativeSigningPlan {
	assertMatchingHost(options.platform, options.hostPlatform);
	if (!options.artifactPath.trim()) {
		throw new Error("Native signing requires a staged artifact path");
	}

	if (options.platform.startsWith("linux-")) {
		if (options.policy.kind !== "not-required") {
			throw new Error(
				`${options.policy.kind} is not compatible with Linux artifacts`,
			);
		}
		return { policyName: "not-required", commands: [] };
	}

	if (options.platform.startsWith("darwin-")) {
		if (
			options.policy.kind !== "macos-adhoc" &&
			options.policy.kind !== "macos-identity"
		) {
			throw new Error(
				`${options.policy.kind} is not compatible with macOS artifacts`,
			);
		}
		const identity =
			options.policy.kind === "macos-adhoc"
				? "-"
				: assertMacIdentity(options.policy.identity);
		const executable = options.codesignPath ?? "/usr/bin/codesign";
		return {
			policyName: options.policy.kind,
			commands: [
				{
					stage: "sign",
					executable,
					args: ["--force", "--sign", identity, options.artifactPath],
				},
				{
					stage: "verify",
					executable,
					args: ["--verify", "--strict", "--verbose=4", options.artifactPath],
				},
				{
					stage: "inspect",
					executable,
					args: ["--display", "--verbose=4", options.artifactPath],
				},
			],
		};
	}

	if (
		options.policy.kind !== "windows-authenticode" &&
		options.policy.kind !== "windows-explicit-unsigned"
	) {
		throw new Error(
			`${options.policy.kind} is not compatible with Windows artifacts`,
		);
	}
	const executable = assertWindowsSignToolPath(
		options.signToolPath ?? "signtool.exe",
	);
	if (options.policy.kind === "windows-explicit-unsigned") {
		if (!options.policy.acknowledged) {
			throw new Error(
				"Windows explicit unsigned policy requires an acknowledgement",
			);
		}
		return {
			policyName: options.policy.kind,
			commands: [
				{
					stage: "remove",
					executable,
					args: ["remove", "/s", "/v", options.artifactPath],
				},
			],
		};
	}

	const certificateThumbprint = normalizeCertificateThumbprint(
		options.policy.certificateThumbprint,
	);
	const timestampUrl = assertHttpsTimestampUrl(options.policy.timestampUrl);
	return {
		policyName: options.policy.kind,
		commands: [
			{
				stage: "sign",
				executable,
				args: [
					"sign",
					"/sha1",
					certificateThumbprint,
					"/fd",
					"SHA256",
					"/tr",
					timestampUrl,
					"/td",
					"SHA256",
					"/v",
					options.artifactPath,
				],
			},
			{
				stage: "verify",
				executable,
				args: ["verify", "/pa", "/v", options.artifactPath],
			},
		],
	};
}

const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const SIGNING_COMMAND_TIMEOUT_MS = 120_000;

function appendBounded(current: string, chunk: Buffer): string {
	if (current.length >= MAX_COMMAND_OUTPUT_BYTES) return current;
	return `${current}${chunk.toString("utf8")}`.slice(
		0,
		MAX_COMMAND_OUTPUT_BYTES,
	);
}

async function runSigningCommand(
	command: NativeSigningCommand,
): Promise<NativeSigningCommandResult> {
	return await new Promise((resolve, reject) => {
		const child = spawn(command.executable, command.args, {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill();
			reject(new Error(`Native ${command.stage} command timed out`));
		}, SIGNING_COMMAND_TIMEOUT_MS);
		child.stdout.on("data", (chunk: Buffer) => {
			stdout = appendBounded(stdout, chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = appendBounded(stderr, chunk);
		});
		child.once("error", () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error(`Native ${command.stage} tool could not be started`));
		});
		child.once("close", (exitCode) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ exitCode: exitCode ?? -1, stdout, stderr });
		});
	});
}

function assertCommandSuccess(
	command: NativeSigningCommand,
	result: NativeSigningCommandResult,
): void {
	if (result.exitCode !== 0) {
		throw new Error(`Native ${command.stage} command failed`);
	}
}

export async function hasPeCertificateTable(
	filePath: string,
): Promise<boolean> {
	const handle = await fs.open(filePath, "r");
	try {
		const stat = await handle.stat();
		const result = await inspectNativeSignaturePresence(
			handle,
			"win32-x64",
			stat.size,
		);
		return result.presence === "present";
	} finally {
		await handle.close();
	}
}

export async function finalizeNativeSigning(options: {
	artifactPath: string;
	platform: NativeArtifactPlatform;
	hostPlatform: NativeArtifactPlatform;
	policy: NativeSigningPolicy;
	codesignPath?: string;
	signToolPath?: string;
	runCommand?: NativeSigningCommandRunner;
}): Promise<NativeSigningResult> {
	const plan = createNativeSigningPlan(options);
	if (plan.policyName === "not-required") {
		return {
			policyName: plan.policyName,
			verification: "not-required",
			warningCodes: [],
		};
	}

	const runner = options.runCommand ?? runSigningCommand;
	let inspectOutput = "";
	for (const command of plan.commands) {
		if (
			plan.policyName === "windows-explicit-unsigned" &&
			command.stage === "remove" &&
			!(await hasPeCertificateTable(options.artifactPath))
		) {
			continue;
		}
		let result: NativeSigningCommandResult;
		try {
			result = await runner(command);
		} catch {
			throw new Error(`Native ${command.stage} command failed`);
		}
		assertCommandSuccess(command, result);
		if (command.stage === "inspect") {
			inspectOutput = `${result.stdout}\n${result.stderr}`;
		}
	}

	if (plan.policyName === "macos-adhoc") {
		if (!/(?:^|\n)Signature=adhoc(?:\n|$)/.test(inspectOutput)) {
			throw new Error(
				"macOS ad-hoc signature verification did not match policy",
			);
		}
	}
	if (
		plan.policyName === "macos-identity" &&
		(/(?:^|\n)Signature=adhoc(?:\n|$)/.test(inspectOutput) ||
			!/(?:^|\n)Authority=.+(?:\n|$)/.test(inspectOutput))
	) {
		throw new Error("macOS configured signature did not expose an identity");
	}
	if (
		plan.policyName === "windows-explicit-unsigned" &&
		(await hasPeCertificateTable(options.artifactPath))
	) {
		throw new Error(
			"Windows signature removal did not clear the certificate table",
		);
	}
	if (
		plan.policyName === "windows-authenticode" &&
		!(await hasPeCertificateTable(options.artifactPath))
	) {
		throw new Error(
			"Windows Authenticode signing did not create a certificate table",
		);
	}

	return {
		policyName: plan.policyName,
		verification: "pass",
		warningCodes:
			plan.policyName === "macos-adhoc"
				? ["macos-adhoc-identity"]
				: plan.policyName === "windows-explicit-unsigned"
					? ["windows-unsigned-artifact"]
					: [],
	};
}
