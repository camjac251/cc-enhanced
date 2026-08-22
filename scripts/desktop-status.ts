import process from "node:process";
import { hideBin } from "yargs/helpers";
import yargs from "yargs/yargs";
import {
	createDesktopInventoryEvidence,
	type DesktopPlatform,
} from "../src/desktop/contract.js";
import { inspectDesktopInventory } from "../src/desktop/inventory.js";
import { createDesktopStatusResult } from "../src/desktop/status.js";
import { renderDesktopStatus } from "../src/presentation/desktop-status.js";
import { renderOperationJson } from "../src/presentation/json.js";

const argv = await yargs(hideBin(process.argv))
	.version(false)
	.option("platform", {
		type: "string",
		choices: ["linux", "darwin", "win32"] as const,
		default:
			process.platform === "darwin" || process.platform === "win32"
				? process.platform
				: "linux",
		description: "Desktop operating-system adapter",
	})
	.option("app-root", {
		type: "string",
		demandOption: true,
		description: "Explicit Desktop application or application-container root",
	})
	.option("cache-root", {
		type: "string",
		demandOption: true,
		description: "Explicit Desktop-managed claude-code cache root",
	})
	.option("json", {
		type: "boolean",
		description: "Render the shared operation envelope as JSON",
	})
	.option("evidence", {
		type: "boolean",
		description: "Render a sanitized path-free evidence document",
	})
	.conflicts("evidence", "json")
	.strict()
	.help()
	.parse();

const result = createDesktopStatusResult(
	await inspectDesktopInventory({
		platform: argv.platform as DesktopPlatform,
		appRoot: argv.appRoot,
		cacheRoot: argv.cacheRoot,
	}),
);
process.stdout.write(
	argv.evidence
		? `${JSON.stringify(createDesktopInventoryEvidence(result.data), null, "\t")}\n`
		: argv.json
			? `${renderOperationJson(result)}\n`
			: `${renderDesktopStatus(result).join("\n")}\n`,
);
if (!result.ok) process.exitCode = 1;
