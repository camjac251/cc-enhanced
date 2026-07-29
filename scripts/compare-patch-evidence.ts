#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import {
	comparePatchEvidence,
	extractPatchEvidence,
	formatPatchEvidenceComparisonMarkdown,
} from "../src/verification/patch-evidence.js";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");

interface CompareEvidenceOptions {
	previousPath: string;
	currentPath: string;
	json: boolean;
	output?: string;
}

function resolveFromRepo(value: string): string {
	return path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
}

function parseOptions(): CompareEvidenceOptions {
	const rawArgs = hideBin(process.argv);
	const separatorIndex = rawArgs.indexOf("--");
	if (separatorIndex !== -1) rawArgs.splice(separatorIndex, 1);
	const argv = yargs(rawArgs)
		.scriptName("compare-patch-evidence")
		.usage("$0 <previous-summary-or-manifest> <current-summary-or-manifest>")
		.option("json", {
			type: "boolean",
			default: false,
			description: "Print the machine-readable comparison",
		})
		.option("output", {
			type: "string",
			description: "Write the report to this path instead of stdout",
		})
		.strictOptions()
		.parseSync();
	const positional = argv._.map(String).filter((value) => value !== "$0");
	if (positional.length !== 2) {
		throw new Error(
			`Expected exactly 2 positional arguments, got ${positional.length}.`,
		);
	}
	return {
		previousPath: resolveFromRepo(positional[0] as string),
		currentPath: resolveFromRepo(positional[1] as string),
		json: argv.json,
		output: argv.output ? resolveFromRepo(argv.output) : undefined,
	};
}

async function readJson(filePath: string): Promise<unknown> {
	try {
		return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Unable to read patch evidence at ${filePath}: ${reason}`);
	}
}

async function main(): Promise<void> {
	const options = parseOptions();
	const previous = extractPatchEvidence(await readJson(options.previousPath));
	const current = extractPatchEvidence(await readJson(options.currentPath));
	const comparison = comparePatchEvidence(previous, current);
	const output = options.json
		? `${JSON.stringify(comparison, null, 2)}\n`
		: formatPatchEvidenceComparisonMarkdown(comparison);
	if (options.output) {
		await fs.mkdir(path.dirname(options.output), { recursive: true });
		await fs.writeFile(options.output, output, "utf8");
		console.log(`Wrote patch evidence comparison: ${options.output}`);
		return;
	}
	process.stdout.write(output);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
