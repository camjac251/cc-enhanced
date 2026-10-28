#!/usr/bin/env bun
/**
 * Check that the plugin still loads and passes its engine tests on the oldest
 * Claude Code the manifest declares, without the latest-release prompt checks.
 * Run it whenever the mod starts using a mods API feature or another hook.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchNativeRelease } from "../src/native-release.js";
import { verifyMods } from "../src/verify-mod.js";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const manifest = JSON.parse(
	fs.readFileSync(
		path.join(repoRoot, "plugin", ".claude-plugin", "plugin.json"),
		"utf8",
	),
) as { metadata?: { minimumClaudeCodeVersion?: string } };
const minimum = manifest.metadata?.minimumClaudeCodeVersion;
if (!minimum)
	throw new Error("plugin.json has no metadata.minimumClaudeCodeVersion");
const release = await fetchNativeRelease({ spec: minimum });
await verifyMods(release.binaryPath, { live: false });
console.log(
	`cc-enhanced loads and passes its engine tests on Claude Code ${minimum}.`,
);
