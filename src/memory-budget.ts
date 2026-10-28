/// <reference lib="es2024.promise" />

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_MEMORY_MIB = 16384;

const MIB = 1024 * 1024;
const MIN_MEMORY_MIB = 64;
const BUDGET_ENV = "CC_ENHANCED_MEMORY_MAX_MIB";
const SCOPE_PATTERN =
	/^cc-enhanced-memory-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.scope$/;
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const STOP_TIMEOUT_MS = 15_000;

interface MemoryBoundary {
	limitBytes: number;
	cgroupPath: string;
}

interface CgroupHierarchy {
	currentPath: string;
	ancestors: string[];
}

function configuredCeilingMiB(requestedMiB = process.env[BUDGET_ENV]): number {
	if (requestedMiB === undefined) return MAX_MEMORY_MIB;
	if (!/^\d+$/.test(requestedMiB)) {
		throw new Error(
			`${BUDGET_ENV} must be an integer decimal from ${MIN_MEMORY_MIB} to ${MAX_MEMORY_MIB}; it can only lower the RAM ceiling`,
		);
	}
	const value = Number(requestedMiB);
	if (
		!Number.isSafeInteger(value) ||
		value < MIN_MEMORY_MIB ||
		value > MAX_MEMORY_MIB
	) {
		throw new Error(
			`${BUDGET_ENV} must be between ${MIN_MEMORY_MIB} and ${MAX_MEMORY_MIB} MiB; no unlimited override is supported`,
		);
	}
	return value;
}

export function selectMemoryBudgetMiB(
	availableBytes: number,
	requestedMiB = process.env[BUDGET_ENV],
): number {
	const ceiling = configuredCeilingMiB(requestedMiB);
	if (!Number.isSafeInteger(availableBytes) || availableBytes <= 0) {
		throw new Error(
			"Available memory must be a positive, safe integer byte count",
		);
	}
	const budget = Math.min(ceiling, Math.floor(availableBytes / 2 / MIB));
	if (budget < MIN_MEMORY_MIB) {
		throw new Error(
			`Not enough available memory to reserve half as headroom and enforce at least ${MIN_MEMORY_MIB} MiB; stop other workloads before retrying`,
		);
	}
	return budget;
}

function decodeMountPath(value: string): string {
	return value.replace(/\\([0-7]{3})/g, (_, octal: string) =>
		String.fromCharCode(Number.parseInt(octal, 8)),
	);
}

function readHierarchy(): CgroupHierarchy {
	if (process.platform !== "linux") {
		throw new Error("Memory scope initialization requires Linux cgroup v2");
	}
	const memberships = readFileSync("/proc/self/cgroup", "utf8")
		.split("\n")
		.filter((line) => line.startsWith("0::"));
	const membership = memberships[0]?.slice(3);
	if (
		memberships.length !== 1 ||
		!membership?.startsWith("/") ||
		membership.split("/").some((part) => part === "." || part === "..")
	) {
		throw new Error(
			"Cannot establish the current cgroup v2 membership; enable Linux cgroup v2 memory accounting before running heavy work",
		);
	}

	// Use the kernel's mount table, not an environment-controlled cgroup path.
	let mount: { root: string; directory: string } | undefined;
	for (const line of readFileSync("/proc/self/mountinfo", "utf8").split("\n")) {
		const [fields, filesystem] = line.split(" - ");
		if (!filesystem?.startsWith("cgroup2 ")) continue;
		const columns = fields.split(" ");
		const root = decodeMountPath(columns[3] ?? "");
		const directory = decodeMountPath(columns[4] ?? "");
		if (
			!root.startsWith("/") ||
			!directory.startsWith("/") ||
			(root !== "/" &&
				membership !== root &&
				!membership.startsWith(`${root}/`))
		) {
			continue;
		}
		if (!mount || root.length < mount.root.length) mount = { root, directory };
	}
	if (!mount) {
		throw new Error(
			"No accessible cgroup v2 mount contains this process; enable cgroup v2 and the systemd user manager before running heavy work",
		);
	}
	const currentPath = path.join(
		mount.directory,
		path.relative(mount.root, membership),
	);
	const ancestors: string[] = [];
	for (let directory = currentPath; ; directory = path.dirname(directory)) {
		ancestors.push(directory);
		if (directory === mount.directory) break;
		if (directory === path.dirname(directory)) {
			throw new Error("Cannot resolve the cgroup v2 mount boundary");
		}
	}
	return { currentPath, ancestors };
}

function readControl(directory: string, name: string): string | undefined {
	try {
		return readFileSync(path.join(directory, name), "utf8").trim();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function readBytes(directory: string, name: string): bigint | undefined {
	const value = readControl(directory, name);
	if (value === undefined || (name === "memory.max" && value === "max")) {
		return undefined;
	}
	if (!/^\d+$/.test(value)) {
		throw new Error(`Cannot verify ${name} in ${directory}`);
	}
	return BigInt(value);
}

function findBoundary(
	hierarchy: CgroupHierarchy,
	ceilingMiB: number,
): MemoryBoundary | undefined {
	const ceilingBytes = BigInt(ceilingMiB * MIB);
	for (const directory of hierarchy.ancestors) {
		const limit = readBytes(directory, "memory.max");
		if (
			limit !== undefined &&
			limit > 0n &&
			limit <= ceilingBytes &&
			readControl(directory, "memory.swap.max") === "0" &&
			readControl(directory, "memory.oom.group") === "1"
		) {
			return { limitBytes: Number(limit), cgroupPath: directory };
		}
	}
	return undefined;
}

export function assertMemoryBudget(): MemoryBoundary | undefined {
	// Other supported platforms retain their existing tooling behavior. Only the
	// Linux runner claims kernel containment; its validation never falls back.
	if (process.platform !== "linux") return undefined;
	const ceiling = configuredCeilingMiB();
	const boundary = findBoundary(readHierarchy(), ceiling);
	if (!boundary) {
		throw new Error(
			`No verified cgroup memory boundary: require memory.max <= ${ceiling} MiB, memory.swap.max=0 and memory.oom.group=1 in one containing cgroup. Run through scripts/run-memory-limited.ts -- <command> instead`,
		);
	}
	return boundary;
}

export function initializeMemoryScope(expectedScope: string): void {
	if (!SCOPE_PATTERN.test(expectedScope)) {
		throw new Error("Refusing an invalid internal memory scope name");
	}
	const hierarchy = readHierarchy();
	if (path.basename(hierarchy.currentPath) !== expectedScope) {
		throw new Error(
			"Refusing internal memory bootstrap outside its exact generated cgroup scope",
		);
	}
	const limit = readBytes(hierarchy.currentPath, "memory.max");
	if (
		limit === undefined ||
		limit <= 0n ||
		limit > BigInt(configuredCeilingMiB() * MIB) ||
		readControl(hierarchy.currentPath, "memory.swap.max") !== "0"
	) {
		throw new Error(
			"Refusing internal memory bootstrap: the scope must already enforce the configured RAM ceiling and zero swap",
		);
	}
	// Only this exact, already-bounded generated scope may be modified. Never
	// change a user's containing cgroup just to make validation pass.
	try {
		writeFileSync(path.join(hierarchy.currentPath, "memory.oom.group"), "1\n");
	} catch (error) {
		throw new Error(
			"Cannot enable whole-group OOM protection in the memory scope; check cgroup memory-controller permissions",
			{ cause: error },
		);
	}
	assertMemoryBudget();
}

function availableMemoryBytes(hierarchy: CgroupHierarchy): number {
	const match = /^MemAvailable:[ \t]+(\d+)[ \t]+kB[ \t]*$/m.exec(
		readFileSync("/proc/meminfo", "utf8"),
	);
	if (!match)
		throw new Error("Cannot determine MemAvailable from /proc/meminfo");
	let available = Number(match[1]) * 1024;
	if (!Number.isSafeInteger(available) || available <= 0) {
		throw new Error("The kernel reported invalid available memory");
	}
	for (const directory of hierarchy.ancestors) {
		const limit = readBytes(directory, "memory.max");
		if (limit === undefined) continue;
		const current = readBytes(directory, "memory.current");
		if (current === undefined) {
			throw new Error(`Cannot determine memory headroom in ${directory}`);
		}
		available = Math.min(available, Number(limit - current));
	}
	return available;
}

async function stopOwnedScope(scope: string): Promise<void> {
	// This function is only called with the UUID generated by runMemoryLimited,
	// never with a scope name supplied to the internal bootstrap.
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const child = spawn(
		"systemctl",
		["--user", "--no-ask-password", "--quiet", "stop", "--", scope],
		{
			stdio: "ignore",
			timeout: STOP_TIMEOUT_MS,
			killSignal: "SIGKILL",
		},
	);
	child.once("error", reject);
	child.once("close", (code, signal) => {
		// --collect may have already unloaded an empty scope. systemctl uses
		// LSB status 5 for a unit that is not loaded.
		if (code === 0 || code === 5) resolve();
		else {
			reject(
				new Error(
					`Could not stop owned memory scope ${scope} (${signal ?? `status ${code}`}); check systemctl --user`,
				),
			);
		}
	});
	await promise;
}

async function executeCommand(
	command: string,
	args: readonly string[],
	ownedScope?: string,
): Promise<number> {
	let child: ChildProcess | undefined;
	let receivedSignal: NodeJS.Signals | undefined;
	let escalation: NodeJS.Timeout | undefined;
	let finished = false;
	let cleanupFailed = false;
	const listeners = FORWARDED_SIGNALS.map((signal) => {
		const listener = () => {
			receivedSignal ??= signal;
			if (finished) return;
			child?.kill(signal);
			// An ignoring child cannot keep the wrapper waiting forever before
			// its finally block stops the entire owned scope.
			escalation ??= setTimeout(() => child?.kill("SIGKILL"), 5_000);
			escalation.unref();
		};
		process.on(signal, listener);
		return { signal, listener };
	});
	let outcome: { code: number | null; signal: NodeJS.Signals | null };
	try {
		const { promise, resolve, reject } = Promise.withResolvers<{
			code: number | null;
			signal: NodeJS.Signals | null;
		}>();
		// Scope mode preserves the caller's environment, cwd and stdio. Do
		// not serialize secrets into --setenv arguments or a shell command.
		child = spawn(command, args, { stdio: "inherit" });
		child.once("error", reject);
		child.once("close", (code, signal) => resolve({ code, signal }));
		outcome = await promise;
	} finally {
		finished = true;
		clearTimeout(escalation);
		try {
			if (ownedScope) await stopOwnedScope(ownedScope);
		} catch (error) {
			cleanupFailed = true;
			console.error(
				`[memory] Scope cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			for (const { signal, listener } of listeners)
				process.off(signal, listener);
		}
	}
	if (outcome.signal) {
		console.error(`[memory] Command terminated by ${outcome.signal}`);
		return 128 + (constants.signals[outcome.signal] ?? 1);
	}
	if (outcome.code !== 0) {
		console.error(`[memory] Command exited with status ${outcome.code ?? 1}`);
		return outcome.code ?? 1;
	}
	if (receivedSignal) {
		console.error(`[memory] Wrapper interrupted by ${receivedSignal}`);
		return 128 + (constants.signals[receivedSignal] ?? 1);
	}
	return cleanupFailed ? 1 : 0;
}

export async function runMemoryLimited(
	command: string,
	args: readonly string[],
): Promise<number> {
	if (!command) throw new Error("A command is required for the memory runner");
	if (process.platform !== "linux") {
		console.error(
			`[memory] Kernel memory containment is Linux-only; no kernel memory limit is provided on ${process.platform}`,
		);
		return executeCommand(command, args);
	}
	const ceiling = configuredCeilingMiB();
	const hierarchy = readHierarchy();
	const boundary = findBoundary(hierarchy, ceiling);
	if (boundary) {
		console.error(
			`[memory] Sharing ${(boundary.limitBytes / MIB).toFixed(1)} MiB RAM across the process tree; swap disabled`,
		);
		return executeCommand(command, args);
	}
	if (
		hierarchy.ancestors.some((directory) =>
			/^cc-enhanced-memory-.*\.scope$/.test(path.basename(directory)),
		)
	) {
		throw new Error(
			"The inherited cc-enhanced memory scope does not satisfy the requested protection; refusing to escape it into a new scope. Restart the outer command with the desired lower memory ceiling",
		);
	}
	if (!process.versions.bun) {
		throw new Error(
			"Start scripts/run-memory-limited.ts with Bun so its bounded bootstrap can run with --smol",
		);
	}
	const budget = selectMemoryBudgetMiB(availableMemoryBytes(hierarchy));
	const scope = `cc-enhanced-memory-${randomUUID()}.scope`;
	const bootstrap = fileURLToPath(
		new URL("../scripts/run-memory-limited.ts", import.meta.url),
	);
	console.error(
		`[memory] Limiting the process tree to ${budget} MiB RAM; swap disabled; whole-group OOM termination required`,
	);
	return executeCommand(
		"systemd-run",
		[
			"--user",
			"--scope",
			"--quiet",
			"--collect",
			"--no-ask-password",
			"--expand-environment=no",
			`--unit=${scope}`,
			"--description=cc-enhanced bounded workload",
			`--property=MemoryMax=${budget * MIB}`,
			"--property=MemorySwapMax=0",
			"--property=KillMode=control-group",
			"--property=SendSIGKILL=yes",
			"--property=TimeoutStopSec=5s",
			"--",
			process.execPath,
			"--smol",
			bootstrap,
			"--inside",
			scope,
			"--",
			command,
			...args,
		],
		scope,
	);
}
