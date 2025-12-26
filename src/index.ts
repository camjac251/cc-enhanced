#!/usr/bin/env node
import path from "node:path";
import chalk from "chalk";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { Manager } from "./manager.js";

const PATCHES = {
	prompts: [
		"Bash prompt condensed",
		"Tool policy softened",
		"Todo examples trimmed",
		"Read/Write guards relaxed",
		"Glob/Grep/WebSearch disabled",
		"Read tool restricted to media",
		"Write result trimmed",
	],
	editTool: ["Edit tool extended (line insert, diff, batch)"],
	limits: ["Read limits bumped (5000 lines, 1MB)"],
	signature: ["Patch signature injected"],
};

async function main() {
	const argv = await yargs(hideBin(process.argv))
		.version(false)
		.command(["$0", "pull"], "Download and patch Claude Code CLI", (yargs) => {
			return yargs
				.option("version", {
					alias: "v",
					type: "string",
					description: "Specific version to patch (e.g., 2.0.75)",
				})
				.option("out-dir", {
					type: "string",
					default: "versions",
					description: "Output directory",
				})
				.option("skip-format", {
					type: "boolean",
					description: "Skip Prettier formatting",
				})
				.option("dry-run", {
					type: "boolean",
					description: "Preview without writing",
				})
				.option("diff", {
					type: "boolean",
					description: "Show diff of changes",
				})
				.option("verify", {
					type: "boolean",
					default: true,
					description: "Verify patches after applying",
				})
				.option("list", {
					type: "boolean",
					description: "List available patches and exit",
				})
				.option("patch", {
					type: "boolean",
					default: true,
					description: "Apply patches (--no-patch to skip)",
				})
				.option("prompts", {
					type: "boolean",
					default: true,
					description: "Apply prompt enhancements",
				})
				.option("edit-tool", {
					type: "boolean",
					default: true,
					description: "Apply Edit tool extensions",
				})
				.option("limits", {
					type: "boolean",
					default: true,
					description: "Bump read limits",
				})
				.option("signature", {
					type: "boolean",
					default: true,
					description: "Inject patch signature",
				})
				.option("summary-path", {
					type: "string",
					description: "Write JSON summary to file",
				});
		})
		.help()
		.parse();

	const opts = argv as any;

	// Handle --list
	if (opts.list) {
		console.log(chalk.bold("\nAvailable Patches\n"));
		console.log(chalk.cyan("--prompts:"));
		PATCHES.prompts.forEach((p) => {
			console.log(`  • ${p}`);
		});
		console.log(chalk.cyan("\n--edit-tool:"));
		PATCHES.editTool.forEach((p) => {
			console.log(`  • ${p}`);
		});
		console.log(chalk.cyan("\n--limits:"));
		PATCHES.limits.forEach((p) => {
			console.log(`  • ${p}`);
		});
		console.log(chalk.cyan("\n--signature:"));
		PATCHES.signature.forEach((p) => {
			console.log(`  • ${p}`);
		});
		console.log("\nUse --no-<option> to disable (e.g., --no-prompts)\n");
		return;
	}

	console.log(chalk.bold("\nClaude Code Patcher"));
	console.log(chalk.dim("==================="));

	const activePatches: string[] = [];
	if (opts.patch !== false) {
		if (opts.prompts !== false) activePatches.push("Prompts");
		if (opts.editTool !== false) activePatches.push("Edit Tool");
		if (opts.limits !== false) activePatches.push("Limits");
		if (opts.signature !== false) activePatches.push("Signature");
	}

	console.log(`Target:  ${chalk.cyan(opts.outDir)}`);
	console.log(
		`Patches: ${activePatches.length > 0 ? chalk.green(activePatches.join(", ")) : chalk.yellow("None")}`,
	);
	if (opts.dryRun)
		console.log(chalk.yellow("Dry run mode - no changes will be written"));
	if (opts.skipFormat) console.log(chalk.yellow("Formatting skipped"));
	console.log("");

	const applyPatches = opts.patch !== false;
	const manager = new Manager({
		outDir: path.resolve(opts.outDir),
		skipFormat: opts.skipFormat,
		dryRun: opts.dryRun,
		showDiff: opts.diff,
		verify: opts.verify,
		applyPatches,
		// Prompt-related patches (all controlled by --prompts)
		enhancePrompts: applyPatches && opts.prompts !== false,
		patchBashPrompt: applyPatches && opts.prompts !== false,
		patchToolPolicy: applyPatches && opts.prompts !== false,
		trimTodo: applyPatches && opts.prompts !== false,
		normalizeRead: applyPatches && opts.prompts !== false,
		patchDisableTools: applyPatches && opts.prompts !== false,
		patchRestrictFileRead: applyPatches && opts.prompts !== false,
		patchShrinkWriteResult: applyPatches && opts.prompts !== false,
		// Standalone patches
		patchEditTool: applyPatches && opts.editTool !== false,
		bumpLimits: applyPatches && opts.limits !== false,
		patchSignature: applyPatches && opts.signature !== false,
		summaryPath: opts.summaryPath ? path.resolve(opts.summaryPath) : undefined,
	});

	try {
		const version = await manager.resolveVersion(
			opts.version as string | undefined,
		);
		console.log(`Patching version: ${version}`);

		const report = await manager.processVersion(version);

		if (opts.summaryPath && report) {
			const fs = await import("node:fs/promises");
			const p = path.resolve(opts.summaryPath);
			await fs.mkdir(path.dirname(p), { recursive: true });
			await fs.writeFile(p, JSON.stringify(report, null, 2), "utf-8");
			console.log(`Summary written to ${p}`);
		}
	} catch (e) {
		console.error(e);
		process.exit(1);
	}
}

main();
