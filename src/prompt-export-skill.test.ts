import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { runPromptExport } from "../scripts/export-prompts.js";

async function exportFixture(
	cliPath: string,
	outputDir: string,
): Promise<string> {
	const previousProfile = process.env.CLAUDE_PATCHER_PROFILE;
	const originalError = console.error;
	const originalLog = console.log;
	const stderr: string[] = [];
	process.env.CLAUDE_PATCHER_PROFILE = "1";
	console.error = (...args: unknown[]) => {
		stderr.push(args.map(String).join(" "));
	};
	console.log = () => {};
	try {
		await runPromptExport([
			process.execPath,
			"scripts/export-prompts.ts",
			cliPath,
			"--label",
			"fixture",
			"--output-dir",
			outputDir,
		]);
		return stderr.join("\n");
	} finally {
		console.error = originalError;
		console.log = originalLog;
		if (previousProfile === undefined) {
			delete process.env.CLAUDE_PATCHER_PROFILE;
		} else {
			process.env.CLAUDE_PATCHER_PROFILE = previousProfile;
		}
	}
}

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

		const stderr = await exportFixture(cliPath, outputDir);
		assert.match(stderr, /checkpoint=prompt-export\.analysis-released/);

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

test("prompt exporter resolves object properties returned by local helper calls", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "prompt-export-object-property-"),
	);
	const cliPath = path.join(tempDir, "cli.js");
	const outputDir = path.join(tempDir, "exported");
	try {
		await fs.writeFile(
			cliPath,
			`
function isFeatureEnabled() {
  return false;
}
function getFeatureStatus() {
  if (isFeatureEnabled()) {
    return { enabled: true, text: "The optional feature is available." };
  }
  return { enabled: false, text: "The optional feature is unavailable." };
}
function buildGuidePrompt() {
  const status = getFeatureStatus();
  return \`# Product guide

Session status: \${status.text}

Use the current product documentation when answering configuration questions.\`;
}
const builtInGuide = {
  agentType: "product-guide",
  getSystemPrompt: buildGuidePrompt,
};
`,
			"utf8",
		);

		await exportFixture(cliPath, outputDir);

		const prompt = await fs.readFile(
			path.join(outputDir, "agents", "product-guide.md"),
			"utf8",
		);
		assert.match(
			prompt,
			/Session status: The optional feature is unavailable\./,
		);
		assert.doesNotMatch(prompt, /\$\{value_/);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("prompt exporter resolves bindings from enclosing module initializers", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "prompt-export-module-bindings-"),
	);
	const cliPath = path.join(tempDir, "cli.js");
	const outputDir = path.join(tempDir, "exported");
	try {
		await fs.writeFile(
			cliPath,
			`
const initializeModule = setup(() => {
  const taskToolName = "TaskCreate";
  const shellToolName = "Bash";
  const agentToolName = "Agent";
  const agentToolPrompt = "Launch a new agent to handle complex, multi-step tasks. Use the current agent catalog and pass an explicit agent type when delegating work.";
  const apiScopeCorpus = "TRIGGER - read before opening the target file whenever the task is about an application that directly calls the Claude API or uses an Anthropic SDK. API request parameters, model IDs, pricing, limits, streaming, and tool use are in scope. DO NOT TRIGGER merely because a task mentions Claude Code or local session JSONL/transcripts. Client-only work remains out of scope unless API calls are involved.";
  const backgroundJobCorpus = "This session is a background job. The user may be live or away. A classifier reads only your message text, so narrate the work and restate important results. You should choose execution mode by intent, keep command output inspectable, and provide a self-contained completion summary after running a sanity check. Continue useful work while independent operations run.";

  function buildUsingTools(runtimeToolName) {
    return \`# Using your tools

Break down and manage your work with the \${taskToolName} tool.
Reserve \${shellToolName} for shell-only operations.
Use \${runtimeToolName} only when it is available in the current session.\`;
  }

  registerTool({
    name: agentToolName,
    prompt: () => agentToolPrompt,
    inputSchema: {},
  });

  registerSkill({
    name: "claude-api",
    getPromptForCommand() {
      return [{ type: "text", text: "Use the bundled API reference for this application integration task." }];
    },
  });

  registerSection(buildUsingTools);
});
initializeModule();
`,
			"utf8",
		);

		await exportFixture(cliPath, outputDir);

		const section = await fs.readFile(
			path.join(outputDir, "system", "sections", "using-your-tools.md"),
			"utf8",
		);
		assert.match(section, /TaskCreate tool/);
		assert.match(section, /Reserve Bash for shell-only operations/);
		assert.doesNotMatch(section, /\$\{runtimeToolName\}/);
		assert.match(section, /\$\{value_\d+\}/);

		const tool = await fs.readFile(
			path.join(outputDir, "tools", "builtin", "agent.md"),
			"utf8",
		);
		assert.match(
			tool,
			/Launch a new agent to handle complex, multi-step tasks/,
		);

		const skills = JSON.parse(
			await fs.readFile(path.join(outputDir, "skills.json"), "utf8"),
		) as Array<{ name: string; description: string | null }>;
		const skill = skills.find((candidate) => candidate.name === "claude-api");
		assert.ok(skill);
		assert.match(
			skill.description ?? "",
			/application that directly calls the Claude API or uses an Anthropic SDK/,
		);

		const backgroundJob = await fs.readFile(
			path.join(outputDir, "agents", "background-job.md"),
			"utf8",
		);
		assert.match(backgroundJob, /A classifier reads only your message text/);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});
