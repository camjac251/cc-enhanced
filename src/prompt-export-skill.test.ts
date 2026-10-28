import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { runPromptExport } from "../scripts/export-prompts.js";
import { BUN_TRAILER, SIZEOF_MODULE_NEW } from "./bun-format.js";
import { buildPromptDatasetFilename } from "./prompt-corpus.js";

async function exportFixture(
	cliPath: string | undefined,
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
			...(cliPath === undefined ? [] : [cliPath]),
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

test("prompt exporter extracts all JavaScript modules from an explicit native binary", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "prompt-export-native-input-"),
	);
	const modules = [
		{
			name: "/virtual/cli.js",
			contents:
				'import { stockPrompt } from "./prompts.js"; registerSection(stockPrompt);',
		},
		{
			name: "/virtual/prompts.js",
			contents:
				'export function stockPrompt() { return "# Native stock policy\\n\\nPreserve this complete instruction from the stock dependency module."; }',
		},
		{
			name: "/virtual/lazy-prompts.js",
			contents:
				'export function lazyPrompt() { return "# Lazy stock policy\\n\\nPreserve this stock instruction even when its module is not imported by the entry point."; }',
		},
	];
	const chunks: Buffer[] = [];
	let length = 0;
	const append = (content: string) => {
		const buffer = Buffer.from(content);
		const pointer = { offset: length, length: buffer.length };
		chunks.push(buffer);
		length += buffer.length;
		return pointer;
	};
	const modulePointers = modules.map((module) => ({
		name: append(module.name),
		contents: append(module.contents),
	}));
	const moduleTableOffset = length;
	const moduleTable = Buffer.alloc(modules.length * SIZEOF_MODULE_NEW);
	for (const [index, pointers] of modulePointers.entries()) {
		const moduleOffset = index * SIZEOF_MODULE_NEW;
		moduleTable.writeUInt32LE(pointers.name.offset, moduleOffset);
		moduleTable.writeUInt32LE(pointers.name.length, moduleOffset + 4);
		moduleTable.writeUInt32LE(pointers.contents.offset, moduleOffset + 8);
		moduleTable.writeUInt32LE(pointers.contents.length, moduleOffset + 12);
		moduleTable.writeUInt8(1, moduleOffset + 49);
		moduleTable.writeUInt8(2, moduleOffset + 50);
	}
	chunks.push(moduleTable);
	length += moduleTable.length;
	const offsets = Buffer.alloc(32);
	offsets.writeBigUInt64LE(BigInt(length), 0);
	offsets.writeUInt32LE(moduleTableOffset, 8);
	offsets.writeUInt32LE(moduleTable.length, 12);
	const binary = Buffer.concat([
		Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
		...chunks,
		offsets,
		BUN_TRAILER,
		Buffer.alloc(8),
	]);
	try {
		const binaryPath = path.join(tempDir, "claude");
		const outputDir = path.join(tempDir, "exported");
		await fs.writeFile(binaryPath, binary);
		assert.doesNotMatch(
			await exportFixture(binaryPath, outputDir),
			/Failed to export prompts/,
		);
		for (const slug of ["native-stock-policy", "lazy-stock-policy"]) {
			const section = await fs.readFile(
				path.join(outputDir, "system", "sections", `${slug}.md`),
				"utf8",
			);
			assert.match(section, /Preserve this.*stock/);
		}
		const manifest = JSON.parse(
			await fs.readFile(path.join(outputDir, "manifest.json"), "utf8"),
		);
		await assert.rejects(fs.access(manifest.inputCliPath));
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

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
  const runtimeToolName = "/wrong/outer/value";
  const agentToolName = "Agent";
  function unrelatedFactory() {
    const agentToolName = () => true;
    return agentToolName;
  }
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

test("prompt exporter bounds generated section filenames for long headings", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "prompt-export-long-heading-"),
	);
	const cliPath = path.join(tempDir, "cli.js");
	const outputDir = path.join(tempDir, "exported");
	const longHeading = `# ${"long-heading-segment-".repeat(20)}end`;
	const body =
		"Keep the complete section body available after export so the generated artifact remains usable.";
	try {
		await fs.writeFile(
			cliPath,
			`function buildLongSection() { return ${JSON.stringify(`${longHeading}\n\n${body}`)}; }\nregisterSection(buildLongSection);\n`,
			"utf8",
		);

		const stderr = await exportFixture(cliPath, outputDir);
		assert.doesNotMatch(stderr, /Failed to export prompts/);

		const sectionFiles = await fs.readdir(
			path.join(outputDir, "system", "sections"),
		);
		assert.equal(sectionFiles.length, 1);
		const [sectionFilename] = sectionFiles;
		assert.ok(sectionFilename);
		assert.ok(Buffer.byteLength(sectionFilename, "utf8") <= 255);

		const exportedSection = await fs.readFile(
			path.join(outputDir, "system", "sections", sectionFilename),
			"utf8",
		);
		assert.ok(exportedSection.includes(longHeading));
		assert.ok(exportedSection.includes(body));
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("prompt export requires an explicit input", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "prompt-export-explicit-input-"),
	);
	const outputDir = path.join(tempDir, "exported");
	const previousExitCode = process.exitCode ?? 0;
	try {
		const stderr = await exportFixture(undefined, outputDir);
		assert.equal(process.exitCode, 1);
		assert.match(
			stderr,
			/An explicit stock version, cli\.js path, or native binary path is required/,
		);
		await assert.rejects(fs.access(outputDir));
	} finally {
		process.exitCode = previousExitCode;
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

for (const mode of [
	"!0",
	"!1",
	"runtimeMode()",
	"reassigned",
	"reassigned-function",
	"reassigned-declaration",
] as const) {
	test(`tool prompt inventories preserve only reachable guidance for ${mode}`, async () => {
		const tempDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "prompt-export-conditional-guidance-"),
		);
		try {
			const cliPath = path.join(tempDir, "cli.js");
			const outputDir = path.join(tempDir, "exported");
			const binding =
				mode === "reassigned"
					? "let enabled = !0; if (runtimeReassignment()) enabled = false;"
					: mode === "reassigned-function"
						? "let gate = () => true; if (runtimeReassignment()) gate = () => false; const enabled = gate();"
						: mode === "reassigned-declaration"
							? "function gate() { return true; } if (runtimeReassignment()) gate = () => false; const enabled = gate();"
							: `const enabled = ${mode};`;
			await fs.writeFile(
				cliPath,
				`
const toolName = runtimeName() ? "Bash" : "OtherShell";
function buildPrompt() {
  ${binding}
  function unrelated() { let enabled = !1; enabled = !0; }
  return [
    "Executes a command and returns its output.",
    ...(enabled
      ? ["Use the active command policy for this operation."]
      : ["Use the inactive command policy for this operation."]),
  ].join("\\n");
}
const tool = { name: toolName, inputSchema: {}, prompt: buildPrompt };
`,
			);
			await exportFixture(cliPath, outputDir);
			const prompt = await fs.readFile(
				path.join(outputDir, "tools", "builtin", "bash.md"),
				"utf8",
			);
			assert.equal(
				prompt.includes("Use the active command policy"),
				mode !== "!1",
			);
			assert.equal(
				prompt.includes("Use the inactive command policy"),
				mode !== "!0",
			);
			const unresolved = mode !== "!0" && mode !== "!1";
			assert.equal(
				prompt.includes("## Conditional prompt variants"),
				unresolved,
			);
			assert.doesNotMatch(prompt, /OtherShell/);
			if (unresolved) {
				assert.match(prompt, /condition_\d+: true/);
				assert.match(prompt, /condition_\d+: false/);
			}
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
}

test("tool prompt inventories label returned alternatives without publishing scalar fragments", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "prompt-export-returned-variants-"),
	);
	try {
		const cliPath = path.join(tempDir, "cli.js");
		const outputDir = path.join(tempDir, "exported");
		await fs.writeFile(
			cliPath,
			'function buildPrompt() {\n const phrase = runtimePhrase() ? "focused structural and lexical lookup tools" : "the alternate structured lookup toolset";\n return runtimeMode() ? `Use ${phrase} for this investigation.` : "Use the direct file tools for this investigation.";\n}\nconst tool = { name: "Bash", inputSchema: {}, prompt: () => buildPrompt() };\n',
		);
		await exportFixture(cliPath, outputDir);
		const prompt = await fs.readFile(
			path.join(outputDir, "tools", "builtin", "bash.md"),
			"utf8",
		);
		assert.match(
			prompt,
			/Use focused structural and lexical lookup tools for this investigation\./,
		);
		assert.match(prompt, /Use the direct file tools for this investigation\./);
		assert.doesNotMatch(
			prompt,
			/^focused structural and lexical lookup tools$|^the alternate structured lookup toolset$/m,
		);
		assert.equal(
			prompt.match(/^### condition_\d+: (?:true|false)$/gm)?.length,
			2,
		);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("tool prompt inventories keep nested runtime guidance without inventing static branches", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "prompt-export-nested-guidance-"),
	);
	try {
		const cliPath = path.join(tempDir, "cli.js");
		const outputDir = path.join(tempDir, "exported");
		await fs.writeFile(
			cliPath,
			'function specializedPolicy() { return null; }\nfunction buildPrompt() {\n  const special = specializedPolicy();\n  return ["Executes a command and returns its output.", ...(special !== null\n    ? ["Unreachable specialized command instructions."]\n    : runtimeTrimmed()\n      ? ["Communication: Output text directly."]\n      : [`Read files with Read; search with dedicated tools; write with Write. Path: ${runtimePath()}.`]),\n    ...(runtimeSecondPolicy() ? ["Prefer separate commands for independent checks."] : ["Combine related commands when their output is bounded."])\n  ].join("\\n");\n}\nconst tool = {name:"Bash",inputSchema:{},prompt:buildPrompt};\n',
		);
		await exportFixture(cliPath, outputDir);
		const prompt = await fs.readFile(
			path.join(outputDir, "tools", "builtin", "bash.md"),
			"utf8",
		);
		assert.match(prompt, /Communication: Output text directly/);
		assert.match(
			prompt,
			/Read files with Read; search with dedicated tools; write with Write/,
		);
		assert.match(prompt, /Path: \$\{value_\d+\(\)\}/);
		assert.doesNotMatch(prompt, /Unreachable specialized command instructions/);
		assert.equal(
			prompt.match(/^### condition_\d+: (?:true|false)$/gm)?.length,
			4,
		);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("prompt helper parameters and uninitialized locals shadow unrelated numeric bindings", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "prompt-export-runtime-bindings-"),
	);
	try {
		const cliPath = path.join(tempDir, "cli.js");
		const outputDir = path.join(tempDir, "exported");
		await fs.writeFile(
			cliPath,
			'const budgetNote = 80, unavailable = 81, localNote = 82;\nfunction budgetPrompt({ budgetNote }, unavailable) {\n  let localNote;\n  return `Launch an agent for an independent task. Budget: ${budgetNote}. Missing: ${unavailable}. Local: ${localNote}.`;\n}\nconst tool = { name: "Agent", inputSchema: {}, prompt({ budgetNote }) { return budgetPrompt({ budgetNote }); } };\n',
		);
		await exportFixture(cliPath, outputDir);
		const prompt = await fs.readFile(
			path.join(outputDir, "tools", "builtin", "agent.md"),
			"utf8",
		);
		assert.match(
			prompt,
			/Budget: \$\{value_\d+\}\. Missing: \$\{value_\d+\}\. Local: \$\{value_\d+\}\./,
		);
		assert.doesNotMatch(prompt, /\b(?:80|81|82)\b/);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("prompt export retains optional guidance with unresolved runtime values", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "prompt-export-optional-guidance-"),
	);
	const cliPath = path.join(tempDir, "cli.js");
	const outputDir = path.join(tempDir, "exported");
	try {
		await fs.writeFile(
			cliPath,
			'function backgroundGuidance() {\n  if (disabled()) return null;\n  return `Wait for completion notifications; inspect saved output by range. Timeout: ${runtimeBudget()}.`;\n}\nfunction buildBackgroundPolicy() {\n  const optional = backgroundGuidance();\n  return ["# Background behavior", ...(optional !== null ? [optional] : []), ...(false ? ["Disabled branch policy"] : [])].join("\\n");\n}\nconst agent = {agentType:"background-policy",getSystemPrompt:buildBackgroundPolicy};\n',
		);
		await exportFixture(cliPath, outputDir);
		const section = await fs.readFile(
			path.join(outputDir, "agents", "background-policy.md"),
			"utf8",
		);
		assert.match(
			section,
			/Wait for completion notifications; inspect saved output by range/,
		);
		assert.doesNotMatch(section, /Disabled branch policy/);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("section exports do not publish interpolated local fragments as standalone instructions", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "prompt-export-fragments-"),
	);
	try {
		const cliPath = path.join(tempDir, "cli.js");
		const outputDir = path.join(tempDir, "exported");
		await fs.writeFile(
			cliPath,
			'function section() {\n const searchPhrase = enabled() ? "focused structural and lexical lookup tools" : "the alternate structured lookup toolset";\n const standalone = "Keep this standalone policy as a complete section instruction.";\n return ["# Fragment fixture", `Use ${searchPhrase} for this investigation.`, standalone].join("\\n");\n}\n',
		);
		await exportFixture(cliPath, outputDir);
		const section = await fs.readFile(
			path.join(outputDir, "system", "sections", "fragment-fixture.md"),
			"utf8",
		);
		assert.match(
			section,
			/Use focused structural and lexical lookup tools for this investigation\./,
		);
		assert.doesNotMatch(
			section,
			/^focused structural and lexical lookup tools$|^the alternate structured lookup toolset$/m,
		);
		assert.match(
			section,
			/Keep this standalone policy as a complete section instruction\./,
		);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

const AUTO_MODE_EXPORT_FIXTURE =
	'const shellTool="Bash", readTool="Read", editTool="Edit", writeTool="Write";\nfunction renderAutoMode(e) {\nswitch (e.type) {\ncase "auto_mode": {\nconst strict = `Do your work through the ${shellTool} tool wherever it can accomplish the job: read files with cat, head, or sed -n, search with grep and find, and make file changes with sed, heredocs, or short scripts, rather than using the dedicated ${readTool}, ${editTool}, or ${writeTool} tools. Fall back to a dedicated tool only when ${shellTool} genuinely cannot do the job.`;\nconst relaxed = `You can do much of your work through the ${shellTool} tool when it is the simpler route: read files with cat, head, or sed -n, search with grep and find, and make small, mechanical file changes with sed, heredocs, or short scripts instead of the dedicated ${readTool}, ${editTool}, or ${writeTool} tools. The choice is yours: prefer ${editTool} or ${writeTool} when a shell edit would be fragile, such as exact or multi-line replacements, or sed/awk flags that differ between GNU and BSD/macOS.`;\nconst selected = e.bashFirstSteer === "relaxed" ? relaxed : strict;\nreturn e.bypass ? `While bypass permissions mode is active:\\n\\n${selected}` : e.steerOnly ? `While auto mode is active:\\n\\n${selected}` : "## Auto mode\\n\\nKeep working. Ask for consent before publishing.\\n\\n" + (e.bashFirst ? selected : "");\n}\n}\n}';

test("attachment exports preserve stock guidance", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "prompt-export-attachments-"),
	);
	try {
		const cliPath = path.join(tempDir, "cli.js");
		const outputDir = path.join(tempDir, "exported");
		await fs.writeFile(cliPath, AUTO_MODE_EXPORT_FIXTURE);
		assert.doesNotMatch(
			await exportFixture(cliPath, outputDir),
			/Failed to export prompts/,
		);
		const attachment = await fs.readFile(
			path.join(outputDir, "system/attachments/auto-mode-shell-guidance.md"),
			"utf8",
		);
		const corpus = await fs.readFile(
			path.join(outputDir, "prompt-corpus.json"),
			"utf8",
		);
		const dataset = await fs.readFile(
			path.join(outputDir, buildPromptDatasetFilename("fixture")),
			"utf8",
		);
		const manifest = JSON.parse(
			await fs.readFile(path.join(outputDir, "manifest.json"), "utf8"),
		);
		assert.equal(manifest.counts.autoModeShellGuidance, 2);
		assert.equal(Object.hasOwn(manifest, "bundledMods"), false);
		for (const text of [attachment, corpus, dataset]) {
			assert.match(text, /Do your work through the/);
			assert.match(text, /You can do much of your work through the/);
			assert.match(text, /read files with cat, head, or sed -n/);
		}
		assert.doesNotMatch(attachment, /\$\{(?:value|expr)_/);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("attachment export does not manufacture missing stock guidance", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "prompt-export-attachment-missing-"),
	);
	try {
		const cliPath = path.join(tempDir, "cli.js");
		const outputDir = path.join(tempDir, "exported");
		await fs.writeFile(
			cliPath,
			'function render(e) { switch (e.type) { case "auto_mode": return "Consent guidance with no shell steering."; } }',
		);
		assert.doesNotMatch(
			await exportFixture(cliPath, outputDir),
			/Failed to export prompts/,
		);
		await assert.rejects(
			fs.access(
				path.join(outputDir, "system/attachments/auto-mode-shell-guidance.md"),
			),
		);
		const manifest = JSON.parse(
			await fs.readFile(path.join(outputDir, "manifest.json"), "utf8"),
		);
		assert.equal(manifest.counts.autoModeShellGuidance, 0);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("attachment export preserves drifted wording and excludes unrelated attachment types", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "prompt-export-attachment-drift-"),
	);
	try {
		const cliPath = path.join(tempDir, "cli.js");
		const outputDir = path.join(tempDir, "exported");
		const source = AUTO_MODE_EXPORT_FIXTURE.replaceAll(
			"read files with cat, head, or sed -n",
			"read files with new utilities",
		);
		await fs.writeFile(cliPath, source);
		await exportFixture(cliPath, outputDir);
		const attachment = await fs.readFile(
			path.join(outputDir, "system/attachments/auto-mode-shell-guidance.md"),
			"utf8",
		);
		assert.match(attachment, /read files with new utilities/);
		assert.doesNotMatch(attachment, /read files with cat, head, or sed -n/);
		await fs.writeFile(
			cliPath,
			AUTO_MODE_EXPORT_FIXTURE.replace(
				'case "auto_mode"',
				'case "custom_context"',
			),
		);
		await exportFixture(cliPath, outputDir);
		await assert.rejects(
			fs.access(
				path.join(outputDir, "system/attachments/auto-mode-shell-guidance.md"),
			),
		);
		assert.match(
			await fs.readFile(path.join(outputDir, "prompt-corpus.json"), "utf8"),
			/read files with cat, head, or sed -n/,
		);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});
