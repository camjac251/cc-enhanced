#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import {
	comparePromptExports,
	formatPromptExportComparisonMarkdown,
} from "../src/verification/prompt-export-compare.js";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");

interface ComparePromptOptions {
	baseExportDir: string;
	patchedExportDir: string;
	etcClaudeDir: string;
	json: boolean;
	output?: string;
	sampleLimit: number;
	minOverlapLineLength: number;
}

function resolveFromRepo(value: string): string {
	if (value.startsWith("/")) return value;
	return path.resolve(repoRoot, value);
}

function parseOptions(): ComparePromptOptions {
	const rawArgs = hideBin(process.argv);
	const separatorIndex = rawArgs.indexOf("--");
	if (separatorIndex !== -1) rawArgs.splice(separatorIndex, 1);

	const argv = yargs(rawArgs)
		.scriptName("compare-prompts")
		.usage(
			"$0 <base-export-dir> <patched-export-dir> <etc-claude-dir> [options]",
		)
		.option("json", {
			type: "boolean",
			default: false,
			description: "Print the raw comparison result as JSON",
		})
		.option("output", {
			type: "string",
			description: "Write the report to this path instead of stdout",
		})
		.option("sample-limit", {
			type: "number",
			default: 20,
			description: "Maximum sample rows per report section",
		})
		.option("min-overlap-line-length", {
			type: "number",
			default: 20,
			description:
				"Minimum trimmed line length for exact /etc-to-export overlap checks",
		})
		.strictOptions()
		.parseSync();

	const positional = argv._.map(String).filter((value) => value !== "$0");
	if (positional.length !== 3) {
		throw new Error(
			`Expected exactly 3 positional arguments, got ${positional.length}.`,
		);
	}
	if (!Number.isInteger(argv.sampleLimit) || argv.sampleLimit < 1) {
		throw new Error("--sample-limit must be a positive integer");
	}
	if (
		!Number.isInteger(argv.minOverlapLineLength) ||
		argv.minOverlapLineLength < 1
	) {
		throw new Error("--min-overlap-line-length must be a positive integer");
	}

	return {
		baseExportDir: resolveFromRepo(positional[0] as string),
		patchedExportDir: resolveFromRepo(positional[1] as string),
		etcClaudeDir: resolveFromRepo(positional[2] as string),
		json: argv.json,
		output: argv.output ? resolveFromRepo(argv.output) : undefined,
		sampleLimit: argv.sampleLimit,
		minOverlapLineLength: argv.minOverlapLineLength,
	};
}

async function main(): Promise<void> {
	const options = parseOptions();
	const result = await comparePromptExports(options);
	const output = options.json
		? `${JSON.stringify(result, null, 2)}\n`
		: formatPromptExportComparisonMarkdown(result, {
				sampleLimit: options.sampleLimit,
			});
	if (options.output) {
		await fs.mkdir(path.dirname(options.output), { recursive: true });
		await fs.writeFile(options.output, output, "utf8");
		console.log(`Wrote prompt comparison report: ${options.output}`);
		return;
	}
	console.log(output);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
