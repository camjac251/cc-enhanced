import type { NormalizedCacheDiagnostics } from "./cache-diagnostics.js";
import {
	type CacheScenarioPlan,
	type CacheScenarioRequestBody,
	countRequestCacheBreakpoints,
} from "./cache-scenario-plan.js";

export interface CacheScenarioTransportCall {
	stepId: string;
	body: Record<string, unknown>;
	diagnosticsPreviousMessageId?: string | null;
}

export interface CacheScenarioTransportResponse {
	id?: string;
	usage: unknown;
	diagnostics?: NormalizedCacheDiagnostics;
}

export type CacheScenarioTransport = (
	call: CacheScenarioTransportCall,
) => Promise<CacheScenarioTransportResponse>;

export interface CacheScenarioExecutionOptions {
	liveRun: boolean;
	diagnosticsEnabled: boolean;
	model: string;
	maxTokens: number;
	temperature: number;
	maxBreakpoints: number;
}

export interface CacheScenarioExecutionStep {
	stepId: string;
	phase: string;
	lineage: string;
	schemaLane: string;
	diagnosticsPreviousRequestId: string | null;
	cacheBreakpointCount: number;
	messageCount: number;
	usage: unknown;
	responseId?: string;
	diagnostics?: NormalizedCacheDiagnostics;
}

export interface CacheScenarioExecutionResult {
	scenario: CacheScenarioPlan["scenario"];
	policy: CacheScenarioPlan["policy"];
	ttl: CacheScenarioPlan["ttl"];
	steps: CacheScenarioExecutionStep[];
}

function sameBreakpointCounts(
	left: ReturnType<typeof countRequestCacheBreakpoints>,
	right: ReturnType<typeof countRequestCacheBreakpoints>,
): boolean {
	return (
		left.system === right.system &&
		left.tools === right.tools &&
		left.messages === right.messages &&
		left.total === right.total
	);
}

function withoutCacheControl(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutCacheControl);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => key !== "cache_control")
			.map(([key, child]) => [key, withoutCacheControl(child)]),
	);
}

function sameCachePrefix(left: unknown, right: unknown): boolean {
	return (
		JSON.stringify(withoutCacheControl(left)) ===
		JSON.stringify(withoutCacheControl(right))
	);
}

function markedMessageIndexes(body: CacheScenarioRequestBody): number[] {
	return body.messages.flatMap((message, index) =>
		message.content.some((block) => block.cache_control) ? [index] : [],
	);
}

function hasReusableMessagePrefix(
	predecessor: CacheScenarioPlan["requests"][number],
	request: CacheScenarioPlan["requests"][number],
): boolean {
	const predecessorIndexes = markedMessageIndexes(predecessor.body);
	const requestIndexes = markedMessageIndexes(request.body);
	for (const predecessorIndex of predecessorIndexes) {
		for (const requestIndex of requestIndexes) {
			if (predecessorIndex > requestIndex) continue;
			const interveningBlocks = request.body.messages
				.slice(predecessorIndex + 1, requestIndex + 1)
				.reduce((total, message) => total + message.content.length, 0);
			if (interveningBlocks > 20) continue;
			if (
				sameCachePrefix(
					predecessor.body.messages.slice(0, predecessorIndex + 1),
					request.body.messages.slice(0, predecessorIndex + 1),
				)
			) {
				return true;
			}
		}
	}
	return false;
}

function validatePlan(plan: CacheScenarioPlan, maxBreakpoints: number): void {
	const seen = new Set<string>();
	const priorRequests = new Map<
		string,
		CacheScenarioPlan["requests"][number]
	>();
	for (const request of plan.requests) {
		if (seen.has(request.id)) {
			throw new Error(`Duplicate cache scenario step ID: ${request.id}`);
		}
		if (
			request.diagnosticsPreviousRequestId !== null &&
			!seen.has(request.diagnosticsPreviousRequestId)
		) {
			throw new Error(
				`${request.id} references unavailable predecessor ${request.diagnosticsPreviousRequestId}`,
			);
		}
		const actual = countRequestCacheBreakpoints(request.body);
		if (!sameBreakpointCounts(actual, request.breakpoints)) {
			throw new Error(
				`${request.id} cache breakpoints disagree with its declared inventory`,
			);
		}
		if (actual.total > maxBreakpoints) {
			throw new Error(
				`${request.id} has ${actual.total} cache breakpoints (max ${maxBreakpoints})`,
			);
		}
		if (request.phase === "fork") {
			const parent = request.parentRequestId
				? priorRequests.get(request.parentRequestId)
				: undefined;
			if (parent?.phase !== "parent") {
				throw new Error(
					`${request.id} requires an earlier fork parent request`,
				);
			}
			if (
				!sameCachePrefix(request.body.system, parent.body.system) ||
				!sameCachePrefix(request.body.tools, parent.body.tools) ||
				!sameCachePrefix(
					request.body.messages.slice(0, parent.body.messages.length),
					parent.body.messages,
				)
			) {
				throw new Error(
					`${request.id} does not preserve its fork parent prefix`,
				);
			}
			const diagnosticPredecessor = request.diagnosticsPreviousRequestId
				? priorRequests.get(request.diagnosticsPreviousRequestId)
				: undefined;
			if (
				!diagnosticPredecessor ||
				!hasReusableMessagePrefix(diagnosticPredecessor, request)
			) {
				throw new Error(
					`${request.id} has no reusable message checkpoint within the 20-block cache lookback`,
				);
			}
		}
		seen.add(request.id);
		priorRequests.set(request.id, request);
	}
}

function buildApiBody(
	requestBody: CacheScenarioRequestBody,
	options: CacheScenarioExecutionOptions,
): Record<string, unknown> {
	return {
		model: options.model,
		max_tokens: options.maxTokens,
		temperature: options.temperature,
		...structuredClone(requestBody),
	};
}

export async function executeCacheScenarioPlan(
	plan: CacheScenarioPlan,
	transport: CacheScenarioTransport,
	options: CacheScenarioExecutionOptions,
): Promise<CacheScenarioExecutionResult> {
	validatePlan(plan, options.maxBreakpoints);
	const responseIds = new Map<string, string>();
	const steps: CacheScenarioExecutionStep[] = [];

	for (const request of plan.requests) {
		let diagnosticsPreviousMessageId: string | null | undefined;
		if (options.diagnosticsEnabled) {
			if (request.diagnosticsPreviousRequestId === null) {
				diagnosticsPreviousMessageId = null;
			} else {
				diagnosticsPreviousMessageId = responseIds.get(
					request.diagnosticsPreviousRequestId,
				);
				if (!diagnosticsPreviousMessageId && options.liveRun) {
					throw new Error(
						`${request.id} requires response ID from ${request.diagnosticsPreviousRequestId}`,
					);
				}
			}
		}

		let response: CacheScenarioTransportResponse = { usage: {} };
		if (options.liveRun) {
			response = await transport({
				stepId: request.id,
				body: buildApiBody(request.body, options),
				...(options.diagnosticsEnabled ? { diagnosticsPreviousMessageId } : {}),
			});
			if (response.id) responseIds.set(request.id, response.id);
		}

		steps.push({
			stepId: request.id,
			phase: request.phase,
			lineage: request.lineage,
			schemaLane: request.schemaLane,
			diagnosticsPreviousRequestId: request.diagnosticsPreviousRequestId,
			cacheBreakpointCount: request.breakpoints.total,
			messageCount: request.body.messages.length,
			usage: response.usage,
			...(response.id ? { responseId: response.id } : {}),
			...(response.diagnostics ? { diagnostics: response.diagnostics } : {}),
		});
	}

	return {
		scenario: plan.scenario,
		policy: plan.policy,
		ttl: plan.ttl,
		steps,
	};
}
