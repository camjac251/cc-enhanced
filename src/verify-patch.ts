import * as fs from "node:fs";
import chalk from "chalk";
import type { PatchReport } from "./types.js";

export interface VerifyCheck {
	name: string;
	check: (content: string) => boolean;
	required: boolean;
	/** Only run this check if the corresponding patch was applied */
	condition?: (report: PatchReport) => boolean;
}

export interface VerifyResult {
	passed: boolean;
	checks: { name: string; passed: boolean; required: boolean }[];
	failedCount: number;
}

const CHECKS: VerifyCheck[] = [
	{
		name: "Edit Tool: Extended Schema",
		check: (c) => c.includes("line_number") && /edits: \w+\.array/.test(c),
		required: true,
		condition: (r) => r.edit_tool_extended,
	},
	{
		name: "Edit Tool: Prompt Updated",
		check: (c) => c.includes("Edit supports string replace, line insert"),
		required: true,
		condition: (r) => r.edit_tool_extended,
	},
	{
		name: "Tool Policy: Read Restriction",
		check: (c) => c.includes("avoid Read except for PDFs/images"),
		required: true,
		condition: (r) => r.tool_policy_softened,
	},
	{
		name: "Bash Prompt: Tool Preferences",
		check: (c) =>
			c.includes("- Tool Preferences (See /etc/claude-code/CLAUDE.md"),
		required: true,
		condition: (r) => r.bash_prompt_condensed,
	},
	{
		name: "Bash Prompt: Avoid Section Removed",
		check: (c) => !c.includes("- Avoid using Bash with the `find`"),
		required: true,
		condition: (r) => r.bash_prompt_condensed,
	},
	{
		name: "Read Tool: Visual Hint Preserved",
		check: (c) => c.includes("contents are presented visually"),
		required: true,
	},
	{
		name: "Write Tool: Snippet Removed",
		check: (c) => !c.includes("Here's the result of running `cat -n`"),
		required: true,
		condition: (r) => r.write_result_trimmed,
	},
	{
		name: "Signature Injected",
		check: (c) => c.includes("patched:"),
		required: true,
	},
];

export function verifyPatch(
	cliPath: string,
	report?: PatchReport,
): VerifyResult {
	if (!fs.existsSync(cliPath)) {
		throw new Error(`File not found: ${cliPath}`);
	}

	const content = fs.readFileSync(cliPath, "utf-8");
	const results: VerifyResult = {
		passed: true,
		checks: [],
		failedCount: 0,
	};

	for (const check of CHECKS) {
		// Skip checks that don't apply based on what patches were run
		if (check.condition && report && !check.condition(report)) {
			continue;
		}

		const passed = check.check(content);
		results.checks.push({ name: check.name, passed, required: check.required });

		if (!passed && check.required) {
			results.failedCount++;
			results.passed = false;
		}
	}

	return results;
}

export function logVerifyResult(result: VerifyResult, verbose = true) {
	for (const check of result.checks) {
		if (verbose || !check.passed) {
			if (check.passed) {
				console.log(chalk.green(`     ✓ ${check.name}`));
			} else {
				console.log(chalk.red(`     ✗ ${check.name}`));
			}
		}
	}

	if (!result.passed) {
		console.log(
			chalk.red(`     ${result.failedCount} verification check(s) failed`),
		);
	}
}

// CLI mode - run directly
if (
	process.argv[1]?.endsWith("verify-patch.ts") ||
	process.argv[1]?.endsWith("verify-patch.js")
) {
	const version = process.argv[2];
	if (!version) {
		console.error("Usage: tsx verify-patch.ts <version>");
		process.exit(1);
	}

	const cliPath = `versions/${version}/package/cli.js`;
	console.log(chalk.blue(`Verifying ${cliPath}...`));

	try {
		const result = verifyPatch(cliPath);
		logVerifyResult(result);

		if (!result.passed) {
			process.exit(1);
		} else {
			console.log(chalk.green("\nAll checks passed!"));
		}
	} catch (e) {
		console.error(chalk.red(`Error: ${e}`));
		process.exit(1);
	}
}
