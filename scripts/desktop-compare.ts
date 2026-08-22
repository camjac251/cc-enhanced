import process from "node:process";
import { hideBin } from "yargs/helpers";
import yargs from "yargs/yargs";
import {
	compareDesktopInventoryEvidence,
	readDesktopInventoryEvidenceFile,
} from "../src/desktop/drift.js";
import { createDesktopDriftResult } from "../src/desktop/status.js";
import { renderDesktopDrift } from "../src/presentation/desktop-drift.js";
import { renderOperationJson } from "../src/presentation/json.js";

const argv = await yargs(hideBin(process.argv))
	.version(false)
	.option("baseline", {
		type: "string",
		demandOption: true,
		description: "Bounded sanitized Desktop inventory evidence baseline",
	})
	.option("current", {
		type: "string",
		demandOption: true,
		description: "Bounded sanitized current Desktop inventory evidence",
	})
	.option("json", {
		type: "boolean",
		description: "Render the shared operation envelope as JSON",
	})
	.option("evidence", {
		type: "boolean",
		description: "Render the path-free drift evidence document",
	})
	.conflicts("evidence", "json")
	.strict()
	.help()
	.parse();

const [baseline, current] = await Promise.all([
	readDesktopInventoryEvidenceFile(argv.baseline),
	readDesktopInventoryEvidenceFile(argv.current),
]);
const result = createDesktopDriftResult(
	compareDesktopInventoryEvidence(baseline, current),
);
process.stdout.write(
	argv.evidence
		? `${JSON.stringify(result.data, null, "\t")}\n`
		: argv.json
			? `${renderOperationJson(result)}\n`
			: `${renderDesktopDrift(result).join("\n")}\n`,
);
if (!result.ok) process.exitCode = 1;
