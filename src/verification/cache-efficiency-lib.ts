export interface CacheUsageTotals {
	inputTokens: number;
	outputTokens: number;
	cacheCreationInputTokens: number;
	cacheReadInputTokens: number;
	cacheCreation5mInputTokens: number;
	cacheCreation1hInputTokens: number;
	cacheCreationUnscopedInputTokens: number;
}

export interface CacheCostMultipliers {
	write5m: number;
	write1h: number;
	writeDefault: number;
	read: number;
}

export interface CachePricingPerMillionTokens {
	inputUsdPerMillion: number;
	outputUsdPerMillion: number;
}

export interface CacheEfficiencyStats {
	equivalentInputTokens: number;
	estimatedCostUsd: number;
	totals: CacheUsageTotals;
}

export interface CacheEfficiencyGateOptions {
	maxCostRegressionPct: number;
	minCacheReadDeltaTokens: number;
}

export interface CacheEfficiencyGateResult {
	ok: boolean;
	reasons: string[];
	baseline: CacheEfficiencyStats;
	patched: CacheEfficiencyStats;
	deltas: {
		cacheReadInputTokens: number;
		equivalentInputTokens: number;
		estimatedCostUsd: number;
		estimatedCostPct: number;
	};
}

type UnknownRecord = Record<string, unknown>;

function asFiniteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function getNestedNumber(value: unknown, key: string): number {
	if (!value || typeof value !== "object") return 0;
	return asFiniteNumber((value as UnknownRecord)[key]);
}

export function normalizeCacheUsage(usage: unknown): CacheUsageTotals {
	const usageObj =
		usage && typeof usage === "object" ? (usage as UnknownRecord) : {};
	const cacheCreation = getNestedNumber(
		usageObj,
		"cache_creation_input_tokens",
	);
	const cacheCreationObj = usageObj.cache_creation;
	const cacheCreation5m = getNestedNumber(
		cacheCreationObj,
		"ephemeral_5m_input_tokens",
	);
	const cacheCreation1h = getNestedNumber(
		cacheCreationObj,
		"ephemeral_1h_input_tokens",
	);
	const scopedCreationTotal = cacheCreation5m + cacheCreation1h;
	return {
		inputTokens: getNestedNumber(usageObj, "input_tokens"),
		outputTokens: getNestedNumber(usageObj, "output_tokens"),
		cacheCreationInputTokens: cacheCreation,
		cacheReadInputTokens: getNestedNumber(usageObj, "cache_read_input_tokens"),
		cacheCreation5mInputTokens: cacheCreation5m,
		cacheCreation1hInputTokens: cacheCreation1h,
		cacheCreationUnscopedInputTokens: Math.max(
			0,
			cacheCreation - scopedCreationTotal,
		),
	};
}

export function mergeCacheUsageTotals(
	usages: CacheUsageTotals[],
): CacheUsageTotals {
	return usages.reduce<CacheUsageTotals>(
		(acc, usage) => ({
			inputTokens: acc.inputTokens + usage.inputTokens,
			outputTokens: acc.outputTokens + usage.outputTokens,
			cacheCreationInputTokens:
				acc.cacheCreationInputTokens + usage.cacheCreationInputTokens,
			cacheReadInputTokens:
				acc.cacheReadInputTokens + usage.cacheReadInputTokens,
			cacheCreation5mInputTokens:
				acc.cacheCreation5mInputTokens + usage.cacheCreation5mInputTokens,
			cacheCreation1hInputTokens:
				acc.cacheCreation1hInputTokens + usage.cacheCreation1hInputTokens,
			cacheCreationUnscopedInputTokens:
				acc.cacheCreationUnscopedInputTokens +
				usage.cacheCreationUnscopedInputTokens,
		}),
		{
			inputTokens: 0,
			outputTokens: 0,
			cacheCreationInputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreation5mInputTokens: 0,
			cacheCreation1hInputTokens: 0,
			cacheCreationUnscopedInputTokens: 0,
		},
	);
}

export function hasCacheActivity(totals: CacheUsageTotals): boolean {
	return (
		totals.cacheCreationInputTokens > 0 ||
		totals.cacheReadInputTokens > 0 ||
		totals.cacheCreation5mInputTokens > 0 ||
		totals.cacheCreation1hInputTokens > 0 ||
		totals.cacheCreationUnscopedInputTokens > 0
	);
}

export function estimateEquivalentInputTokens(
	totals: CacheUsageTotals,
	multipliers: CacheCostMultipliers,
): number {
	return (
		totals.inputTokens +
		totals.cacheCreation5mInputTokens * multipliers.write5m +
		totals.cacheCreation1hInputTokens * multipliers.write1h +
		totals.cacheCreationUnscopedInputTokens * multipliers.writeDefault +
		totals.cacheReadInputTokens * multipliers.read
	);
}

export function estimateCostUsd(
	totals: CacheUsageTotals,
	multipliers: CacheCostMultipliers,
	pricing: CachePricingPerMillionTokens,
): number {
	const equivalentInput = estimateEquivalentInputTokens(totals, multipliers);
	const inputCost = (equivalentInput / 1_000_000) * pricing.inputUsdPerMillion;
	const outputCost =
		(totals.outputTokens / 1_000_000) * pricing.outputUsdPerMillion;
	return inputCost + outputCost;
}

export function buildCacheEfficiencyStats(
	totals: CacheUsageTotals,
	multipliers: CacheCostMultipliers,
	pricing: CachePricingPerMillionTokens,
): CacheEfficiencyStats {
	return {
		equivalentInputTokens: estimateEquivalentInputTokens(totals, multipliers),
		estimatedCostUsd: estimateCostUsd(totals, multipliers, pricing),
		totals,
	};
}

function asPct(base: number, delta: number): number {
	if (base === 0) return delta === 0 ? 0 : Infinity;
	return (delta / base) * 100;
}

export function evaluateCacheEfficiencyGate(
	baseline: CacheEfficiencyStats,
	patched: CacheEfficiencyStats,
	options: CacheEfficiencyGateOptions,
): CacheEfficiencyGateResult {
	const reasons: string[] = [];
	const costDelta = patched.estimatedCostUsd - baseline.estimatedCostUsd;
	const costDeltaPct = asPct(baseline.estimatedCostUsd, costDelta);
	const readDelta =
		patched.totals.cacheReadInputTokens - baseline.totals.cacheReadInputTokens;
	const equivalentDelta =
		patched.equivalentInputTokens - baseline.equivalentInputTokens;

	const maxAllowedCost =
		baseline.estimatedCostUsd * (1 + options.maxCostRegressionPct / 100);
	if (patched.estimatedCostUsd > maxAllowedCost) {
		reasons.push(
			`Estimated cost regression ${costDeltaPct.toFixed(2)}% exceeds allowed ${options.maxCostRegressionPct.toFixed(2)}%`,
		);
	}

	if (readDelta < options.minCacheReadDeltaTokens) {
		reasons.push(
			`cache_read_input_tokens delta ${readDelta} is below required minimum ${options.minCacheReadDeltaTokens}`,
		);
	}

	return {
		ok: reasons.length === 0,
		reasons,
		baseline,
		patched,
		deltas: {
			cacheReadInputTokens: readDelta,
			equivalentInputTokens: equivalentDelta,
			estimatedCostUsd: costDelta,
			estimatedCostPct: costDeltaPct,
		},
	};
}
