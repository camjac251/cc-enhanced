#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, rmSync } from "node:fs";
import { mkdtemp, readdir, readFile, symlink } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const testRoots = ["src", "scripts"].map((directory) =>
	path.join(repoRoot, directory),
);
const testFilePattern = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/;
const isWindows = process.platform === "win32";

async function collectTestFiles(directory) {
	const entries = await readdir(directory, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectTestFiles(entryPath)));
		} else if (entry.isFile() && testFilePattern.test(entry.name)) {
			files.push(path.relative(repoRoot, entryPath));
		}
	}
	return files;
}

// Any Bun on the pinned minor line or newer is accepted, so a patch bump of
// the pin does not reject an install that still tracks the previous patch.
async function readBunFloor() {
	const manifest = JSON.parse(
		await readFile(path.join(repoRoot, "package.json"), "utf8"),
	);
	const match = /^bun@(\d+)\.(\d+)\.\d+(?:\+.+)?$/.exec(
		manifest.packageManager ?? "",
	);
	if (!match) {
		throw new Error(
			`package.json packageManager must pin bun@<version>, found ${JSON.stringify(manifest.packageManager)}`,
		);
	}
	return {
		pin: manifest.packageManager,
		major: Number(match[1]),
		minor: Number(match[2]),
	};
}

// Windows spawns only `.com` and `.exe` files for an extensionless name, in
// that order, so the lookup mirrors it there.
function findOnPath(name) {
	const fileNames = isWindows ? [`${name}.com`, `${name}.exe`] : [name];
	let unusable;
	for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!directory) continue;
		for (const fileName of fileNames) {
			const candidate = path.resolve(directory, fileName);
			try {
				accessSync(candidate, constants.X_OK);
				return { command: candidate };
			} catch (error) {
				if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
					unusable ??= `${candidate}: ${error.code}`;
				}
			}
		}
	}
	return {
		detail: unusable ? `not executable (${unusable})` : "not found on PATH",
	};
}

function probeBun(source, command, floor) {
	const result = spawnSync(command, ["--version"], { encoding: "utf8" });
	if (result.error) {
		const detail =
			result.error.code === "ENOENT" ? "not found" : result.error.message;
		return { source, command, usable: false, detail };
	}
	if (result.status !== 0) {
		return {
			source,
			command,
			usable: false,
			detail: `--version exited ${result.status ?? result.signal}: ${result.stderr.trim()}`,
		};
	}
	const output = result.stdout.trim();
	const match = /^(\d+)\.(\d+)\.\d+/.exec(output);
	if (!match) {
		return {
			source,
			command,
			usable: false,
			detail: `unrecognized --version output ${JSON.stringify(output)}`,
		};
	}
	const major = Number(match[1]);
	const minor = Number(match[2]);
	const usable =
		major > floor.major || (major === floor.major && minor >= floor.minor);
	return {
		source,
		command,
		version: match[0],
		usable,
		detail: usable
			? match[0]
			: `${match[0]} is older than ${floor.major}.${floor.minor}`,
	};
}

// Tries the Bun that launched `bun run`, then `bun` on PATH, then the Bun mise
// resolves for this checkout, so a stale Bun earlier on PATH cannot run the suite.
function resolveTestBun(floor) {
	const attempts = [];
	const consider = (source, command) => {
		const attempt = probeBun(source, command, floor);
		attempts.push(attempt);
		return attempt.usable ? attempt : undefined;
	};

	const launcher = process.env.npm_execpath;
	if (launcher && path.basename(launcher, ".exe") === "bun") {
		const chosen = consider("bun run launcher", path.resolve(launcher));
		if (chosen) return chosen;
	}

	const onPath = findOnPath("bun");
	if (onPath.command) {
		const chosen = consider("PATH", onPath.command);
		if (chosen) return chosen;
	} else {
		attempts.push({ source: "PATH", command: "bun", detail: onPath.detail });
	}

	let staleMiseVersion;
	const mise = spawnSync("mise", ["which", "bun"], {
		cwd: repoRoot,
		encoding: "utf8",
	});
	const miseBun = mise.stdout?.trim();
	if (mise.error) {
		attempts.push({
			source: "mise",
			command: "mise which bun",
			detail:
				mise.error.code === "ENOENT" ? "mise not found" : mise.error.message,
		});
	} else if (mise.status !== 0 || !miseBun) {
		attempts.push({
			source: "mise",
			command: "mise which bun",
			detail: `exited ${mise.status ?? mise.signal}: ${mise.stderr.trim() || "no path printed"}`,
		});
	} else {
		const chosen = consider("mise", miseBun);
		if (chosen) return chosen;
		staleMiseVersion = attempts.at(-1).version;
	}

	const floorText = `${floor.major}.${floor.minor}`;
	// `mise install` cannot help when mise already resolves an older Bun: the
	// mise config needs the same bump as packageManager.
	const remedy = staleMiseVersion
		? `mise resolves bun ${staleMiseVersion} for this checkout, older than the ${floor.pin} pin in package.json. Raise the Bun version in the checkout's mise config to ${floorText} or newer and run \`mise install\`, or put a newer bun first on PATH.`
		: "Install the pinned release with `mise install`, or put a newer bun first on PATH.";
	throw new Error(
		[
			`No bun ${floorText} or newer is available for the test suite (package.json pins ${floor.pin}). Tried:`,
			...attempts.map(
				({ source, command, detail }) => `  ${source} (${command}): ${detail}`,
			),
			remedy,
		].join("\n"),
	);
}

// Tests that spawn `bun` get the runner's Bun through a private directory
// first on PATH. Nested shells that re-run mise's PATH hook strip mise install
// directories from PATH but leave this one, so `bun run` scripts stay on it.
async function createBunShim(bunCommand) {
	const shimDir = await mkdtemp(
		path.join(os.tmpdir(), "cc-enhanced-test-bun-"),
	);
	await symlink(bunCommand, path.join(shimDir, "bun"));
	return shimDir;
}

function runTestFile(bunCommand, env, testFile, extraArgs) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			bunCommand,
			["test", testFile, "--parallel=1", ...extraArgs],
			{
				cwd: repoRoot,
				env,
				stdio: ["ignore", "inherit", "inherit"],
			},
		);
		child.on("error", reject);
		child.on("close", (code, signal) => {
			resolve({
				code: code ?? 1,
				signal,
			});
		});
	});
}

const bun = resolveTestBun(await readBunFloor());

const testFiles = (
	await Promise.all(testRoots.map((root) => collectTestFiles(root)))
)
	.flat()
	.sort((left, right) => left.localeCompare(right, "en"));
if (testFiles.length === 0) {
	throw new Error(`No test files found under ${testRoots.join(", ")}`);
}

// Windows cannot spawn an extensionless link and needs a privilege to create
// one, so there the chosen Bun's own directory goes first instead.
const shimDir = isWindows ? undefined : await createBunShim(bun.command);
const removeShim = () => {
	if (shimDir) rmSync(shimDir, { recursive: true, force: true });
};
if (shimDir) {
	for (const signal of ["SIGINT", "SIGTERM"]) {
		process.once(signal, () => {
			removeShim();
			process.kill(process.pid, signal);
		});
	}
}

const pathKey =
	Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ??
	"PATH";
const childEnv = {
	...process.env,
	[pathKey]: [shimDir ?? path.dirname(bun.command), process.env[pathKey]]
		.filter(Boolean)
		.join(path.delimiter),
};

try {
	const startedAt = performance.now();
	console.log(
		`Running ${testFiles.length} test files serially with bun ${bun.version} (${bun.source}: ${bun.command})`,
	);
	// Every file runs even after a failure, so one run reports all failing files.
	const failures = [];
	for (const [index, testFile] of testFiles.entries()) {
		const fileStartedAt = performance.now();
		const result = await runTestFile(
			bun.command,
			childEnv,
			testFile,
			process.argv.slice(2),
		);
		const elapsedSeconds = ((performance.now() - fileStartedAt) / 1000).toFixed(
			2,
		);
		const position = `${String(index + 1).padStart(String(testFiles.length).length, " ")}/${testFiles.length}`;
		if (result.code !== 0) {
			const signalSuffix = result.signal ? ` (signal ${result.signal})` : "";
			failures.push(`${testFile}${signalSuffix}`);
			console.log(
				`FAIL ${position} ${testFile} (${elapsedSeconds}s)${signalSuffix}`,
			);
			continue;
		}
		console.log(`PASS ${position} ${testFile} (${elapsedSeconds}s)`);
	}

	const totalSeconds = ((performance.now() - startedAt) / 1000).toFixed(2);
	if (failures.length > 0) {
		throw new Error(
			[
				`${failures.length} of ${testFiles.length} test files failed in ${totalSeconds}s:`,
				...failures.map((failure) => `  ${failure}`),
			].join("\n"),
		);
	}
	console.log(`All ${testFiles.length} test files passed in ${totalSeconds}s`);
} finally {
	removeShim();
}
