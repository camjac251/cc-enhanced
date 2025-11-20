import * as fs from "fs/promises";
import * as path from "path";
import chalk from "chalk";
import { downloadAndExtract, getPackageMeta, getAllVersions, getLatestVersion, versionExists } from "./downloader.js";
import { normalize } from "./normalizer.js";
import { PatchRunner } from "./patch-runner.js";
import * as patches from "./patches/index.js";

interface ManagerOptions {
    outDir: string;
    formatter?: string;
    skipFormat?: boolean;
    enhancePrompts?: boolean;
    bumpLimits?: boolean;
    applyPatches?: boolean;
    summaryPath?: string;
    // specific patches...
    patchGlob?: boolean;
    patchRipgrep?: boolean;
    patchToolPolicy?: boolean;
    patchContext?: boolean;
    trimTodo?: boolean;
    normalizeRead?: boolean;
    relaxGuard?: boolean;
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
        if (o.enhancePrompts !== false) { // Default true
            if (o.patchGlob !== false) this.runner.addRule(patches.globPrompt);
            if (o.patchRipgrep !== false) this.runner.addRule(patches.ripgrepPrompt);
            if (o.patchToolPolicy !== false) this.runner.addRule(patches.toolPolicy);
            if (o.trimTodo !== false) this.runner.addRule(patches.todoTrims);
            if (o.normalizeRead !== false) this.runner.addRule(patches.readWritePrompts); // includes write guard relax logic in patches.py?
            if (o.patchContext !== false) {
                this.runner.addRule(patches.tokenCache);
            }
            this.runner.addRule(patches.editTool);
        }
        if (o.bumpLimits !== false) { // Default true
            this.runner.addRule(patches.bumpLimits);
        }
        // Always add signature last
        this.runner.addRule(patches.injectSignature);
    }

    async getMeta() {
        if (!this.meta) {
            this.meta = await getPackageMeta();
        }
        return this.meta;
    }

    async resolveVersions(versions: string[] | undefined, all: boolean, latest: number | undefined): Promise<string[]> {
        const meta = await this.getMeta();
        
        if (all) {
            return getAllVersions(meta);
        }
        
        if (versions && versions.length > 0) {
            const missing = versions.filter(v => !versionExists(meta, v));
            if (missing.length > 0) {
                throw new Error(`Unknown version(s): ${missing.join(", ")}`);
            }
            return versions;
        }
        
        const allVers = getAllVersions(meta);
        const count = latest || 1;
        return allVers.slice(-count);
    }

    async processVersion(version: string) {
        const vDir = path.join(this.options.outDir, version);
        console.log(chalk.blue(`→ Downloading ${version} → ${vDir}`));
        
        await downloadAndExtract(version, vDir, await this.getMeta());
        
        const cliPath = path.join(vDir, "package", "cli.js");
        
        try {
             await fs.access(cliPath);
        } catch {
             console.error(chalk.red(`  Error: ${cliPath} not found after extraction.`));
             return { version, error: "File not found" };
        }

        if (!this.options.skipFormat) {
            console.log(chalk.gray(`   Formatting ${version}...`));
            try {
                const raw = await fs.readFile(cliPath, "utf-8");
                const formatted = await normalize(raw);
                await fs.writeFile(cliPath, formatted, "utf-8");
            } catch (e) {
                console.error(chalk.yellow(`   Formatting failed: ${e}`));
            }
        }
        
        console.log(chalk.gray("   Enhancing prompt/help text..."));
        try {
            const report = await this.runner.run(cliPath);
            this.logReport(report);
            return { version, ...report };
        } catch (e: any) {
            console.error(chalk.red(`   Patching failed: ${e}`));
            return { version, error: e.toString() };
        }
    }
    
    private logReport(r: any) {
         // Concise log
         const checks = [
             r.glob_prompt_standardized && "Glob",
             r.ripgrep_prompt_standardized && "Ripgrep",
             r.tool_policy_softened && "Policy",
             r.context_usage_hint_added && "Context",
             r.todo_examples_trimmed && "Todo",
             r.read_tool_prompt_normalized && "Read",
             r.write_guard_relaxed && "Guard",
             r.edit_tool_extended && "EditExt",
             r.token_usage_snapshot_enabled && "TokenSnap",
         ].filter(Boolean).join(", ");
         console.log(chalk.green(`     - Applied: ${checks || "None"}`));
         
         if (r.lines_cap_bumped || r.byte_ceiling_bumped) {
             console.log(chalk.green(`     - Limits bumped`));
         }
    }
}
