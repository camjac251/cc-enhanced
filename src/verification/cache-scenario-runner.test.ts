import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildCacheScenarioPlans,
	type CacheScenarioTranscript,
	countRequestCacheBreakpoints,
} from "./cache-scenario-plan.js";
import {
	type CacheScenarioTransport,
	executeCacheScenarioPlan,
} from "./cache-scenario-runner.js";

const transcript: CacheScenarioTranscript = {
	systemBlocks: ["A stable synthetic system prompt used only by tests."],
	turns: Array.from({ length: 17 }, (_, index) => ({
		user: `user-${index}`,
		assistant: `assistant-${index}`,
	})),
};

test("cache scenario runner resolves fork branches to the warmed parent response", async () => {
	const plan = buildCacheScenarioPlans({ scenario: "fork", transcript }).find(
		(candidate) => candidate.policy === "patched",
	);
	assert.ok(plan);
	const calls: Array<{
		id: string;
		previousMessageId: string | null | undefined;
	}> = [];
	const transport: CacheScenarioTransport = async (call) => {
		calls.push({
			id: call.stepId,
			previousMessageId: call.diagnosticsPreviousMessageId,
		});
		return { id: `response:${call.stepId}`, usage: {} };
	};

	await executeCacheScenarioPlan(plan, transport, {
		liveRun: true,
		diagnosticsEnabled: true,
		model: "synthetic-model",
		maxTokens: 16,
		temperature: 0,
		maxBreakpoints: 4,
	});

	assert.deepEqual(calls, [
		{ id: "patched:fork:parent", previousMessageId: null },
		{
			id: "patched:fork:branch-a",
			previousMessageId: "response:patched:fork:parent",
		},
		{
			id: "patched:fork:branch-b",
			previousMessageId: "response:patched:fork:branch-a",
		},
	]);
});

test("cache scenario preflight rejects a fork whose parent identity is not earlier in the plan", async () => {
	const plan = structuredClone(
		buildCacheScenarioPlans({ scenario: "fork", transcript })[1],
	);
	const branch = plan.requests.find((request) => request.phase === "fork");
	assert.ok(branch);
	branch.parentRequestId = "patched:fork:missing-parent";
	let callCount = 0;
	const transport: CacheScenarioTransport = async () => {
		callCount += 1;
		return { usage: {} };
	};

	await assert.rejects(
		executeCacheScenarioPlan(plan, transport, {
			liveRun: true,
			diagnosticsEnabled: true,
			model: "synthetic-model",
			maxTokens: 16,
			temperature: 0,
			maxBreakpoints: 4,
		}),
		/requires an earlier fork parent request/,
	);
	assert.equal(callCount, 0);
});

test("cache scenario preflight requires a reusable parent message checkpoint", async () => {
	const plan = structuredClone(
		buildCacheScenarioPlans({ scenario: "fork", transcript })[1],
	);
	const parent = plan.requests.find((request) => request.phase === "parent");
	assert.ok(parent);
	for (const message of parent.body.messages) {
		for (const block of message.content) delete block.cache_control;
	}
	parent.breakpoints = countRequestCacheBreakpoints(parent.body);
	let callCount = 0;
	const transport: CacheScenarioTransport = async () => {
		callCount += 1;
		return { usage: {} };
	};

	await assert.rejects(
		executeCacheScenarioPlan(plan, transport, {
			liveRun: true,
			diagnosticsEnabled: true,
			model: "synthetic-model",
			maxTokens: 16,
			temperature: 0,
			maxBreakpoints: 4,
		}),
		/no reusable message checkpoint/,
	);
	assert.equal(callCount, 0);
});

test("cache scenario runner omits diagnostics edges when disabled", async () => {
	const plan = buildCacheScenarioPlans({ scenario: "main", transcript })[0];
	const previousIds: Array<string | null | undefined> = [];
	const transport: CacheScenarioTransport = async (call) => {
		previousIds.push(call.diagnosticsPreviousMessageId);
		return { usage: {} };
	};

	await executeCacheScenarioPlan(plan, transport, {
		liveRun: true,
		diagnosticsEnabled: false,
		model: "synthetic-model",
		maxTokens: 16,
		temperature: 0,
		maxBreakpoints: 4,
	});

	assert.deepEqual(previousIds, [undefined, undefined]);
});

test("cache scenario dry runs make zero transport calls and preserve the symbolic graph", async () => {
	const plan = buildCacheScenarioPlans({ scenario: "workflow", transcript })[1];
	let callCount = 0;
	const transport: CacheScenarioTransport = async () => {
		callCount += 1;
		return { usage: {} };
	};

	const result = await executeCacheScenarioPlan(plan, transport, {
		liveRun: false,
		diagnosticsEnabled: true,
		model: "synthetic-model",
		maxTokens: 16,
		temperature: 0,
		maxBreakpoints: 4,
	});

	assert.equal(callCount, 0);
	assert.deepEqual(
		result.steps.map((step) => step.diagnosticsPreviousRequestId),
		plan.requests.map((step) => step.diagnosticsPreviousRequestId),
	);
});

test("cache scenario preflight rejects overflow before calling the transport", async () => {
	const plan = structuredClone(
		buildCacheScenarioPlans({ scenario: "main", transcript })[0],
	);
	plan.requests[0].breakpoints.total = 5;
	let callCount = 0;
	const transport: CacheScenarioTransport = async () => {
		callCount += 1;
		return { usage: {} };
	};

	await assert.rejects(
		executeCacheScenarioPlan(plan, transport, {
			liveRun: true,
			diagnosticsEnabled: true,
			model: "synthetic-model",
			maxTokens: 16,
			temperature: 0,
			maxBreakpoints: 4,
		}),
		/cache breakpoints/,
	);
	assert.equal(callCount, 0);
});

test("cache scenario runner names both steps when a predecessor response ID is missing", async () => {
	const plan = buildCacheScenarioPlans({ scenario: "fork", transcript })[0];
	const sent: string[] = [];
	const transport: CacheScenarioTransport = async (call) => {
		sent.push(call.stepId);
		return {
			...(call.stepId.endsWith(":parent")
				? {}
				: { id: `response:${call.stepId}` }),
			usage: {},
		};
	};

	await assert.rejects(
		executeCacheScenarioPlan(plan, transport, {
			liveRun: true,
			diagnosticsEnabled: true,
			model: "synthetic-model",
			maxTokens: 16,
			temperature: 0,
			maxBreakpoints: 4,
		}),
		/stock:fork:branch-a requires response ID from stock:fork:parent/,
	);
	assert.deepEqual(sent, ["stock:fork:parent"]);
});
