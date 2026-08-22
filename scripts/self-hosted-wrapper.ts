import * as fs from "node:fs/promises";
import * as path from "node:path";
import process from "node:process";
import { hideBin } from "yargs/helpers";
import yargs from "yargs/yargs";
import { sanitizeArtifactDiagnostic } from "../src/artifacts/native-evidence.js";
import { createAndProbeSelfHostedWrapper } from "../src/operations/self-hosted-wrapper.js";
import { renderOperationJson } from "../src/presentation/json.js";
import { renderSelfHostedWrapper } from "../src/presentation/self-hosted-wrapper.js";
import { validateSelfHostedWrapperReceipt } from "../src/self-hosted/wrapper.js";

async function writeReceipt(outputPath: string, value: unknown): Promise<void> {
	const receipt = validateSelfHostedWrapperReceipt(value);
	await fs.mkdir(path.dirname(outputPath), { recursive: true });
	const temporaryPath = `${outputPath}.${process.pid}.tmp`;
	try {
		await fs.writeFile(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		await fs.rename(temporaryPath, outputPath);
	} catch (error) {
		await fs.rm(temporaryPath, { force: true });
		throw error;
	}
}

async function main(): Promise<void> {
	const argv = await yargs(hideBin(process.argv))
		.version(false)
		.option("wrapper-output", {
			type: "string",
			demandOption: true,
			description: "New ignored POSIX wrapper candidate",
		})
		.option("receipt", {
			type: "string",
			demandOption: true,
			description: "Path-free durable wrapper probe receipt",
		})
		.option("json", {
			type: "boolean",
			description: "Render the shared operation envelope as JSON",
		})
		.strict()
		.help()
		.parse();

	const wrapperOutput = path.resolve(argv.wrapperOutput);
	const receiptPath = path.resolve(argv.receipt);
	if (wrapperOutput === receiptPath) {
		throw new Error("Wrapper candidate and receipt paths must be distinct");
	}
	const result = await createAndProbeSelfHostedWrapper({
		wrapperOutput,
		allowedOutputRoot: path.join(
			process.cwd(),
			".cache",
			"self-hosted-wrapper",
		),
	});
	await writeReceipt(receiptPath, result.data);
	process.stdout.write(
		argv.json
			? `${renderOperationJson(result)}\n`
			: `${renderSelfHostedWrapper(result).join("\n")}\n`,
	);
}

main().catch((error) => {
	console.error(sanitizeArtifactDiagnostic(error));
	process.exitCode = 1;
});
