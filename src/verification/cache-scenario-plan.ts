export type CacheScenario = "main" | "fork" | "normal-agent" | "workflow";
export type CacheScenarioPolicy = "stock" | "patched";
export type CacheScenarioTtl = "5m" | "1h";

export interface CacheScenarioTranscript {
	system?: string;
	systemBlocks?: string[];
	minimumSystemCharacters?: number;
	turns: Array<{ user: string; assistant: string }>;
}

export interface CacheControl {
	type: "ephemeral";
	ttl?: "1h";
}

export interface CacheTextBlock {
	type: "text";
	text: string;
	cache_control?: CacheControl;
}

export interface CacheMessage {
	role: "user" | "assistant";
	content: CacheTextBlock[];
}

export interface CacheTool {
	name: string;
	description: string;
	input_schema: Record<string, unknown>;
	defer_loading?: boolean;
	cache_control?: CacheControl;
}

export interface CacheScenarioRequestBody {
	system: CacheTextBlock[];
	tools: CacheTool[];
	messages: CacheMessage[];
}

export interface CacheBreakpointCounts {
	system: number;
	tools: number;
	messages: number;
	total: number;
}

export interface CacheScenarioRequest {
	id: string;
	phase: "main" | "parent" | "fork" | "agent" | "workflow";
	lineage: string;
	schemaLane: string;
	diagnosticsPreviousRequestId: string | null;
	parentRequestId?: string;
	body: CacheScenarioRequestBody;
	breakpoints: CacheBreakpointCounts;
}

export interface CacheScenarioPlan {
	scenario: CacheScenario;
	policy: CacheScenarioPolicy;
	ttl: CacheScenarioTtl | "mixed";
	requests: CacheScenarioRequest[];
}

interface BuildCacheScenarioPlansOptions {
	scenario: CacheScenario;
	transcript: CacheScenarioTranscript;
}

function cacheControl(ttl: CacheScenarioTtl): CacheControl {
	return ttl === "1h"
		? { type: "ephemeral", ttl: "1h" }
		: { type: "ephemeral" };
}

function cloneMessage(message: CacheMessage): CacheMessage {
	return {
		role: message.role,
		content: message.content.map((block) => ({
			...block,
			...(block.cache_control
				? { cache_control: { ...block.cache_control } }
				: {}),
		})),
	};
}

function cloneTool(tool: CacheTool): CacheTool {
	return {
		...tool,
		input_schema: structuredClone(tool.input_schema),
		...(tool.cache_control ? { cache_control: { ...tool.cache_control } } : {}),
	};
}

function buildMessagesThroughTurn(
	transcript: CacheScenarioTranscript,
	turnIndex: number,
): CacheMessage[] {
	const messages: CacheMessage[] = [];
	for (let index = 0; index <= turnIndex; index++) {
		const turn = transcript.turns[index];
		messages.push({
			role: "user",
			content: [{ type: "text", text: turn.user }],
		});
		if (index < turnIndex) {
			messages.push({
				role: "assistant",
				content: [{ type: "text", text: turn.assistant }],
			});
		}
	}
	return messages;
}

export function padCacheSystemText(
	sourceBlocks: string[],
	minimumCharacters: number,
	segmentLabel: string,
): string[] {
	const source = sourceBlocks.slice();
	if (source.length === 0) source.push("Stable cache benchmark system policy.");
	const minimum = Math.max(0, Math.floor(minimumCharacters));
	let segment = 1;
	while (source.reduce((total, text) => total + text.length, 0) < minimum) {
		source[0] +=
			`\nSynthetic stable ${segmentLabel} segment ${segment}: ` +
			"preserve ordered tools, deterministic schemas, and unchanged workspace context.";
		segment += 1;
	}
	return source;
}

function buildSystemBlocks(
	transcript: CacheScenarioTranscript,
	scenario: CacheScenario,
	policy: CacheScenarioPolicy,
	ttl: CacheScenarioTtl,
): CacheTextBlock[] {
	let source =
		transcript.systemBlocks && transcript.systemBlocks.length > 0
			? transcript.systemBlocks.slice(0, 2)
			: transcript.system
				? [transcript.system]
				: ["Stable cache benchmark system policy."];
	if (source.length === 1) {
		source.push(`Stable ${scenario} request identity and workspace context.`);
	}
	source = padCacheSystemText(
		source,
		transcript.minimumSystemCharacters ?? 0,
		"cache protocol",
	);
	const namespace = policy === "stock" ? "policy:a" : "policy:b";
	source[0] += `\n[cache-benchmark-namespace:${namespace}]`;
	return source.map((text) => ({
		type: "text",
		text,
		cache_control: cacheControl(ttl),
	}));
}

function schemaForLane(lane: string): Record<string, unknown> {
	if (lane === "surface") {
		return {
			type: "object",
			properties: {
				surface: { type: "string" },
				drift: { type: "boolean" },
			},
			required: ["surface", "drift"],
			additionalProperties: false,
		};
	}
	return {
		type: "object",
		properties: {
			status: { enum: ["pass", "fail"] },
			evidence: { type: "array", items: { type: "string" } },
		},
		required: ["status", "evidence"],
		additionalProperties: false,
	};
}

function buildTools(lane: string): CacheTool[] {
	return [
		{
			name: "ReadEvidence",
			description: "Read one synthetic evidence record.",
			input_schema: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
				additionalProperties: false,
			},
		},
		{
			name: "SearchEvidence",
			description: "Search the synthetic evidence index.",
			input_schema: {
				type: "object",
				properties: { query: { type: "string" } },
				required: ["query"],
				additionalProperties: false,
			},
		},
		{
			name: "StructuredOutput",
			description: `Return the ${lane} result schema.`,
			input_schema: schemaForLane(lane),
		},
	];
}

function markMessages(
	messages: CacheMessage[],
	indexes: Iterable<number>,
	ttl: CacheScenarioTtl,
): CacheMessage[] {
	const marked = new Set(indexes);
	return messages.map((message, index) => {
		const next = cloneMessage(message);
		if (!marked.has(index) || next.content.length === 0) return next;
		const blockIndex = next.content.length - 1;
		next.content[blockIndex] = {
			...next.content[blockIndex],
			cache_control: cacheControl(ttl),
		};
		return next;
	});
}

function stockMessageIndexes(
	messages: CacheMessage[],
	forkIndex: number | undefined,
): number[] {
	if (messages.length === 0) return [];
	const latest = messages.length - 1;
	if (forkIndex !== undefined && forkIndex >= 0 && forkIndex < latest) {
		return [forkIndex, latest];
	}
	return latest > 0 ? [latest - 1, latest] : [latest];
}

function patchedMessageIndexes(
	messages: CacheMessage[],
	forkIndex: number | undefined,
	messageBudget: number,
): number[] {
	if (messageBudget <= 0) return [];
	const userIndexes = messages.flatMap((message, index) =>
		message.role === "user" ? [index] : [],
	);
	const decimation = new Set(
		userIndexes.filter((_, ordinal) => (ordinal + 1) % 15 === 0),
	);
	const candidates = new Set<number>();
	for (const index of userIndexes.slice(-2)) candidates.add(index);
	for (const index of decimation) candidates.add(index);
	if (forkIndex !== undefined) candidates.add(forkIndex);

	const chronological = [...candidates].sort((left, right) => left - right);
	const prioritized: number[] = [];
	const add = (index: number | undefined): void => {
		if (index === undefined || prioritized.includes(index)) return;
		prioritized.push(index);
	};
	const latest = chronological.at(-1);
	const latestStable = chronological
		.slice(0, -1)
		.reverse()
		.find((index) => !decimation.has(index));
	const latestDecimation = chronological
		.slice()
		.reverse()
		.find((index) => decimation.has(index));

	add(latestStable);
	add(latest);
	add(latestDecimation);
	for (const index of chronological.slice().reverse()) add(index);
	return prioritized
		.slice(0, messageBudget)
		.sort((left, right) => left - right);
}

function applyPolicy(
	rawBody: CacheScenarioRequestBody,
	policy: CacheScenarioPolicy,
	ttl: CacheScenarioTtl,
	forkIndex?: number,
): CacheScenarioRequestBody {
	const system = rawBody.system.map((block) => ({
		...block,
		cache_control: cacheControl(ttl),
	}));
	const tools = rawBody.tools.map((tool) => {
		const next = cloneTool(tool);
		delete next.cache_control;
		return next;
	});

	if (policy === "stock") {
		return {
			system,
			tools,
			messages: markMessages(
				rawBody.messages,
				stockMessageIndexes(rawBody.messages, forkIndex),
				ttl,
			),
		};
	}

	for (let index = tools.length - 1; index >= 0; index--) {
		if (tools[index].defer_loading) continue;
		tools[index].cache_control = cacheControl("1h");
		break;
	}
	const systemToolCount =
		system.filter((block) => block.cache_control).length +
		tools.filter((tool) => tool.cache_control).length;
	const messageBudget = Math.max(0, 4 - systemToolCount);
	return {
		system,
		tools,
		messages: markMessages(
			rawBody.messages,
			patchedMessageIndexes(rawBody.messages, forkIndex, messageBudget),
			"1h",
		),
	};
}

export function countRequestCacheBreakpoints(
	body: CacheScenarioRequestBody,
): CacheBreakpointCounts {
	const system = body.system.filter((block) => block.cache_control).length;
	const tools = body.tools.filter((tool) => tool.cache_control).length;
	let messages = 0;
	for (const message of body.messages) {
		for (const block of message.content) {
			if (block.cache_control) messages += 1;
		}
	}
	return { system, tools, messages, total: system + tools + messages };
}

function ttlForPlan(
	scenario: CacheScenario,
	policy: CacheScenarioPolicy,
): CacheScenarioPlan["ttl"] {
	if (scenario === "main" || policy === "patched") return "1h";
	if (scenario === "fork") return "mixed";
	return "5m";
}

function ttlForRequest(
	scenario: CacheScenario,
	policy: CacheScenarioPolicy,
	phase: CacheScenarioRequest["phase"],
): CacheScenarioTtl {
	if (policy === "patched" || scenario === "main" || phase === "parent") {
		return "1h";
	}
	return "5m";
}

function buildRequest(
	plan: Pick<CacheScenarioPlan, "scenario" | "policy" | "ttl">,
	transcript: CacheScenarioTranscript,
	options: {
		id: string;
		phase: CacheScenarioRequest["phase"];
		lineage: string;
		schemaLane: string;
		messages: CacheMessage[];
		diagnosticsPreviousRequestId: string | null;
		parentRequestId?: string;
		forkIndex?: number;
	},
): CacheScenarioRequest {
	const requestTtl = ttlForRequest(plan.scenario, plan.policy, options.phase);
	const rawBody: CacheScenarioRequestBody = {
		system: buildSystemBlocks(
			transcript,
			plan.scenario,
			plan.policy,
			requestTtl,
		),
		tools: buildTools(options.schemaLane),
		messages: options.messages.map((message) => cloneMessage(message)),
	};
	const body = applyPolicy(rawBody, plan.policy, requestTtl, options.forkIndex);
	return {
		id: options.id,
		phase: options.phase,
		lineage: options.lineage,
		schemaLane: options.schemaLane,
		diagnosticsPreviousRequestId: options.diagnosticsPreviousRequestId,
		...(options.parentRequestId
			? { parentRequestId: options.parentRequestId }
			: {}),
		body,
		breakpoints: countRequestCacheBreakpoints(body),
	};
}

function buildPolicyPlan(
	scenario: CacheScenario,
	policy: CacheScenarioPolicy,
	transcript: CacheScenarioTranscript,
): CacheScenarioPlan {
	const ttl = ttlForPlan(scenario, policy);
	const plan: CacheScenarioPlan = { scenario, policy, ttl, requests: [] };
	const prefix = `${policy}:${scenario}`;

	if (scenario === "main") {
		let previousRequestId: string | null = null;
		for (let turnIndex = 0; turnIndex < 2; turnIndex++) {
			const id = `${prefix}:turn-${turnIndex + 1}`;
			plan.requests.push(
				buildRequest(plan, transcript, {
					id,
					phase: "main",
					lineage: `${prefix}:lineage`,
					schemaLane: "interactive",
					messages: buildMessagesThroughTurn(transcript, turnIndex),
					diagnosticsPreviousRequestId: previousRequestId,
				}),
			);
			previousRequestId = id;
		}
		return plan;
	}

	if (scenario === "fork") {
		const parentTurnIndex = Math.min(transcript.turns.length - 2, 15);
		const parentMessages = buildMessagesThroughTurn(
			transcript,
			parentTurnIndex,
		);
		const parentId = `${prefix}:parent`;
		plan.requests.push(
			buildRequest(plan, transcript, {
				id: parentId,
				phase: "parent",
				lineage: `${prefix}:parent-lineage`,
				schemaLane: "interactive",
				messages: parentMessages,
				diagnosticsPreviousRequestId: null,
			}),
		);
		const branchTurn = transcript.turns[parentTurnIndex + 1];
		let diagnosticsPreviousRequestId = parentId;
		for (const branch of ["a", "b"] as const) {
			const id = `${prefix}:branch-${branch}`;
			const messages = [
				...parentMessages.map((message) => cloneMessage(message)),
				{
					role: "user" as const,
					content: [
						{
							type: "text" as const,
							text: `${branchTurn.user}\nSynthetic fork branch: ${branch}`,
						},
					],
				},
			];
			plan.requests.push(
				buildRequest(plan, transcript, {
					id,
					phase: "fork",
					lineage: `${prefix}:branch-${branch}-lineage`,
					schemaLane: "interactive",
					messages,
					diagnosticsPreviousRequestId,
					parentRequestId: parentId,
					forkIndex: parentMessages.length - 1,
				}),
			);
			diagnosticsPreviousRequestId = id;
		}
		return plan;
	}

	if (scenario === "normal-agent") {
		let previousRequestId: string | null = null;
		for (let index = 0; index < 2; index++) {
			const id = `${prefix}:peer-${index + 1}`;
			plan.requests.push(
				buildRequest(plan, transcript, {
					id,
					phase: "agent",
					lineage: `${id}:lineage`,
					schemaLane: "unit",
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: transcript.turns[index].user }],
						},
					],
					diagnosticsPreviousRequestId: previousRequestId,
				}),
			);
			previousRequestId = id;
		}
		return plan;
	}

	const workflowLanes = ["unit", "unit", "surface"];
	let warmRequestId: string | null = null;
	for (const [index, lane] of workflowLanes.entries()) {
		const id = `${prefix}:request-${index + 1}`;
		plan.requests.push(
			buildRequest(plan, transcript, {
				id,
				phase: "workflow",
				lineage: `${id}:lineage`,
				schemaLane: lane,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: transcript.turns[index].user }],
					},
				],
				diagnosticsPreviousRequestId: warmRequestId,
			}),
		);
		if (warmRequestId === null) warmRequestId = id;
	}
	return plan;
}

export function buildCacheScenarioPlans(
	options: BuildCacheScenarioPlansOptions,
): CacheScenarioPlan[] {
	if (
		!Array.isArray(options.transcript.turns) ||
		options.transcript.turns.length < 4
	) {
		throw new Error(
			"Cache scenario transcript must contain at least four turns",
		);
	}
	return (["stock", "patched"] as const).map((policy) =>
		buildPolicyPlan(options.scenario, policy, options.transcript),
	);
}
