#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { status } from "../src/promote.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const exportCurrentScript = path.join(__dirname, "export-prompts-current.ts");
const exportedPromptsDir = path.join(repoRoot, "exported-prompts");

interface BundleOptions {
	input: string;
	outputDir: string;
	label: string;
	maxUncategorized?: number;
}

function detectCurrentLabel(): string {
	const info = status();
	if (!info.current) {
		throw new Error(
			"No promoted binary found. Run `mise run native:update` first or pass an explicit version/path.",
		);
	}
	const versionInfo = info.current.version;
	if (!versionInfo) {
		throw new Error(
			`Could not determine version from: ${info.current.binaryPath}`,
		);
	}
	return versionInfo.isPatched
		? `${versionInfo.version}_patched`
		: versionInfo.version;
}

function deriveLabel(input: string, override?: string): string {
	if (override) return override;
	if (input === "current") return detectCurrentLabel();
	if (/^\d+\.\d+\.\d+/.test(input)) return input;
	const base = path.basename(input).replace(/\.js$/, "");
	return `scratch-${base}`;
}

function parseOptions(): BundleOptions {
	const argv = yargs(hideBin(process.argv))
		.scriptName("bundle-prompts")
		.usage("$0 [current|version|cli.js] [options]")
		.version(false)
		.option("label", {
			type: "string",
			description: "Override export label (and default output dir)",
		})
		.option("output-dir", {
			type: "string",
			description: "Output directory (default: exported-prompts/<label>)",
		})
		.option("max-uncategorized", {
			type: "number",
			description: "Fail if uncategorized corpus count exceeds this value",
		})
		.strictOptions()
		.parseSync();

	const positional = ((argv._ as unknown[]) ?? [])
		.map((value) => String(value))
		.filter((value) => value !== "$0");
	if (positional.length > 1) {
		throw new Error(
			`Unexpected extra positional argument "${positional[1]}". Expected at most one input.`,
		);
	}
	const maxUncategorized = argv.maxUncategorized;
	if (
		maxUncategorized !== undefined &&
		(!Number.isInteger(maxUncategorized) || maxUncategorized < 0)
	) {
		throw new Error("--max-uncategorized must be a non-negative integer");
	}

	const input = positional[0] ?? "current";
	const label = deriveLabel(input, argv.label);
	const outputDir = argv.outputDir
		? path.resolve(repoRoot, argv.outputDir)
		: path.join(exportedPromptsDir, label);

	return { input, outputDir, label, maxUncategorized };
}

function runExporter(options: BundleOptions): void {
	if (fs.existsSync(options.outputDir)) {
		fs.rmSync(options.outputDir, { recursive: true, force: true });
	}
	fs.mkdirSync(options.outputDir, { recursive: true });

	const args = [
		exportCurrentScript,
		options.input,
		"--output-dir",
		options.outputDir,
		"--label",
		options.label,
	];
	if (options.maxUncategorized !== undefined) {
		args.push("--max-uncategorized", String(options.maxUncategorized));
	}

	const result = spawnSync("bun", args, { stdio: "inherit", cwd: repoRoot });
	if (result.status !== 0) {
		console.error(`Exporter failed with exit code ${result.status ?? 1}`);
		process.exit(result.status ?? 1);
	}
}

function readManifestLabel(outputDir: string, fallback: string): string {
	const manifestPath = path.join(outputDir, "manifest.json");
	try {
		const raw = fs.readFileSync(manifestPath, "utf8");
		const parsed = JSON.parse(raw) as { label?: unknown };
		if (typeof parsed.label === "string" && parsed.label.length > 0) {
			return parsed.label;
		}
	} catch {
		/* manifest unreadable; fall back */
	}
	return fallback;
}

function writeIndex(options: BundleOptions): void {
	const label = readManifestLabel(options.outputDir, options.label);
	const generatedAt = new Date().toISOString();
	const lines = [
		`# Prompt Artifacts Index: ${label}`,
		"",
		`Generated: ${generatedAt}`,
		"",
		"Self-contained navigable export of Claude Code prompt surfaces.",
		"All links are relative; this file plus the bundle is the unit.",
		"",
		"## Bundle (extracted from cli.js)",
		"- [Top-level export README](./README.md)",
		"- [System prompts (sections, variants, reminders)](./system/README.md)",
		"- [Built-in agents](./agents/README.md)",
		"- [Skills](./skills/README.md)",
		"- [Tool prompts](./tools/README.md)",
		"- [Internal agents](./internal-agents/README.md)",
		"- [Manifest](./manifest.json)",
		"",
		"## Corpora and indexes",
		"- [Corpus (categorized)](./corpus-categorized.json)",
		"- [Corpus summary](./corpus-summary.json)",
		"- [Prompt corpus](./prompt-corpus.json)",
		"- [Prompt hash index](./prompt-hash-index.json)",
		"- [Data references](./data-references.json)",
		"- [Runtime symbol map](./runtime-symbol-map.json)",
		"- [Output styles](./output-styles.json)",
		"",
	];

	const indexPath = path.join(options.outputDir, "INDEX.md");
	fs.writeFileSync(indexPath, `${lines.join("\n")}\n`);
	console.log(`Index: ${path.relative(repoRoot, indexPath)}`);
}

function main(): void {
	const options = parseOptions();

	console.log(`Label: ${options.label}`);
	console.log(`Bundle target: ${path.relative(repoRoot, options.outputDir)}`);
	runExporter(options);
	writeIndex(options);

	console.log("");
	console.log(`Bundle ready: ${path.relative(repoRoot, options.outputDir)}`);
	console.log(
		`Open: ${path.relative(repoRoot, path.join(options.outputDir, "INDEX.md"))}`,
	);
}

main();
