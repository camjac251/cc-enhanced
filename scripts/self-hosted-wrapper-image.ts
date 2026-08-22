import * as fs from "node:fs/promises";
import * as path from "node:path";
import process from "node:process";
import { hideBin } from "yargs/helpers";
import yargs from "yargs/yargs";
import { sanitizeArtifactDiagnostic } from "../src/artifacts/native-evidence.js";
import { withHeavyOperationGuard } from "../src/heavy-operation-guard.js";
import { buildSelfHostedWrapperImage } from "../src/operations/self-hosted-wrapper-image.js";
import { renderOperationJson } from "../src/presentation/json.js";
import { renderSelfHostedWrapperImage } from "../src/presentation/self-hosted-wrapper-image.js";
import { validateSelfHostedWrapperImageReceipt } from "../src/self-hosted/wrapper-image.js";

async function writeReceipt(outputPath: string, value: unknown): Promise<void> {
	const receipt = validateSelfHostedWrapperImageReceipt(value);
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
		.option("parent-receipt", {
			type: "string",
			demandOption: true,
			description: "Exact immutable parent image receipt",
		})
		.option("wrapper-receipt", {
			type: "string",
			demandOption: true,
			description: "Exact synthetic wrapper contract receipt",
		})
		.option("wrapper", {
			type: "string",
			demandOption: true,
			description: "Exact canonical wrapper candidate",
		})
		.option("context-dir", {
			type: "string",
			demandOption: true,
			description: "New ignored derived-image context under .cache",
		})
		.option("receipt", {
			type: "string",
			demandOption: true,
			description: "Path-free durable wrapper-image receipt",
		})
		.option("json", {
			type: "boolean",
			description: "Render the shared operation envelope as JSON",
		})
		.strict()
		.help()
		.parse();

	const parentReceiptPath = path.resolve(argv.parentReceipt);
	const wrapperReceiptPath = path.resolve(argv.wrapperReceipt);
	const wrapperPath = path.resolve(argv.wrapper);
	const contextDir = path.resolve(argv.contextDir);
	const receiptPath = path.resolve(argv.receipt);
	const relativeReceipt = path.relative(contextDir, receiptPath);
	if (
		!relativeReceipt ||
		(!relativeReceipt.startsWith("..") && !path.isAbsolute(relativeReceipt))
	) {
		throw new Error(
			"Wrapper image receipt must be outside the generated context",
		);
	}

	const result = await withHeavyOperationGuard(
		{ operation: "self-hosted wrapper image construction" },
		() =>
			buildSelfHostedWrapperImage({
				parentReceiptPath,
				wrapperReceiptPath,
				wrapperPath,
				contextDir,
				allowedContextRoot: path.join(
					process.cwd(),
					".cache",
					"self-hosted-wrapper-image",
				),
			}),
	);
	await writeReceipt(receiptPath, result.data);
	process.stdout.write(
		argv.json
			? `${renderOperationJson(result)}\n`
			: `${renderSelfHostedWrapperImage(result).join("\n")}\n`,
	);
}

main().catch((error) => {
	console.error(sanitizeArtifactDiagnostic(error));
	process.exitCode = 1;
});
