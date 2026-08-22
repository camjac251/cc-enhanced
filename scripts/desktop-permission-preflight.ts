import * as path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { hideBin } from "yargs/helpers";
import yargs from "yargs/yargs";
import {
	createDesktopPermissionPreflight,
	type DesktopPermissionPreflightEvidence,
	type DesktopPermissionPreflightInputs,
	type DesktopPermissionPreflightPaths,
	readDesktopPermissionPreflightInputs,
} from "../src/desktop/permission-preflight.js";
import { createDesktopPermissionPreflightResult } from "../src/desktop/status.js";
import { renderDesktopPermissionPreflight } from "../src/presentation/desktop-permission-preflight.js";
import { renderOperationJson } from "../src/presentation/json.js";

export interface DesktopPermissionPreflightCommandOptions {
	paths: DesktopPermissionPreflightPaths;
	format: "human" | "json" | "evidence";
}

export interface DesktopPermissionPreflightCommandDependencies {
	readInputs: (
		paths: DesktopPermissionPreflightPaths,
	) => Promise<DesktopPermissionPreflightInputs>;
	createPreflight: (
		inputs: DesktopPermissionPreflightInputs,
	) => DesktopPermissionPreflightEvidence;
}

export interface DesktopPermissionPreflightCommandResult {
	exitCode: number;
	output: string;
}

const defaultDependencies: DesktopPermissionPreflightCommandDependencies = {
	readInputs: readDesktopPermissionPreflightInputs,
	createPreflight: createDesktopPermissionPreflight,
};

export async function runDesktopPermissionPreflightCommand(
	options: DesktopPermissionPreflightCommandOptions,
	dependencies: DesktopPermissionPreflightCommandDependencies = defaultDependencies,
): Promise<DesktopPermissionPreflightCommandResult> {
	const inputs = await dependencies.readInputs(options.paths);
	const result = createDesktopPermissionPreflightResult(
		dependencies.createPreflight(inputs),
	);
	let output: string;
	if (options.format === "evidence") {
		output = JSON.stringify(result.data, null, "\t");
	} else if (options.format === "json") {
		output = renderOperationJson(result);
	} else {
		output = renderDesktopPermissionPreflight(result).join("\n");
	}
	return {
		exitCode: result.ok ? 0 : 1,
		output: `${output}\n`,
	};
}

async function main(): Promise<void> {
	const argv = await yargs(hideBin(process.argv))
		.version(false)
		.option("inventory", {
			type: "string",
			demandOption: true,
			description: "Validated path-free Desktop inventory evidence",
		})
		.option("artifact", {
			type: "string",
			demandOption: true,
			description: "Validated Desktop artifact inspection evidence",
		})
		.option("sdk-contract", {
			type: "string",
			demandOption: true,
			description: "Validated Desktop SDK public-contract evidence",
		})
		.option("probe-plan", {
			type: "string",
			demandOption: true,
			description: "Validated Read/Edit/Write permission probe plan",
		})
		.option("profile-support", {
			type: "string",
			demandOption: true,
			description: "Validated Desktop profile-support evidence",
		})
		.option("json", {
			type: "boolean",
			description: "Render the shared operation envelope as JSON",
		})
		.option("evidence", {
			type: "boolean",
			description: "Render the path-free stock-preflight evidence",
		})
		.conflicts("evidence", "json")
		.strict()
		.help()
		.parse();
	const result = await runDesktopPermissionPreflightCommand({
		paths: {
			inventoryPath: argv.inventory,
			artifactPath: argv.artifact,
			sdkContractPath: argv.sdkContract,
			probePlanPath: argv.probePlan,
			profileSupportPath: argv.profileSupport,
		},
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
		process.stderr.write(`Desktop permission preflight failed: ${message}\n`);
		process.exitCode = 1;
	}
}
