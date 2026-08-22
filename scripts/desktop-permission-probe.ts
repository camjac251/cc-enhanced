import * as path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { hideBin } from "yargs/helpers";
import yargs from "yargs/yargs";
import {
	createDesktopPermissionProbePlan,
	type DesktopPermissionProbePlanEvidence,
	readDesktopSdkContractEvidenceFile,
} from "../src/desktop/permission-probe.js";
import type { DesktopSdkContractEvidence } from "../src/desktop/sdk-contract.js";
import { createDesktopPermissionProbePlanResult } from "../src/desktop/status.js";
import { renderDesktopPermissionProbePlan } from "../src/presentation/desktop-permission-probe.js";
import { renderOperationJson } from "../src/presentation/json.js";

export interface DesktopPermissionProbeCommandOptions {
	sdkContractPath: string;
	format: "human" | "json" | "evidence";
}

export interface DesktopPermissionProbeCommandDependencies {
	readSdkContract: (
		sdkContractPath: string,
	) => Promise<DesktopSdkContractEvidence>;
	createPlan: (
		sdkContract: DesktopSdkContractEvidence,
	) => DesktopPermissionProbePlanEvidence;
}

export interface DesktopPermissionProbeCommandResult {
	exitCode: number;
	output: string;
}

const defaultDependencies: DesktopPermissionProbeCommandDependencies = {
	readSdkContract: readDesktopSdkContractEvidenceFile,
	createPlan: createDesktopPermissionProbePlan,
};

export async function runDesktopPermissionProbeCommand(
	options: DesktopPermissionProbeCommandOptions,
	dependencies: DesktopPermissionProbeCommandDependencies = defaultDependencies,
): Promise<DesktopPermissionProbeCommandResult> {
	const sdkContract = await dependencies.readSdkContract(
		options.sdkContractPath,
	);
	const result = createDesktopPermissionProbePlanResult(
		dependencies.createPlan(sdkContract),
	);
	let output: string;
	if (options.format === "evidence") {
		output = JSON.stringify(result.data, null, "\t");
	} else if (options.format === "json") {
		output = renderOperationJson(result);
	} else {
		output = renderDesktopPermissionProbePlan(result).join("\n");
	}
	return {
		exitCode: result.ok ? 0 : 1,
		output: `${output}\n`,
	};
}

async function main(): Promise<void> {
	const argv = await yargs(hideBin(process.argv))
		.version(false)
		.option("sdk-contract", {
			type: "string",
			demandOption: true,
			description: "Validated path-free Desktop SDK public-contract evidence",
		})
		.option("json", {
			type: "boolean",
			description: "Render the shared operation envelope as JSON",
		})
		.option("evidence", {
			type: "boolean",
			description: "Render the path-free Read/Edit/Write probe plan",
		})
		.conflicts("evidence", "json")
		.strict()
		.help()
		.parse();
	const result = await runDesktopPermissionProbeCommand({
		sdkContractPath: argv.sdkContract,
		format: argv.evidence ? "evidence" : argv.json ? "json" : "human",
	});
	process.stdout.write(result.output);
	process.exitCode = result.exitCode;
}

const entryUrl = process.argv[1]
	? pathToFileURL(path.resolve(process.argv[1])).href
	: "";
if (import.meta.url === entryUrl) {
	try {
		await main();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(
			`Desktop permission probe planning failed: ${message}\n`,
		);
		process.exitCode = 1;
	}
}
