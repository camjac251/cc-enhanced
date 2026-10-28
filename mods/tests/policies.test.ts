import { expect, test } from "claude-code/testing";

const CORE = { plugin: "engine", tier: "core" } as const;
const STOCK_WRAPPER =
	"Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.";
const SKILL_ENTRY = [
	"- claude-api: Reference for the Claude API / Anthropic SDK — model ids, pricing, params.",
	'TRIGGER — read BEFORE opening the target file; don\'t skip because it "looks like a one-liner" — whenever: the prompt names Claude/Anthropic.',
	"SKIP only when another provider is being worked on (overrides all triggers): OpenAI/GPT/Gemini.",
].join("\n");

test("skill listing narrows the Claude API entry only for engine attachments", async ($, on) => {
	on("prompt.attachment", (_$, e) => ({ text: e.text }));
	const text = `${SKILL_ENTRY}\n- other: keep this skill's trigger and skip.`;
	const answer = await $.prompt.attachment({
		type: "skill_listing",
		origin: { kind: "engine" },
		text,
	});
	expect(answer.text).toContain(
		"TRIGGER: building, debugging, or migrating an application",
	);
	expect(answer.text).toContain(
		"SKIP: Claude Code or CLI usage and configuration, transcripts, hooks, skills, MCP setup, model routing",
	);
	expect(answer.text).toContain("- other: keep this skill's trigger and skip.");
	for (const origin of [
		{ kind: "hook", event: "SessionStart" },
		{ kind: "plugin", event: "prompt.submit" },
	] as const) {
		expect(
			await $.prompt.attachment({ type: "skill_listing", origin, text }),
		).toEqual({ text });
	}
	expect(
		await $.prompt.attachment({
			type: "custom",
			origin: { kind: "engine" },
			text,
		}),
	).toEqual({ text });
});

test("skill listing respects downstream replacement and null", async ($, on) => {
	let replacement: string | null = null;
	on("prompt.attachment", () => ({ text: replacement }));
	const input = {
		type: "skill_listing",
		origin: { kind: "engine" },
		text: SKILL_ENTRY,
	} as const;
	expect(await $.prompt.attachment(input)).toEqual({ text: null });
	replacement = "A custom skill list.";
	expect(await $.prompt.attachment(input)).toEqual({ text: replacement });
});

test("CLAUDE.md wrapper changes without modifying file text or unrelated context", async ($, on) => {
	on("prompt.context", (_$, e) => ({ blocks: e.blocks }));
	const contents = `Contents of /work/CLAUDE.md:\n\nKeep $& and \ufeff\r\n${STOCK_WRAPPER}`;
	const result = await $.prompt.context({
		blocks: [
			{ name: "claudeMd", text: `${STOCK_WRAPPER}\n\n${contents}` },
			{ name: "custom", text: STOCK_WRAPPER },
		],
	});
	expect(result.blocks[0]?.text).toContain(
		"Treat applicable CLAUDE.md instructions as requirements.",
	);
	expect(result.blocks[0]?.text.endsWith(contents)).toBe(true);
	expect(result.blocks[1]).toEqual({ name: "custom", text: STOCK_WRAPPER });
});

for (const agent of ["statusline-setup", "claude-code-guide"]) {
	test(`${agent} is hidden only when built in`, async ($, on) => {
		on("agent.offer", () => ({ isOffered: true }));
		expect(
			await $.agent.offer({
				agent,
				description: "Built in",
				source: "built-in",
				provider: CORE,
			}),
		).toEqual({ isOffered: false });
		expect(
			await $.agent.offer({
				agent,
				description: "Custom",
				source: "plugin",
				provider: { plugin: "custom", tier: "user" },
			}),
		).toEqual({ isOffered: true });
		expect(
			await $.agent.offer({
				agent: "general-purpose",
				description: "General",
				source: "built-in",
				provider: CORE,
			}),
		).toEqual({ isOffered: true });
	});
}

for (const tool of ["Glob", "Grep", "WebSearch", "WebFetch", "NotebookEdit"]) {
	test(`${tool} is denied and its core description deferred`, async ($, on) => {
		on("tool.describe", (_$, e) => ({ description: e.description }));
		const check = await $.tool.check({ tool, input: {} });
		expect(check.decision).toBe("deny");
		expect(check.reason).toContain("mcp__cc-enhanced__view");
		const description = await $.tool.describe({
			tool,
			description: "Original",
			provider: CORE,
		});
		expect(description.isDeferred).toBe(true);
		expect(description.description).toContain("Disabled by cc-enhanced");
		expect(
			await $.tool.describe({
				tool,
				description: "Other provider",
				provider: { plugin: "custom", tier: "user" },
			}),
		).toEqual({ description: "Other provider" });
	});
}

test("disabled tool.call is stopped before reaching a provider", async ($, on) => {
	let calls = 0;
	on("tool.call", { tool: "WebSearch" }, () => {
		calls += 1;
		return { deny: "Provider must not execute" };
	});
	const result = await $.tool.call({
		tool: "WebSearch",
		query: "verification",
	});
	expect(result.deny).toContain("Disabled by cc-enhanced");
	expect(calls).toBe(0);
});

test("tool groups expand in place without changing calls or viewport metadata", async ($, on) => {
	let expanded = false;
	on("ui.render", { component: "ToolGroup" }, (_$, e) => {
		expanded = e.props.isExpanded;
		expect(e.props.calls[0]?.tool).toBe("Read");
		expect(e.props.isActive).toBe(true);
		return { type: "engine", ref: 0 };
	});
	await $.ui.render({
		surface: "terminal",
		component: "ToolGroup",
		requestId: "group",
		props: {
			calls: [
				{
					tool: "Read",
					input: { file_path: "/work/file.txt" },
					isRunning: false,
					isErrored: false,
					isInterrupted: false,
				},
			],
			isActive: true,
			isExpanded: false,
		},
	});
	expect(expanded).toBe(true);
});
