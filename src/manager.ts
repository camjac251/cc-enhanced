import * as fs from "node:fs/promises";
import * as path from "node:path";
import chalk from "chalk";
import {
	downloadAndExtract,
	getLatestVersion,
	getPackageMeta,
	versionExists,
} from "./downloader.js";
import { normalize } from "./normalizer.js";
import { PatchRunner } from "./patch-runner.js";
import * as patches from "./patches/index.js";
import { logVerifyResult, verifyPatch } from "./verify-patch.js";

interface ManagerOptions {
	outDir: string;
	formatter?: string;
	skipFormat?: boolean;
	enhancePrompts?: boolean;
	bumpLimits?: boolean;
	applyPatches?: boolean;
	verify?: boolean;
	dryRun?: boolean;
	showDiff?: boolean;
	summaryPath?: string;
	// specific patches
	patchBashPrompt?: boolean;
	patchToolPolicy?: boolean;
	trimTodo?: boolean;
	normalizeRead?: boolean;
	relaxGuard?: boolean;
	patchEditTool?: boolean;
	patchSignature?: boolean;
	patchDisableTools?: boolean;
	patchRestrictFileRead?: boolean;
	patchShrinkWriteResult?: boolean;
	// Glob/Grep removal patches
	patchRemoveGlobGrepRefs?: boolean;
	patchAllowedToolsPrompt?: boolean;
	patchTaskToolPrompt?: boolean;
	patchSkillAllowedTools?: boolean;
	// Agent configuration patches
	patchAgentTools?: boolean;
	patchAgentPrompts?: boolean;
	// Context management patch
	patchContextManagement?: boolean;
}

export class Manager {
	private runner: PatchRunner;
	private meta: any = null;

	constructor(private options: ManagerOptions) {
		this.runner = new PatchRunner();
		if (options.applyPatches !== false) {
			this.configureRunner();
		}
	}

	private configureRunner() {
		const o = this.options;
		const _toolsDisabled = o.patchDisableTools !== false;

		if (o.enhancePrompts !== false) {
			// Default true
			if (o.patchBashPrompt !== false)
				this.runner.addStringRule(patches.bashPromptString);
			if (o.patchToolPolicy !== false) this.runner.addRule(patches.toolPolicy);
			if (o.trimTodo !== false) this.runner.addRule(patches.todoTrims);
			if (o.normalizeRead !== false)
				this.runner.addRule(patches.readWritePrompts);
			if (o.patchEditTool !== false) this.runner.addRule(patches.editTool);
			if (o.patchDisableTools !== false)
				this.runner.addRule(patches.disableTools);
			if (o.patchRestrictFileRead !== false)
				this.runner.addRule(patches.restrictFileRead);
			if (o.patchShrinkWriteResult !== false)
				this.runner.addRule(patches.shrinkWriteResult);
			if (o.patchEditTool !== false)
				this.runner.addRule(patches.patchDefinitions);
			// Glob/Grep removal patches - remove all references to disabled tools
			// String-based patches run first (faster)
			if (o.patchRemoveGlobGrepRefs !== false)
				this.runner.addStringRule(patches.removeGlobGrepRefsString);
			if (o.patchAllowedToolsPrompt !== false)
				this.runner.addStringRule(patches.removeAllowedToolsPrompt);
			if (o.patchTaskToolPrompt !== false)
				this.runner.addStringRule(patches.taskToolPromptString);
			if (o.patchSkillAllowedTools !== false) {
				this.runner.addStringRule(patches.skillAllowedToolsString);
				this.runner.addRule(patches.skillAllowedTools); // AST for filePatternTools array
			}
			// Agent configuration patches
			if (o.patchAgentTools !== false)
				this.runner.addRule(patches.patchAgentTools);
			if (o.patchAgentPrompts !== false)
				this.runner.addStringRule(patches.patchAgentPromptsString);
			// Context management patch (AST-based for future resilience)
			if (o.patchContextManagement !== false)
				this.runner.addRule(patches.patchContextManagement);
		}
		if (o.bumpLimits !== false) {
			// Default true
			this.runner.addRule(patches.bumpLimits);
		}
		// Always add signature last
		if (o.patchSignature !== false)
			this.runner.addRule(patches.injectSignature);
	}

	async getMeta() {
		if (!this.meta) {
			this.meta = await getPackageMeta();
		}
		return this.meta;
	}

	async resolveVersion(specificVersion?: string): Promise<string> {
		const meta = await this.getMeta();

		if (specificVersion) {
			if (!versionExists(meta, specificVersion)) {
				throw new Error(`Unknown version: ${specificVersion}`);
			}
			return specificVersion;
		}

		// Default to latest
		return getLatestVersion(meta);
	}

	async processVersion(version: string) {
		const vDir = path.join(this.options.outDir, version);
		console.log(chalk.blue(`→ Downloading ${version} → ${vDir}`));

		await downloadAndExtract(version, vDir, await this.getMeta());

		const cliPath = path.join(vDir, "package", "cli.js");

		try {
			await fs.access(cliPath);
		} catch {
			console.error(
				chalk.red(`  Error: ${cliPath} not found after extraction.`),
			);
			return { version, error: "File not found" };
		}

		if (!this.options.skipFormat) {
			console.log(chalk.gray(`   Formatting ${version}...`));
			try {
				const raw = await fs.readFile(cliPath, "utf-8");
				const formatted = await normalize(raw, { filepath: cliPath });
				await fs.writeFile(cliPath, formatted, "utf-8");
			} catch (e) {
				console.error(chalk.yellow(`   Formatting failed: ${e}`));
			}
		}

		console.log(chalk.gray("   Enhancing prompt/help text..."));
		try {
			const report = await this.runner.run(cliPath, {
				dryRun: this.options.dryRun,
				showDiff: this.options.showDiff,
			});
			this.logReport(report);

			// Run verification if enabled (default: true when patches applied, skip in dry-run)
			if (
				this.options.verify !== false &&
				this.options.applyPatches !== false &&
				!this.options.dryRun
			) {
				console.log(chalk.gray("   Verifying patches..."));
				const verifyResult = verifyPatch(cliPath, report);
				logVerifyResult(verifyResult, false); // Only show failures

				if (!verifyResult.passed) {
					return { version, ...report, verificationFailed: true };
				}
			}

			return { version, ...report };
		} catch (e: any) {
			console.error(chalk.red(`   Patching failed: ${e}`));
			if (e.stack) console.error(chalk.gray(e.stack));
			return { version, error: e.toString() };
		}
	}

	private logReport(r: any) {
		// Concise log
		const checks = [
			r.bash_prompt_condensed && "Bash",
			r.tool_policy_softened && "Policy",
			r.context_usage_hint_added && "Context",
			r.todo_examples_trimmed && "Todo",
			r.read_tool_prompt_normalized && "Read",
			r.write_guard_relaxed && "Guard",
			r.edit_tool_extended && "EditExt",
			r.tools_disabled && "ToolsTrimmed",
			r.file_read_restricted && "ReadRestricted",
			r.write_result_trimmed && "WriteResult",
			(r.agents_disabled || r.agents_filtered) && "AgentsOff",
			r.claude_guide_blocklist && "GuideBlocklist",
			r.agent_prompts_patched && "AgentPrompts",
		]
			.filter(Boolean)
			.join(", ");
		console.log(chalk.green(`     - Applied: ${checks || "None"}`));

		if (r.lines_cap_bumped || r.byte_ceiling_bumped) {
			console.log(chalk.green(`     - Limits bumped`));
		}
	}
}
