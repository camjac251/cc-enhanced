import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

test("prompt exporter resolves program bindings assigned by lazy initializers", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "prompt-export-skill-binding-"),
	);
	const cliPath = path.join(tempDir, "cli.js");
	const outputDir = path.join(tempDir, "exported");
	try {
		await fs.writeFile(
			cliPath,
			`
var skillDescription = "stale initializer";
const lazyInitializer = setup(() => {
  skillDescription = [
    "Reference for an application that directly calls the Claude API or uses an Anthropic SDK.",
    "DO NOT TRIGGER merely because a task mentions Claude Code or local session JSONL/transcripts.",
  ].join("\\n");
});
function registerBuiltInSkill() {
  addSkill({
    name: "claude-api",
    description: skillDescription,
    allowedTools: ["Read"],
    userInvocable: true,
    getPromptForCommand() {
      return [{ type: "text", text: "Use the bundled API reference for this application integration task." }];
    },
  });
}
`,
			"utf8",
		);

		const result = spawnSync(
			process.execPath,
			[
				"scripts/export-prompts.ts",
				cliPath,
				"--label",
				"fixture",
				"--output-dir",
				outputDir,
			],
			{
				cwd: repoRoot,
				encoding: "utf8",
				env: { ...process.env, CLAUDE_PATCHER_PROFILE: "1" },
			},
		);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stderr, /checkpoint=prompt-export\.analysis-released/);

		const skills = JSON.parse(
			await fs.readFile(path.join(outputDir, "skills.json"), "utf8"),
		) as Array<{ name: string; description: string | null }>;
		const skill = skills.find((candidate) => candidate.name === "claude-api");
		assert.ok(skill);
		assert.match(
			skill.description ?? "",
			/application that directly calls the Claude API or uses an Anthropic SDK/,
		);
		assert.match(
			skill.description ?? "",
			/Claude Code or local session JSONL\/transcripts/,
		);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});
