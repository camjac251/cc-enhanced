import type {
	AgentInfo,
	EngineInterface,
	On,
	PluginOptions,
	RenderElement,
	RenderInput,
	SessionRateLimit,
	Timer,
	TurnUsage,
} from "claude-code";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const USAGE_STORE_KEY = "statuslineUsage";
/** The effort each model's last main request carried, shared by sessions. */
const EFFORT_STORE_KEY = "statuslineEffort";
/** Every open session shares one fetch through the plugin store. */
const USAGE_TTL_MS = 5 * 60_000;
const USAGE_RETRY_MS = 2 * 60_000;
/** A session about to fetch claims it; others reuse their copy meanwhile. */
const USAGE_CLAIM_MS = 30_000;
/** Older than this, figures from the usage endpoint are marked stale. */
const USAGE_STALE_MS = 3 * USAGE_TTL_MS;
const TICK_MS = 60_000;
const FIVE_MINUTES_MS = 5 * 60_000;
const ONE_HOUR_MS = 60 * 60_000;
/** Windows from here up are named beside the model, as the startup header does. */
const LONG_CONTEXT_TOKENS = 1_000_000;
/** A segment is dropped before a much more important one is shortened. */
const DROP_BEFORE_SHRINK_MARGIN = 40;

const MUTED = "#999999";
const VALUE = "text";
const ACCENT = "#60a5fa";
const WARNING = "warning";
const ERROR = "error";

const MODEL_COLORS: readonly [string, string][] = [
	["gpt-5.6-sol", "#ff7a59"],
	["gpt-5.6-terra", "#69db94"],
	["gpt-5.6-luna", "#7daaff"],
	["fable", "#ff8cbe"],
	["mythos", "#ff8cbe"],
	["opus", "#c8a0ff"],
	["sonnet", "#ffc864"],
	["haiku", "#64dcff"],
];

const EFFORT_COLORS: Record<string, string> = {
	low: "#64dcff",
	medium: VALUE,
	high: "#ffc864",
	xhigh: "#ff78c8",
	max: "#ff78c8",
};

/**
 * `auto` draws only where no `statusLine` command is configured, so a person's
 * own command keeps its line; `replace` draws over one; `off` never draws.
 */
export type StatuslineMode = "auto" | "replace" | "off";

export type StatuslineOptions = {
	mode: StatuslineMode;
	path: boolean;
	pathLink: boolean;
	model: boolean;
	effort: boolean;
	cost: boolean;
	fiveHour: boolean;
	weekly: boolean;
	modelLimits: boolean;
	cache: boolean;
	context: boolean;
	agents: boolean;
};

/** Fields default on; only an explicit `false` hides one. */
export function statuslineOptions(options: PluginOptions): StatuslineOptions {
	const shown = (key: string) => options[key] !== false;
	const mode = options.statusline;
	return {
		mode: mode === "replace" || mode === "off" ? mode : "auto",
		path: shown("statusline_path"),
		pathLink: shown("statusline_path_link"),
		model: shown("statusline_model"),
		effort: shown("statusline_effort"),
		cost: shown("statusline_cost"),
		fiveHour: shown("statusline_five_hour"),
		weekly: shown("statusline_weekly"),
		modelLimits: shown("statusline_model_limits"),
		cache: shown("statusline_cache"),
		context: shown("statusline_context"),
		agents: shown("statusline_agents"),
	};
}

type Limit = { percent: number; resetsAt?: number };
type ScopedLimit = Limit & { label: string };

export type UsageSnapshot = {
	fetchedAt: number;
	retryAt?: number;
	/** Another session is fetching until then. */
	fetchingUntil?: number;
	fiveHour?: Limit;
	sevenDay?: Limit;
	scoped: ScopedLimit[];
};

export type CacheActivity = {
	readTokens: number;
	writeTokens: number;
	readAt?: number;
	writeAt?: number;
	fiveMinuteAt?: number;
	oneHourAt?: number;
	unlabeledAt?: number;
};

type Span = { text: string; color?: string; bold?: boolean; href?: string };
type Segment = { priority: number; variants: Span[][] };

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

/** Reset times are compared and shown to the minute. */
function resetTime(value: unknown): number | undefined {
	const parsed =
		typeof value === "string"
			? Date.parse(value)
			: typeof value === "number"
				? value
				: Number.NaN;
	if (!Number.isFinite(parsed)) return undefined;
	return Math.round(parsed / 60_000) * 60_000;
}

function limitFrom(value: unknown): Limit | undefined {
	if (!record(value)) return undefined;
	const percent = finite(value.utilization) ?? finite(value.percent);
	if (percent === undefined) return undefined;
	return { percent, resetsAt: resetTime(value.resets_at) };
}

/** A limit's short label from the API's own model name: `Fable 5.1` is `fable`. */
function limitLabel(model: Record<string, unknown>): string {
	const displayName =
		typeof model.display_name === "string" ? model.display_name.trim() : "";
	const name = displayName || (typeof model.id === "string" ? model.id : "");
	const first = name.replace(/^claude[\s-]+/i, "").split(/[\s-]+/)[0] ?? "";
	return first
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "")
		.slice(0, 12);
}

/** Reads the OAuth usage response; a malformed section is left out. */
export function parseUsage(body: unknown, fetchedAt: number): UsageSnapshot {
	const usage: UsageSnapshot = { fetchedAt, scoped: [] };
	if (!record(body)) return usage;
	usage.fiveHour = limitFrom(body.five_hour);
	usage.sevenDay = limitFrom(body.seven_day);
	for (const row of Array.isArray(body.limits) ? body.limits : []) {
		if (!record(row)) continue;
		const percent = finite(row.percent);
		if (percent === undefined) continue;
		const limit = { percent, resetsAt: resetTime(row.resets_at) };
		const scope = record(row.scope) ? row.scope : undefined;
		const model = scope && record(scope.model) ? scope.model : undefined;
		if (row.kind === "session" || row.group === "session") {
			usage.fiveHour ??= limit;
		} else if (
			model &&
			(row.kind === "weekly_scoped" || row.group === "weekly")
		) {
			const label = limitLabel(model);
			if (label) usage.scoped.push({ label, ...limit });
		} else if (
			row.kind === "weekly_all" ||
			(row.group === "weekly" && !scope)
		) {
			usage.sevenDay ??= limit;
		}
	}
	return usage;
}

function storedUsage(value: unknown): UsageSnapshot | undefined {
	if (!record(value) || finite(value.fetchedAt) === undefined) return undefined;
	return value as UsageSnapshot;
}

function windowResetSince(usage: UsageSnapshot, now: number): boolean {
	return [usage.fiveHour, usage.sevenDay, ...usage.scoped].some(
		(limit) =>
			limit?.resetsAt !== undefined &&
			limit.resetsAt > usage.fetchedAt &&
			limit.resetsAt <= now,
	);
}

function retryDelay(headers: Record<string, string>): number {
	const header = Object.entries(headers).find(
		([name]) => name.toLowerCase() === "retry-after",
	)?.[1];
	const seconds = header === undefined ? Number.NaN : Number(header);
	if (!Number.isFinite(seconds)) return USAGE_RETRY_MS;
	return Math.min(Math.max(seconds, 1), 900) * 1000;
}

/**
 * Returns the shared per-model usage, fetching only when every session's copy
 * is stale. Claude Code adds the credential; the token never reaches the mod.
 */
export async function refreshUsage(
	$: EngineInterface,
	now: number,
): Promise<UsageSnapshot | undefined> {
	const cached = storedUsage(await $.store.get(USAGE_STORE_KEY));
	if (cached) {
		if (cached.retryAt !== undefined && now < cached.retryAt) return cached;
		if (cached.fetchingUntil !== undefined && now < cached.fetchingUntil)
			return cached;
		if (now - cached.fetchedAt < USAGE_TTL_MS && !windowResetSince(cached, now))
			return cached;
	}
	const authorization = await $.session.authorize();
	if (authorization?.kind !== "bearer") return cached;
	// The store has no compare-and-set: a claim narrows, not closes, the window
	// in which two sessions fetch together. The result written below drops it.
	await $.store.set(USAGE_STORE_KEY, {
		...(cached ?? { fetchedAt: 0, scoped: [] }),
		fetchingUntil: now + USAGE_CLAIM_MS,
	});
	let next: UsageSnapshot;
	try {
		const response = await $.http.fetch(USAGE_URL, {
			auth: authorization.handle,
			headers: {
				Accept: "application/json",
				"anthropic-beta": "oauth-2025-04-20",
			},
		});
		next = response.ok
			? parseUsage(JSON.parse(response.text), now)
			: {
					...(cached ?? { fetchedAt: 0, scoped: [] }),
					retryAt: now + retryDelay(response.headers),
				};
	} catch {
		next = {
			...(cached ?? { fetchedAt: 0, scoped: [] }),
			retryAt: now + USAGE_RETRY_MS,
		};
	}
	await $.store.set(USAGE_STORE_KEY, next);
	return next;
}

/** Folds one main-conversation response into the cache activity. */
export function cacheAfter(
	previous: CacheActivity | undefined,
	usage: TurnUsage,
	now: number,
): CacheActivity {
	const activity: CacheActivity = previous
		? { ...previous }
		: { readTokens: 0, writeTokens: 0 };
	const read = usage.cache_read_input_tokens;
	const written = usage.cache_creation_input_tokens;
	if (read > 0) {
		activity.readTokens = read;
		activity.readAt = now;
	}
	if (written > 0) {
		activity.writeTokens = written;
		activity.writeAt = now;
		const fiveMinute = usage.ephemeral_5m_input_tokens ?? 0;
		const oneHour = usage.ephemeral_1h_input_tokens ?? 0;
		if (fiveMinute > 0) activity.fiveMinuteAt = now;
		if (oneHour > 0) activity.oneHourAt = now;
		if (written - fiveMinute - oneHour > 0) activity.unlabeledAt = now;
	}
	return activity;
}

/** `claude-opus-5-5[1m]` and `claude-opus-5-5` name one model's effort. */
function modelKey(model: string): string {
	return model.toLowerCase().replace(/\[[^\]]+\]$/, "");
}

function effortMap(value: unknown): Record<string, string> {
	if (!record(value)) return {};
	return Object.fromEntries(
		Object.entries(value).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string",
		),
	);
}

const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

async function rememberEffort(
	$: EngineInterface,
	model: string,
	level: string,
): Promise<void> {
	const key = modelKey(model);
	if (facts.efforts[key] === level) return;
	// Merge so another session's models keep their entries.
	facts.efforts = {
		...effortMap(await $.store.get(EFFORT_STORE_KEY)),
		[key]: level,
	};
	await $.store.set(EFFORT_STORE_KEY, facts.efforts);
}

async function recordStep(
	$: EngineInterface,
	model: string,
	effort: string | number | undefined,
	usage: TurnUsage | null,
): Promise<void> {
	if (effort !== undefined) {
		await rememberEffort($, model, String(effort).toLowerCase());
	}
	if (usage) {
		const previous = await $.state.get({
			plugin: "cc-enhanced",
			key: "statuslineCache",
		});
		await $.state.set(
			{ plugin: "cc-enhanced", key: "statuslineCache" },
			cacheAfter(previous.value, usage, await $.clock.now()),
		);
	}
}

function width(spans: readonly Span[]): number {
	return spans.reduce((sum, span) => sum + Array.from(span.text).length, 0);
}

/**
 * Fits segments into `columns`: drop the least important segment when it is
 * far less important than the next one that can shorten, else shorten.
 */
export function fitSegments(
	segments: readonly Segment[],
	columns: number,
	separator: readonly Span[],
	prefix: readonly Span[] = [],
): Span[] {
	const live = segments
		.filter((segment) => segment.variants.length > 0)
		.map((segment) => ({ segment, variant: 0 }));
	const line = () => {
		const spans: Span[] = [...prefix];
		live.forEach(({ segment, variant }, index) => {
			if (index > 0) spans.push(...separator);
			spans.push(...(segment.variants[variant] ?? []));
		});
		return spans;
	};
	const lowest = (entries: typeof live) =>
		entries.reduce<(typeof live)[number] | undefined>(
			(found, entry) =>
				found === undefined || entry.segment.priority < found.segment.priority
					? entry
					: found,
			undefined,
		);
	while (live.length > 0 && width(line()) > columns) {
		const shrink = lowest(
			live.filter(
				({ segment, variant }) => variant < segment.variants.length - 1,
			),
		);
		const drop = live.length > 1 ? lowest(live) : undefined;
		if (
			drop &&
			(!shrink ||
				drop.segment.priority + DROP_BEFORE_SHRINK_MARGIN <
					shrink.segment.priority)
		) {
			live.splice(live.indexOf(drop), 1);
		} else if (shrink) {
			shrink.variant++;
		} else {
			break;
		}
	}
	return line();
}

export function formatTokens(tokens: number): string {
	for (const [unit, suffix] of [
		[1e9, "B"],
		[1e6, "M"],
		[1e3, "K"],
	] as const) {
		if (tokens >= unit) {
			const value = tokens / unit;
			return `${Number.isInteger(value) ? value : value.toFixed(1)}${suffix}`;
		}
	}
	return String(Math.round(tokens));
}

export function formatPercent(percent: number): string {
	const whole = Math.round(percent);
	return Math.abs(percent - whole) < 0.05
		? `${whole}%`
		: `${percent.toFixed(1)}%`;
}

function tier(percent: number): Pick<Span, "color" | "bold"> {
	if (percent >= 90) return { color: ERROR, bold: true };
	if (percent >= 75) return { color: WARNING };
	return { color: VALUE };
}

function label(text: string): Span {
	return { text, color: MUTED };
}

type ModelLabel = { long: string; medium: string; tiny: string; color: string };

function capitalized(word: string): string {
	return `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`;
}

/**
 * Names a model from its id alone, so a new model needs no table:
 * `claude-opus-5-5` with the engine's 1M window is `Opus 5.5 (1M)`.
 */
export function modelLabel(id: string, window: number): ModelLabel {
	const lower = id.toLowerCase();
	const color =
		MODEL_COLORS.find(([match]) => lower.includes(match))?.[1] ?? VALUE;
	const tokens = lower
		.replace(/^[a-z0-9-]+:[^:]+:/, "")
		.replace(/\[[^\]]+\]$/, "")
		.replace(/^(anthropic\.)?claude-/, "")
		.replace(/-\d{8}$/, "")
		.replace(/-v\d.*$/, "")
		.split("-")
		.filter(Boolean);
	const words = tokens.filter((token) => !/^\d+(\.\d+)*$/.test(token));
	const version = tokens.filter((token) => /^\d+(\.\d+)*$/.test(token));
	const named = words.map(capitalized);
	// A short alphabetic leading word is an acronym (`gpt`); later words are
	// names (`sol`), as are longer leading words (`opus`).
	const [first, ...rest] = named.map((word, index) =>
		index === 0 && /^[A-Z][a-z]{0,2}$/.test(word) ? word.toUpperCase() : word,
	);
	if (!first) return { long: id, medium: id, tiny: id.slice(0, 12), color };
	const medium = [first, version.join("."), ...rest].filter(Boolean).join(" ");
	return {
		long:
			window >= LONG_CONTEXT_TOKENS
				? `${medium} (${formatTokens(window)})`
				: medium,
		medium,
		tiny: rest.at(-1) ?? first,
		color,
	};
}

function homeRelative(path: string, home: string | undefined): string {
	if (!home) return path;
	if (path === home) return "~";
	return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function fileUrl(path: string): string | undefined {
	if (!path.startsWith("/")) return undefined;
	return `file://${path.replace(/[^A-Za-z0-9\-._~/]/g, (character) =>
		Array.from(
			new TextEncoder().encode(character),
			(byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`,
		).join(""),
	)}`;
}

type Clock = { now: number; twelveHour: boolean };

function hourMinute(at: number, clock: Clock, wholeHour: string): string {
	const date = new Date(at);
	const minute = date.getMinutes();
	if (clock.twelveHour) {
		const hour = date.getHours() % 12 || 12;
		const suffix = date.getHours() < 12 ? "am" : "pm";
		return minute === 0
			? `${hour}${suffix}`
			: `${hour}:${String(minute).padStart(2, "0")}${suffix}`;
	}
	const hour = String(date.getHours()).padStart(2, "0");
	return minute === 0
		? `${hour}${wholeHour}`
		: `${hour}:${String(minute).padStart(2, "0")}`;
}

function countdown(ms: number): string {
	const minutes = Math.max(0, Math.round(ms / 60_000));
	const hours = Math.floor(minutes / 60);
	return hours > 0 ? `${hours}h${minutes % 60}m` : `${minutes}m`;
}

function elapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24)
		return minutes % 60 ? `${hours}h${minutes % 60}m` : `${hours}h`;
	const days = Math.floor(hours / 24);
	return hours % 24 ? `${days}d${hours % 24}h` : `${days}d`;
}

/** `AgentInfo.tokenSamples` are taken about five seconds apart. */
const TOKEN_SAMPLE_SECONDS = 5;

function tokensPerMinute(samples: readonly number[]): number | undefined {
	const first = samples[0];
	const last = samples.at(-1);
	if (first === undefined || last === undefined || samples.length < 2) return;
	if (last <= first) return;
	return ((last - first) * 60) / ((samples.length - 1) * TOKEN_SAMPLE_SECONDS);
}

/** A model's summary is free text: keep it to one row. */
function oneLine(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

export type AgentRowInput = Pick<
	AgentInfo,
	| "name"
	| "type"
	| "label"
	| "description"
	| "model"
	| "effort"
	| "lastRequest"
	| "contextWindowSize"
	| "tokenCount"
	| "tokenSamples"
	| "startTime"
>;

/**
 * One agent row: name, model, effort, context, burn rate, elapsed time and
 * the current task. Narrow rows shed burn, effort, task, model, then elapsed.
 */
export function agentRowSpans(
	agent: AgentRowInput,
	now: number,
	columns = Number.POSITIVE_INFINITY,
): Span[] {
	const segments: Segment[] = [
		{
			priority: 200,
			variants: [
				[{ text: oneLine(agent.name ?? "") || agent.type, color: ACCENT }],
			],
		},
	];
	const modelId = agent.lastRequest?.model ?? agent.model;
	if (modelId) {
		const model = modelLabel(modelId, 0);
		segments.push({
			priority: 70,
			variants: [[{ text: model.medium, color: model.color }]],
		});
	}
	const effort = agent.lastRequest?.effort ?? agent.effort;
	if (typeof effort === "string") {
		segments.push({
			priority: 50,
			variants: [
				[
					{
						text: effort,
						color: EFFORT_COLORS[effort] ?? MUTED,
						bold: effort === "max",
					},
				],
			],
		});
	}
	const window = agent.contextWindowSize;
	const amount: Span = { text: formatTokens(agent.tokenCount), color: VALUE };
	if (window && window > 0) {
		const percent = Math.round((agent.tokenCount / window) * 100);
		segments.push({
			priority: 150,
			variants: [
				[
					amount,
					label(`/${formatTokens(window)}`),
					{ text: " " },
					{ text: `${percent}%`, ...tier(percent) },
				],
			],
		});
	} else {
		segments.push({ priority: 150, variants: [[amount]] });
	}
	const rate = tokensPerMinute(agent.tokenSamples);
	if (rate !== undefined) {
		segments.push({
			priority: 40,
			variants: [
				[{ text: `${formatTokens(Math.round(rate))}/m`, color: VALUE }],
			],
		});
	}
	segments.push({
		priority: 80,
		variants: [[label(elapsed(now - agent.startTime))]],
	});
	const detail = oneLine(agent.label) || oneLine(agent.description);
	if (detail) {
		segments.push({
			priority: 60,
			variants: [[{ text: detail, color: VALUE }]],
		});
	}
	return fitSegments(segments, columns, [
		{ text: " " },
		label("·"),
		{ text: " " },
	]);
}

/** Raw colors for theme keys, since an agent row's body is SGR text. */
const SGR_THEME: Record<string, string | undefined> = {
	[VALUE]: undefined,
	[WARNING]: "#ffc107",
	[ERROR]: "#ff6b80",
};

export function sgrText(spans: readonly Span[]): string {
	return spans
		.map((span) => {
			const hex =
				span.color === undefined
					? undefined
					: span.color in SGR_THEME
						? SGR_THEME[span.color]
						: span.color;
			const codes: string[] = [];
			if (span.bold) codes.push("1");
			const rgb = hex && /^#([0-9a-f]{6})$/i.exec(hex)?.[1];
			if (rgb) {
				const value = Number.parseInt(rgb, 16);
				codes.push(`38;2;${value >> 16};${(value >> 8) & 255};${value & 255}`);
			}
			return codes.length > 0
				? `\u001b[${codes.join(";")}m${span.text}\u001b[0m`
				: span.text;
		})
		.join("");
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function weekday(at: number): string {
	return WEEKDAYS[new Date(at).getDay()] ?? "";
}

export type StatuslineView = {
	cwd: string;
	home?: string;
	model: string;
	effort?: string;
	costUsd?: number;
	/** The engine priced a model it has no rates for at another's. */
	costUnpriced?: boolean;
	rateLimits: readonly SessionRateLimit[];
	usage?: UsageSnapshot;
	cache?: CacheActivity;
	context: { tokens?: number; window: number; percent?: number };
	clock: Clock;
};

function live<T extends Limit>(
	limit: T | undefined,
	now: number,
): T | undefined {
	return limit && (limit.resetsAt === undefined || limit.resetsAt > now)
		? limit
		: undefined;
}

function sessionLimit(view: StatuslineView, kind: string): Limit | undefined {
	const limit = view.rateLimits.find((row) => row.kind === kind);
	return limit
		? { percent: limit.percentUsed, resetsAt: resetTime(limit.resetsAt) }
		: undefined;
}

function headerSegments(
	view: StatuslineView,
	options: StatuslineOptions,
): Segment[] {
	const segments: Segment[] = [];
	const bracket = (spans: Span[]): Span[] => [label("["), ...spans, label("]")];
	if (options.path && view.cwd) {
		// A terminal without hyperlinks draws the label and then the URL.
		const href = options.pathLink ? fileUrl(view.cwd) : undefined;
		const full = homeRelative(view.cwd, view.home);
		const base = full.split("/").filter(Boolean).at(-1) ?? full;
		segments.push({
			priority: 90,
			variants: [
				[{ text: full, color: ACCENT, href }],
				[{ text: base, color: ACCENT, href }],
			],
		});
	}
	if (options.model && view.model) {
		const model = modelLabel(view.model, view.context.window);
		segments.push({
			priority: 130,
			variants: [model.long, model.medium, model.tiny]
				.filter((text, index, all) => all.indexOf(text) === index)
				.map((text) => bracket([{ text, color: model.color }])),
		});
	}
	if (options.effort && view.effort) {
		const chip: Span = {
			text: view.effort,
			color: EFFORT_COLORS[view.effort] ?? MUTED,
			bold: view.effort === "max",
		};
		segments.push({
			priority: 55,
			variants: [
				bracket([label("effort:"), chip]),
				bracket([label("eff:"), chip]),
				bracket([chip]),
			],
		});
	}
	return segments;
}

function percentSegment(
	name: string,
	limit: Limit,
	priority: number,
	suffix: Span[] = [],
	marker: Span[] = [],
): Segment {
	return {
		priority,
		variants: [
			[
				label(name),
				...marker,
				{ text: formatPercent(limit.percent), ...tier(limit.percent) },
				...suffix,
			],
		],
	};
}

function statusSegments(
	view: StatuslineView,
	options: StatuslineOptions,
): Segment[] {
	const { now } = view.clock;
	const segments: Segment[] = [];
	// The engine's own limits are current; the usage endpoint's copy can lag
	// when refreshes keep failing.
	const stale: Span[] =
		view.usage !== undefined && now - view.usage.fetchedAt > USAGE_STALE_MS
			? [label("~")]
			: [];
	if (options.cost && view.costUsd !== undefined) {
		const cost: Span[] = [
			label("$"),
			{ text: view.costUsd.toFixed(2), color: VALUE, bold: true },
			...(view.costUnpriced ? [label("?")] : []),
		];
		segments.push({
			priority: 80,
			variants: [[label("session:"), ...cost], [label("s:"), ...cost], cost],
		});
	}
	const fiveHourEngine = sessionLimit(view, "five_hour");
	const fiveHour = live(fiveHourEngine ?? view.usage?.fiveHour, now);
	if (options.fiveHour && fiveHour) {
		const marker = fiveHourEngine ? [] : stale;
		const percent: Span = {
			text: formatPercent(fiveHour.percent),
			...tier(fiveHour.percent),
		};
		const remaining =
			fiveHour.resetsAt === undefined
				? []
				: [{ text: ` ${countdown(fiveHour.resetsAt - now)}`, color: VALUE }];
		const clock =
			fiveHour.resetsAt === undefined
				? []
				: [label(` (${hourMinute(fiveHour.resetsAt, view.clock, "")})`)];
		segments.push({
			priority: 100,
			variants: [
				[label("usage:"), ...marker, percent, ...remaining, ...clock],
				[label("u:"), ...marker, percent, ...remaining],
				[label("u:"), ...marker, percent],
				[...marker, percent],
			],
		});
	}
	const sevenDayEngine = sessionLimit(view, "seven_day");
	const sevenDay = live(sevenDayEngine ?? view.usage?.sevenDay, now);
	if (options.weekly && sevenDay) {
		const reset =
			sevenDay.resetsAt === undefined
				? []
				: [
						label(
							` (${
								sevenDay.resetsAt - now >= 24 * ONE_HOUR_MS
									? weekday(sevenDay.resetsAt)
									: hourMinute(sevenDay.resetsAt, view.clock, ":00")
							})`,
						),
					];
		segments.push(
			percentSegment("7d:", sevenDay, 15, reset, sevenDayEngine ? [] : stale),
		);
	}
	if (options.modelLimits) {
		for (const row of view.usage?.scoped ?? []) {
			const scoped = live(row, now);
			if (scoped)
				segments.push(
					percentSegment(`${scoped.label}:`, scoped, 14, [], stale),
				);
		}
	}
	const cache = view.cache;
	if (options.cache && cache && (cache.readAt || cache.writeAt)) {
		const ttls = [
			cache.fiveMinuteAt !== undefined &&
			cache.fiveMinuteAt + FIVE_MINUTES_MS > now
				? "5m"
				: undefined,
			cache.unlabeledAt !== undefined &&
			cache.unlabeledAt + FIVE_MINUTES_MS > now
				? "?"
				: undefined,
			cache.oneHourAt !== undefined && cache.oneHourAt + ONE_HOUR_MS > now
				? "1h"
				: undefined,
		].filter((ttl) => ttl !== undefined);
		const state =
			ttls.length > 0
				? ttls.join(" ")
				: cache.readTokens > 0
					? "hit"
					: "expired";
		const stateSpan: Span = {
			text: state,
			color: state === "expired" ? WARNING : VALUE,
		};
		const detail: Span[] = [];
		if (cache.readAt !== undefined && cache.readAt >= (cache.writeAt ?? 0)) {
			detail.push({
				text: ` r:${formatTokens(cache.readTokens)}`,
				color: VALUE,
			});
		}
		if (cache.writeAt !== undefined && cache.writeAt >= (cache.readAt ?? 0)) {
			detail.push({
				text: ` w:${formatTokens(cache.writeTokens)}`,
				color: VALUE,
			});
		}
		segments.push({
			priority: 50,
			variants: [
				[label("cache:"), stateSpan, ...detail],
				[label("cache:"), stateSpan],
			],
		});
	}
	if (options.context) {
		const { tokens, window, percent } = view.context;
		if (tokens === undefined || percent === undefined) {
			segments.push({
				priority: 110,
				variants: [[label("context:N/A")], [label("ctx:N/A")]],
			});
		} else {
			const amount: Span = { text: formatTokens(tokens), color: VALUE };
			const share: Span = {
				text: `${Math.min(percent, 100)}%`,
				...tier(percent),
			};
			segments.push({
				priority: 110,
				variants: [
					[
						label("context:"),
						amount,
						{ text: "/" },
						label(formatTokens(window)),
						{ text: " " },
						share,
					],
					[label("ctx:"), amount, { text: " " }, share],
					[label("ctx:"), share],
					[share],
				],
			});
		}
	}
	return segments;
}

/** Lays the footer out in at most `maxRows` rows of `columns` cells. */
export function statuslineRows(
	view: StatuslineView,
	options: StatuslineOptions,
	columns: number,
	maxRows: number,
): Span[][] {
	if (maxRows < 1 || columns < 1) return [];
	const prefix: Span[] = [{ text: "❯ ", color: ACCENT }];
	const separator: Span[] = [{ text: " " }, label("│"), { text: " " }];
	const header = headerSegments(view, options);
	const status = statusSegments(view, options);
	if (maxRows >= 2) {
		return [
			header.length > 0 ? fitSegments(header, columns, [{ text: " " }]) : [],
			status.length > 0 ? fitSegments(status, columns, separator, prefix) : [],
		].filter((row) => row.length > 0);
	}
	const model = header.find((segment) => segment.priority === 130);
	const single = model
		? [{ ...model, variants: model.variants.slice(1) }, ...status]
		: status;
	return single.length > 0
		? [fitSegments(single, columns, separator, prefix)]
		: [];
}

async function gather($: EngineInterface): Promise<StatuslineView> {
	const [cwd, model, usage, cache, home, lang, now] = await Promise.all([
		$.session.cwd(),
		$.session.model(),
		$.session.usage(),
		$.state.get({ plugin: "cc-enhanced", key: "statuslineCache" }),
		$.env.get("HOME"),
		$.env.get("LC_TIME"),
		$.clock.now(),
	]);
	const locale = lang || (await $.env.get("LANG")) || "";
	return {
		cwd,
		home,
		model,
		effort: facts.efforts[modelKey(model)],
		costUsd: usage.cost?.usd,
		costUnpriced: usage.cost?.hasUnknownPrice === true,
		rateLimits: usage.rateLimits,
		usage: facts.usage,
		cache: cache.value,
		context: usage.context,
		clock: { now, twelveHour: locale.toLowerCase().includes("en_us") },
	};
}

function draw(
	$: EngineInterface,
	e: RenderInput<"StatusLine", "terminal">,
	rows: readonly Span[][],
	beneath: RenderElement,
): RenderElement {
	const { Box, Text, Link } = $.ui.resolve(e);
	const span = (part: Span) =>
		Text({
			color: part.color,
			bold: part.bold,
			children: [
				part.href ? Link({ href: part.href, label: part.text }) : part.text,
			],
		});
	return Box({
		flexDirection: "column",
		children: [
			...rows.map((row) =>
				Text({ wrap: "truncate-end", children: row.map(span) }),
			),
			beneath,
		],
	});
}

function logFailure($: EngineInterface, what: string, error: unknown): void {
	$.ui.log(
		`cc-enhanced statusline ${what}: ${error instanceof Error ? error.message : String(error)}`,
		{ to: "debug" },
	);
}

let ticker: Timer | undefined;

/**
 * The footer last drawn and the frame it was laid out for; `null` when the
 * site was left to a statusLine command. A refresh redraws only on change.
 */
let drawn:
	| { columns: number; maxRows: number; rows: string }
	| null
	| undefined;

/** Redraws when the footer's text would differ from what is on screen. */
async function redrawIfChanged(
	$: EngineInterface,
	options: StatuslineOptions,
): Promise<void> {
	if (drawn === null) return;
	if (drawn !== undefined) {
		const rows = statuslineRows(
			await gather($),
			options,
			drawn.columns,
			drawn.maxRows,
		);
		if (JSON.stringify(rows) === drawn.rows) return;
	}
	$.ui.invalidate("ui.render");
}

/**
 * What outlives one conversation. `/clear` starts a new session state without
 * a session start, but this module, each model's effort, the account's limits
 * and the person's settings stay; only the cache figures belong to one thread.
 */
const facts: {
	commandConfigured: boolean;
	usage?: UsageSnapshot;
	efforts: Record<string, string>;
} = { commandConfigured: false, efforts: {} };

/**
 * Reads the settings and remembered efforts, and keeps shared usage and
 * time-based fields current, in interactive sessions only. A failure here
 * never fails the session start.
 */
export async function startStatusline(
	$: EngineInterface,
	options: StatuslineOptions,
	isInteractive: boolean,
): Promise<void> {
	if (options.mode === "off" || !isInteractive) return;
	try {
		const settings: Record<string, unknown> = await $.settings.read();
		facts.commandConfigured = record(settings.statusLine);
		// The engine exposes no effort before a request: show the level this
		// model's last request carried, never a setting it may not honor.
		facts.efforts = effortMap(await $.store.get(EFFORT_STORE_KEY));
	} catch (error) {
		logFailure($, "could not read settings", error);
	}
	const tick = async () => {
		try {
			if (!(await $.session.surfaces()).includes("terminal")) return;
			if (options.modelLimits) {
				const usage = await refreshUsage($, await $.clock.now());
				if (usage) {
					facts.usage = usage;
				}
			}
			await redrawIfChanged($, options);
		} catch (error) {
			logFailure($, "refresh failed", error);
		}
	};
	void tick();
	// A later start, such as after /clear, replaces the ticker instead of adding one.
	ticker?.cancel();
	ticker = $.clock.every(TICK_MS, () => void tick());
}

export function registerStatuslineMods(
	on: On,
	options: StatuslineOptions,
): void {
	if (options.agents) {
		on("ui.render", { component: "AgentRow" }, async ($, e, next) => {
			// Another plugin beneath already drew this row's body: keep it.
			if (e.props.body !== undefined || e.props.columns === 0) return next(e);
			try {
				const body = sgrText(
					agentRowSpans(e.props, await $.clock.now(), e.props.columns),
				);
				return next({ ...e, props: { ...e.props, body } });
			} catch (error) {
				logFailure($, "could not draw an agent row", error);
				return next(e);
			}
		});
	}
	if (options.mode === "off") return;

	on("turn.step", async function* ($, e, next) {
		const result = yield* next(e);
		// Subagents, workflow agents, and engine forks carry an agent id.
		if (e.agentId === undefined) {
			try {
				await recordStep($, e.model, e.effort, result.usage);
				await redrawIfChanged($, options);
			} catch (error) {
				logFailure($, "could not record a step", error);
			}
		}
		return result;
	});

	// `/effort <level>` takes effect at once; the footer follows without
	// waiting for a request. A bare `/effort` opens a picker, and an invalid or
	// downgraded level is corrected by the next request's own effort.
	on("command.run", { command: "effort" }, async ($, e, next) => {
		const result = await next(e);
		const level = e.args.trim().toLowerCase();
		if (EFFORT_LEVELS.has(level)) {
			try {
				await rememberEffort($, await $.session.model(), level);
				await redrawIfChanged($, options);
			} catch (error) {
				logFailure($, "could not record /effort", error);
			}
		}
		return result;
	});

	on("ui.render", { component: "StatusLine" }, async ($, e, next) => {
		if (e.surface !== "terminal") return next(e);
		if (options.mode === "auto") {
			if (
				e.props.isManaged ||
				e.props.text !== null ||
				facts.commandConfigured
			) {
				drawn = null;
				return next(e);
			}
		}
		let rows: Span[][];
		try {
			rows = statuslineRows(
				await gather($),
				options,
				e.props.columns,
				e.props.maxRows,
			);
		} catch (error) {
			logFailure($, "could not draw", error);
			return next(e);
		}
		drawn = {
			columns: e.props.columns,
			maxRows: e.props.maxRows,
			rows: JSON.stringify(rows),
		};
		if (rows.length === 0) return next(e);
		// The line takes the statusLine command's place where one is replaced;
		// other mods' rows at this site still draw beneath it.
		return draw(
			$,
			e,
			rows,
			await next({ ...e, props: { ...e.props, text: null } }),
		);
	});
}
