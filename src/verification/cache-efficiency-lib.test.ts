import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildCacheEfficiencyStats,
	evaluateCacheEfficiencyGate,
	hasCacheActivity,
	mergeCacheUsageTotals,
	normalizeCacheUsage,
} from "./cache-efficiency-lib.js";

test("normalizeCacheUsage derives scoped and unscoped cache creation tokens", () => {
	const usage = normalizeCacheUsage({
		input_tokens: 1000,
		output_tokens: 50,
		cache_creation_input_tokens: 700,
		cache_read_input_tokens: 600,
		cache_creation: {
			ephemeral_5m_input_tokens: 300,
			ephemeral_1h_input_tokens: 200,
		},
	});

	assert.equal(usage.inputTokens, 1000);
	assert.equal(usage.outputTokens, 50);
	assert.equal(usage.cacheCreationInputTokens, 700);
	assert.equal(usage.cacheCreation5mInputTokens, 300);
	assert.equal(usage.cacheCreation1hInputTokens, 200);
	assert.equal(usage.cacheCreationUnscopedInputTokens, 200);
	assert.equal(usage.cacheReadInputTokens, 600);
});

test("evaluateCacheEfficiencyGate reports cost regressions and read-token drops", () => {
	const multipliers = {
		write5m: 1.25,
		write1h: 2,
		writeDefault: 1.25,
		read: 0.1,
	};
	const pricing = {
		inputUsdPerMillion: 1,
		outputUsdPerMillion: 0,
	};

	const baselineTotals = mergeCacheUsageTotals([
		normalizeCacheUsage({
			input_tokens: 10000,
			cache_creation_input_tokens: 5000,
			cache_read_input_tokens: 8000,
			cache_creation: { ephemeral_5m_input_tokens: 5000 },
		}),
	]);
	const patchedTotals = mergeCacheUsageTotals([
		normalizeCacheUsage({
			input_tokens: 15000,
			cache_creation_input_tokens: 7000,
			cache_read_input_tokens: 3000,
			cache_creation: { ephemeral_5m_input_tokens: 7000 },
		}),
	]);

	const result = evaluateCacheEfficiencyGate(
		buildCacheEfficiencyStats(baselineTotals, multipliers, pricing),
		buildCacheEfficiencyStats(patchedTotals, multipliers, pricing),
		{
			maxCostRegressionPct: 0,
			minCacheReadDeltaTokens: 0,
		},
	);

	assert.equal(result.ok, false);
	assert.equal(
		result.reasons.some((reason) =>
			reason.includes("Estimated cost regression"),
		),
		true,
	);
	assert.equal(
		result.reasons.some((reason) =>
			reason.includes("cache_read_input_tokens delta"),
		),
		true,
	);
});

test("hasCacheActivity detects cache write/read usage", () => {
	assert.equal(
		hasCacheActivity(
			normalizeCacheUsage({
				input_tokens: 100,
				output_tokens: 10,
			}),
		),
		false,
	);
	assert.equal(
		hasCacheActivity(
			normalizeCacheUsage({
				input_tokens: 100,
				output_tokens: 10,
				cache_read_input_tokens: 1,
			}),
		),
		true,
	);
	assert.equal(
		hasCacheActivity(
			normalizeCacheUsage({
				cache_creation_input_tokens: 3,
				cache_creation: { ephemeral_5m_input_tokens: 3 },
			}),
		),
		true,
	);
});
