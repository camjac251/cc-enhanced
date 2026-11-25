import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type AgentRowInput,
	agentRowSpans,
	cacheAfter,
	parseUsage,
	type StatuslineView,
	sgrText,
	statuslineOptions,
	statuslineRows,
} from "../../plugin/hooks/statusline.js";

const NOW = Date.UTC(2026, 10, 24, 15, 0);
const MINUTE = 60_000;

function view(overrides: Partial<StatuslineView> = {}): StatuslineView {
	return {
		cwd: "/work",
		model: "claude-opus-5-5",
		rateLimits: [],
		context: { window: 200_000 },
		clock: { now: NOW, twelveHour: false },
		...overrides,
	};
}

const AGENT: AgentRowInput = {
	name: "reviewer",
	type: "general-purpose",
	label: "Reading the diff\nand the tests",
	description: "review change",
	model: "claude-sonnet-5-5",
	effort: "high",
	lastRequest: { at: NOW, model: "claude-opus-5-5", effort: "xhigh" },
	contextWindowSize: 200_000,
	tokenCount: 50_000,
	// 15 intervals of five seconds: 15,000 tokens over 75 s is 12K a minute.
	tokenSamples: Array.from({ length: 16 }, (_, i) => 35_000 + i * 1_000),
	startTime: NOW - 125_000,
};

function agentText(columns?: number): string {
	return agentRowSpans(AGENT, NOW, columns)
		.map((span) => span.text)
		.join("");
}

test("an agent row shows what its last request carried, on one line", () => {
	assert.equal(
		agentText(),
		"reviewer · Opus 5.5 · xhigh · 50K/200K 25% · 12K/m · 2m · Reading the diff and the tests",
	);
});

test("a narrow agent row sheds burn, effort, task, then model", () => {
	const withTask =
		"reviewer · Opus 5.5 · 50K/200K 25% · 2m · Reading the diff and the tests";
	assert.equal(agentText(withTask.length), withTask);
	assert.equal(
		agentText(withTask.length - 1),
		"reviewer · Opus 5.5 · 50K/200K 25% · 2m",
	);
	assert.equal(agentText(30), "reviewer · 50K/200K 25% · 2m");
	assert.equal(agentText(12), "reviewer");
});

test("an agent row's body carries colors as SGR and no control characters", () => {
	const body = sgrText(agentRowSpans(AGENT, NOW));
	assert.match(body, /\u001b\[38;2;96;165;250mreviewer\u001b\[0m/);
	assert.doesNotMatch(body.replace(/\u001b\[[0-9;]*m/g, ""), /[\u0000-\u001f]/);
});

function status(state: Partial<StatuslineView>): string {
	const rows = statuslineRows(view(state), statuslineOptions({}), 220, 2);
	return (
		rows
			.at(-1)
			?.map((span) => span.text)
			.join("") ?? ""
	);
}

test("cache figures follow the last response and expire by lifetime", () => {
	const written = cacheAfter(
		undefined,
		{
			input_tokens: 10,
			output_tokens: 5,
			cache_read_input_tokens: 267_700,
			cache_creation_input_tokens: 1_400,
			ephemeral_5m_input_tokens: 0,
			ephemeral_1h_input_tokens: 1_400,
			model: "claude-opus-5-5",
		},
		NOW,
	);
	assert.match(status({ cache: written }), /cache:1h r:267\.7K w:1\.4K/);

	// A later read-only response shows its read alone; the 1h write still lives.
	const read = cacheAfter(
		written,
		{
			input_tokens: 3,
			output_tokens: 2,
			cache_read_input_tokens: 269_000,
			cache_creation_input_tokens: 0,
			model: "claude-opus-5-5",
		},
		NOW + MINUTE,
	);
	assert.match(
		status({ cache: read, clock: { now: NOW + MINUTE, twelveHour: false } }),
		/cache:1h r:269K(?! w:)/,
	);

	// Past the hour, nothing is cached any more but the last read hit.
	assert.match(
		status({
			cache: read,
			clock: { now: NOW + 61 * MINUTE, twelveHour: false },
		}),
		/cache:hit r:269K/,
	);
});

test("usage parsing takes limits rows generically and drops unknown shapes", () => {
	const usage = parseUsage(
		{
			five_hour: "not an object",
			limits: [
				{ kind: "session", percent: 61, resets_at: "2026-11-24T18:00:00Z" },
				{ kind: "weekly_all", percent: 37 },
				{
					kind: "weekly_scoped",
					percent: 9,
					scope: { model: { id: "claude-nova-6", display_name: "Nova 6" } },
				},
				{ kind: "weekly_scoped", percent: "bad" },
			],
		},
		NOW,
	);
	assert.equal(usage.fiveHour?.percent, 61);
	assert.equal(usage.sevenDay?.percent, 37);
	assert.deepEqual(
		usage.scoped.map((row) => [row.label, row.percent]),
		[["nova", 9]],
	);
});

test("limits whose window already reset are not shown", () => {
	const text = status({
		rateLimits: [
			{
				kind: "seven_day",
				percentUsed: 80,
				resetsAt: new Date(NOW - MINUTE).toISOString(),
			},
		],
	});
	assert.doesNotMatch(text, /7d:/);
});
