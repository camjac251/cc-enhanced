import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	PROMPT_SURFACE_RULES,
	type PromptSurfaceRule,
} from "./prompt-surface-rules.js";
import { verifyPromptSurfaces } from "./verify-prompt-surfaces.js";

async function writeSurface(
	root: string,
	relativePath: string,
	content: string,
): Promise<void> {
	const fullPath = path.join(root, relativePath);
	await fs.mkdir(path.dirname(fullPath), { recursive: true });
	await fs.writeFile(fullPath, content, "utf8");
}

async function createValidSurfaceFixture(root: string): Promise<void> {
	for (const rule of PROMPT_SURFACE_RULES) {
		await writeSurface(root, rule.file, validContentForRule(rule));
	}
}

async function createValidRequiredSurfaceFixture(root: string): Promise<void> {
	for (const rule of PROMPT_SURFACE_RULES) {
		if (rule.presence === "optional") continue;
		await writeSurface(root, rule.file, validContentForRule(rule));
	}
}

function validContentForRule(rule: PromptSurfaceRule): string {
	return [
		`# Fixture for ${rule.file}`,
		"Resolved prompt content.",
		...(rule.required ?? []).map((required) => required.needle),
	].join("\n");
}

function ruleFor(file: string): PromptSurfaceRule {
	const rule = PROMPT_SURFACE_RULES.find(
		(candidate) => candidate.file === file,
	);
	assert.ok(rule, `missing prompt surface rule for ${file}`);
	return rule;
}

function contentWithForbiddenNeedles(file: string): string {
	const rule = ruleFor(file);
	return [
		validContentForRule(rule),
		...(rule.forbidden ?? []).map((forbidden) => forbidden.needle),
	].join("\n");
}

test("verifyPromptSurfaces reports unreadable surface files", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "verify-prompt-surfaces-missing-"),
	);
	try {
		const result = await verifyPromptSurfaces({ exportDir: tempDir });
		assert.equal(result.ok, false);
		assert.ok(
			result.failures.some((failure) => failure.id === "surface-not-readable"),
		);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("verifyPromptSurfaces rejects dynamic Read prompt exports", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "verify-prompt-surfaces-dynamic-read-"),
	);
	try {
		await createValidSurfaceFixture(tempDir);
		await writeSurface(
			tempDir,
			"tools/builtin/read.md",
			"# Tool: Read\n\n## Prompt\n\n(Dynamic prompt: not statically resolved from cli.js AST.)",
		);
		const result = await verifyPromptSurfaces({ exportDir: tempDir });
		assert.equal(result.ok, false);
		assert.ok(
			result.failures.some(
				(failure) => failure.id === "surface-dynamic-prompt",
			),
		);
		assert.ok(result.failures.some((failure) => failure.id === "read-range"));
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("verifyPromptSurfaces passes for patched live prompt surfaces", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "verify-prompt-surfaces-valid-"),
	);
	try {
		await createValidSurfaceFixture(tempDir);
		await writeSurface(
			tempDir,
			"system/sections/session-specific-guidance.md",
			[
				validContentForRule(
					ruleFor("system/sections/session-specific-guidance.md"),
				),
				"spawn Agent with subagent_type=${agent.explore.agentType}",
			].join("\n"),
		);
		const result = await verifyPromptSurfaces({ exportDir: tempDir });
		assert.equal(result.ok, true);
		assert.deepEqual(result.failures, []);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("verifyPromptSurfaces allows intentionally disabled optional surfaces to be absent", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "verify-prompt-surfaces-optional-absent-"),
	);
	try {
		await createValidRequiredSurfaceFixture(tempDir);
		const result = await verifyPromptSurfaces({ exportDir: tempDir });
		assert.equal(result.ok, true);
		assert.deepEqual(result.failures, []);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("verifyPromptSurfaces rejects Unicode dash punctuation in exported prompt markdown", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "verify-prompt-surfaces-dash-style-"),
	);
	try {
		await createValidSurfaceFixture(tempDir);
		await writeSurface(
			tempDir,
			"tools/builtin/bash.md",
			"# Tool: Bash\n\n## Prompt\n\nUse Bash for shell-only operations — do not use it as a prose style example.",
		);
		await writeSurface(
			tempDir,
			"scratch/en-dash.md",
			"Read the most recent 1–3 days before deciding.",
		);

		const result = await verifyPromptSurfaces({ exportDir: tempDir });
		assert.equal(result.ok, false);
		const dashFailures = result.failures.filter(
			(failure) => failure.id === "surface-unicode-dash-style",
		);
		assert.equal(dashFailures.length, 2);
		assert.ok(
			dashFailures.some(
				(failure) =>
					failure.file === "tools/builtin/bash.md" &&
					failure.reason.includes("em dash"),
			),
		);
		assert.ok(
			dashFailures.some(
				(failure) =>
					failure.file === "scratch/en-dash.md" &&
					failure.reason.includes("en dash"),
			),
		);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("verifyPromptSurfaces rejects legacy live prompt guidance", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "verify-prompt-surfaces-legacy-"),
	);
	try {
		await createValidSurfaceFixture(tempDir);
		await writeSurface(
			tempDir,
			"tools/builtin/read.md",
			[
				validContentForRule(ruleFor("tools/builtin/read.md")),
				"You can optionally specify a line offset and limit",
				"Results are returned using cat -n format",
			].join("\n"),
		);
		await writeSurface(
			tempDir,
			"agents/claude-code-guide.md",
			contentWithForbiddenNeedles("agents/claude-code-guide.md"),
		);
		await writeSurface(
			tempDir,
			"agents/explore.md",
			[
				contentWithForbiddenNeedles("agents/explore.md"),
				"${value_22}",
				"${...conditional(array(2) | array(0))}",
				"npm view ${object.PACKAGE_URL}@${value_1} version",
			].join("\n"),
		);
		await writeSurface(
			tempDir,
			"agents/plan.md",
			[
				validContentForRule(ruleFor("agents/plan.md")),
				"Find existing patterns using ${conditional(template | template)}",
				"Then inspect ${value_22} for drift",
			].join("\n"),
		);
		await writeSurface(
			tempDir,
			"tools/builtin/repl.md",
			contentWithForbiddenNeedles("tools/builtin/repl.md"),
		);
		await writeSurface(
			tempDir,
			"tools/builtin/toolsearch.md",
			contentWithForbiddenNeedles("tools/builtin/toolsearch.md"),
		);
		await writeSurface(
			tempDir,
			"system/reminders/you-re-running-in-a-remote-planning-session-the-user-trigge.md",
			contentWithForbiddenNeedles(
				"system/reminders/you-re-running-in-a-remote-planning-session-the-user-trigge.md",
			),
		);
		await writeSurface(
			tempDir,
			"system/sections/session-specific-guidance.md",
			contentWithForbiddenNeedles(
				"system/sections/session-specific-guidance.md",
			),
		);
		await writeSurface(
			tempDir,
			"system/sections/dream-memory-consolidation.md",
			contentWithForbiddenNeedles(
				"system/sections/dream-memory-consolidation.md",
			),
		);
		await writeSurface(
			tempDir,
			"system/sections/dream-memory-pruning.md",
			contentWithForbiddenNeedles("system/sections/dream-memory-pruning.md"),
		);

		const result = await verifyPromptSurfaces({ exportDir: tempDir });
		assert.equal(result.ok, false);
		assert.ok(
			result.failures.some((failure) => failure.id === "read-offset-limit"),
		);
		assert.ok(result.failures.some((failure) => failure.id === "read-cat-n"));
		assert.ok(
			result.failures.some((failure) => failure.id === "guide-webfetch"),
		);
		assert.ok(
			result.failures.some((failure) => failure.id === "explore-placeholder"),
		);
		assert.ok(
			result.failures.some(
				(failure) => failure.id === "surface-unresolved-value",
			),
		);
		assert.ok(
			result.failures.some(
				(failure) => failure.id === "surface-unresolved-spread",
			),
		);
		assert.ok(
			result.failures.some((failure) => failure.id === "explore-stray-command"),
		);
		assert.ok(
			result.failures.some(
				(failure) => failure.id === "plan-broken-helper-render",
			),
		);
		assert.ok(
			result.failures.some(
				(failure) => failure.id === "plan-unresolved-placeholder",
			),
		);
		assert.ok(
			result.failures.some((failure) => failure.id === "repl-glob-example"),
		);
		assert.ok(
			result.failures.some(
				(failure) => failure.id === "toolsearch-grep-select-example",
			),
		);
		assert.ok(
			result.failures.some(
				(failure) => failure.id === "remote-planning-glob-grep-read",
			),
		);
		assert.ok(
			result.failures.some(
				(failure) => failure.id === "session-find-grep-helper",
			),
		);
		assert.ok(
			result.failures.some(
				(failure) => failure.id === "dream-memory-grep-transcripts",
			),
		);
		assert.ok(
			result.failures.some((failure) => failure.id === "dream-memory-find-md"),
		);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});
