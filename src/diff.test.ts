import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { extractPatchAnchors } from "./diff.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function withBundleFixtures(
	fn: (oldBundle: string, newBundle: string, tempDir: string) => void,
): void {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-diff-test-"));
	const oldBundle = path.join(tempDir, "old.js");
	const newBundle = path.join(tempDir, "new.js");

	fs.writeFileSync(
		oldBundle,
		[
			"// Version: 1.0.0",
			'const tool = { name: "Read", description: "Read files" };',
			'const oldCommand = { command: "brief-mode-enforce", description: "In brief mode you must call SendUserMessage" };',
			'persist("userSettings", { effortLevel: "medium" });',
			"const oldReminder = `<system-reminder>Whenever you read a file, review the file before editing.</system-reminder>`;",
			'console.log("[upstreamproxy] client socket error: ${}");',
			'console.log("[upstreamproxy] ca-cert fetch ${}; proxy disabled");',
			'console.log("claude-code/1.0.0");',
			"",
		].join("\n"),
	);
	fs.writeFileSync(
		newBundle,
		[
			"// Version: 1.0.1",
			'const tool = { name: "Read", description: "Read files" };',
			'const added = { name: "Purge", description: "Delete project state" };',
			'console.log("purge [path]");',
			'console.log("--dry-run");',
			'console.log("CLAUDE_CODE_PROJECT_STATE");',
			'persist("userSettings", { effortLevel: "high" });',
			'persist("userSettings", { effortLevel: undefined });',
			'console.log("[egress-gateway] client socket error: ${}");',
			'console.log("[egress-gateway] ca-cert fetch ${}; proxy disabled");',
			"const newReminder = `<system-reminder>Brand new reminder added in 1.0.1 about file editing review.</system-reminder>`;",
			'const wrapped = "Pre-text guard sentence <system-reminder>Inner reminder body about review.</system-reminder> Post-text guard sentence";',
			'console.log("claude-code/1.0.1");',
			"",
		].join("\n"),
	);

	try {
		fn(oldBundle, newBundle, tempDir);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}

function runBundleDiffJson(oldBundle: string, newBundle: string): any {
	return JSON.parse(
		execFileSync(
			"bun",
			["src/diff.ts", oldBundle, newBundle, "--json", "--limit", "40"],
			{
				cwd: repoRoot,
				encoding: "utf8",
			},
		),
	);
}

function runBundleDiffText(args: string[]): string {
	return execFileSync("bun", ["src/diff.ts", ...args], {
		cwd: repoRoot,
		encoding: "utf8",
	});
}

test("bundle diff reports high-signal additions without version noise", {
	timeout: 15000,
}, () => {
	withBundleFixtures((oldBundle, newBundle) => {
		const report = runBundleDiffJson(oldBundle, newBundle);
		const added = report.added.map(
			(change: { kind: string; value: string }) =>
				`${change.kind}:${change.value}`,
		);

		assert.ok(added.includes("object-label:name=Purge"));
		assert.ok(added.includes("cli-flag:--dry-run"));
		assert.ok(added.includes("env-var:CLAUDE_CODE_PROJECT_STATE"));
		assert.ok(!added.some((value: string) => value.includes("1.0.1")));

		const addedCommands = report.sections.commands.added.map(
			(change: { value: string }) => change.value,
		);
		assert.ok(addedCommands.includes("purge [path]"));
		assert.ok(
			report.prefixRewrites.some(
				(rewrite: { oldPrefix: string; newPrefix: string }) =>
					rewrite.oldPrefix === "upstreamproxy" &&
					rewrite.newPrefix === "egress-gateway",
			),
		);
		assert.ok(
			report.removedCapabilities.some(
				(candidate: { token: string }) => candidate.token === "brief",
			),
		);

		const settingsWrites = report.sections.settings.countChanged.map(
			(change: { value: string; delta: number }) =>
				`${change.value}:${change.delta}`,
		);
		assert.ok(settingsWrites.includes("userSettings.effortLevel:1"));
		const removedReminders = report.sections.reminders.removed.map(
			(change: { value: string }) => change.value,
		);
		assert.ok(
			removedReminders.some((value: string) =>
				value.includes("Whenever you read a file"),
			),
		);
	});
});

test("bundle diff supports focus, markdown, cache, config, and prompt export checks", {
	timeout: 15000,
}, () => {
	withBundleFixtures((oldBundle, newBundle, tempDir) => {
		const cacheDir = path.join(tempDir, "cache");
		const promptDir = path.join(tempDir, "prompts");
		const configPath = path.join(tempDir, "bundle-diff.config.json");
		fs.mkdirSync(promptDir);
		fs.writeFileSync(path.join(promptDir, "live.md"), "Read files\n");
		fs.writeFileSync(
			configPath,
			JSON.stringify({
				ignoreTokens: ["ignore-me"],
				highSignalTokens: ["gateway"],
			}),
		);

		const markdown = runBundleDiffText([
			oldBundle,
			newBundle,
			"--markdown",
			"--focus",
			"commands",
			"--cache",
			"--cache-dir",
			cacheDir,
			"--config",
			configPath,
			"--prompt-export",
			promptDir,
		]);
		assert.match(markdown, /^# Bundle Surface Diff/);
		assert.match(markdown, /Command Candidates/);
		assert.match(markdown, /purge \[path\]/);
		assert.ok(fs.readdirSync(cacheDir).some((file) => file.endsWith(".json")));

		const promptReport = JSON.parse(
			runBundleDiffText([
				oldBundle,
				newBundle,
				"--json",
				"--focus",
				"prompts",
				"--prompt-export",
				promptDir,
			]),
		);
		assert.equal(promptReport.promptExport.filesScanned, 1);
		assert.ok(promptReport.promptExport.bundleOnlyPromptLike.length > 0);
		assert.ok(promptReport.sections.reminders.removed.length > 0);

		const bundleOnlyKinds = promptReport.promptExport.bundleOnlyPromptLike.map(
			(change: { kind: string }) => change.kind,
		);
		assert.ok(
			bundleOnlyKinds.includes("system-reminder"),
			`expected system-reminder in bundleOnlyPromptLike, got ${bundleOnlyKinds.join(", ")}`,
		);
	});
});

test("system reminder embedded in surrounding prose surfaces both reminder and remainder", {
	timeout: 15000,
}, () => {
	withBundleFixtures((oldBundle, newBundle) => {
		const report = runBundleDiffJson(oldBundle, newBundle);
		const addedReminders = report.added
			.filter((change: { kind: string }) => change.kind === "system-reminder")
			.map((change: { value: string }) => change.value);
		assert.ok(
			addedReminders.some((value: string) =>
				value.includes("Inner reminder body about review"),
			),
			`expected inner reminder among added system-reminders: ${addedReminders.join(" | ")}`,
		);
		const addedTextValues = report.added
			.filter(
				(change: { kind: string }) =>
					change.kind === "user-message" || change.kind === "literal",
			)
			.map((change: { value: string }) => change.value);
		assert.ok(
			addedTextValues.some(
				(value: string) =>
					value.includes("Pre-text guard sentence") &&
					value.includes("Post-text guard sentence") &&
					!value.includes("<system-reminder>"),
			),
			`expected reminder-stripped remainder among added text surfaces: ${addedTextValues.join(" | ")}`,
		);
	});
});

test("loadDiffConfig surfaces a clear error on malformed JSON", {
	timeout: 15000,
}, () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-diff-cfg-"));
	try {
		const oldBundle = path.join(tempDir, "old.js");
		const newBundle = path.join(tempDir, "new.js");
		const configPath = path.join(tempDir, "broken.json");
		fs.writeFileSync(oldBundle, 'const tool = { name: "Read" };\n');
		fs.writeFileSync(newBundle, 'const tool = { name: "Read" };\n');
		fs.writeFileSync(configPath, '{ "ignoreTokens": [unterminated\n');

		try {
			execFileSync(
				"bun",
				["src/diff.ts", oldBundle, newBundle, "--json", "--config", configPath],
				{ cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
			);
			assert.fail("expected diff CLI to exit non-zero on malformed config");
		} catch (error) {
			const err = error as { status: number; stderr?: string; stdout?: string };
			assert.notEqual(err.status, 0, "expected non-zero exit");
			const message = `${err.stderr ?? ""}${err.stdout ?? ""}`;
			assert.match(message, /Invalid JSON in bundle diff config/);
			assert.match(message, /broken\.json/);
		}
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("extractPatchAnchors captures multi-line backtick template literals", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "patch-anchor-"));
	try {
		const fixturePath = path.join(tempDir, "fake-patch.ts");
		fs.writeFileSync(
			fixturePath,
			[
				"export const STATIC_PROMPT: string = `Read files from the local filesystem.",
				"",
				"You can access any file directly by using this tool.",
				"",
				"Range parameter (for text files only, supported bat-style forms):",
				"- 30:40 - lines 30 to 40",
				"- 40: - line 40 to end of file`;",
				"",
				'const SHORT_ANCHOR = "Failed to set effort level";',
				'console.warn("Patch mutator: Could not find appendSystemPrompt flow to patch");',
				"function verify(): true | string {",
				'  return "Missing fallback from appendSubagentSystemPrompt to appendSystemPrompt";',
				"}",
				"",
				"export function noop(): void {}",
				"",
			].join("\n"),
		);

		const anchors = extractPatchAnchors(fixturePath);
		assert.ok(
			anchors.some((anchor) =>
				anchor.toLowerCase().includes("read files from the local filesystem"),
			),
			"expected the multi-line backtick prose to be captured as an anchor",
		);
		assert.ok(
			anchors.some((anchor) =>
				anchor.toLowerCase().includes("range parameter"),
			),
			"expected mid-template prose to be captured as an anchor",
		);
		assert.ok(
			anchors.some((anchor) =>
				anchor.toLowerCase().includes("failed to set effort level"),
			),
			"expected single-quoted string anchor to be captured",
		);
		assert.ok(
			!anchors.some((anchor) => anchor.includes("Could not find")),
			"expected patcher warning diagnostics to be skipped",
		);
		assert.ok(
			!anchors.some((anchor) => anchor.includes("Missing fallback")),
			"expected verifier failure diagnostics to be skipped",
		);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("patch relevance ignores rewritten surfaces when the anchor survives", {
	timeout: 15000,
}, () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "patch-drift-"));
	try {
		const oldBundle = path.join(tempDir, "old.js");
		const newBundle = path.join(tempDir, "new.js");
		fs.writeFileSync(
			oldBundle,
			[
				"// Version: 1.0.0",
				"const skill = `# Skill\\n\\n## When to Use WebFetch\\n\\nUse WebFetch to get the latest documentation when:\\n\\n- old case\\n`;",
				"",
			].join("\n"),
		);
		fs.writeFileSync(
			newBundle,
			[
				"// Version: 1.0.1",
				"const skill = `# Skill\\n\\nSome new guidance.\\n\\n## When to Use WebFetch\\n\\nUse WebFetch to get the latest documentation when:\\n\\n- new case\\n`;",
				"",
			].join("\n"),
		);

		const output = runBundleDiffText([
			oldBundle,
			newBundle,
			"--focus",
			"patches",
			"--limit",
			"20",
		]);
		assert.doesNotMatch(output, /tools-off/);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("matrix mode summarizes adjacent bundle changes", {
	timeout: 15000,
}, () => {
	withBundleFixtures((oldBundle, newBundle) => {
		const output = runBundleDiffText([
			"matrix",
			oldBundle,
			newBundle,
			"--markdown",
			"--limit",
			"20",
		]);
		assert.match(output, /^# Bundle Diff Matrix/);
		assert.match(output, /Latest-Only Additions/);
		assert.match(output, /purge \[path\]/);
	});
});
