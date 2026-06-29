import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildPatchRelevance, extractPatchAnchors } from "./diff.js";

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
			'const tool = { name: "Inspect", description: "Inspect records" };',
			'const oldCommand = { command: "fixture-mode-enforce", description: "In fixture mode you must call NotifyOperator" };',
			'persist("fixtureSettings", { modeLevel: "medium" });',
			"const oldReminder = `<system-reminder>Whenever you inspect a record, review it before editing.</system-reminder>`;",
			'console.log("[legacy-channel] client socket error: ${}");',
			'console.log("[legacy-channel] cert fetch ${}; proxy disabled");',
			'console.log("fixture-app/1.0.0");',
			"",
		].join("\n"),
	);
	fs.writeFileSync(
		newBundle,
		[
			"// Version: 1.0.1",
			'const tool = { name: "Inspect", description: "Inspect records" };',
			'const added = { name: "Archive", description: "Archive fixture state" };',
			'console.log("archive [target]");',
			'console.log("--dry-run");',
			'console.log("FIXTURE_SERVICE_STATE");',
			'persist("fixtureSettings", { modeLevel: "high" });',
			'persist("fixtureSettings", { modeLevel: undefined });',
			'console.log("[modern-channel] client socket error: ${}");',
			'console.log("[modern-channel] cert fetch ${}; proxy disabled");',
			'app.command("control-plane").description("Run the fixture control service").requiredOption("--config <path>", "Path to fixture config");',
			'const group = app.command("group").description("Configure fixture groups");',
			'group.command("child").description("Start the fixture child service");',
			'if (pathname === "/status/live" && req.method === "GET") respond("ok");',
			'const fixtureRoutes = { "/api/events": "events" };',
			'const runtimeRoutes = ["/v1/logs", "/v1/workflows", "/readyz"];',
			'router.post("/tasks", taskHandler);',
			'const routes = [{ method: "GET", path: "/live" }];',
			'const storage = { filePath: "/tmp/cache" };',
			'const deployHelp = { description: "Deploy the fixture service" };',
			'console.log("deploy <env>");',
			"sql`CREATE TABLE quota_rules (id TEXT PRIMARY KEY)`;",
			"sql`CREATE INDEX quota_rules_updated_at ON quota_rules (updated_at)`;",
			"const newReminder = `<system-reminder>Brand new reminder added in 1.0.1 about file editing review.</system-reminder>`;",
			'const wrapped = "Pre-text guard sentence <system-reminder>Inner reminder body about review.</system-reminder> Post-text guard sentence";',
			'console.log("fixture-app/1.0.1");',
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

		assert.ok(added.includes("object-label:name=Archive"));
		assert.ok(added.includes("cli-flag:--dry-run"));
		assert.ok(added.includes("env-var:FIXTURE_SERVICE_STATE"));
		assert.ok(!added.some((value: string) => value.includes("1.0.1")));

		const addedCommands = report.sections.commands.added.map(
			(change: { value: string }) => change.value,
		);
		assert.ok(addedCommands.includes("archive [target]"));
		assert.ok(
			report.prefixRewrites.some(
				(rewrite: { oldPrefix: string; newPrefix: string }) =>
					rewrite.oldPrefix === "legacy-channel" &&
					rewrite.newPrefix === "modern-channel",
			),
		);
		assert.ok(
			report.removedCapabilities.some(
				(candidate: { token: string }) => candidate.token === "fixture",
			),
		);
		const inventory = report.inventory.added.map(
			(change: { kind: string; value: string }) =>
				`${change.kind}:${change.value}`,
		);
		assert.ok(inventory.includes("commands:control-plane"));
		assert.ok(inventory.includes("commands:group"));
		assert.ok(inventory.includes("commands:group child"));
		assert.ok(inventory.includes("routes:/status/live"));
		assert.ok(inventory.includes("routes:/api/events"));
		assert.ok(inventory.includes("routes:/readyz"));
		assert.ok(inventory.includes("routes:/tasks"));
		assert.ok(inventory.includes("routes:/live"));
		assert.ok(!inventory.includes("routes:/tmp/cache"));
		assert.ok(inventory.includes("sqlTables:quota_rules"));
		assert.ok(inventory.includes("sqlIndexes:quota_rules_updated_at"));

		const featureSummaries = report.releaseSummary.features.map(
			(item: { title: string }) => item.title,
		);
		assert.ok(featureSummaries.includes("Command added: control-plane"));
		assert.ok(
			featureSummaries.includes("Command candidate added: deploy <env>"),
		);
		assert.ok(
			featureSummaries.some((title: string) =>
				title.includes("API routes added: /api/events"),
			),
		);
		assert.ok(
			featureSummaries.some((title: string) =>
				title.includes("API routes added: /api/events, /v1/workflows"),
			),
		);
		assert.ok(
			!featureSummaries.some(
				(title: string) =>
					title.includes("API routes added") && title.includes("/v1/logs"),
			),
			"expected telemetry route to stay out of generic API summary",
		);
		const infrastructureSummaries = report.releaseSummary.infrastructure.map(
			(item: { title: string }) => item.title,
		);
		assert.ok(
			infrastructureSummaries.some((title: string) =>
				title.includes("Telemetry ingestion routes added: /v1/logs"),
			),
		);
		assert.ok(
			infrastructureSummaries.some((title: string) =>
				title.includes("SQL schema added: quota_rules"),
			),
		);
		assert.ok(
			infrastructureSummaries.some((title: string) =>
				title.includes("Health/readiness/protocol routes added"),
			),
		);

		const settingsWrites = report.sections.settings.countChanged.map(
			(change: { value: string; delta: number }) =>
				`${change.value}:${change.delta}`,
		);
		assert.ok(settingsWrites.includes("fixtureSettings.modeLevel:1"));
		const removedReminders = report.sections.reminders.removed.map(
			(change: { value: string }) => change.value,
		);
		assert.ok(
			removedReminders.some((value: string) =>
				value.includes("Whenever you inspect a record"),
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
		fs.writeFileSync(path.join(promptDir, "live.md"), "Inspect records\n");
		fs.writeFileSync(
			configPath,
			JSON.stringify({
				ignoreTokens: ["ignore-me"],
				highSignalTokens: ["control"],
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
		assert.match(markdown, /archive \[target\]/);
		assert.ok(fs.readdirSync(cacheDir).some((file) => file.endsWith(".json")));

		const inventory = runBundleDiffText([
			oldBundle,
			newBundle,
			"--focus",
			"inventory",
			"--limit",
			"20",
		]);
		assert.match(inventory, /Semantic inventory/);
		assert.match(inventory, /control-plane/);
		assert.match(inventory, /quota_rules/);

		const release = runBundleDiffText([
			oldBundle,
			newBundle,
			"--focus",
			"release",
			"--limit",
			"20",
		]);
		assert.match(release, /Release summary/);
		assert.match(release, /Command added: control-plane/);
		assert.match(release, /SQL schema added: quota_rules/);
		assert.doesNotMatch(release, /Semantic inventory/);

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
		fs.writeFileSync(oldBundle, 'const tool = { name: "Inspect" };\n');
		fs.writeFileSync(newBundle, 'const tool = { name: "Inspect" };\n');
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
				"export const STATIC_PROMPT: string = `Inspect fixture records.",
				"",
				"Use this tool for direct fixture access.",
				"",
				"Range parameter (for text files only, supported bat-style forms):",
				"- 30:40 - lines 30 to 40",
				"- 40: - line 40 to end of file`;",
				"",
				'const SHORT_ANCHOR = "Failed to set fixture level";',
				'console.warn("Patch mutator: Could not find fixture prompt flow to patch");',
				"function verify(): true | string {",
				'  return "Missing fallback from fixture child prompt to fixture parent prompt";',
				"}",
				"",
				"export function noop(): void {}",
				"",
			].join("\n"),
		);

		const anchors = extractPatchAnchors(fixturePath);
		assert.ok(
			anchors.some((anchor) =>
				anchor.toLowerCase().includes("inspect fixture records"),
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
				anchor.toLowerCase().includes("failed to set fixture level"),
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
		const patchPath = path.join(tempDir, "synthetic-anchor.ts");
		fs.writeFileSync(
			patchPath,
			'export const FIXTURE_ANCHOR = "Durable fixture heading";\n',
		);

		const context = {
			line: 1,
			usage: "string",
			ast: "Program > StringLiteral",
			objectLabels: [],
		};
		const removed = {
			kind: "user-message",
			value: "Durable fixture heading with old wording",
			count: 1,
			contexts: [context],
			delta: -1,
		};
		const added = {
			kind: "user-message",
			value: "Durable fixture heading with new wording",
			count: 1,
			contexts: [context],
			delta: 1,
		};

		assert.deepEqual(
			buildPatchRelevance([added] as any, [removed] as any, [], [], tempDir),
			[],
		);
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
		assert.match(output, /archive \[target\]/);
	});
});
