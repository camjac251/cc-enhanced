#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import {
	comparePromptExportMatrix,
	formatPromptExportMatrixMarkdown,
} from "../src/verification/prompt-export-matrix.js";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");

interface ComparePromptMatrixOptions {
	baselineExportDir: string;
	candidateExportDir: string;
	etcClaudeDir: string;
	json: boolean;
	output?: string;
	minOverlapLineLength: number;
}

function resolveFromRepo(value: string): string {
	return path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
}

function parseOptions(): ComparePromptMatrixOptions {
	const rawArgs = hideBin(process.argv);
	const separatorIndex = rawArgs.indexOf("--");
	if (separatorIndex !== -1) rawArgs.splice(separatorIndex, 1);
	const argv = yargs(rawArgs)
		.scriptName("compare-prompt-matrix")
		.usage(
			"$0 <baseline-export-dir> <candidate-export-dir> <etc-claude-dir> [options]",
		)
		.option("json", {
			type: "boolean",
			default: false,
			description: "Print the machine-readable comparison",
		})
		.option("output", {
			type: "string",
			description: "Write the report to this path instead of stdout",
		})
		.option("min-overlap-line-length", {
			type: "number",
			default: 20,
			description:
				"Minimum trimmed line length for exact runtime-policy overlap checks",
		})
		.strictOptions()
		.parseSync();
	const positional = argv._.map(String).filter((value) => value !== "$0");
	if (positional.length !== 3) {
		throw new Error(
			`Expected exactly 3 positional arguments, got ${positional.length}.`,
		);
	}
	if (
		!Number.isInteger(argv.minOverlapLineLength) ||
		argv.minOverlapLineLength < 1
	) {
		throw new Error("--min-overlap-line-length must be a positive integer");
	}
	return {
		baselineExportDir: resolveFromRepo(positional[0] as string),
		candidateExportDir: resolveFromRepo(positional[1] as string),
		etcClaudeDir: resolveFromRepo(positional[2] as string),
		json: argv.json,
		output: argv.output ? resolveFromRepo(argv.output) : undefined,
		minOverlapLineLength: argv.minOverlapLineLength,
	};
}

async function main(): Promise<void> {
	const options = parseOptions();
	const result = await comparePromptExportMatrix(options);
	const output = options.json
		? `${JSON.stringify(result, null, 2)}\n`
		: formatPromptExportMatrixMarkdown(result);
	if (options.output) {
		await fs.mkdir(path.dirname(options.output), { recursive: true });
		await fs.writeFile(options.output, output, "utf8");
		console.log(`Wrote stock release prompt matrix: ${options.output}`);
		return;
	}
	process.stdout.write(output);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
