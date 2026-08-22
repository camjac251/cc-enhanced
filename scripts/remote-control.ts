import process from "node:process";
import { hideBin } from "yargs/helpers";
import yargs from "yargs/yargs";
import { createOperationResult } from "../src/operations/contract.js";
import { renderOperationJson } from "../src/presentation/json.js";
import { renderRemoteControlReadiness } from "../src/presentation/remote-control.js";
import { superviseRemoteControlServer } from "../src/remote-control/launcher.js";
import {
	createRemoteControlReadinessPlan,
	createRemoteControlReadinessResult,
	inspectRemoteControlConfiguration,
	type RemoteControlEligibility,
	type RemoteControlServerChoice,
	readRemoteControlHostReceipt,
} from "../src/remote-control/readiness.js";

interface RemoteControlArguments {
	doctor?: boolean;
	start?: boolean;
	json?: boolean;
	evidence?: boolean;
	settings?: string[];
	hostReceipt?: string;
	binary?: string;
	workspace?: string;
	subscriptionConfirmed?: boolean;
	organizationEnabled?: boolean;
	organizationNotRequired?: boolean;
	workspaceTrusted?: boolean;
	workspaceKind?: "git" | "non-git";
	spawn?: "same-dir" | "worktree" | "session";
	capacity?: number;
	sandbox?: boolean;
	createSessionInDir?: boolean;
	acknowledgeTranscriptStorage?: boolean;
	authorizeLiveStart?: boolean;
}

function eligibilityFrom(
	argv: RemoteControlArguments,
): RemoteControlEligibility {
	return {
		subscription: argv.subscriptionConfirmed ? "confirmed" : "unknown",
		organizationEnablement: argv.organizationEnabled
			? "confirmed"
			: argv.organizationNotRequired
				? "not-required"
				: "unknown",
		workspaceTrust: argv.workspaceTrusted ? "confirmed" : "unknown",
		workspaceKind: argv.workspaceKind ?? "unknown",
	};
}

function serverChoiceFrom(
	argv: RemoteControlArguments,
): RemoteControlServerChoice | undefined {
	const hasChoice =
		argv.spawn !== undefined ||
		argv.capacity !== undefined ||
		argv.sandbox !== undefined ||
		argv.createSessionInDir !== undefined;
	if (!hasChoice) return undefined;
	if (
		argv.spawn === undefined ||
		argv.sandbox === undefined ||
		argv.createSessionInDir === undefined
	) {
		throw new Error(
			"Server choice requires explicit spawn, sandbox, and create-session settings",
		);
	}
	if (argv.spawn === "session") {
		if (argv.capacity !== undefined) {
			throw new Error("Session spawn cannot be combined with capacity");
		}
		return {
			spawn: argv.spawn,
			capacity: null,
			sandbox: argv.sandbox ? "enabled" : "disabled",
			createSessionInDir: argv.createSessionInDir,
		};
	}
	if (argv.capacity === undefined) {
		throw new Error("Same-directory and worktree spawn require capacity");
	}
	return {
		spawn: argv.spawn,
		capacity: argv.capacity,
		sandbox: argv.sandbox ? "enabled" : "disabled",
		createSessionInDir: argv.createSessionInDir,
	};
}

async function parseArguments(): Promise<RemoteControlArguments> {
	return (await yargs(hideBin(process.argv))
		.version(false)
		.exitProcess(false)
		.fail((message, error) => {
			throw error ?? new Error(message);
		})
		.option("doctor", {
			type: "boolean",
			description:
				"Inspect known environment blockers and explicit settings files",
		})
		.option("start", {
			type: "boolean",
			description: "Start the receipt-bound upstream server in the foreground",
		})
		.option("json", {
			type: "boolean",
			description: "Render the shared operation envelope as JSON",
		})
		.option("evidence", {
			type: "boolean",
			description: "Render the deterministic path-free readiness plan",
		})
		.option("settings", {
			type: "string",
			array: true,
			description: "Explicit settings document to inspect",
		})
		.option("host-receipt", {
			type: "string",
			description: "Explicit verified native host receipt",
		})
		.option("binary", {
			type: "string",
			description: "Explicit receipt-bound patched host binary",
		})
		.option("workspace", {
			type: "string",
			description: "Explicit trusted workspace for a live start",
		})
		.option("subscription-confirmed", { type: "boolean" })
		.option("organization-enabled", { type: "boolean" })
		.option("organization-not-required", { type: "boolean" })
		.option("workspace-trusted", { type: "boolean" })
		.option("workspace-kind", {
			type: "string",
			choices: ["git", "non-git"] as const,
		})
		.option("spawn", {
			type: "string",
			choices: ["same-dir", "worktree", "session"] as const,
		})
		.option("capacity", { type: "number" })
		.option("sandbox", { type: "boolean" })
		.option("create-session-in-dir", { type: "boolean" })
		.option("acknowledge-transcript-storage", { type: "boolean" })
		.option("authorize-live-start", { type: "boolean" })
		.conflicts("evidence", ["json", "doctor", "start"])
		.conflicts("organization-enabled", "organization-not-required")
		.implies("start", "doctor")
		.strict()
		.help()
		.parse()) as RemoteControlArguments;
}

function assertStartArguments(
	argv: RemoteControlArguments,
): asserts argv is RemoteControlArguments & {
	hostReceipt: string;
	binary: string;
	workspace: string;
} {
	if (argv.acknowledgeTranscriptStorage !== true) {
		throw new Error("Start requires transcript storage acknowledgement");
	}
	if (argv.authorizeLiveStart !== true) {
		throw new Error("Start requires explicit live authorization");
	}
	if (!argv.hostReceipt || !argv.binary || !argv.workspace) {
		throw new Error(
			"Start requires explicit host receipt, binary, and workspace inputs",
		);
	}
	if (
		!argv.subscriptionConfirmed ||
		(!argv.organizationEnabled && !argv.organizationNotRequired) ||
		!argv.workspaceTrusted ||
		!argv.workspaceKind
	) {
		throw new Error("Start requires every operator eligibility attestation");
	}
	if (!serverChoiceFrom(argv)) {
		throw new Error("Start requires an explicit bounded server choice");
	}
}

async function main(): Promise<void> {
	const argv = await parseArguments();
	if (argv.start) assertStartArguments(argv);

	const hostReceipt =
		argv.doctor && argv.hostReceipt
			? await readRemoteControlHostReceipt(argv.hostReceipt)
			: undefined;
	const evidence = argv.doctor
		? createRemoteControlReadinessPlan({
				configuration: await inspectRemoteControlConfiguration({
					env: process.env,
					settingsFiles: argv.settings ?? [],
				}),
				hostReceipt,
				eligibility: eligibilityFrom(argv),
				server: serverChoiceFrom(argv),
			})
		: createRemoteControlReadinessPlan();

	if (argv.start) {
		assertStartArguments(argv);
		if (!hostReceipt) throw new Error("Start requires a verified host receipt");
		const exit = await superviseRemoteControlServer({
			readiness: evidence,
			hostReceipt,
			binaryPath: argv.binary,
			cwd: argv.workspace,
			acknowledgeTranscriptStorage: true,
			authorizeLiveStart: true,
		});
		const result = createOperationResult({
			operation: "remote-control-launch",
			ok: exit.successful,
			data: exit,
			checks: [
				{
					id: "foreground-supervision",
					status: exit.successful ? "pass" : "fail",
				},
			],
		});
		process.stdout.write(
			argv.json
				? `${renderOperationJson(result)}\n`
				: `Remote Control server ${exit.status}; exit code ${exit.exitCode ?? "none"}; signal ${exit.signal ?? "none"}\n`,
		);
		process.exitCode = exit.successful ? 0 : (exit.exitCode ?? 1);
		return;
	}

	const result = createRemoteControlReadinessResult(evidence);
	process.stdout.write(
		argv.evidence
			? `${JSON.stringify(evidence, null, "\t")}\n`
			: argv.json
				? `${renderOperationJson(result)}\n`
				: `${renderRemoteControlReadiness(result).join("\n")}\n`,
	);
	if (!result.ok) process.exitCode = 1;
}

try {
	await main();
} catch (error) {
	const message = error instanceof Error ? error.message : "unknown failure";
	process.stderr.write(`Remote Control: ${message}\n`);
	process.exitCode = 1;
}
