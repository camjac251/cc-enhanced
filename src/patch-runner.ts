import * as fs from "node:fs/promises";
import chalk from "chalk";
import * as Diff from "diff";
import ora from "ora";
import { parse, print } from "./loader.js";
import {
	initialReport,
	type PatchContext,
	type PatchReport,
	type PatchRule,
	type StringPatchRule,
} from "./types.js";

export class PatchRunner {
	private rules: PatchRule[] = [];
	private stringRules: StringPatchRule[] = [];

	addRule(rule: PatchRule) {
		this.rules.push(rule);
	}

	addStringRule(rule: StringPatchRule) {
		this.stringRules.push(rule);
	}

	async run(
		filePath: string,
		options: { dryRun?: boolean; showDiff?: boolean } = {},
	): Promise<PatchReport & { diff?: string }> {
		const originalCode = await fs.readFile(filePath, "utf-8");
		let code = originalCode;

		const report: PatchReport = {
			...initialReport,
			locations: {},
			detected_variables: {},
		};
		const context: PatchContext = {
			report,
			filePath,
		};

		const errors: { rule: string; error: Error }[] = [];

		// Run string-based patches first
		for (const rule of this.stringRules) {
			const ruleSpinner = ora({
				text: rule.name,
				prefixText: "   ",
				color: "blue",
			}).start();
			try {
				code = rule(code, context);
				ruleSpinner.succeed(rule.name);
			} catch (e) {
				const err = e instanceof Error ? e : new Error(String(e));
				errors.push({ rule: rule.name, error: err });
				ruleSpinner.fail(`${rule.name}: ${err.message}`);
			}
		}

		const spinner = ora({
			text: `Parsing AST (${(code.length / 1024 / 1024).toFixed(1)} MB)`,
			prefixText: "   ",
			color: "cyan",
		}).start();
		const ast = parse(code);
		spinner.succeed("AST parsed");

		for (const rule of this.rules) {
			const ruleSpinner = ora({
				text: rule.name,
				prefixText: "   ",
				color: "blue",
			}).start();
			try {
				await rule(ast, context);
				ruleSpinner.succeed(rule.name);
			} catch (e) {
				const err = e instanceof Error ? e : new Error(String(e));
				errors.push({ rule: rule.name, error: err });
				ruleSpinner.fail(`${rule.name}: ${err.message}`);
			}
		}

		if (errors.length > 0) {
			console.log(
				chalk.yellow(
					`\n    ${errors.length} patch(es) failed: ${errors.map((e) => e.rule).join(", ")}`,
				),
			);
		}

		const output = print(ast);

		// Generate diff if requested
		let diffOutput: string | undefined;
		if (options.showDiff || options.dryRun) {
			const patch = Diff.createPatch(
				filePath,
				originalCode,
				output,
				"original",
				"patched",
			);
			diffOutput = patch;

			if (options.showDiff) {
				// Print colorized diff
				const lines = patch.split("\n");
				for (const line of lines) {
					if (line.startsWith("+") && !line.startsWith("+++")) {
						console.log(chalk.green(line));
					} else if (line.startsWith("-") && !line.startsWith("---")) {
						console.log(chalk.red(line));
					} else if (line.startsWith("@@")) {
						console.log(chalk.cyan(line));
					} else {
						console.log(chalk.gray(line));
					}
				}
			}
		}

		if (!options.dryRun) {
			await fs.writeFile(filePath, output, "utf-8");
		} else {
			console.log(chalk.yellow("    Dry run - no changes written"));
		}

		return { ...report, diff: diffOutput };
	}
}
