import process from "node:process";
import { hideBin } from "yargs/helpers";
import yargs from "yargs/yargs";
import { createOperationResult } from "../src/operations/contract.js";
import { renderOperationJson } from "../src/presentation/json.js";
import { renderProfileSupport } from "../src/presentation/profile-support.js";
import {
	createPatchSupportEvidence,
	createPatchSurfaceReadiness,
} from "../src/profiles/readiness.js";
import type { RuntimeSurface } from "../src/targets/contract.js";

const SURFACES = [
	"cli",
	"desktop-local",
	"desktop-wsl",
	"desktop-ssh",
	"remote-control",
	"self-hosted-runner",
] as const satisfies readonly RuntimeSurface[];

const argv = await yargs(hideBin(process.argv))
	.version(false)
	.option("surface", {
		type: "string",
		choices: SURFACES,
		default: "desktop-local" as const,
		description: "Runtime surface to assess",
	})
	.option("json", {
		type: "boolean",
		description: "Render the shared operation envelope as JSON",
	})
	.option("evidence", {
		type: "boolean",
		description: "Render the deterministic path-free support evidence",
	})
	.conflicts("evidence", "json")
	.strict()
	.help()
	.parse();

const report = createPatchSurfaceReadiness(argv.surface as RuntimeSurface);
const ok = report.readiness === "ready" && report.selectable;
const result = createOperationResult({
	operation: "profile-support",
	ok,
	data: report,
	checks: [
		{ id: "capability-catalog", status: "pass" },
		{
			id: "surface-assessment",
			status: report.readiness === "not-assessed" ? "fail" : "pass",
		},
		{
			id: "required-probes",
			status: report.requiredProbes.length === 0 ? "pass" : "fail",
		},
		{
			id: "profile-selectable",
			status: report.selectable ? "pass" : "fail",
		},
	],
	warnings: report.selectable
		? []
		: [
				{
					code: "profile-not-selectable",
					message:
						"This profile is reserved for planning and does not authorize target patching.",
				},
			],
});

process.stdout.write(
	argv.evidence
		? `${JSON.stringify(createPatchSupportEvidence(report), null, "\t")}\n`
		: argv.json
			? `${renderOperationJson(result)}\n`
			: `${renderProfileSupport(result).join("\n")}\n`,
);
if (!ok) process.exitCode = 1;
