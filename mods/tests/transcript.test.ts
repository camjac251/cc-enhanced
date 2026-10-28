import type {
	BuiltinToolResults,
	On,
	RenderInput,
	Settings,
} from "claude-code";
import { expect, mock, test } from "claude-code/testing";

const PLAN = "/work/project/notes/plans/review.md";
const MEMORY = "/config/claude/projects/project-key/memory/facts.md";
const PATCH = [
	{
		oldStart: 2,
		oldLines: 2,
		newStart: 2,
		newLines: 3,
		lines: ["-Old approach", "+New approach", "+One more step", " Keep this"],
	},
];
const DIFF =
	"@@ -2,2 +2,3 @@\n-Old approach\n+New approach\n+One more step\n Keep this";

type Environment = {
	root?: string;
	env?: Record<string, string>;
	settings?: Settings;
	sources?: Record<string, Settings>;
};

function environment(on: On, options: Environment = {}): void {
	mock.env(
		on,
		options.env ?? {
			HOME: "/home/tester",
			CLAUDE_CONFIG_DIR: "/config/claude",
		},
	);
	on("session.root", () => ({ value: options.root ?? "/work/project" }));
	on("settings.read", (_$, e) => ({
		value: e.source
			? (options.sources?.[e.source] ?? {})
			: (options.settings ?? { plansDirectory: "notes/plans" }),
	}));
	on("session.usage", () => {
		throw new Error("Rendering a file diff must not scan the context.");
	});
	on("fs.*", () => {
		throw new Error("Rendering a stored result must not reread files.");
	});
}

function changed(
	tool: "Edit" | "Write",
	filePath: string,
): BuiltinToolResults["Edit"] | BuiltinToolResults["Write"] {
	if (tool === "Edit") {
		return {
			filePath,
			oldString: "Old approach",
			newString: "New approach\nOne more step",
			originalFile: "# Notes\nOld approach\nKeep this\n",
			structuredPatch: PATCH,
			userModified: false,
			replaceAll: false,
		};
	}
	return {
		type: "update",
		filePath,
		content: "# Notes\nNew approach\nOne more step\nKeep this\n",
		originalFile: "# Notes\nOld approach\nKeep this\n",
		structuredPatch: PATCH,
	};
}

function row(
	component: "ToolUse" | "ToolResult",
	tool: string,
	output: unknown,
): RenderInput<"ToolUse" | "ToolResult"> {
	const result =
		typeof output === "object" && output !== null
			? (output as Record<string, unknown>)
			: undefined;
	const file_path = result?.filePath ?? PLAN;
	const input =
		tool === "Write"
			? { file_path, content: result?.content ?? "" }
			: tool === "Edit"
				? {
						file_path,
						old_string: result?.oldString ?? "Old approach",
						new_string: result?.newString ?? "New approach\nOne more step",
					}
				: { file_path };
	const common = {
		tool_use_id: "file-change",
		tool,
		output,
		isErrored: false,
		isExpanded: false,
		onScreen: null,
	};
	const envelope = {
		surface: "terminal" as const,
		requestId: "file-change",
	};
	return component === "ToolUse"
		? {
				...envelope,
				component,
				props: {
					...common,
					input,
					isRunning: false,
					isInterrupted: false,
				},
			}
		: { ...envelope, component, props: common };
}

for (const component of ["ToolUse", "ToolResult"] as const) {
	for (const tool of ["Edit", "Write"] as const) {
		for (const filePath of [PLAN, MEMORY]) {
			test(`${component} ${component === "ToolUse" ? "renders" : "does not duplicate"} the ${tool} diff for ${filePath}`, async ($, on) => {
				environment(on);
				for (const surface of [
					"terminal",
					"desktop",
					"vscode",
					"mobile",
				] as const) {
					const target = row(component, tool, changed(tool, filePath));
					const ui = await $.ui.mount({
						plugin: "cc-enhanced",
						...target,
						surface,
					});
					if (component === "ToolUse") {
						expect((await ui.find({ type: "Text" }))?.text).toBe(
							`${tool} ${filePath}`,
						);
						expect((await ui.find({ type: "Code" }))?.props).toMatchObject({
							format: "diff",
							source: DIFF,
							path: filePath,
						});
					} else {
						expect(await ui.find({ type: "Code" })).toBeUndefined();
						expect(await ui.find({ type: "Text" })).toBeUndefined();
					}
					expect((await ui.drawn()).type).toBe("Box");
					await ui.unmount();
				}
			});
		}
	}

	for (const content of [
		"# New file\r\nEvery line\r\n",
		"# New file\nEvery line",
	]) {
		test(`${component} ${component === "ToolUse" ? "renders" : "does not repeat"} new Write contents with ${content.endsWith("\n") ? "CRLF" : "no final newline"}`, async ($, on) => {
			environment(on);
			const output: BuiltinToolResults["Write"] = {
				type: "create",
				filePath: MEMORY,
				content,
				structuredPatch: [],
				originalFile: null,
			};
			const ui = await $.ui.mount({
				plugin: "cc-enhanced",
				...row(component, "Write", output),
			});
			if (component === "ToolUse") {
				expect((await ui.find({ type: "Code" }))?.props.source).toBe(
					"@@ -0,0 +1,2 @@\n+# New file\n+Every line" +
						(content.endsWith("\n") ? "" : "\n\\ No newline at end of file"),
				);
			} else {
				expect(await ui.find({ type: "Code" })).toBeUndefined();
			}
			await ui.unmount();
		});
	}

	const unchanged = changed("Write", PLAN);
	const cases: {
		name: string;
		tool?: string;
		output: unknown;
		error?: boolean;
	}[] = [
		{
			name: "unchanged Write",
			output: {
				...unchanged,
				content: unchanged.originalFile,
				structuredPatch: [],
			},
		},
		{
			name: "unchanged Edit",
			tool: "Edit",
			output: {
				...changed("Edit", PLAN),
				oldString: "Same",
				newString: "Same",
				structuredPatch: [],
			},
		},
		{
			name: "unavailable old Write contents",
			output: { ...unchanged, originalFile: null, structuredPatch: [] },
		},
		{
			name: "timed out Write diff",
			output: { ...unchanged, structuredPatch: [] },
		},
		{
			name: "context-only diff",
			output: {
				...unchanged,
				structuredPatch: [
					{
						oldStart: 1,
						oldLines: 1,
						newStart: 1,
						newLines: 1,
						lines: [" Keep this"],
					},
				],
			},
		},
		{ name: "staged Write", output: { ...unchanged, staged: true } },
		{
			name: "staged Edit",
			tool: "Edit",
			output: { ...changed("Edit", PLAN), staged: true },
		},
		{
			name: "empty new file",
			output: {
				...unchanged,
				type: "create",
				content: "",
				originalFile: null,
				structuredPatch: [],
			},
		},
		{ name: "unresolved result", output: undefined },
		{ name: "failed result", output: "Permission denied", error: true },
		{ name: "errored structured result", output: unchanged, error: true },
		{ name: "non-Edit/Write tool", tool: "Read", output: unchanged },
		{
			name: "malformed hunk",
			output: {
				...unchanged,
				structuredPatch: [{ ...PATCH[0], newLines: 42 }],
			},
		},
		{
			name: "control character content",
			output: {
				...unchanged,
				type: "create",
				content: "private\u001b[2J",
				originalFile: null,
			},
		},
		{
			name: "content beyond drawing capacity",
			output: {
				...unchanged,
				type: "create",
				content: "x".repeat(100_001),
				originalFile: null,
			},
		},
		...[
			"/work/project/src/code.ts",
			"/work/project/plans/code.md",
			"/work/project/memory/code.md",
			"/work/project/notes/plans-copy/code.md",
			"/work/project/notes/plans/code.ts",
			"/work/project/notes/plans/../../code.md",
			"/work/project/.claude/projects/key/memory/code.md",
			"/config/claude-copy/projects/key/memory/code.md",
			"/config/claude/projects/key/memory-copy/code.md",
		].map((filePath) => ({
			name: `ordinary path ${filePath}`,
			output: changed("Write", filePath),
		})),
	];
	for (const scenario of cases) {
		test(`${component} leaves ${scenario.name} to the stock renderer`, async ($, on) => {
			environment(on);
			const target = row(component, scenario.tool ?? "Write", scenario.output);
			if (scenario.error) target.props.isErrored = true;
			let stockCalls = 0;
			on("ui.render", { component: ["ToolUse", "ToolResult"] }, ($, e) => {
				stockCalls++;
				expect(e.props).toEqual(target.props);
				return $.ui.resolve(e).Text({ children: "stock row" });
			});
			const ui = await $.ui.mount({ plugin: "cc-enhanced", ...target });
			expect((await ui.find({ type: "Text" }))?.text).toBe("stock row");
			expect(await ui.find({ type: "Code" })).toBeUndefined();
			expect(stockCalls).toBe(1);
			await ui.unmount();
		});
	}
}

for (const state of ["isRunning", "isInterrupted"] as const) {
	test(`ToolUse keeps ${state} visible even when output is present`, async ($, on) => {
		environment(on);
		const target = row("ToolUse", "Edit", changed("Edit", PLAN));
		if (target.component !== "ToolUse")
			throw new Error("Expected ToolUse fixture");
		target.props[state] = true;
		on("ui.render", { component: "ToolUse" }, ($, e) => {
			expect(e.props).toEqual(target.props);
			return $.ui.resolve(e).Text({ children: "stock active row" });
		});
		const ui = await $.ui.mount({ plugin: "cc-enhanced", ...target });
		expect((await ui.find({ type: "Text" }))?.text).toBe("stock active row");
		expect(await ui.find({ type: "Code" })).toBeUndefined();
		await ui.unmount();
	});
}

const pathCases: (Environment & { name: string; path: string })[] = [
	{
		name: "absolute configured plan folder",
		path: PLAN,
		settings: { plansDirectory: "/work/project/notes/plans" },
	},
	{
		name: "default config plan folder",
		path: "/config/claude/plans/review.md",
		settings: {},
	},
	{
		name: "default home config folder",
		path: "/home/tester/.claude/plans/review.md",
		settings: {},
		env: { HOME: "/home/tester" },
	},
	{
		name: "invalid outside-project plan setting falls back",
		path: "/config/claude/plans/review.md",
		settings: { plansDirectory: "/elsewhere/plans" },
	},
	{
		name: "user memory directory",
		path: "/home/tester/notes/facts.md",
		sources: { user: { autoMemoryDirectory: "~/notes" } },
	},
	{
		name: "managed memory directory",
		path: "/managed/notes/facts.md",
		sources: {
			policy: { autoMemoryDirectory: "/managed/notes" },
			user: { autoMemoryDirectory: "/other/notes" },
		},
	},
	{
		name: "Windows custom plan folder",
		root: "C:\\work\\project",
		path: "C:\\WORK\\project\\notes\\plans\\review.md",
		settings: { plansDirectory: "notes\\plans" },
		env: { USERPROFILE: "C:\\Users\\tester" },
	},
	{
		name: "Windows default memory folder",
		root: "C:\\work\\project",
		path: "C:\\Users\\tester\\.claude\\projects\\key\\memory\\facts.md",
		env: { USERPROFILE: "C:\\Users\\tester" },
	},
];
for (const scenario of pathCases) {
	test(`path classification recognizes ${scenario.name}`, async ($, on) => {
		environment(on, scenario);
		const ui = await $.ui.mount({
			plugin: "cc-enhanced",
			...row("ToolUse", "Edit", changed("Edit", scenario.path)),
		});
		expect((await ui.find({ type: "Text" }))?.text).toBe(
			`Edit ${scenario.path}`,
		);
		expect((await ui.find({ type: "Code" }))?.props.source).toBe(DIFF);
		await ui.unmount();
	});
}

for (const setting of [
	{ plansDirectory: "/elsewhere/plans" },
	{ autoMemoryDirectory: "/elsewhere/plans" },
]) {
	test(`unaccepted ${Object.keys(setting)[0]} cannot classify arbitrary directories`, async ($, on) => {
		environment(on, { settings: setting, sources: { project: setting } });
		on("ui.render", { component: "ToolResult" }, ($, e) =>
			$.ui.resolve(e).Text({ children: "stock row" }),
		);
		const ui = await $.ui.mount({
			plugin: "cc-enhanced",
			...row(
				"ToolResult",
				"Write",
				changed("Write", "/elsewhere/plans/code.md"),
			),
		});
		expect((await ui.find({ type: "Text" }))?.text).toBe("stock row");
		expect(await ui.find({ type: "Code" })).toBeUndefined();
		await ui.unmount();
	});
}

for (const type of [
	"plan_mode",
	"plan_mode_reentry",
	"plan_mode_exit",
] as const) {
	test(`engine ${type} detail identifies the actual plan file`, async ($, on) => {
		environment(on);
		on("prompt.attachment", () => ({ text: "Plan reminder" }));
		const filePath = "/host-selected/location/plan.md";
		const attachment = {
			text: "Plan reminder",
			origin: { kind: "engine" } as const,
		};
		if (type === "plan_mode") {
			await $.prompt.attachment({
				...attachment,
				type,
				detail: { planFilePath: filePath, hasPlan: true, reminder: "full" },
			});
		} else if (type === "plan_mode_exit") {
			await $.prompt.attachment({
				...attachment,
				type,
				detail: { planFilePath: filePath, hasPlan: true },
			});
		} else {
			await $.prompt.attachment({
				...attachment,
				type,
				detail: { planFilePath: filePath },
			});
		}
		const ui = await $.ui.mount({
			plugin: "cc-enhanced",
			...row("ToolUse", "Edit", changed("Edit", filePath)),
		});
		expect((await ui.find({ type: "Code" }))?.props.source).toBe(DIFF);
		await ui.unmount();
	});
}

test("actual memory index paths identify sibling memory files without classifying ordinary instruction folders", async ($, on) => {
	environment(on);
	on("prompt.context", (_$, e) => ({ blocks: e.blocks }));
	on("ui.render", { component: "ToolResult" }, ($, e) =>
		$.ui.resolve(e).Text({ children: "stock row" }),
	);
	await $.prompt.context({
		blocks: [],
		instructionFiles: [
			{
				path: "/host-selected/notes/MEMORY.md",
				kind: "memory",
				content: "Index",
			},
			{
				path: "/ordinary/docs/MEMORY.md",
				kind: "project",
				content: "Not auto-memory",
			},
		],
	});
	const special = await $.ui.mount({
		plugin: "cc-enhanced",
		...row("ToolUse", "Edit", changed("Edit", "/host-selected/notes/facts.md")),
	});
	expect((await special.find({ type: "Code" }))?.props.source).toBe(DIFF);
	await special.unmount();
	const ordinary = await $.ui.mount({
		plugin: "cc-enhanced",
		...row("ToolResult", "Edit", changed("Edit", "/ordinary/docs/code.md")),
	});
	expect(await ordinary.find({ type: "Code" })).toBeUndefined();
	expect((await ordinary.find({ type: "Text" }))?.text).toBe("stock row");
	await ordinary.unmount();
});

test("an expanded ToolUse redraw switches from stock pending state to its actual diff", async ($, on) => {
	environment(on);
	on("ui.render", { component: "ToolUse" }, ($, e) =>
		$.ui.resolve(e).Text({ children: "stock pending row" }),
	);
	const target = row("ToolUse", "Edit", undefined);
	if (target.component !== "ToolUse")
		throw new Error("Expected ToolUse fixture");
	target.props.isRunning = true;
	target.props.isExpanded = true;
	const ui = await $.ui.mount({ plugin: "cc-enhanced", ...target });
	expect((await ui.find({ type: "Text" }))?.text).toBe("stock pending row");
	await ui.redraw({
		...target.props,
		isRunning: false,
		output: changed("Edit", PLAN),
	});
	expect((await ui.find({ type: "Code" }))?.props.source).toBe(DIFF);
	expect((await ui.find({ type: "Text" }))?.text).toBe(`Edit ${PLAN}`);
	await ui.unmount();
});
