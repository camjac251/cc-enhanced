#!/usr/bin/env tsx
/**
 * Export prompt artifacts from the currently promoted (patched) binary.
 *
 * Usage:
 *   tsx scripts/export-prompts-current.ts          # promoted binary -> <version>_patched
 *   tsx scripts/export-prompts-current.ts 2.1.71   # clean version from versions_clean/
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { extractClaudeJsFromNativeBinary } from "../src/native.js";
import { status } from "../src/promote.js";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.join(path.dirname(__filename), "..");
const exportScript = path.join(repoRoot, "scripts", "export-prompts.ts");
const versionsDir = path.join(repoRoot, "versions_clean");

function run(label: string): void {
	console.log(`Exporting prompts for: ${label}`);
	execFileSync("npx", ["tsx", exportScript, label], {
		cwd: repoRoot,
		stdio: "inherit",
	});
}

function exportCurrent(): void {
	const info = status();
	if (!info.current) {
		console.error("No promoted binary found.");
		process.exit(1);
	}

	const binaryPath = info.current.binaryPath;
	const versionInfo = info.current.version;
	if (!versionInfo) {
		console.error(`Could not determine version from: ${binaryPath}`);
		process.exit(1);
	}

	const label = versionInfo.isPatched
		? `${versionInfo.version}_patched`
		: versionInfo.version;
	const outDir = path.join(versionsDir, label);

	console.log(`Promoted binary: ${binaryPath}`);
	console.log(`Version: ${versionInfo.version} -> ${label}`);

	fs.mkdirSync(outDir, { recursive: true });
	try {
		const jsBuffer = extractClaudeJsFromNativeBinary(binaryPath);
		fs.writeFileSync(path.join(outDir, "cli.js"), jsBuffer);
		run(label);
	} finally {
		fs.rmSync(outDir, { recursive: true, force: true });
	}
}

function main(): void {
	const arg = process.argv[2];
	if (!arg || arg === "current") {
		exportCurrent();
	} else {
		run(arg);
	}
}

main();
