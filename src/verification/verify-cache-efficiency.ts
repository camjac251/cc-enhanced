#!/usr/bin/env node
import * as fs from "node:fs/promises";
import * as path from "node:path";
import chalk from "chalk";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import {
	CACHE_DIAGNOSTICS_BETA,
	type NormalizedCacheDiagnostics,
	sendCacheDiagnosticMessage,
} from "./cache-diagnostics.js";
import {
	buildCacheEfficiencyStats,
	type CacheCostMultipliers,
	type CachePricingPerMillionTokens,
	type CacheUsageTotals,
	evaluateCacheEfficiencyGate,
	hasCacheActivity,
	mergeCacheUsageTotals,
	normalizeCacheUsage,
} from "./cache-efficiency-lib.js";
import {
	buildCacheScenarioPlans,
	type CacheScenario,
	padCacheSystemText,
} from "./cache-scenario-plan.js";
import {
	type CacheScenarioTransport,
	executeCacheScenarioPlan,
} from "./cache-scenario-runner.js";

type CacheTtl = "5m" | "1h" | "none";

interface TranscriptTurn {
	user: string;
	assistant: string;
}

interface CacheTranscript {
	name?: string;
	description?: string;
	system?: string;
	systemBlocks?: string[];
	minimumSystemCharacters?: number;
	turns: TranscriptTurn[];
}

interface ApiTextBlock {
	type: "text";
	text: string;
	cache_control?: {
		type: "ephemeral";
		ttl?: "1h";
	};
}

interface ApiMessage {
	role: "user" | "assistant";
	content: ApiTextBlock[];
}

interface CachePolicy {
	name: "baseline" | "patched";
	cacheNamespace: "policy:a" | "policy:b";
	tailWindow: number;
	cacheAssistantTail: boolean;
}

interface TurnResult {
	turn: number;
	userPrompt: string;
	messageCount: number;
	cacheBreakpointCount: number;
	usage: CacheUsageTotals;
	equivalentInputTokens: number;
	estimatedCostUsd: number;
	responseId?: string;
	scenario?: CacheScenario;
	stepId?: string;
	phase?: string;
	lineage?: string;
	schemaLane?: string;
	previousStepId?: string | null;
	diagnostics?: NormalizedCacheDiagnostics;
}

interface PolicyResult {
	policy: CachePolicy["name"];
	turns: TurnResult[];
	totals: CacheUsageTotals;
	equivalentInputTokens: number;
	estimatedCostUsd: number;
}

const POLICIES: CachePolicy[] = [
	{
		name: "baseline",
		cacheNamespace: "policy:a",
		tailWindow: 1,
		cacheAssistantTail: true,
	},
	{
		name: "patched",
		cacheNamespace: "policy:b",
		tailWindow: 3,
		cacheAssistantTail: false,
	},
];

function getCacheControl(
	ttl: CacheTtl,
): ApiTextBlock["cache_control"] | undefined {
	if (ttl === "none") return undefined;
	if (ttl === "1h") return { type: "ephemeral", ttl: "1h" };
	return { type: "ephemeral" };
}

function cloneMessage(message: ApiMessage): ApiMessage {
	return {
		role: message.role,
		content: message.content.map((block) => ({
			type: "text",
			text: block.text,
			...(block.cache_control
				? { cache_control: { ...block.cache_control } }
				: {}),
		})),
	};
}

function withCacheControl(
	message: ApiMessage,
	cacheControl: ApiTextBlock["cache_control"],
): ApiMessage {
	if (!cacheControl) return cloneMessage(message);
	const next = cloneMessage(message);
	if (next.content.length === 0) {
		next.content = [{ type: "text", text: "", cache_control: cacheControl }];
		return next;
	}
	const lastIndex = next.content.length - 1;
	next.content[lastIndex] = {
		...next.content[lastIndex],
		cache_control: cacheControl,
	};
	return next;
}

function countBreakpoints(
	system: ApiTextBlock[],
	messages: ApiMessage[],
): number {
	let count = 0;
	for (const block of system) {
		if (block.cache_control) count++;
	}
	for (const message of messages) {
		for (const block of message.content) {
			if (block.cache_control) count++;
		}
	}
	return count;
}

function buildSystemBlocks(
	transcript: CacheTranscript,
	ttl: CacheTtl,
	cacheNamespace?: CachePolicy["cacheNamespace"],
): ApiTextBlock[] {
	const cacheControl = getCacheControl(ttl);
	const sourceBlocks = padCacheSystemText(
		transcript.systemBlocks && transcript.systemBlocks.length > 0
			? transcript.systemBlocks
			: transcript.system
				? [transcript.system]
				: ["You are a concise assistant for cache policy benchmarking."],
		transcript.minimumSystemCharacters ?? 0,
		"legacy benchmark protocol",
	);
	const namespaceSuffix = cacheNamespace
		? `\n[cache-benchmark-namespace:${cacheNamespace}]`
		: "";
	return sourceBlocks.map((text) => ({
		type: "text",
		text: `${text}${namespaceSuffix}`,
		...(cacheControl ? { cache_control: cacheControl } : {}),
	}));
}

function buildConversationMessages(
	turns: TranscriptTurn[],
	turnIndex: number,
): ApiMessage[] {
	const messages: ApiMessage[] = [];
	for (let i = 0; i <= turnIndex; i++) {
		const turn = turns[i];
		messages.push({
			role: "user",
			content: [{ type: "text", text: turn.user }],
		});
		if (i < turnIndex) {
			messages.push({
				role: "assistant",
				content: [{ type: "text", text: turn.assistant }],
			});
		}
	}
	return messages;
}

function applyPolicy(
	messages: ApiMessage[],
	policy: CachePolicy,
	ttl: CacheTtl,
): ApiMessage[] {
	const cacheControl = getCacheControl(ttl);
	if (!cacheControl) return messages.map((message) => cloneMessage(message));

	const cutoff = messages.length - (policy.tailWindow + 1);
	return messages.map((message, index) => {
		const isTail = index > cutoff;
		if (!isTail) return cloneMessage(message);
		if (message.role === "assistant" && !policy.cacheAssistantTail) {
			return cloneMessage(message);
		}
		return withCacheControl(message, cacheControl);
	});
}

async function loadTranscript(
	transcriptPath: string,
): Promise<CacheTranscript> {
	const raw = await fs.readFile(transcriptPath, "utf-8");
	const parsed = JSON.parse(raw) as CacheTranscript;
	if (!Array.isArray(parsed.turns) || parsed.turns.length < 2) {
		throw new Error(
			`Transcript at ${transcriptPath} must contain at least 2 turns`,
		);
	}
	for (const [index, turn] of parsed.turns.entries()) {
		if (
			!turn ||
			typeof turn.user !== "string" ||
			typeof turn.assistant !== "string"
		) {
			throw new Error(
				`Invalid turn at index ${index}; expected { user: string, assistant: string }`,
			);
		}
	}
	return parsed;
}

async function callAnthropicMessagesApi(
	apiUrl: string,
	apiKey: string,
	anthropicVersion: string,
	body: Record<string, unknown>,
	timeoutMs: number,
	diagnosticsPreviousMessageId?: string | null,
): Promise<{
	id?: string;
	usage: unknown;
	diagnostics?: NormalizedCacheDiagnostics;
}> {
	if (diagnosticsPreviousMessageId !== undefined) {
		return sendCacheDiagnosticMessage({
			apiUrl,
			apiKey,
			anthropicVersion,
			body,
			previousMessageId: diagnosticsPreviousMessageId,
			timeoutMs,
		});
	}
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(apiUrl, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": apiKey,
				"anthropic-version": anthropicVersion,
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`Anthropic API ${response.status} ${response.statusText}: ${errorText}`,
			);
		}
		const json = (await response.json()) as { id?: string; usage?: unknown };
		return { id: json.id, usage: json.usage ?? {} };
	} finally {
		clearTimeout(timeoutId);
	}
}

function toCsvValue(value: string | number): string {
	if (typeof value === "number") return String(value);
	if (!value.includes(",") && !value.includes('"') && !value.includes("\n")) {
		return value;
	}
	return `"${value.replace(/"/g, '""')}"`;
}

async function main() {
	const rawArgs = hideBin(process.argv);
	const argv = await yargs(rawArgs)
		.option("preset", {
			choices: [
				"default",
				"agent",
				"main",
				"fork",
				"normal-agent",
				"workflow",
				"all",
			] as const,
			default: "default" as const,
			description:
				"Apply legacy or stock-vs-patched request-mode benchmark presets",
		})
		.option("transcript", {
			type: "string",
			default: path.resolve(
				process.cwd(),
				"src/verification/fixtures/cache-transcript.json",
			),
			description: "Path to cache benchmark transcript JSON fixture",
		})
		.option("model", {
			type: "string",
			default: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
			description: "Anthropic model ID",
		})
		.option("api-url", {
			type: "string",
			default: "https://api.anthropic.com/v1/messages",
			description: "Anthropic messages API URL",
		})
		.option("anthropic-version", {
			type: "string",
			default: "2023-06-01",
			description: "Anthropic API version header",
		})
		.option("max-tokens", {
			type: "number",
			default: 16,
			description: "max_tokens for each benchmark request",
		})
		.option("temperature", {
			type: "number",
			default: 0,
			description: "temperature for benchmark requests",
		})
		.option("ttl", {
			choices: ["5m", "1h", "none"] as const,
			default: "5m" as const,
			description: "cache_control TTL to use for benchmark breakpoints",
		})
		.option("baseline-ttl", {
			choices: ["5m", "1h", "none"] as const,
			description:
				"cache_control TTL for the baseline policy; defaults to --ttl",
		})
		.option("patched-ttl", {
			choices: ["5m", "1h", "none"] as const,
			description:
				"cache_control TTL for the patched policy; defaults to --ttl",
		})
		.option("max-breakpoints", {
			type: "number",
			default: 4,
			description: "Maximum allowed cache breakpoints per request",
		})
		.option("fail-on-breakpoint-overflow", {
			type: "boolean",
			default: true,
			description: "Fail if any generated request exceeds --max-breakpoints",
		})
		.option("max-cost-regression-pct", {
			type: "number",
			default: 0,
			description:
				"Allowed patched-vs-baseline estimated cost regression percent",
		})
		.option("min-cache-read-delta", {
			type: "number",
			default: 0,
			description:
				"Required minimum delta for patched.cache_read_input_tokens - baseline.cache_read_input_tokens",
		})
		.option("write-multiplier-5m", {
			type: "number",
			default: 1.25,
			description: "Cost multiplier for 5m cache creation tokens",
		})
		.option("write-multiplier-1h", {
			type: "number",
			default: 2,
			description: "Cost multiplier for 1h cache creation tokens",
		})
		.option("write-multiplier-default", {
			type: "number",
			default: 1.25,
			description:
				"Fallback write multiplier when usage omits 5m/1h split fields",
		})
		.option("read-multiplier", {
			type: "number",
			default: 0.1,
			description: "Cost multiplier for cache read tokens",
		})
		.option("input-usd-per-million", {
			type: "number",
			default: 1,
			description: "Input price USD per million tokens for estimated cost math",
		})
		.option("output-usd-per-million", {
			type: "number",
			default: 0,
			description:
				"Output price USD per million tokens for estimated cost math",
		})
		.option("timeout-ms", {
			type: "number",
			default: 120000,
			description: "Per-request API timeout in milliseconds",
		})
		.option("dry-run", {
			type: "boolean",
			default: false,
			description: "Do not call the API; only render benchmark request plan",
		})
		.option("cache-diagnostics", {
			type: "boolean",
			default: false,
			description:
				"Enable the Claude API cache-diagnosis beta and chain diagnostic response IDs",
		})
		.option("output-json", {
			type: "string",
			description: "Path to write JSON benchmark report",
		})
		.option("output-csv", {
			type: "string",
			description: "Path to write per-turn CSV report",
		})
		.strict()
		.help()
		.parse();

	const hasFlag = (name: string): boolean =>
		rawArgs.some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
	const requestModePreset = [
		"main",
		"fork",
		"normal-agent",
		"workflow",
		"all",
	].includes(argv.preset);
	if (requestModePreset) {
		const ttlOverrides = ["ttl", "baseline-ttl", "patched-ttl"].filter(hasFlag);
		if (ttlOverrides.length > 0) {
			throw new Error(
				`TTL overrides are not supported by request-mode presets; remove ${ttlOverrides.map((flag) => `--${flag}`).join(", ")}`,
			);
		}
	}
	if (argv.preset === "agent") {
		if (!hasFlag("transcript")) {
			argv.transcript = path.resolve(
				process.cwd(),
				"src/verification/fixtures/cache-transcript-subagent.json",
			);
		}
		if (!hasFlag("baseline-ttl")) argv.baselineTtl = "5m";
		if (!hasFlag("patched-ttl")) argv.patchedTtl = "1h";
		if (!hasFlag("max-cost-regression-pct")) argv.maxCostRegressionPct = 10;
		if (!hasFlag("min-cache-read-delta")) {
			argv.minCacheReadDelta = -1_000_000;
		}
	}
	if (
		["main", "fork", "normal-agent", "workflow", "all"].includes(argv.preset) &&
		!hasFlag("transcript")
	) {
		argv.transcript = path.resolve(
			process.cwd(),
			"src/verification/fixtures/cache-transcript-scenarios.json",
		);
	}

	const model = String(argv.model ?? "").trim();
	const baselineTtl = (argv.baselineTtl ?? argv.ttl) as CacheTtl;
	const patchedTtl = (argv.patchedTtl ?? argv.ttl) as CacheTtl;

	const transcriptPath = path.resolve(String(argv.transcript));
	const transcript = await loadTranscript(transcriptPath);
	const multipliers: CacheCostMultipliers = {
		write5m: Number(argv.writeMultiplier5m),
		write1h: Number(argv.writeMultiplier1h),
		writeDefault: Number(argv.writeMultiplierDefault),
		read: Number(argv.readMultiplier),
	};
	const pricing: CachePricingPerMillionTokens = {
		inputUsdPerMillion: Number(argv.inputUsdPerMillion),
		outputUsdPerMillion: Number(argv.outputUsdPerMillion),
	};

	const liveRun = !argv.dryRun;
	const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
	if (liveRun && !apiKey) {
		throw new Error(
			"ANTHROPIC_API_KEY is required for live verification (omit only with --dry-run).",
		);
	}

	const policyResults: PolicyResult[] = [];
	const gateFailures: string[] = [];
	const maxBreakpoints = Number(argv.maxBreakpoints);
	const cacheDiagnosticsEnabled = Boolean(argv.cacheDiagnostics);
	const selectedScenarios: CacheScenario[] | null =
		argv.preset === "main"
			? ["main"]
			: argv.preset === "fork"
				? ["fork"]
				: argv.preset === "normal-agent"
					? ["normal-agent"]
					: argv.preset === "workflow"
						? ["workflow"]
						: argv.preset === "all"
							? ["main", "fork", "normal-agent", "workflow"]
							: null;

	if (selectedScenarios) {
		const turnsByPolicy: Record<"baseline" | "patched", TurnResult[]> = {
			baseline: [],
			patched: [],
		};
		const transport: CacheScenarioTransport = async (call) =>
			callAnthropicMessagesApi(
				String(argv.apiUrl),
				apiKey,
				String(argv.anthropicVersion),
				call.body,
				Number(argv.timeoutMs),
				call.diagnosticsPreviousMessageId,
			);

		for (const scenario of selectedScenarios) {
			for (const plan of buildCacheScenarioPlans({ scenario, transcript })) {
				const execution = await executeCacheScenarioPlan(plan, transport, {
					liveRun,
					diagnosticsEnabled: cacheDiagnosticsEnabled,
					model,
					maxTokens: Number(argv.maxTokens),
					temperature: Number(argv.temperature),
					maxBreakpoints: argv.failOnBreakpointOverflow
						? maxBreakpoints
						: Number.POSITIVE_INFINITY,
				});
				const policyName =
					execution.policy === "stock" ? "baseline" : "patched";
				for (const [stepIndex, step] of execution.steps.entries()) {
					const usage = normalizeCacheUsage(step.usage);
					const stats = buildCacheEfficiencyStats(usage, multipliers, pricing);
					const plannedRequest = plan.requests[stepIndex];
					const prompt =
						plannedRequest.body.messages.at(-1)?.content.at(-1)?.text ?? "";
					turnsByPolicy[policyName].push({
						turn: turnsByPolicy[policyName].length + 1,
						userPrompt: prompt,
						messageCount: step.messageCount,
						cacheBreakpointCount: step.cacheBreakpointCount,
						usage,
						equivalentInputTokens: stats.equivalentInputTokens,
						estimatedCostUsd: stats.estimatedCostUsd,
						scenario,
						stepId: step.stepId,
						phase: step.phase,
						lineage: step.lineage,
						schemaLane: step.schemaLane,
						previousStepId: step.diagnosticsPreviousRequestId,
						...(step.responseId ? { responseId: step.responseId } : {}),
						...(step.diagnostics ? { diagnostics: step.diagnostics } : {}),
					});
				}
			}
		}

		for (const policy of ["baseline", "patched"] as const) {
			const turns = turnsByPolicy[policy];
			const totals = mergeCacheUsageTotals(turns.map((turn) => turn.usage));
			const stats = buildCacheEfficiencyStats(totals, multipliers, pricing);
			policyResults.push({
				policy,
				turns,
				totals,
				equivalentInputTokens: stats.equivalentInputTokens,
				estimatedCostUsd: stats.estimatedCostUsd,
			});
		}
	} else {
		for (const policy of POLICIES) {
			const turns: TurnResult[] = [];
			const policyTtl = policy.name === "baseline" ? baselineTtl : patchedTtl;
			const systemBlocks = buildSystemBlocks(
				transcript,
				policyTtl,
				policy.cacheNamespace,
			);
			let previousResponseId: string | null = null;
			for (
				let turnIndex = 0;
				turnIndex < transcript.turns.length;
				turnIndex++
			) {
				const baseMessages = buildConversationMessages(
					transcript.turns,
					turnIndex,
				);
				const messages = applyPolicy(baseMessages, policy, policyTtl);
				const cacheBreakpointCount = countBreakpoints(systemBlocks, messages);
				const exceedsBreakpointLimit = cacheBreakpointCount > maxBreakpoints;
				if (argv.failOnBreakpointOverflow && exceedsBreakpointLimit) {
					gateFailures.push(
						`${policy.name} turn ${turnIndex + 1} has ${cacheBreakpointCount} cache breakpoints (max ${maxBreakpoints})`,
					);
				}

				let usage = normalizeCacheUsage({});
				let responseId: string | undefined;
				let diagnostics: NormalizedCacheDiagnostics | undefined;
				if (
					liveRun &&
					!(argv.failOnBreakpointOverflow && exceedsBreakpointLimit)
				) {
					const response = await callAnthropicMessagesApi(
						String(argv.apiUrl),
						apiKey,
						String(argv.anthropicVersion),
						{
							model,
							max_tokens: Number(argv.maxTokens),
							temperature: Number(argv.temperature),
							system: systemBlocks,
							messages,
						},
						Number(argv.timeoutMs),
						cacheDiagnosticsEnabled ? previousResponseId : undefined,
					);
					usage = normalizeCacheUsage(response.usage);
					responseId = response.id;
					diagnostics = response.diagnostics;
					if (
						cacheDiagnosticsEnabled &&
						turnIndex < transcript.turns.length - 1 &&
						!responseId
					) {
						throw new Error(
							`${policy.name} turn ${turnIndex + 2} requires response ID from turn ${turnIndex + 1}`,
						);
					}
					if (responseId) previousResponseId = responseId;
				}

				const stats = buildCacheEfficiencyStats(usage, multipliers, pricing);
				turns.push({
					turn: turnIndex + 1,
					userPrompt: transcript.turns[turnIndex].user,
					messageCount: messages.length,
					cacheBreakpointCount,
					usage,
					equivalentInputTokens: stats.equivalentInputTokens,
					estimatedCostUsd: stats.estimatedCostUsd,
					...(responseId ? { responseId } : {}),
					...(diagnostics ? { diagnostics } : {}),
				});
			}

			const totals = mergeCacheUsageTotals(turns.map((turn) => turn.usage));
			const stats = buildCacheEfficiencyStats(totals, multipliers, pricing);
			policyResults.push({
				policy: policy.name,
				turns,
				totals,
				equivalentInputTokens: stats.equivalentInputTokens,
				estimatedCostUsd: stats.estimatedCostUsd,
			});
		}
	}

	const baseline = policyResults.find((result) => result.policy === "baseline");
	const patched = policyResults.find((result) => result.policy === "patched");
	if (!baseline || !patched) {
		throw new Error("Missing baseline or patched result");
	}

	const comparison = evaluateCacheEfficiencyGate(
		buildCacheEfficiencyStats(baseline.totals, multipliers, pricing),
		buildCacheEfficiencyStats(patched.totals, multipliers, pricing),
		{
			maxCostRegressionPct: Number(argv.maxCostRegressionPct),
			minCacheReadDeltaTokens: Number(argv.minCacheReadDelta),
		},
	);
	if (gateFailures.length > 0) comparison.reasons.push(...gateFailures);
	if (
		liveRun &&
		!hasCacheActivity(baseline.totals) &&
		!hasCacheActivity(patched.totals)
	) {
		comparison.reasons.push(
			"Inconclusive live run: prompt caching did not engage (no cache creation/read tokens observed in either policy)",
		);
	}

	const report = {
		generatedAt: new Date().toISOString(),
		liveRun,
		model,
		transcriptPath,
		transcriptName: transcript.name ?? null,
		transcriptDescription: transcript.description ?? null,
		options: {
			preset: argv.preset,
			cacheDiagnostics: cacheDiagnosticsEnabled,
			cacheDiagnosisBeta: cacheDiagnosticsEnabled
				? CACHE_DIAGNOSTICS_BETA
				: null,
			syntheticRequestShapes: selectedScenarios !== null,
			ttl: selectedScenarios ? null : argv.ttl,
			baselineTtl: selectedScenarios ? null : baselineTtl,
			patchedTtl: selectedScenarios ? null : patchedTtl,
			scenarioTtls: selectedScenarios
				? Object.fromEntries(
						selectedScenarios.map((scenario) => [
							scenario,
							{
								stock:
									scenario === "main"
										? "1h"
										: scenario === "fork"
											? "parent=1h,fork=5m"
											: "5m",
								patched: "1h",
							},
						]),
					)
				: null,
			maxTokens: Number(argv.maxTokens),
			temperature: Number(argv.temperature),
			maxBreakpoints,
			failOnBreakpointOverflow: Boolean(argv.failOnBreakpointOverflow),
			maxCostRegressionPct: Number(argv.maxCostRegressionPct),
			minCacheReadDelta: Number(argv.minCacheReadDelta),
			multipliers,
			pricing,
		},
		policies: policyResults,
		comparison: {
			ok: comparison.ok && comparison.reasons.length === 0,
			reasons: comparison.reasons,
			deltas: comparison.deltas,
			baseline: comparison.baseline,
			patched: comparison.patched,
		},
	};

	if (argv.outputJson) {
		const outputPath = path.resolve(String(argv.outputJson));
		await fs.mkdir(path.dirname(outputPath), { recursive: true });
		await fs.writeFile(outputPath, JSON.stringify(report, null, 2), "utf-8");
		console.log(`JSON report written: ${outputPath}`);
	}

	if (argv.outputCsv) {
		const outputPath = path.resolve(String(argv.outputCsv));
		const rows = [
			[
				"policy",
				"turn",
				"message_count",
				"cache_breakpoint_count",
				"input_tokens",
				"cache_creation_input_tokens",
				"cache_creation_5m_input_tokens",
				"cache_creation_1h_input_tokens",
				"cache_creation_unscoped_input_tokens",
				"cache_read_input_tokens",
				"output_tokens",
				"equivalent_input_tokens",
				"estimated_cost_usd",
				"scenario",
				"step_id",
				"phase",
				"lineage",
				"schema_lane",
				"previous_step_id",
				"cache_diagnostic_status",
				"cache_miss_reason_type",
				"cache_missed_input_tokens",
			].join(","),
		];
		for (const policy of policyResults) {
			for (const turn of policy.turns) {
				rows.push(
					[
						toCsvValue(policy.policy),
						toCsvValue(turn.turn),
						toCsvValue(turn.messageCount),
						toCsvValue(turn.cacheBreakpointCount),
						toCsvValue(turn.usage.inputTokens),
						toCsvValue(turn.usage.cacheCreationInputTokens),
						toCsvValue(turn.usage.cacheCreation5mInputTokens),
						toCsvValue(turn.usage.cacheCreation1hInputTokens),
						toCsvValue(turn.usage.cacheCreationUnscopedInputTokens),
						toCsvValue(turn.usage.cacheReadInputTokens),
						toCsvValue(turn.usage.outputTokens),
						toCsvValue(turn.equivalentInputTokens),
						toCsvValue(turn.estimatedCostUsd),
						toCsvValue(turn.scenario ?? ""),
						toCsvValue(turn.stepId ?? ""),
						toCsvValue(turn.phase ?? ""),
						toCsvValue(turn.lineage ?? ""),
						toCsvValue(turn.schemaLane ?? ""),
						toCsvValue(turn.previousStepId ?? ""),
						toCsvValue(turn.diagnostics?.status ?? ""),
						toCsvValue(turn.diagnostics?.cacheMissReason ?? ""),
						toCsvValue(turn.diagnostics?.cacheMissedInputTokens ?? ""),
					].join(","),
				);
			}
			rows.push(
				[
					toCsvValue(policy.policy),
					"total",
					"",
					"",
					toCsvValue(policy.totals.inputTokens),
					toCsvValue(policy.totals.cacheCreationInputTokens),
					toCsvValue(policy.totals.cacheCreation5mInputTokens),
					toCsvValue(policy.totals.cacheCreation1hInputTokens),
					toCsvValue(policy.totals.cacheCreationUnscopedInputTokens),
					toCsvValue(policy.totals.cacheReadInputTokens),
					toCsvValue(policy.totals.outputTokens),
					toCsvValue(policy.equivalentInputTokens),
					toCsvValue(policy.estimatedCostUsd),
					"",
					"",
					"",
					"",
					"",
					"",
					"",
					"",
					"",
				].join(","),
			);
		}
		await fs.mkdir(path.dirname(outputPath), { recursive: true });
		await fs.writeFile(outputPath, `${rows.join("\n")}\n`, "utf-8");
		console.log(`CSV report written: ${outputPath}`);
	}

	const finalOk = report.comparison.ok;
	const cacheReadDelta = report.comparison.deltas.cacheReadInputTokens;
	const equivalentDelta = report.comparison.deltas.equivalentInputTokens;
	const costDeltaPct = report.comparison.deltas.estimatedCostPct;

	console.log(chalk.bold("\nCache Efficiency Verification\n"));
	console.log(`Transcript: ${transcriptPath}`);
	console.log(`Model:      ${model}`);
	console.log(`Preset:     ${argv.preset}`);
	console.log(`Mode:       ${liveRun ? "live API" : "dry-run planning only"}`);
	console.log(
		`Diagnostics: ${cacheDiagnosticsEnabled ? CACHE_DIAGNOSTICS_BETA : "disabled"}`,
	);
	if (selectedScenarios) {
		const ttlSummary = selectedScenarios
			.map(
				(scenario) =>
					`${scenario}(stock=${
						scenario === "main"
							? "1h"
							: scenario === "fork"
								? "parent 1h -> fork 5m"
								: "5m"
					},patched=1h)`,
			)
			.join(", ");
		console.log(`TTL:        ${ttlSummary}`);
	} else {
		console.log(`TTL:        baseline=${baselineTtl}, patched=${patchedTtl}`);
	}
	if (liveRun) {
		console.log(
			`Delta:      cache_read=${cacheReadDelta}, equivalent_input=${equivalentDelta.toFixed(2)}, estimated_cost_pct=${Number.isFinite(costDeltaPct) ? costDeltaPct.toFixed(2) : "inf"}%`,
		);
	} else {
		console.log("Delta:      not measured during dry-run planning");
	}
	if (cacheDiagnosticsEnabled && liveRun) {
		const diagnostics = policyResults.flatMap((policy) =>
			policy.turns.flatMap((turn) =>
				turn.diagnostics ? [turn.diagnostics] : [],
			),
		);
		const statuses = new Map<string, number>();
		const reasons = new Map<string, number>();
		for (const diagnostic of diagnostics) {
			statuses.set(
				diagnostic.status,
				(statuses.get(diagnostic.status) ?? 0) + 1,
			);
			if (diagnostic.cacheMissReason) {
				reasons.set(
					diagnostic.cacheMissReason,
					(reasons.get(diagnostic.cacheMissReason) ?? 0) + 1,
				);
			}
		}
		const statusSummary = [...statuses.entries()]
			.map(([status, count]) => `${status}=${count}`)
			.join(", ");
		const reasonSummary = [...reasons.entries()]
			.map(([reason, count]) => `${reason}=${count}`)
			.join(", ");
		console.log(
			`Diagnosis:  ${statusSummary || "no response diagnostics"}${reasonSummary ? `; reasons ${reasonSummary}` : ""}`,
		);
	}
	if (!finalOk) {
		for (const reason of report.comparison.reasons) {
			console.log(chalk.red(`FAIL: ${reason}`));
		}
		process.exit(1);
	}
	if (!liveRun) {
		console.log(
			chalk.green(
				"PLAN OK: request graph and breakpoint preflight passed; efficiency was not measured",
			),
		);
		return;
	}
	console.log(chalk.green("PASS: cache efficiency gate satisfied"));
}

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(chalk.red(`verify-cache-efficiency failed: ${message}`));
	process.exit(1);
});
