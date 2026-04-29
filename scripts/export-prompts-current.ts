#!/usr/bin/env bun
/**
 * Export prompt artifacts from the currently promoted (patched) binary.
 *
 * Usage:
 *   bun scripts/export-prompts-current.ts          # promoted binary -> <version>_patched
 *   bun scripts/export-prompts-current.ts 2.1.71   # clean version from versions_clean/
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { extractClaudeJsFromNativeBinary } from "../src/native.js";
import { status } from "../src/promote.js";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.join(path.dirname(__filename), "..");
const exportScript = path.join(repoRoot, "scripts", "export-prompts.ts");

interface CurrentExportOptions {
	input: string;
	label?: string;
	outputDir?: string;
	maxUncategorized?: number;
}

function parseOptions(): CurrentExportOptions {
	const argv = yargs(hideBin(process.argv))
		.scriptName("export-prompts-current")
		.usage("$0 [current|version|cli.js] [options]")
		.version(false)
		.option("label", {
			type: "string",
			description: "Override export label",
		})
		.option("output-dir", {
			type: "string",
			description: "Override output directory",
		})
		.option("max-uncategorized", {
			type: "number",
			description: "Fail if uncategorized corpus count exceeds this value",
		})
		.strictOptions()
		.parseSync();
	const positional = ((argv._ as unknown[]) ?? [])
		.map((value) => String(value))
		.filter((value) => value !== "$0");
	if (positional.length > 1) {
		throw new Error(
			`Unexpected extra positional argument "${positional[1]}". Expected at most one input.`,
		);
	}
	const maxUncategorized = argv.maxUncategorized;
	if (
		maxUncategorized !== undefined &&
		(!Number.isInteger(maxUncategorized) || maxUncategorized < 0)
	) {
		throw new Error("--max-uncategorized must be a non-negative integer");
	}
	return {
		input: positional[0] ?? "current",
		label: argv.label,
		outputDir: argv.outputDir,
		maxUncategorized,
	};
}

function buildExportArgs(input: string, label?: string): string[] {
	const args = [exportScript, input];
	if (label) args.push("--label", label);
	return args;
}

function appendExportOptions(
	args: string[],
	options: CurrentExportOptions,
): void {
	if (options.outputDir) args.push("--output-dir", options.outputDir);
	if (options.maxUncategorized !== undefined) {
		args.push("--max-uncategorized", String(options.maxUncategorized));
	}
}

function run(
	input: string,
	options: CurrentExportOptions,
	label?: string,
): void {
	console.log(`Exporting prompts for: ${label ?? input}`);
	const args = buildExportArgs(input, label);
	appendExportOptions(args, options);
	execFileSync("bun", args, {
		cwd: repoRoot,
		stdio: "inherit",
	});
}

function exportCurrent(options: CurrentExportOptions): void {
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
	const exportLabel = options.label ?? label;
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-prompts-current-"));
	const tempCliPath = path.join(tempDir, "cli.js");

	console.log(`Promoted binary: ${binaryPath}`);
	console.log(`Version: ${versionInfo.version} -> ${exportLabel}`);

	try {
		const jsBuffer = extractClaudeJsFromNativeBinary(binaryPath);
		fs.writeFileSync(tempCliPath, jsBuffer);
		run(tempCliPath, options, exportLabel);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}

function main(): void {
	const options = parseOptions();
	if (options.input === "current") {
		exportCurrent(options);
	} else {
		run(options.input, options, options.label ?? options.input);
	}
}

main();
