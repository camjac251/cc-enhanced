import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
	buildCacheScenarioPlans,
	type CacheScenario,
	type CacheScenarioTranscript,
	countRequestCacheBreakpoints,
} from "./cache-scenario-plan.js";

const transcript: CacheScenarioTranscript = {
	systemBlocks: ["Stable benchmark system policy."],
	turns: Array.from({ length: 17 }, (_, index) => ({
		user: `user-${index + 1}`,
		assistant: `assistant-${index + 1}`,
	})),
};

function getPolicy(scenario: CacheScenario, policy: "stock" | "patched") {
	const plans = buildCacheScenarioPlans({ scenario, transcript });
	const result = plans.find((candidate) => candidate.policy === policy);
	assert.ok(result, `missing ${policy} plan for ${scenario}`);
	return result;
}

function markedMessageIndexes(
	request: ReturnType<typeof getPolicy>["requests"][number],
): number[] {
	return request.body.messages.flatMap((message, index) =>
		message.content.some((block) => block.cache_control) ? [index] : [],
	);
}

test("all cache mode plans stay inside the four-breakpoint API limit", () => {
	for (const scenario of [
		"main",
		"fork",
		"normal-agent",
		"workflow",
	] as const) {
		for (const plan of buildCacheScenarioPlans({ scenario, transcript })) {
			for (const request of plan.requests) {
				const counts = countRequestCacheBreakpoints(request.body);
				assert.equal(counts.total, request.breakpoints.total);
				assert.ok(
					counts.total <= 4,
					`${scenario}/${plan.policy}/${request.id} has ${counts.total} breakpoints`,
				);
				for (const tool of request.body.tools) {
					if (tool.defer_loading) assert.equal(tool.cache_control, undefined);
				}
			}
		}
	}
});

test("main mode keeps stock and patched TTL at one hour while removing assistant-tail writes", () => {
	const stock = getPolicy("main", "stock");
	const patched = getPolicy("main", "patched");

	assert.equal(stock.ttl, "1h");
	assert.equal(patched.ttl, "1h");
	assert.ok(stock.requests.length >= 2);
	assert.equal(stock.requests.length, patched.requests.length);

	const stockWarm = stock.requests.at(-1);
	const patchedWarm = patched.requests.at(-1);
	assert.ok(stockWarm && patchedWarm);
	assert.ok(
		stockWarm.body.messages.some(
			(message) =>
				message.role === "assistant" &&
				message.content.some((block) => block.cache_control),
		),
	);
	assert.equal(
		patchedWarm.body.messages.some(
			(message) =>
				message.role === "assistant" &&
				message.content.some((block) => block.cache_control),
		),
		false,
	);
	assert.equal(patchedWarm.breakpoints.tools, 1);
	assert.equal(stockWarm.breakpoints.tools, 0);
	assert.equal(
		stockWarm.diagnosticsPreviousRequestId,
		stock.requests.at(-2)?.id,
	);
});

test("fork mode branches twice from one warmed parent and prioritizes its inherited checkpoint", () => {
	const stock = getPolicy("fork", "stock");
	const patched = getPolicy("fork", "patched");
	const parent = patched.requests.find((request) => request.phase === "parent");
	const branches = patched.requests.filter(
		(request) => request.phase === "fork",
	);

	assert.ok(parent);
	assert.equal(branches.length, 2);
	for (const branch of branches) {
		assert.equal(branch.parentRequestId, parent.id);
		assert.equal(branch.breakpoints.messages, 1);
		const marked = branch.body.messages.flatMap((message, index) =>
			message.content.some((block) => block.cache_control) ? [index] : [],
		);
		assert.deepEqual(marked, [parent.body.messages.length - 1]);
	}
	assert.equal(branches[0].diagnosticsPreviousRequestId, parent.id);
	assert.equal(branches[1].diagnosticsPreviousRequestId, branches[0].id);
	assert.notEqual(branches[0].lineage, branches[1].lineage);
	assert.deepEqual(
		branches[0].body.messages.slice(0, -1),
		branches[1].body.messages.slice(0, -1),
	);
	assert.equal(stock.ttl, "mixed");
	assert.equal(stock.requests[0].body.system[0].cache_control?.ttl, "1h");
	assert.equal(stock.requests[1].body.system[0].cache_control?.ttl, undefined);
});

test("checked-in fork fixture warms a reusable parent prefix before the sibling fork checkpoint", async () => {
	const fixture = JSON.parse(
		await readFile(
			new URL("./fixtures/cache-transcript-scenarios.json", import.meta.url),
			"utf8",
		),
	) as CacheScenarioTranscript;
	const patched = buildCacheScenarioPlans({
		scenario: "fork",
		transcript: fixture,
	}).find((candidate) => candidate.policy === "patched");
	assert.ok(patched);
	const parent = patched.requests.find((request) => request.phase === "parent");
	const branches = patched.requests.filter(
		(request) => request.phase === "fork",
	);
	assert.ok(parent);
	assert.equal(branches.length, 2);
	assert.deepEqual(markedMessageIndexes(parent), [2]);
	assert.deepEqual(markedMessageIndexes(branches[0]), [4]);
	assert.deepEqual(markedMessageIndexes(branches[1]), [4]);
	assert.equal(branches[0].diagnosticsPreviousRequestId, parent.id);
	assert.equal(branches[1].diagnosticsPreviousRequestId, branches[0].id);
	assert.deepEqual(
		branches[0].body.messages.slice(0, parent.body.messages.length),
		branches[1].body.messages.slice(0, parent.body.messages.length),
	);
});

test("normal agent peers are fresh lineages with a shared cache prefix", () => {
	const stock = getPolicy("normal-agent", "stock");
	const patched = getPolicy("normal-agent", "patched");

	assert.equal(stock.ttl, "5m");
	assert.equal(patched.ttl, "1h");
	assert.equal(
		new Set(patched.requests.map((request) => request.lineage)).size,
		2,
	);
	assert.deepEqual(
		patched.requests[0].body.system,
		patched.requests[1].body.system,
	);
	assert.deepEqual(
		patched.requests[0].body.tools,
		patched.requests[1].body.tools,
	);
	assert.equal(
		patched.requests[1].diagnosticsPreviousRequestId,
		patched.requests[0].id,
	);
	assert.equal(patched.requests[0].body.messages.length, 1);
	assert.equal(patched.requests[1].body.messages.length, 1);
});

test("workflow mode warms one schema lane and diagnoses a separate schema lane", () => {
	const patched = getPolicy("workflow", "patched");
	assert.equal(patched.requests.length, 3);

	const warm = patched.requests[0];
	const peers = patched.requests.slice(1, 2);
	const changedSchema = patched.requests[2];
	for (const peer of peers) {
		assert.equal(peer.schemaLane, warm.schemaLane);
		assert.equal(peer.diagnosticsPreviousRequestId, warm.id);
		assert.deepEqual(peer.body.system, warm.body.system);
		assert.deepEqual(peer.body.tools, warm.body.tools);
	}
	assert.notEqual(changedSchema.schemaLane, warm.schemaLane);
	assert.equal(changedSchema.diagnosticsPreviousRequestId, warm.id);
	assert.notDeepEqual(changedSchema.body.tools, warm.body.tools);
	assert.equal(
		new Set(patched.requests.map((request) => request.lineage)).size,
		patched.requests.length,
	);
});

test("scenario policies use isolated namespaces over the same padded fixture", () => {
	const paddedTranscript: CacheScenarioTranscript = {
		...transcript,
		minimumSystemCharacters: 12_000,
	};
	const [stock, patched] = buildCacheScenarioPlans({
		scenario: "main",
		transcript: paddedTranscript,
	});
	const stockSystem = stock.requests[0].body.system;
	const patchedSystem = patched.requests[0].body.system;

	assert.ok(
		stockSystem.reduce((total, block) => total + block.text.length, 0) >=
			12_000,
	);
	assert.notEqual(stockSystem[0].text, patchedSystem[0].text);
	assert.match(stockSystem[0].text, /cache-benchmark-namespace:policy:a/);
	assert.match(patchedSystem[0].text, /cache-benchmark-namespace:policy:b/);
	assert.equal(stockSystem[0].text.length, patchedSystem[0].text.length);
	assert.equal(
		stockSystem[0].text.replace("policy:a", "policy:x"),
		patchedSystem[0].text.replace("policy:b", "policy:x"),
	);
});
