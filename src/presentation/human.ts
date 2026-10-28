import chalk from "chalk";
import type {
	NativePullResult,
	OperationResult,
} from "../operations/contract.js";

export function renderNativePull(
	result: OperationResult<NativePullResult>,
): string[] {
	const data = result.data;
	const fetch = data.fetchResult;
	return [
		"",
		chalk.green("Clean native JS extracted:"),
		`  Fetched: ${fetch.version}/${fetch.platform} (${fetch.fromCache ? "cache" : "download"})`,
		`  Output:  ${data.outputJsPath}`,
		"",
	];
}
