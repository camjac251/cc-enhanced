#!/usr/bin/env node
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { Manager } from "./manager.js";
import path from "path";

// Replicate the CLI structure from Python
// Commands: pull (default)
// Flags: --version, --all, --latest, --out-dir, --skip-format, ...

async function main() {
      const argv = await yargs(hideBin(process.argv))
      .version(false)
      .command(["pull", "$0"], "Fetch and patch versions", (yargs) => {        return yargs
            .option("version", {
                alias: "v",
                type: "array",
                string: true,
                description: "Specific version(s) to fetch"
            })
            .option("all", {
                type: "boolean",
                description: "Fetch all versions"
            })
            .option("latest", {
                type: "number",
                description: "Fetch N latest versions",
                default: 1
            })
            .option("out-dir", {
                type: "string",
                default: "versions",
                description: "Output directory"
            })
            .option("skip-format", {
                type: "boolean",
                description: "Skip formatting step"
            })
            .option("no-enhance-prompts", {
                type: "boolean",
                description: "Disable prompt enhancements"
            })
            .option("no-bump-limits", {
                type: "boolean",
                description: "Disable limit bumps"
            })
            .option("no-patch", {
                type: "boolean",
                description: "Disable all patches (download and normalize only)"
            })
            .option("summary-path", {
                type: "string",
                description: "Write JSON summary to file"
            });
    })
    .help()
    .parse();

    // yargs parsing results
    const opts = argv as any;
    console.log("Options:", opts);

    const manager = new Manager({
        outDir: path.resolve(opts.outDir),
        skipFormat: opts.skipFormat,
        enhancePrompts: !opts.noEnhancePrompts,
        bumpLimits: !opts.noBumpLimits,
        applyPatches: opts.patch !== false,
        summaryPath: opts.summaryPath ? path.resolve(opts.summaryPath) : undefined
    });

    try {
        const versions = await manager.resolveVersions(
            opts.version as string[], 
            opts.all, 
            opts.latest
        );
        
        console.log(`Found ${versions.length} version(s) to fetch: ${versions.join(", ")}`);
        
        const reports = [];
        for (const v of versions) {
            const report = await manager.processVersion(v);
            if (report) reports.push(report);
        }

        if (opts.summaryPath) {
            const fs = await import("fs/promises");
            const p = path.resolve(opts.summaryPath);
            await fs.mkdir(path.dirname(p), { recursive: true });
            await fs.writeFile(p, JSON.stringify(reports, null, 2), "utf-8");
            console.log(`Summary written to ${p}`);
        }

    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}

main();