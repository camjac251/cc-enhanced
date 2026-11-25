import type { On, RenderInput, SessionUsage } from "claude-code";
import { type Engine, expect, mock, test } from "claude-code/testing";

const NOW = Date.UTC(2026, 10, 24, 15, 0);
const HOUR = 60 * 60_000;
const FIVE_HOUR_RESET = NOW + 3 * HOUR + 12 * 60_000;
const WEEKLY_RESET = NOW + 4 * 24 * HOUR;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const USAGE: SessionUsage = {
	startedAt: NOW - HOUR,
	context: { tokens: 269_100, window: 1_000_000, percent: 27 },
	rateLimits: [
		{
			kind: "five_hour",
			percentUsed: 42,
			resetsAt: new Date(FIVE_HOUR_RESET).toISOString(),
		},
		{
			kind: "seven_day",
			percentUsed: 37,
			resetsAt: new Date(WEEKLY_RESET).toISOString(),
		},
	],
	cost: { usd: 29.95 },
};

type World = {
	model?: string;
	settings?: Record<string, unknown>;
	authorized?: boolean;
	fetches?: string[];
	usageBody?: unknown;
	store?: Record<string, unknown>;
	usage?: SessionUsage;
};

function world(on: On, options: World = {}) {
	const clock = mock.clock(on, { now: NOW });
	mock.env(on, { HOME: "/home/tester", LANG: "C.UTF-8" });
	mock.store(on, options.store);
	on("session.cwd", () => ({ value: "/home/tester/projects/demo" }));
	on("session.model", () => ({
		value: options.model ?? "claude-opus-5-5[1m]",
	}));
	on("session.usage", () => ({ value: options.usage ?? USAGE }));
	on("command.run", () => ({ text: "Set effort level" }));
	on("session.surfaces", () => ({ value: ["terminal"] }));
	on("session.authorize", () => ({
		value: options.authorized ? { handle: "credential", kind: "bearer" } : null,
	}));
	on("settings.read", () => ({ value: options.settings ?? {} }));
	on("http.fetch", (_$, e) => {
		options.fetches?.push(e.url);
		return {
			value: {
				status: 200,
				ok: true,
				headers: {},
				text: JSON.stringify(options.usageBody ?? {}),
			},
		};
	});
	on("tool.register", (_$, e) => ({
		value: { tool: `mcp__cc-enhanced__${e.name}` },
	}));
	on("session.start", (_$, e) => ({ cwd: e.cwd }));
	return clock;
}

function footer(
	columns = 220,
	maxRows = 5,
	text: string | null = null,
): RenderInput<"StatusLine", "terminal"> {
	return {
		surface: "terminal",
		component: "StatusLine",
		requestId: "status-line",
		props: { text, isManaged: false, isWorking: false, maxRows, columns },
	};
}

/** The drawn rows: each row is one Text holding its spans. */
async function rows($: Engine, input = footer()): Promise<string[]> {
	const ui = await $.ui.mount({ plugin: "cc-enhanced", ...input });
	const texts = (await ui.findAll({ type: "Text" }))
		.map((element) => element.text)
		.filter((text) => text.length > 0);
	// Other mods drawing at this site keep their rows under ours.
	expect(await ui.keepsBeneath()).toBe(true);
	await ui.unmount();
	return texts.filter(
		(text) => !texts.some((other) => other !== text && other.includes(text)),
	);
}

test("draws the path, model, limits, cost, and context the engine reports", async ($, on) => {
	world(on);
	const [header, status] = await rows($);
	expect(header).toBe("~/projects/demo [Opus 5.5 (1M)]");
	expect(status).toMatch(
		new RegExp(
			`^❯ session:\\$29\\.95 │ usage:42% 3h12m \\(\\d{2}(:\\d{2})?\\) │ 7d:37% \\(${WEEKDAYS[new Date(WEEKLY_RESET).getDay()]}\\) │ context:269\\.1K/1M 27%$`,
		),
	);
});

test("a narrow footer sheds low-priority fields and keeps context", async ($, on) => {
	world(on);
	const [, status] = await rows($, footer(40));
	expect(Array.from(status ?? "").length).toBeLessThanOrEqual(40);
	expect(status).toContain("27%");
	expect(status).not.toContain("7d:");
});

test("one spare row merges the model into the status line", async ($, on) => {
	world(on);
	const drawn = await rows($, footer(220, 1));
	expect(drawn).toHaveLength(1);
	expect(drawn[0]).toContain("Opus 5.5");
	expect(drawn[0]).toContain("context:269.1K/1M 27%");
	expect(drawn[0]).not.toContain("~/projects/demo");
});

test("routed and future model ids are named without a table", async ($, on) => {
	world(on, { model: "clodex:openai-oauth:gpt-5.6-sol" });
	const [header] = await rows($);
	expect(header).toContain("[GPT 5.6 Sol (1M)]");
});

test("an explicit /effort level shows at once; a bare /effort waits for a request", async ($, on) => {
	world(on);
	const typed = {
		command: "effort",
		origin: { kind: "composer" },
		presentation: { isFullscreen: false, columns: 200 },
	} as const;
	await $.command.run({ ...typed, args: "" });
	expect((await rows($))[0]).not.toContain("effort:");
	await $.command.run({ ...typed, args: "high" });
	expect((await rows($))[0]).toContain("[effort:high]");
});

test("a cost that includes an unpriced model is marked", async ($, on) => {
	world(on, { usage: { ...USAGE, cost: { usd: 1.5, hasUnknownPrice: true } } });
	const [, status] = await rows($);
	expect(status).toContain("session:$1.50?");
});

test(
	"turning off a field hides only that field",
	{ options: { statusline_cost: false, statusline_weekly: false } },
	async ($, on) => {
		world(on);
		const [, status] = await rows($);
		expect(status).not.toContain("session:");
		expect(status).not.toContain("7d:");
		expect(status).toContain("context:");
	},
);

test("by default a configured statusLine command keeps its line", async ($, on) => {
	world(on, {
		settings: { statusLine: { type: "command", command: "my-statusline" } },
	});
	await $.session.start({
		cwd: "/home/tester/projects/demo",
		surface: "terminal",
		isInteractive: true,
	});
	// Before the command's first output and after it, only the stock site draws.
	expect((await rows($)).join("\n")).not.toContain("context:");
	const drawn = await rows($, footer(220, 5, "COMMAND_OUTPUT"));
	expect(drawn.join("\n")).not.toContain("context:");
});

test(
	"replace draws over a configured statusLine command",
	{ options: { statusline: "replace" } },
	async ($, on) => {
		world(on, {
			settings: { statusLine: { type: "command", command: "my-statusline" } },
		});
		await $.session.start({
			cwd: "/home/tester/projects/demo",
			surface: "terminal",
			isInteractive: true,
		});
		const drawn = (await rows($, footer(220, 5, "COMMAND_OUTPUT"))).join("\n");
		expect(drawn).toContain("context:269.1K/1M 27%");
		expect(drawn).not.toContain("COMMAND_OUTPUT");
	},
);

test("an interactive start shows the model's last requested effort, not the effortLevel setting, and shares one usage fetch", async ($, on) => {
	const fetches: string[] = [];
	const clock = world(on, {
		authorized: true,
		fetches,
		// The engine may not honor this setting; the last real request decides.
		settings: { effortLevel: "low" },
		store: { statuslineEffort: { "claude-opus-5-5": "medium" } },
		usageBody: {
			limits: [
				{
					kind: "weekly_scoped",
					percent: 9,
					resets_at: new Date(WEEKLY_RESET).toISOString(),
					scope: {
						model: { id: "claude-fable-5-1", display_name: "Fable 5.1" },
					},
				},
			],
		},
	});
	await $.session.start({
		cwd: "/home/tester/projects/demo",
		surface: "terminal",
		isInteractive: true,
	});
	const [header, status] = await rows($);
	expect(header).toContain("[effort:medium]");
	expect(header).not.toContain("effort:low");
	expect(status).toContain("fable:9%");
	expect(fetches).toEqual(["https://api.anthropic.com/api/oauth/usage"]);
	// A minute later the stored copy is still fresh.
	await clock.advance(60_000);
	expect(fetches).toHaveLength(1);
	// Once it is five minutes old, the next tick refreshes it.
	await clock.advance(4 * 60_000);
	expect(fetches).toHaveLength(2);
});

test("a print-mode start neither fetches nor starts a refresh timer", async ($, on) => {
	const fetches: string[] = [];
	const clock = world(on, { authorized: true, fetches });
	await $.session.start({
		cwd: "/home/tester/projects/demo",
		surface: null,
		isInteractive: false,
	});
	await clock.advance(10 * 60_000);
	expect(fetches).toEqual([]);
});

function agentRow(
	props: Partial<RenderInput<"AgentRow", "terminal">["props"]> = {},
): RenderInput<"AgentRow", "terminal"> {
	return {
		surface: "terminal",
		component: "AgentRow",
		requestId: "a1",
		props: {
			id: "a1",
			name: "reviewer",
			description: "review change",
			type: "general-purpose",
			status: "running",
			kind: "local_agent",
			taskStatus: "running",
			label: "Reading the diff",
			startTime: NOW - 125_000,
			cwd: "/home/tester/projects/demo",
			model: "claude-opus-5-5",
			effort: "high",
			contextWindowSize: 200_000,
			tokenCount: 50_000,
			tokenSamples: [40_000, 45_000, 50_000],
			hasRow: true,
			rowIds: ["a1"],
			columns: 120,
			isHidden: false,
			...props,
		},
	};
}

/** The body the engine's row receives from the plugins above it. */
async function rowBody(
	$: Engine,
	on: On,
	props: Parameters<typeof agentRow>[0] = {},
): Promise<string | undefined> {
	let body: string | undefined;
	on("ui.render", { component: "AgentRow" }, ($, e) => {
		body = e.props.body;
		return $.ui.resolve(e).Text({ children: ["engine row"] });
	});
	const ui = await $.ui.mount({ plugin: "cc-enhanced", ...agentRow(props) });
	// The engine keeps its pointer, bullet and keys; only the body is ours.
	expect(await ui.find({ type: "Text", text: "engine row" })).toBeDefined();
	await ui.unmount();
	return body;
}

test("an agent row's body shows its model, effort, context, burn, elapsed time, and task", async ($, on) => {
	world(on);
	const body = await rowBody($, on);
	expect(body?.replace(/\u001b\[[0-9;]*m/g, "")).toBe(
		"reviewer · Opus 5.5 · high · 50K/200K 25% · 60K/m · 2m · Reading the diff",
	);
});

test("a row body drawn beneath is kept", async ($, on) => {
	world(on);
	expect(await rowBody($, on, { body: "OTHER_ROW" })).toBe("OTHER_ROW");
});

test(
	"turning agent rows off leaves the stock row",
	{ options: { statusline_agents: false } },
	async ($, on) => {
		world(on);
		expect(await rowBody($, on)).toBeUndefined();
	},
);
