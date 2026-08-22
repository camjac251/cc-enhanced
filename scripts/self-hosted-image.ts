import * as fs from "node:fs/promises";
import * as path from "node:path";
import process from "node:process";
import { hideBin } from "yargs/helpers";
import yargs from "yargs/yargs";
import { sanitizeArtifactDiagnostic } from "../src/artifacts/native-evidence.js";
import { withHeavyOperationGuard } from "../src/heavy-operation-guard.js";
import { buildSelfHostedImage } from "../src/operations/self-hosted-image.js";
import { renderOperationJson } from "../src/presentation/json.js";
import { renderSelfHostedImage } from "../src/presentation/self-hosted-image.js";
import { validateSelfHostedImageReceipt } from "../src/self-hosted/image.js";

async function writeReceipt(outputPath: string, value: unknown): Promise<void> {
	const receipt = validateSelfHostedImageReceipt(value);
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
		.option("matrix-receipt", {
			type: "string",
			demandOption: true,
			description: "Passing six-platform self-hosted matrix receipt",
		})
		.option("host-receipt", {
			type: "string",
			demandOption: true,
			description: "Matching linux-x64 host receipt",
		})
		.option("artifact", {
			type: "string",
			demandOption: true,
			description: "Exact finalized linux-x64 artifact",
		})
		.option("context-dir", {
			type: "string",
			demandOption: true,
			description: "New ignored build-context directory under .cache",
		})
		.option("base-image", {
			type: "string",
			demandOption: true,
			description: "Locally cached immutable base image@sha256 reference",
		})
		.option("receipt", {
			type: "string",
			demandOption: true,
			description: "Path-free durable image receipt output",
		})
		.option("json", {
			type: "boolean",
			description: "Render the shared operation envelope as JSON",
		})
		.strict()
		.help()
		.parse();

	const matrixReceiptPath = path.resolve(argv.matrixReceipt);
	const hostReceiptPath = path.resolve(argv.hostReceipt);
	const artifactPath = path.resolve(argv.artifact);
	const contextDir = path.resolve(argv.contextDir);
	const receiptPath = path.resolve(argv.receipt);
	const relativeReceipt = path.relative(contextDir, receiptPath);
	if (
		!relativeReceipt ||
		(!relativeReceipt.startsWith("..") && !path.isAbsolute(relativeReceipt))
	) {
		throw new Error(
			"Image receipt must be outside the generated build context",
		);
	}

	const result = await withHeavyOperationGuard(
		{ operation: "self-hosted image construction" },
		() =>
			buildSelfHostedImage({
				matrixReceiptPath,
				hostReceiptPath,
				artifactPath,
				contextDir,
				allowedContextRoot: path.join(process.cwd(), ".cache"),
				baseImage: argv.baseImage,
			}),
	);
	await writeReceipt(receiptPath, result.data);
	process.stdout.write(
		argv.json
			? `${renderOperationJson(result)}\n`
			: `${renderSelfHostedImage(result).join("\n")}\n`,
	);
}

main().catch((error) => {
	console.error(sanitizeArtifactDiagnostic(error));
	process.exitCode = 1;
});
