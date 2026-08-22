import process from "node:process";
import { hideBin } from "yargs/helpers";
import yargs from "yargs/yargs";
import { inspectDesktopCodeArtifact } from "../src/desktop/artifact-inspection.js";
import { readDesktopInventoryEvidenceFile } from "../src/desktop/drift.js";
import { createDesktopArtifactInspectionResult } from "../src/desktop/status.js";
import { renderDesktopArtifactInspection } from "../src/presentation/desktop-artifact.js";
import { renderOperationJson } from "../src/presentation/json.js";

const argv = await yargs(hideBin(process.argv))
	.version(false)
	.option("inventory", {
		type: "string",
		demandOption: true,
		description: "Bounded sanitized Desktop inventory evidence",
	})
	.option("cache-root", {
		type: "string",
		demandOption: true,
		description: "Explicit Desktop-managed claude-code cache root",
	})
	.option("locator", {
		type: "string",
		description: "Confirm the inventory-selected Desktop Code locator",
	})
	.option("verify-provenance", {
		type: "boolean",
		default: false,
		description: "Fetch and compare the exact official release manifest",
	})
	.option("deep-patch-receipt", {
		type: "boolean",
		default: false,
		description:
			"Deep-extract the embedded entry point under the shared heavy-operation lease",
	})
	.option("json", {
		type: "boolean",
		description: "Render the shared operation envelope as JSON",
	})
	.option("evidence", {
		type: "boolean",
		description: "Render the path-free artifact inspection evidence",
	})
	.conflicts("evidence", "json")
	.strict()
	.help()
	.parse();

const inventory = await readDesktopInventoryEvidenceFile(argv.inventory);
const result = createDesktopArtifactInspectionResult(
	await inspectDesktopCodeArtifact({
		inventory,
		cacheRoot: argv.cacheRoot,
		locatorId: argv.locator,
		verifyProvenance: argv.verifyProvenance,
		inspectPatchReceipt: argv.deepPatchReceipt,
	}),
);
process.stdout.write(
	argv.evidence
		? `${JSON.stringify(result.data, null, "\t")}\n`
		: argv.json
			? `${renderOperationJson(result)}\n`
			: `${renderDesktopArtifactInspection(result).join("\n")}\n`,
);
if (!result.ok) process.exitCode = 1;
