import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { selectMemoryBudgetMiB } from "./memory-budget.js";

const MiB = 1024 * 1024;
const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const runner = path.join(repoRoot, "scripts", "run-memory-limited.ts");
const memoryModule = pathToFileURL(
	path.join(repoRoot, "src", "memory-budget.ts"),
).href;

interface CommandResult {
	status: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

function childEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.CC_ENHANCED_MEMORY_MAX_MIB;
	return { ...env, NO_COLOR: "1", ...overrides };
}

function withoutMemoryOverride(body: () => void): void {
	const previous = process.env.CC_ENHANCED_MEMORY_MAX_MIB;
	delete process.env.CC_ENHANCED_MEMORY_MAX_MIB;
	try {
		body();
	} finally {
		if (previous === undefined) delete process.env.CC_ENHANCED_MEMORY_MAX_MIB;
		else process.env.CC_ENHANCED_MEMORY_MAX_MIB = previous;
	}
}

function fixtureDirectory(t: TestContext): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cc-memory-test-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	return directory;
}

function fixture(directory: string, name: string, body: string): string {
	const filename = path.join(directory, `${name}.ts`);
	fs.writeFileSync(
		filename,
		`
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { assertMemoryBudget, initializeMemoryScope, runMemoryLimited } from ${JSON.stringify(memoryModule)};
function currentCgroup() {
  const line = fs.readFileSync("/proc/self/cgroup", "utf8").split("\\n").find(line => line.startsWith("0::"));
  assert.ok(line, "expected a unified cgroup membership");
  return path.join("/sys/fs/cgroup", line.slice(3));
}
function control(directory, name) {
  return fs.readFileSync(path.join(directory, name), "utf8").trim();
}
${body}
`,
	);
	return filename;
}

async function runCommand(
	command: string,
	args: readonly string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<CommandResult> {
	const { promise, resolve, reject } = Promise.withResolvers<CommandResult>();
	const child = spawn(command, [...args], {
		cwd: options.cwd ?? repoRoot,
		env: options.env ?? childEnv(),
		stdio: ["pipe", "pipe", "pipe"],
		detached: process.platform !== "win32",
	});
	let stdout = "";
	let stderr = "";
	let timedOut = false;
	const killTree = () => {
		if (!child.pid) return;
		try {
			if (process.platform === "win32") child.kill("SIGKILL");
			else process.kill(-child.pid, "SIGKILL");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	};
	// A real deadline bounds external kernel/systemd work; fake timers cannot
	// terminate those processes. Assertions await exits and readiness, not time.
	const timer = setTimeout(() => {
		timedOut = true;
		killTree();
		// Let the scope's finally block run even if a descendant retained a pipe.
		resolve({
			status: child.exitCode,
			signal: child.signalCode,
			stdout,
			stderr,
			timedOut,
		});
	}, 20_000);
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk;
	});
	child.stdin.on("error", () => {});
	child.stdin.end(options.input ?? "");
	child.once("error", (error) => {
		clearTimeout(timer);
		killTree();
		reject(error);
	});
	child.once("close", (status, signal) => {
		clearTimeout(timer);
		killTree();
		resolve({ status, signal, stdout, stderr, timedOut });
	});
	return promise;
}

let kernelUnavailable: string | null | undefined;
function requireKernel(t: TestContext): boolean {
	if (kernelUnavailable === undefined) {
		if (process.platform !== "linux") {
			kernelUnavailable = "requires Linux cgroup v2 and a systemd user manager";
		} else if (
			!fs.existsSync("/sys/fs/cgroup/cgroup.controllers") ||
			!fs
				.readFileSync("/sys/fs/cgroup/cgroup.controllers", "utf8")
				.split(/\s+/)
				.includes("memory")
		) {
			kernelUnavailable = "the cgroup v2 memory controller is unavailable";
		} else {
			const executable = spawnSync("systemd-run", ["--version"], {
				encoding: "utf8",
				timeout: 5_000,
				killSignal: "SIGKILL",
			});
			if (
				(executable.error as NodeJS.ErrnoException | undefined)?.code ===
				"ENOENT"
			) {
				kernelUnavailable = "systemd-run is not installed";
			} else {
				assert.ifError(executable.error);
				assert.equal(executable.status, 0, executable.stderr);
				const manager = spawnSync(
					"systemctl",
					["--user", "show", "--property=Version", "--value"],
					{
						encoding: "utf8",
						timeout: 5_000,
						killSignal: "SIGKILL",
					},
				);
				if (
					(manager.error as NodeJS.ErrnoException | undefined)?.code ===
					"ENOENT"
				)
					kernelUnavailable = "systemctl is not installed";
				else {
					assert.ifError(manager.error);
					kernelUnavailable =
						manager.status === 0
							? null
							: `systemd user manager unavailable: ${manager.stderr.trim()}`;
				}
			}
		}
	}
	if (kernelUnavailable) t.skip(kernelUnavailable);
	return !kernelUnavailable;
}

function systemctl(args: string[]) {
	return spawnSync("systemctl", ["--user", ...args], {
		encoding: "utf8",
		timeout: 5_000,
		killSignal: "SIGKILL",
	});
}

async function runScope(
	command: readonly string[],
	options: {
		bootstrap?: boolean;
		owned?: boolean;
		swapMiB?: number;
		cwd?: string;
		env?: NodeJS.ProcessEnv;
		input?: string;
	} = {},
): Promise<CommandResult & { unit: string; unitResult: string }> {
	const unit = `${options.owned === false ? "cc-budget-test" : "cc-enhanced-memory"}-${randomUUID()}.scope`;
	const args =
		options.bootstrap === false
			? [...command]
			: [
					process.execPath,
					"--smol",
					runner,
					"--inside",
					unit,
					"--",
					...command,
				];
	try {
		// A sibling scope is intentional: the full suite itself already has a
		// large aggregate cap. Never change that scope or allocate against it.
		const result = await runCommand(
			"systemd-run",
			[
				"--user",
				"--scope",
				"--quiet",
				"--expand-environment=no",
				`--unit=${unit}`,
				"--property=MemoryMax=256M",
				`--property=MemorySwapMax=${options.swapMiB ?? 0}M`,
				"--",
				...args,
			],
			{
				...options,
				env: childEnv({
					CC_ENHANCED_MEMORY_MAX_MIB: "256",
					MEMORY_TEST_SCOPE: unit,
					...options.env,
				}),
			},
		);
		assert.equal(result.timedOut, false, `scope timed out: ${result.stderr}`);
		// Do not use --collect: retain failed scopes long enough to read the
		// kernel OOM result, then explicitly stop and reset only our own unit.
		const unitResult = systemctl([
			"show",
			unit,
			"--property=Result",
			"--value",
		]);
		assert.ifError(unitResult.error);
		return { ...result, unit, unitResult: unitResult.stdout.trim() };
	} finally {
		for (const action of ["stop", "reset-failed"]) {
			const cleanup = systemctl([action, unit]);
			assert.ifError(cleanup.error);
			if (cleanup.status !== 0) {
				assert.match(
					cleanup.stderr,
					/not (?:loaded|found)|does not exist/i,
					cleanup.stderr,
				);
			}
		}
	}
}

function assertSuccess(result: CommandResult): void {
	assert.equal(result.timedOut, false, result.stderr);
	assert.equal(result.signal, null, result.stderr);
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

test("memory budget reserves half the available headroom and never exceeds 16 GiB", () => {
	withoutMemoryOverride(() => {
		assert.equal(selectMemoryBudgetMiB(64 * 1024 * MiB), 16384);
		assert.equal(selectMemoryBudgetMiB(1025 * MiB), 512);
		assert.equal(selectMemoryBudgetMiB(128 * MiB), 64);
		assert.equal(selectMemoryBudgetMiB(256 * MiB - 1), 127);
		assert.equal(selectMemoryBudgetMiB(64 * 1024 * MiB, "256"), 256);
		assert.equal(selectMemoryBudgetMiB(256 * MiB, "16384"), 128);
		assert.equal(selectMemoryBudgetMiB(64 * 1024 * MiB, "64"), 64);
		assert.equal(selectMemoryBudgetMiB(64 * 1024 * MiB, "0064"), 64);
	});
});

test("memory budget rejects invalid availability and non-lowering or malformed overrides", () => {
	withoutMemoryOverride(() => {
		for (const available of [
			0,
			-1,
			NaN,
			Infinity,
			-Infinity,
			Number.MAX_SAFE_INTEGER + 1,
			127 * MiB,
		]) {
			assert.throws(() => selectMemoryBudgetMiB(available), String(available));
		}
		for (const requested of [
			"",
			" ",
			" 64",
			"64 ",
			"+64",
			"-64",
			"0",
			"63",
			"16385",
			"64.0",
			"1e3",
			"0x100",
			"NaN",
			"Infinity",
		]) {
			assert.throws(
				() => selectMemoryBudgetMiB(64 * 1024 * MiB, requested),
				Error,
				JSON.stringify(requested),
			);
		}
	});
});

test("forged internal CLI bootstrap refuses before executing a command even in a bounded parent", {
	timeout: 60_000,
}, async (t) => {
	const directory = fixtureDirectory(t);
	const marker = path.join(directory, "must-not-exist");
	const result = await runCommand(
		process.execPath,
		[
			"--smol",
			runner,
			"--inside",
			`cc-enhanced-memory-${randomUUID()}.scope`,
			"--",
			process.execPath,
			"--smol",
			"-e",
			`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed")`,
		],
		{ env: childEnv({ CC_ENHANCED_MEMORY_MAX_MIB: "256" }) },
	);
	assert.equal(result.timedOut, false, result.stderr);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /memory|scope|cgroup|linux/i);
	assert.equal(fs.existsSync(marker), false);
});

test("scope initialization checks real protection and a lower cap cannot escape an owned scope", {
	timeout: 60_000,
}, async (t) => {
	if (!requireKernel(t)) return;
	const directory = fixtureDirectory(t);
	const marker = path.join(directory, "escaped");
	const script = fixture(
		directory,
		"initialize",
		`
const current = currentCgroup();
assert.equal(control(current, "memory.max"), String(256 * 1024 * 1024));
assert.equal(control(current, "memory.swap.max"), "0");
assert.equal(control(current, "memory.oom.group"), "0");
assert.throws(() => assertMemoryBudget(), /memory|cgroup|scope|protect/i);
assert.throws(() => initializeMemoryScope("cc-enhanced-memory-00000000-0000-4000-8000-000000000000.scope"));
assert.equal(control(current, "memory.oom.group"), "0", "forged bootstrap must not alter another scope");
process.env.CC_ENHANCED_MEMORY_MAX_MIB = "128";
assert.throws(() => initializeMemoryScope(process.env.MEMORY_TEST_SCOPE));
assert.equal(control(current, "memory.oom.group"), "0", "over-budget bootstrap must not mutate the scope");
process.env.CC_ENHANCED_MEMORY_MAX_MIB = "256";
initializeMemoryScope(process.env.MEMORY_TEST_SCOPE);
assert.deepEqual(assertMemoryBudget(), { limitBytes: 256 * 1024 * 1024, cgroupPath: current });
assert.equal(control(current, "memory.oom.group"), "1");
process.env.CC_ENHANCED_MEMORY_MAX_MIB = "128";
assert.throws(() => assertMemoryBudget());
await assert.rejects(runMemoryLimited(process.execPath, ["--smol", "-e", ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "escaped")`)}]));
assert.equal(fs.existsSync(${JSON.stringify(marker)}), false);
console.log("protected");
`,
	);
	const result = await runScope([process.execPath, "--smol", script], {
		bootstrap: false,
	});
	assertSuccess(result);
	assert.equal(result.stdout.trim(), "protected");
	assert.equal(fs.existsSync(marker), false);
});

test("bootstrap refuses a scope that still permits swap without changing its OOM policy", {
	timeout: 60_000,
}, async (t) => {
	if (!requireKernel(t)) return;
	const directory = fixtureDirectory(t);
	const script = fixture(
		directory,
		"swap",
		`
const current = currentCgroup();
assert.equal(control(current, "memory.swap.max"), String(1024 * 1024));
assert.equal(control(current, "memory.oom.group"), "0");
assert.throws(() => initializeMemoryScope(process.env.MEMORY_TEST_SCOPE), /swap|memory|protect/i);
assert.equal(control(current, "memory.oom.group"), "0");
`,
	);
	assertSuccess(
		await runScope([process.execPath, "--smol", script], {
			bootstrap: false,
			swapMiB: 1,
		}),
	);
});

test("unprotected work fails closed when a systemd scope cannot be launched", {
	timeout: 60_000,
}, async (t) => {
	if (!requireKernel(t)) return;
	const directory = fixtureDirectory(t);
	const marker = path.join(directory, "unbounded");
	const script = fixture(
		directory,
		"no-manager",
		`
assert.throws(() => assertMemoryBudget());
process.env.PATH = ${JSON.stringify(directory)};
process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=" + ${JSON.stringify(path.join(directory, "missing-bus"))};
await assert.rejects(runMemoryLimited(process.execPath, ["--smol", "-e", ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "unbounded")`)}]));
assert.equal(fs.existsSync(${JSON.stringify(marker)}), false);
`,
	);
	assertSuccess(
		await runScope([process.execPath, "--smol", script], {
			bootstrap: false,
			owned: false,
		}),
	);
	assert.equal(fs.existsSync(marker), false);
});

test("public CLI creates real bounds and preserves literal argv, environment, cwd, stdin and nonzero exits", {
	timeout: 60_000,
}, async (t) => {
	if (!requireKernel(t)) return;
	const directory = fixtureDirectory(t);
	const cwd = path.join(directory, "working directory $literal");
	fs.mkdirSync(cwd);
	const argv = [
		"",
		"with spaces",
		"$HOME",
		"${USER}",
		"$(touch must-not-exist)",
		"quote'\"",
		"--literal",
		"line\nbreak",
		"λ",
	];
	const input = "stdin with $literal and unicode λ\n";
	const secret = "synthetic environment value $HOME\nsecond line";
	const script = fixture(
		directory,
		"consumer",
		`
const boundary = assertMemoryBudget();
console.log(JSON.stringify({
  argv: process.argv.slice(2), cwd: process.cwd(), value: process.env.MEMORY_TEST_VALUE,
  stdin: fs.readFileSync(0, "utf8"), boundary, current: currentCgroup(),
  swap: control(boundary.cgroupPath, "memory.swap.max"),
  oom: control(boundary.cgroupPath, "memory.oom.group"),
  maximum: Number(control(boundary.cgroupPath, "memory.max")),
}));
console.error("consumer stderr preserved");
process.exit(23);
`,
	);
	const result = await runScope(
		[
			process.execPath,
			"--smol",
			runner,
			"--",
			process.execPath,
			"--smol",
			script,
			...argv,
		],
		{
			bootstrap: false,
			owned: false,
			cwd,
			input,
			env: { CC_ENHANCED_MEMORY_MAX_MIB: "128", MEMORY_TEST_VALUE: secret },
		},
	);
	assert.equal(result.signal, null, result.stderr);
	assert.equal(result.status, 23, result.stderr);
	const observed = JSON.parse(result.stdout);
	assert.deepEqual(observed.argv, argv);
	assert.equal(observed.cwd, cwd);
	assert.equal(observed.value, secret);
	assert.equal(observed.stdin, input);
	assert.equal(observed.boundary.cgroupPath, observed.current);
	assert.equal(observed.boundary.limitBytes, observed.maximum);
	assert.ok(observed.maximum >= 64 * MiB && observed.maximum <= 128 * MiB);
	assert.match(
		path.basename(observed.current),
		/^cc-enhanced-memory-[0-9a-f-]+\.scope$/,
	);
	assert.notEqual(path.basename(observed.current), result.unit);
	assert.equal(observed.swap, "0");
	assert.equal(observed.oom, "1");
	assert.match(result.stderr, /consumer stderr preserved/);
	assert.match(result.stderr, /128|MiB|memory/i);
	assert.doesNotMatch(result.stderr, /out of memory|oom.kill/i);
	assert.equal(fs.existsSync(path.join(cwd, "must-not-exist")), false);
});

test("nested API and CLI invocations retain one aggregate cgroup budget", {
	timeout: 60_000,
}, async (t) => {
	if (!requireKernel(t)) return;
	const directory = fixtureDirectory(t);
	const leaf = fixture(
		directory,
		"nested-leaf",
		`
const boundary = assertMemoryBudget();
assert.equal(boundary.cgroupPath, process.env.MEMORY_TEST_PARENT_CGROUP);
assert.equal(currentCgroup(), boundary.cgroupPath);
assert.equal(boundary.limitBytes, 256 * 1024 * 1024);
assert.equal(control(boundary.cgroupPath, "memory.swap.max"), "0");
assert.equal(control(boundary.cgroupPath, "memory.oom.group"), "1");
console.log(JSON.stringify(boundary));
process.exit(17);
`,
	);
	const parent = fixture(
		directory,
		"nested-parent",
		`
const boundary = assertMemoryBudget();
assert.equal(currentCgroup(), boundary.cgroupPath);
process.env.MEMORY_TEST_PARENT_CGROUP = boundary.cgroupPath;
console.log(JSON.stringify(boundary));
const status = await runMemoryLimited(process.execPath, ["--smol", ${JSON.stringify(runner)}, "--", process.execPath, "--smol", ${JSON.stringify(leaf)}]);
assert.equal(status, 17);
assert.deepEqual(assertMemoryBudget(), boundary);
`,
	);
	const result = await runScope([process.execPath, "--smol", parent]);
	assertSuccess(result);
	const records = result.stdout
		.trim()
		.split(/\r?\n/)
		.map((line) => JSON.parse(line));
	assert.equal(records.length, 2);
	assert.deepEqual(records[0], records[1]);
	assert.equal(path.basename(records[0].cgroupPath), result.unit);
	assert.equal(records[0].limitBytes, 256 * MiB);
});

test("CLI propagates an actual child signal without inventing an OOM cause", {
	timeout: 60_000,
}, async (t) => {
	if (!requireKernel(t)) return;
	const result = await runScope([
		process.execPath,
		"--smol",
		"-e",
		'process.kill(process.pid, "SIGTERM")',
	]);
	assert.equal(result.signal, null, result.stderr);
	assert.equal(result.status, 143, result.stderr);
	assert.match(result.stderr, /SIGTERM/);
	assert.doesNotMatch(result.stderr, /out of memory|oom.kill/i);
});

test("the kernel kills the entire nested process tree when its combined memory exceeds 256 MiB", {
	timeout: 60_000,
}, async (t) => {
	if (!requireKernel(t)) return;
	const directory = fixtureDirectory(t);
	const worker = fixture(
		directory,
		"oom-worker",
		`
const current = currentCgroup();
// These independent kernel reads are a safety interlock, not an env-marker
// assertion. No allocation occurs if nesting or any real limit is wrong.
assert.equal(current, process.env.MEMORY_TEST_PARENT_CGROUP);
assert.equal(control(current, "memory.max"), String(256 * 1024 * 1024));
assert.equal(control(current, "memory.swap.max"), "0");
assert.equal(control(current, "memory.oom.group"), "1");
assert.equal(assertMemoryBudget().cgroupPath, current);
fs.writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, current }));
process.stdout.write("ready\\n");
assert.equal(fs.readFileSync(0, "utf8"), "allocate\\n");
// Each worker requests only half the cap. Together, plus the supervising
// processes, they exceed the aggregate limit without a large host allocation.
globalThis.memoryTestBuffer = Buffer.alloc(128 * 1024 * 1024, 0x5a);
// Real watchdogs also bound these external processes if the test runner dies.
setTimeout(() => process.exit(74), 10_000);
`,
	);
	const readyFiles = [
		path.join(directory, "worker-0.json"),
		path.join(directory, "worker-1.json"),
	];
	const supervisor = fixture(
		directory,
		"oom-supervisor",
		`
const current = currentCgroup();
assert.equal(control(current, "memory.max"), String(256 * 1024 * 1024));
assert.equal(control(current, "memory.swap.max"), "0");
assert.equal(control(current, "memory.oom.group"), "1");
process.env.MEMORY_TEST_PARENT_CGROUP = current;
// This is a safety deadline, not a guessed wait for worker readiness.
const watchdog = setTimeout(() => process.exit(75), 12_000);
const workers = ${JSON.stringify(readyFiles)}.map(filename => spawn(process.execPath, [
  "--smol", ${JSON.stringify(runner)}, "--", process.execPath, "--smol", ${JSON.stringify(worker)}, filename,
], { env: process.env, stdio: ["pipe", "pipe", "inherit"] }));
const ready = workers.map(child => {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let output = "";
  child.stdout.on("data", chunk => {
    output += chunk.toString();
    if (output.includes("ready\\n")) resolve();
  });
  child.once("error", reject);
  child.once("exit", code => reject(new Error("worker exited before allocation: " + code)));
  child.stdin.on("error", () => {});
  return promise;
});
const exited = workers.map(child => {
  const { promise, resolve } = Promise.withResolvers<number | null>();
  child.once("exit", resolve);
  return promise;
});
await Promise.all(ready);
fs.writeFileSync(${JSON.stringify(path.join(directory, "all-ready"))}, current);
for (const child of workers) child.stdin.end("allocate\\n");
await Promise.all(exited);
clearTimeout(watchdog);
process.exit(76);
`,
	);
	const result = await runScope([process.execPath, "--smol", supervisor]);
	assert.notEqual(result.status, 0, result.stderr);
	assert.equal(
		fs.existsSync(path.join(directory, "all-ready")),
		true,
		`${result.stdout}\n${result.stderr}`,
	);
	assert.equal(
		result.unitResult,
		"oom-kill",
		`${result.stdout}\n${result.stderr}`,
	);
	for (const filename of readyFiles) {
		const workerState = JSON.parse(fs.readFileSync(filename, "utf8"));
		assert.equal(path.basename(workerState.current), result.unit);
		const stat = `/proc/${workerState.pid}/stat`;
		try {
			assert.match(
				fs.readFileSync(stat, "utf8"),
				/\) [ZX] /,
				"OOM worker must be dead, not merely detached",
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
});

test("non-Linux commands keep their exit behavior without claiming kernel containment", {
	skip: process.platform === "linux",
	timeout: 60_000,
}, async (t) => {
	const directory = fixtureDirectory(t);
	const script = fixture(
		directory,
		"portable",
		`
assert.equal(assertMemoryBudget(), undefined);
console.log("portable command");
process.exit(19);
`,
	);
	const result = await runCommand(process.execPath, [
		"--smol",
		runner,
		"--",
		process.execPath,
		"--smol",
		script,
	]);
	assert.equal(result.timedOut, false, result.stderr);
	assert.equal(result.status, 19, result.stderr);
	assert.equal(result.stdout.trim(), "portable command");
	assert.match(result.stderr, /kernel|memory/i);
	assert.match(result.stderr, /not|no |unavailable|unsupported/i);
});
