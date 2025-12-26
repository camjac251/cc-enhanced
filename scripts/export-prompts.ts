#!/usr/bin/env tsx
/**
 * Export system prompts from claude-code cli.js
 * Usage: tsx scripts/export-prompts.ts [version]
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const version = process.argv[2] || "2.0.76";
const cliPath = path.join(
	__dirname,
	"..",
	"versions_clean",
	version,
	"package",
	"cli.js",
);

if (!fs.existsSync(cliPath)) {
	console.error(`File not found: ${cliPath}`);
	console.error("Run: pnpm cli -v VERSION --no-patch first");
	process.exit(1);
}

const code = fs.readFileSync(cliPath, "utf-8");
const outputDir = path.join(__dirname, "..", "exported-prompts", version);
fs.mkdirSync(outputDir, { recursive: true });

// Extract output styles object
function extractOutputStyles(): void {
	// Find x4A = { ... } which contains output styles
	const match = code.match(/x4A\s*=\s*\{[\s\S]*?^\s*\};/m);
	if (match) {
		// Clean up the minified variable references
		let content = match[0];

		// Try to find the insight template (i69)
		const insightMatch = code.match(/i69\s*=\s*`([\s\S]*?)`,\s*x4A/);
		const insightTemplate = insightMatch ? insightMatch[1] : "[INSIGHT_TEMPLATE]";

		// Replace variable references with placeholders
		content = content
			.replace(/\$\{G1\.star\}/g, "★")
			.replace(/\$\{G1\.bullet\}/g, "•")
			.replace(/\$\{i69\}/g, insightTemplate)
			.replace(/\[qD\]/g, '["default"]');

		fs.writeFileSync(path.join(outputDir, "output-styles.js"), content);
		console.log("✓ Exported output-styles.js");
	}
}

// Extract main system prompt template
function extractSystemPrompt(): void {
	// Look for the large template string that builds the system prompt
	// It starts with "You are Claude Code" or similar
	const patterns = [
		/`You are Claude Code, Anthropic's official CLI[\s\S]*?(?=\n\s*\];)/,
		/You are an interactive CLI tool that helps users with software engineering tasks/,
	];

	// Find the RG5 or similar function that builds system prompt
	const funcMatch = code.match(
		/function\s+\w+\([^)]*\)\s*\{[^}]*You are Claude Code[\s\S]*?^\}/m,
	);

	if (funcMatch) {
		fs.writeFileSync(
			path.join(outputDir, "system-prompt-function.js"),
			funcMatch[0],
		);
		console.log("✓ Exported system-prompt-function.js");
	}

	// Extract the template literals from the system prompt builder
	// Look for the array of prompt parts
	const promptArrayMatch = code.match(
		/return\s*\[\s*`You are Claude Code[\s\S]*?\]\s*;/,
	);
	if (promptArrayMatch) {
		fs.writeFileSync(
			path.join(outputDir, "system-prompt-array.js"),
			promptArrayMatch[0],
		);
		console.log("✓ Exported system-prompt-array.js");
	}
}

// Extract specific prompt sections by searching for headers
function extractPromptSections(): void {
	const sections: Record<string, string> = {};

	// Find all template literal strings that look like prompt sections
	const sectionHeaders = [
		"# Tone and style",
		"# Doing tasks",
		"# Tool usage policy",
		"# Code References",
		"# Committing changes with git",
		"# Creating pull requests",
		"# MCP Server Instructions",
		"# Looking up your own documentation",
		"# Task Management",
		"# Asking questions as you work",
		"# Planning without timelines",
		"# Professional objectivity",
	];

	for (const header of sectionHeaders) {
		const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const regex = new RegExp(`${escaped}[\\s\\S]*?(?=\\n#\\s|\\n\`|$)`, "m");
		const match = code.match(regex);
		if (match) {
			const key = header.replace(/^#\s*/, "").replace(/\s+/g, "-").toLowerCase();
			sections[key] = match[0];
		}
	}

	if (Object.keys(sections).length > 0) {
		let content = "";
		for (const [key, value] of Object.entries(sections)) {
			content += `\n${"=".repeat(60)}\n${key.toUpperCase()}\n${"=".repeat(60)}\n\n${value}\n`;
		}
		fs.writeFileSync(path.join(outputDir, "prompt-sections.md"), content);
		console.log(`✓ Exported prompt-sections.md (${Object.keys(sections).length} sections)`);
	}
}

// Extract CLAUDE.md related prompts
function extractClaudeMdPrompts(): void {
	// Find NI5 which is the CLAUDE.md preamble
	const preambleMatch = code.match(/NI5\s*=\s*"([^"]+)"/);
	if (preambleMatch) {
		fs.writeFileSync(
			path.join(outputDir, "claudemd-preamble.txt"),
			preambleMatch[1].replace(/\\n/g, "\n"),
		);
		console.log("✓ Exported claudemd-preamble.txt");
	}
}

// Extract agent system prompts
function extractAgentPrompts(): void {
	const agents: Record<string, string> = {};

	// Find getSystemPrompt functions/arrows
	const agentPatterns = [
		{ name: "general-purpose", pattern: /JX1\s*=\s*\{[\s\S]*?getSystemPrompt[\s\S]*?^\s*\};/m },
		{ name: "explore", pattern: /Jg5\s*=\s*`([\s\S]*?)`;/ },
		{ name: "plan", pattern: /Xg5\s*=\s*`([\s\S]*?)`;/ },
	];

	for (const { name, pattern } of agentPatterns) {
		const match = code.match(pattern);
		if (match) {
			agents[name] = match[1] || match[0];
		}
	}

	// Look for agent definitions with getSystemPrompt
	const agentDefMatches = code.matchAll(
		/agentType:\s*"([^"]+)"[\s\S]*?getSystemPrompt[^}]*?`([\s\S]*?)`/g,
	);
	for (const match of agentDefMatches) {
		agents[match[1]] = match[2];
	}

	if (Object.keys(agents).length > 0) {
		for (const [name, prompt] of Object.entries(agents)) {
			const filename = `agent-${name}.txt`;
			fs.writeFileSync(path.join(outputDir, filename), prompt);
		}
		console.log(`✓ Exported ${Object.keys(agents).length} agent prompts`);
	}
}

// Main execution
console.log(`\nExporting prompts from version ${version}...\n`);

extractOutputStyles();
extractSystemPrompt();
extractPromptSections();
extractClaudeMdPrompts();
extractAgentPrompts();

console.log(`\nOutput directory: ${outputDir}\n`);
