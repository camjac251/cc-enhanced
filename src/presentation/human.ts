import chalk from "chalk";
import type {
	NativeBuildResult,
	NativePullResult,
	NativeUpdateResult,
	OperationResult,
} from "../operations/contract.js";
import type {
	PatchedVersionInfo,
	PromoteResult,
	RollbackResult,
	StatusInfo,
} from "../promote.js";

function formatPatchInfo(version: PatchedVersionInfo): string {
	if (!version.isPatched) return " (unpatched)";
	if (version.patchedTags.includes("signature")) {
		return ` (${version.patchedTags.length} patches)`;
	}
	const runtimeCount = version.patchedTags.length;
	const patchWord = runtimeCount === 1 ? "patch" : "patches";
	return ` (${runtimeCount} runtime ${patchWord} + signature)`;
}

export function renderStatus(result: OperationResult<StatusInfo>): string[] {
	const info = result.data;
	const lines = ["", chalk.bold("Claude Code Status"), ""];

	if (info.current) {
		lines.push(chalk.green("  Current:"));
		lines.push(`    Binary:  ${info.current.binaryPath}`);
		if (info.current.version) {
			lines.push(
				`    Version: ${info.current.version.version}${formatPatchInfo(info.current.version)}`,
			);
		}
	} else {
		lines.push(chalk.yellow("  Current: (none)"));
	}

	if (info.previous) {
		lines.push(chalk.blue("  Previous:"));
		lines.push(`    Binary:  ${info.previous.binaryPath}`);
		if (info.previous.version) {
			lines.push(
				`    Version: ${info.previous.version.version}${formatPatchInfo(info.previous.version)}`,
			);
		}
	} else {
		lines.push(chalk.dim("  Previous: (none)"));
	}

	if (info.cachedVersions.length > 0) {
		lines.push("", chalk.bold("  Cached:"));
		for (const cached of info.cachedVersions) {
			const builds = cached.hasBuilds ? ` (${cached.buildCount} builds)` : "";
			lines.push(`    ${cached.version}/${cached.platform}${builds}`);
		}
	}
	lines.push("");
	return lines;
}

function renderPromoteData(result: PromoteResult): string[] {
	const lines = [
		"",
		chalk.green("Promoted:"),
		`  Target:   ${result.target}`,
		`  Current:  ${result.currentLink}`,
	];
	if (result.previousTarget) {
		lines.push(`  Previous: ${result.previousTarget}`);
	}
	if (result.smokeTestVersion) {
		lines.push(`  Version:  ${result.smokeTestVersion}`);
	} else {
		lines.push(
			chalk.yellow("  Warning: smoke test did not return version info"),
		);
	}
	for (const cleaned of result.cleanedBuilds) {
		lines.push(chalk.dim(`  Cleaned:  ${cleaned}`));
	}
	lines.push("");
	return lines;
}

export function renderPromote(
	result: OperationResult<PromoteResult>,
): string[] {
	return renderPromoteData(result.data);
}

export function renderRollback(
	result: OperationResult<RollbackResult>,
): string[] {
	const lines = [
		"",
		chalk.green("Rolled back:"),
		`  Target:   ${result.data.target}`,
	];
	if (result.data.previousTarget) {
		lines.push(`  Previous: ${result.data.previousTarget}`);
	}
	if (result.data.smokeTestVersion) {
		lines.push(`  Version:  ${result.data.smokeTestVersion}`);
	}
	lines.push("");
	return lines;
}

function renderFetched(result: NativeBuildResult): string {
	const fetch = result.fetchResult;
	return `  Fetched:  ${fetch.version}/${fetch.platform} (${fetch.fromCache ? "cache" : "download"})`;
}

export function renderNativeBuild(
	result: OperationResult<NativeBuildResult>,
): string[] {
	const data = result.data;
	const lines = [
		"",
		chalk.green(data.dryRun ? "Build dry run complete:" : "Build complete:"),
		renderFetched(data),
	];
	lines.push(
		data.dryRun
			? `  Patch out: ${data.patchOutputPath} (not written in --dry-run mode)`
			: `  Patched:  ${data.patchOutputPath}`,
		"",
	);
	return lines;
}

export function renderNativeUpdate(
	result: OperationResult<NativeUpdateResult>,
): string[] {
	const data = result.data;
	const lines = [
		"",
		chalk.green(data.dryRun ? "Update dry run complete:" : "Update complete:"),
		renderFetched(data),
	];
	if (data.dryRun) {
		lines.push(
			`  Patch out: ${data.patchOutputPath} (not written in --dry-run mode)`,
			"",
		);
		return lines;
	}

	lines.push(`  Patched:  ${data.patchOutputPath}`);
	if (!data.promoteResult) {
		lines.push(chalk.yellow("  Warning: promote step did not run"), "");
		return lines;
	}
	return [...lines, ...renderPromoteData(data.promoteResult)];
}

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
