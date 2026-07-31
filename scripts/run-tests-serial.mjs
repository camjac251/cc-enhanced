#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const testRoot = path.join(repoRoot, "src");
const testFilePattern = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/;

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

function runTestFile(testFile, extraArgs) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			"bun",
			["test", testFile, "--parallel=1", ...extraArgs],
			{
				cwd: repoRoot,
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

const testFiles = (await collectTestFiles(testRoot)).sort((left, right) =>
	left.localeCompare(right, "en"),
);
if (testFiles.length === 0) {
	throw new Error(`No test files found under ${testRoot}`);
}

const startedAt = performance.now();
console.log(`Running ${testFiles.length} test files serially`);
for (const [index, testFile] of testFiles.entries()) {
	const fileStartedAt = performance.now();
	const result = await runTestFile(testFile, process.argv.slice(2));
	const elapsedSeconds = ((performance.now() - fileStartedAt) / 1000).toFixed(
		2,
	);
	if (result.code !== 0) {
		const signalSuffix = result.signal ? ` (signal ${result.signal})` : "";
		throw new Error(
			`Test file failed: ${testFile} after ${elapsedSeconds}s${signalSuffix}`,
		);
	}
	console.log(
		`PASS ${String(index + 1).padStart(String(testFiles.length).length, " ")}/${testFiles.length} ${testFile} (${elapsedSeconds}s)`,
	);
}

console.log(
	`All ${testFiles.length} test files passed in ${((performance.now() - startedAt) / 1000).toFixed(2)}s`,
);
