import * as path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { hideBin } from "yargs/helpers";
import yargs from "yargs/yargs";
import type { DesktopInventoryEvidence } from "../src/desktop/contract.js";
import { readDesktopInventoryEvidenceFile } from "../src/desktop/drift.js";
import {
	type DesktopSdkContractEvidence,
	inspectDesktopSdkPublicContract,
} from "../src/desktop/sdk-contract.js";
import { createDesktopSdkContractResult } from "../src/desktop/status.js";
import { renderDesktopSdkContract } from "../src/presentation/desktop-sdk-contract.js";
import { renderOperationJson } from "../src/presentation/json.js";

export interface DesktopSdkContractCommandOptions {
	inventoryPath: string;
	format: "human" | "json" | "evidence";
}

export interface DesktopSdkContractCommandDependencies {
	readInventory: (inventoryPath: string) => Promise<DesktopInventoryEvidence>;
	inspect: (options: {
		inventory: DesktopInventoryEvidence;
	}) => Promise<DesktopSdkContractEvidence>;
}

export interface DesktopSdkContractCommandResult {
	exitCode: number;
	output: string;
}

const defaultDependencies: DesktopSdkContractCommandDependencies = {
	readInventory: readDesktopInventoryEvidenceFile,
	inspect: inspectDesktopSdkPublicContract,
};

export async function runDesktopSdkContractCommand(
	options: DesktopSdkContractCommandOptions,
	dependencies: DesktopSdkContractCommandDependencies = defaultDependencies,
): Promise<DesktopSdkContractCommandResult> {
	const inventory = await dependencies.readInventory(options.inventoryPath);
	const result = createDesktopSdkContractResult(
		await dependencies.inspect({ inventory }),
	);
	let output: string;
	if (options.format === "evidence") {
		output = JSON.stringify(result.data, null, "\t");
	} else if (options.format === "json") {
		output = renderOperationJson(result);
	} else {
		output = renderDesktopSdkContract(result).join("\n");
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
			description:
				"Validated sanitized Desktop inventory evidence with a resolved packaged SDK",
		})
		.option("json", {
			type: "boolean",
			description: "Render the shared operation envelope as JSON",
		})
		.option("evidence", {
			type: "boolean",
			description: "Render the path-free SDK public-contract evidence",
		})
		.conflicts("evidence", "json")
		.strict()
		.help()
		.parse();
	const result = await runDesktopSdkContractCommand({
		inventoryPath: argv.inventory,
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
		process.stderr.write(`Desktop SDK contract audit failed: ${message}\n`);
		process.exitCode = 1;
	}
}
