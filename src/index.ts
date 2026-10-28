#!/usr/bin/env node
import path from "node:path";
import chalk from "chalk";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { withHeavyOperationGuard } from "./heavy-operation-guard.js";
import { Manager } from "./manager.js";
import { createOperationResult } from "./operations/contract.js";
import { renderNativePull } from "./presentation/human.js";
import { parseNativeArtifactPlatform } from "./targets/contract.js";

async function main() {
	const parser = yargs(hideBin(process.argv))
		.scriptName("cc-enhanced")
		.usage(
			"$0 --native-fetch [spec]\n$0 --native-pull [spec]\n$0 --native-unpack <binary> <output-js>",
		)
		.version(false)
		.parserConfiguration({
			"camel-case-expansion": false,
			"parse-positional-numbers": false,
			"duplicate-arguments-array": false,
		})
		.option("native-fetch", {
			type: "string",
			description: "Download an official native binary (default spec: latest)",
		})
		.option("native-pull", {
			type: "string",
			description:
				"Download and extract clean JavaScript (default spec: latest)",
		})
		.option("native-unpack", {
			type: "boolean",
			description:
				"Extract an explicit native binary to the output JavaScript path",
		})
		.option("native-platform", {
			type: "string",
			requiresArg: true,
			description: "Official release platform override for fetch or pull",
		})
		.option("native-cache-dir", {
			type: "string",
			requiresArg: true,
			description: "Download cache directory override for fetch or pull",
		})
		.option("native-force-download", {
			type: "boolean",
			description: "Download again instead of using the cached binary",
		})
		.option("native-pull-output-dir", {
			type: "string",
			requiresArg: true,
			description: "Clean extraction root for pull (default: versions_clean)",
		})
		.strictOptions()
		.help();
	const argv = await parser.parse();
	const platform =
		argv["native-platform"] === undefined
			? undefined
			: parseNativeArtifactPlatform(argv["native-platform"]);
	const fetchSpec = argv["native-fetch"];
	const pullSpec = argv["native-pull"];
	const unpack = argv["native-unpack"] === true;
	const actions =
		Number(fetchSpec !== undefined) +
		Number(pullSpec !== undefined) +
		Number(unpack);
	if (actions > 1) {
		throw new Error(
			"Choose exactly one action: --native-fetch, --native-pull, or --native-unpack",
		);
	}
	if (unpack ? argv._.length !== 2 : argv._.length !== 0) {
		throw new Error(
			unpack
				? "--native-unpack requires exactly two positional paths: <binary> <output-js>"
				: "Unexpected positional arguments; use --native-unpack <binary> <output-js>",
		);
	}
	if (actions === 0) {
		parser.showHelp("log");
		return;
	}
	if (
		unpack &&
		(argv["native-platform"] !== undefined ||
			argv["native-cache-dir"] !== undefined ||
			argv["native-force-download"] !== undefined)
	) {
		throw new Error("Download options require --native-fetch or --native-pull");
	}
	if (pullSpec === undefined && argv["native-pull-output-dir"] !== undefined) {
		throw new Error("--native-pull-output-dir requires --native-pull");
	}

	const manager = new Manager({ nativeCacheDir: argv["native-cache-dir"] });
	const fetchOptions = {
		platform,
		forceDownload: argv["native-force-download"],
	};
	if (fetchSpec !== undefined) {
		const result = await manager.fetchNativeTarget(
			fetchSpec || "latest",
			fetchOptions,
		);
		console.log(
			chalk.green(
				`Fetched native binary: ${result.binaryPath} (${result.version}/${result.platform}, ${result.fromCache ? "cache" : "download"})`,
			),
		);
		return;
	}
	if (pullSpec !== undefined) {
		const result = await withHeavyOperationGuard(
			{ operation: "native clean bundle pull" },
			() =>
				manager.pullNativeCleanJs(pullSpec || "latest", {
					...fetchOptions,
					outputRoot: argv["native-pull-output-dir"],
				}),
		);
		console.log(
			renderNativePull(
				createOperationResult({
					operation: "native-pull",
					ok: true,
					data: result,
				}),
			).join("\n"),
		);
		return;
	}

	const result = await withHeavyOperationGuard(
		{ operation: "native bundle unpack" },
		() =>
			manager.unpackNativeTarget(
				path.resolve(String(argv._[0])),
				path.resolve(String(argv._[1])),
			),
	);
	console.log(
		chalk.green(
			`Unpacked native JS: ${result.outputJsPath} (target: ${result.targetPath})`,
		),
	);
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
