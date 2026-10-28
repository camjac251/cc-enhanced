import type { On } from "claude-code";

const STOCK_MODELS: Record<string, true> = {
	sonnet: true,
	opus: true,
	haiku: true,
	fable: true,
	best: true,
	default: true,
	opusplan: true,
	inherit: true,
};

/** Resolve only saved aliases, using Clodex's canonical, readable route IDs. */
function configuredModel(config: unknown, name: string): string | undefined {
	if (
		config === null ||
		typeof config !== "object" ||
		!("modelAliases" in config) ||
		!Array.isArray(config.modelAliases)
	) {
		return undefined;
	}
	let model: string | undefined;
	for (const alias of config.modelAliases as unknown[]) {
		if (
			alias === null ||
			typeof alias !== "object" ||
			!("name" in alias) ||
			typeof alias.name !== "string" ||
			alias.name.trim().toLowerCase() !== name
		) {
			continue;
		}
		if (
			!("providerId" in alias) ||
			typeof alias.providerId !== "string" ||
			!alias.providerId.trim() ||
			!("modelId" in alias) ||
			typeof alias.modelId !== "string" ||
			!alias.modelId.trim() ||
			("daybreak" in alias && alias.daybreak !== false)
		) {
			// Alias-specific access programs cannot be represented by a model ID.
			return undefined;
		}
		const target = `clodex:${alias.providerId}:${alias.modelId}`;
		if (model !== undefined && model !== target) return undefined;
		model = target;
	}
	return model;
}

export function registerAgentRoutingMods(on: On): void {
	on("agent.spawn", async ($, e, next) => {
		// Forks inherit, resumes keep their saved model, and omission leaves the
		// agent definition and normal stock inheritance in control.
		if (e.fork || e.resume || e.model === undefined) return next(e);
		const name = e.model.trim().toLowerCase();
		if (
			!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) ||
			Object.hasOwn(STOCK_MODELS, name)
		) {
			return next(e);
		}

		// Only the routed launcher opts in. Never infer routing from a proxy URL,
		// the parent model, or a user-wide Clodex installation.
		const path = await $.env.get("CC_ENHANCED_AGENT_ROUTING_CONFIG");
		if (!path) return next(e);
		let config: unknown;
		try {
			config = JSON.parse(await $.fs.read(path));
		} catch {
			return next(e);
		}
		const model = configuredModel(config, name);
		// Effort is not part of AgentSpawnInput. Stock retains the caller's effort;
		// only the explicit model changes, never the task, selected type, or scope.
		return next(model === undefined ? e : { ...e, model });
	});
}
