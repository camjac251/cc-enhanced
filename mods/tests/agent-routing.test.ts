import type { AgentSpawnInput, On } from "claude-code";
import { expect, test } from "claude-code/testing";

const MARKER = "CC_ENHANCED_AGENT_ROUTING_CONFIG";
const CONFIG_PATH = "/work/routing/config.json";
const ALIASES = [
	{ name: "sol", providerId: "provider-alpha", modelId: "model-a" },
	{ name: "terra", providerId: "provider-beta", modelId: "model-b" },
	{ name: "luna", providerId: "provider-alpha", modelId: "model-c" },
];
const CONFIG = JSON.stringify({ modelAliases: ALIASES });

function spawnInput(overrides: Partial<AgentSpawnInput> = {}): AgentSpawnInput {
	return {
		tool_use_id: "spawn-call",
		prompt: "Review the supplied changes without changing files.",
		description: "Review supplied changes",
		subagentType: "security-reviewer",
		provider: { plugin: "engine", tier: "core" },
		parentModel: "claude-parent-model",
		parentAgentId: "parent-agent",
		permissionMode: "plan",
		background: true,
		fork: false,
		cwd: "/work/project",
		...overrides,
	};
}

function routingWorld(on: On, config: string | null = CONFIG, enabled = true) {
	const reads: string[] = [];
	const spawns: AgentSpawnInput[] = [];
	on("env.get", (_$, e) => ({
		value: enabled && e.name === MARKER ? CONFIG_PATH : undefined,
	}));
	on("fs.read", (_$, e) => {
		reads.push(e.path);
		expect(e.path).toBe(CONFIG_PATH);
		if (config === null) throw new Error("ENOENT");
		return { value: config };
	});
	// The engine receives the rewritten spawn, not a separate routing helper's
	// answer. All fields other than model must arrive unchanged.
	on("agent.spawn", (_$, e) => {
		spawns.push(e);
		return {
			model: e.fork ? e.parentModel : (e.model ?? e.parentModel),
			agentId: e.resume?.agentId ?? "child-agent",
		};
	});
	return { reads, spawns };
}

for (const alias of ALIASES) {
	test(`${alias.name} resolves from the routed config without changing the workflow's agent type or task`, async ($, on) => {
		const world = routingWorld(on);
		const input = spawnInput({
			model: alias.name,
			workflow: { runId: "wf_review", agentIndex: 1 },
		});
		const model = `clodex:${alias.providerId}:${alias.modelId}`;
		expect(await $.agent.spawn(input)).toEqual({
			model,
			agentId: "child-agent",
		});
		expect(world.spawns).toEqual([{ ...input, model }]);
		expect(input.model).toBe(alias.name);
		expect(world.reads).toEqual([CONFIG_PATH]);
	});
}

test("saved alias names are case-insensitive and do not imply a provider or model", async ($, on) => {
	const world = routingWorld(
		on,
		JSON.stringify({
			modelAliases: [
				{
					name: " Satellite ",
					providerId: "another-provider",
					modelId: "custom/id",
				},
			],
		}),
	);
	const input = spawnInput({ model: " SATELLITE " });
	await $.agent.spawn(input);
	expect(world.spawns).toEqual([
		{ ...input, model: "clodex:another-provider:custom/id" },
	]);
});

test("ordinary launches never read routing config or rewrite requested aliases", async ($, on) => {
	const world = routingWorld(on, CONFIG, false);
	const input = spawnInput({ model: "luna" });
	await $.agent.spawn(input);
	expect(world.spawns).toEqual([input]);
	expect(world.reads).toEqual([]);
});

for (const model of [
	undefined,
	"",
	"inherit",
	"sonnet",
	"opus",
	"haiku",
	"fable",
	"best",
	"default",
	"opusplan",
	"clodex:unlisted-provider:exact/model-id[1m]",
]) {
	test(`${model ?? "an omitted model"} preserves stock selection without reading routing config`, async ($, on) => {
		const world = routingWorld(on);
		const input = spawnInput(model === undefined ? {} : { model });
		await $.agent.spawn(input);
		expect(world.spawns).toEqual([input]);
		expect(world.reads).toEqual([]);
	});
}

test("unknown explicit models pass through exactly", async ($, on) => {
	const world = routingWorld(on);
	const input = spawnInput({ model: "Unconfigured-Model" });
	await $.agent.spawn(input);
	expect(world.spawns).toEqual([input]);
});

test("forks inherit even when the caller supplies a configured alias", async ($, on) => {
	const world = routingWorld(on);
	const input = spawnInput({ fork: true, subagentType: "fork", model: "luna" });
	expect(await $.agent.spawn(input)).toEqual({
		model: input.parentModel,
		agentId: "child-agent",
	});
	expect(world.spawns).toEqual([input]);
	expect(world.reads).toEqual([]);
});

test("resumed agents keep their saved model without reapplying routing", async ($, on) => {
	const world = routingWorld(on);
	const input = spawnInput({
		model: "luna",
		resume: { agentId: "saved-agent" },
	});
	await $.agent.spawn(input);
	expect(world.spawns).toEqual([input]);
	expect(world.reads).toEqual([]);
});

test("a fresh named teammate keeps its selected type and address", async ($, on) => {
	const world = routingWorld(on);
	const input = spawnInput({
		model: "terra",
		name: "reviewer",
		isTeammate: true,
	});
	await $.agent.spawn(input);
	expect(world.spawns).toEqual([
		{ ...input, model: "clodex:provider-beta:model-b" },
	]);
});

for (const [name, config] of [
	["unreadable", null],
	["invalid JSON", "{"],
	["non-object", "null"],
	["missing aliases", "{}"],
	["invalid aliases", '{"modelAliases":{}}'],
	[
		"invalid alias target",
		JSON.stringify({
			modelAliases: [
				{ name: "luna", providerId: "provider-alpha", modelId: "" },
			],
		}),
	],
	[
		"conflicting targets",
		JSON.stringify({
			modelAliases: [
				ALIASES[2],
				{
					name: "LUNA",
					providerId: "provider-beta",
					modelId: "different-model",
				},
			],
		}),
	],
	[
		"alias-only access program",
		JSON.stringify({ modelAliases: [{ ...ALIASES[2], daybreak: true }] }),
	],
] as const) {
	test(`${name} config does not guess a replacement model`, async ($, on) => {
		const world = routingWorld(on, config);
		const input = spawnInput({ model: "luna" });
		await $.agent.spawn(input);
		expect(world.spawns).toEqual([input]);
	});
}

test("duplicate aliases with the same target still resolve", async ($, on) => {
	const world = routingWorld(
		on,
		JSON.stringify({ modelAliases: [ALIASES[2], ALIASES[2]] }),
	);
	const input = spawnInput({ model: "luna" });
	await $.agent.spawn(input);
	expect(world.spawns).toEqual([
		{ ...input, model: "clodex:provider-alpha:model-c" },
	]);
});
