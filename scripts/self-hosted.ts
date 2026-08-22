import process from "node:process";
import { hideBin } from "yargs/helpers";
import yargs from "yargs/yargs";
import { renderOperationJson } from "../src/presentation/json.js";
import { renderSelfHostedReadiness } from "../src/presentation/self-hosted.js";
import {
	createSelfHostedReadinessPlan,
	createSelfHostedReadinessResult,
	validateSelfHostedReadinessEvidence,
} from "../src/self-hosted/readiness.js";

const argv = await yargs(hideBin(process.argv))
	.version(false)
	.option("json", {
		type: "boolean",
		description: "Render the shared operation envelope as JSON",
	})
	.option("evidence", {
		type: "boolean",
		description: "Render deterministic path-free readiness evidence",
	})
	.conflicts("evidence", "json")
	.strict()
	.help()
	.parse();

const plan = validateSelfHostedReadinessEvidence(
	createSelfHostedReadinessPlan(),
);
const result = createSelfHostedReadinessResult(plan);
process.stdout.write(
	argv.evidence
		? `${JSON.stringify(plan, null, "\t")}\n`
		: argv.json
			? `${renderOperationJson(result)}\n`
			: `${renderSelfHostedReadiness(result).join("\n")}\n`,
);
if (!result.ok) process.exitCode = 1;
