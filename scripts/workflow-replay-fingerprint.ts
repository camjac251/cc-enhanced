#!/usr/bin/env bun
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import {
	computeWorkflowReplayFingerprint,
	WORKFLOW_REPLAY_NAMES,
	type WorkflowReplayName,
} from "../src/workflow-replay-fingerprint.js";

const scriptRepoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

interface CliOptions {
	workflow: WorkflowReplayName;
	repoRoot: string;
	patchedExportPath?: string;
}

function resolveFromRoot(repoRoot: string, value: string): string {
	return path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
}

function parseOptions(): CliOptions {
	const argv = yargs(hideBin(process.argv))
		.scriptName("workflow-replay-fingerprint")
		.usage("$0 <workflow> [options]")
		.positional("workflow", {
			type: "string",
			choices: [...WORKFLOW_REPLAY_NAMES],
			demandOption: true,
		})
		.option("patched-export-path", {
			type: "string",
			description: "Include this export tree for patch-update",
		})
		.strict()
		.demandCommand(1, 1)
		.parseSync();
	const workflow = String(argv._[0]) as WorkflowReplayName;
	return {
		workflow,
		repoRoot: scriptRepoRoot,
		patchedExportPath: argv.patchedExportPath
			? resolveFromRoot(scriptRepoRoot, argv.patchedExportPath)
			: undefined,
	};
}

async function main(): Promise<void> {
	const options = parseOptions();
	const fingerprint = await computeWorkflowReplayFingerprint(options);
	process.stdout.write(`${fingerprint}\n`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
