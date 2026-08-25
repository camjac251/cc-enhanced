import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createPatchOutcomeRecorder,
	runCombinedAstPasses,
} from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import {
	cacheTailPolicy,
	collectCacheTailVerificationInventory,
} from "./cache-tail-policy.js";

async function runCacheTailViaPasses(
	ast: any,
	passIndexes?: number[],
	recorder = undefined as
		| ReturnType<typeof createPatchOutcomeRecorder>
		| undefined,
): Promise<void> {
	const passes = (await cacheTailPolicy.astPasses?.(ast, recorder)) ?? [];
	const selectedPasses =
		passIndexes === undefined
			? passes
			: passIndexes.map((index) => passes[index]).filter(Boolean);
	const originalWarn = console.warn;
	console.warn = () => {};
	try {
		await runCombinedAstPasses(
			ast,
			selectedPasses.map((pass) => ({ tag: cacheTailPolicy.tag, pass })),
			() => {},
			() => {},
			(_tag, error) => {
				throw error;
			},
		);
	} finally {
		console.warn = originalWarn;
	}
}

// Minimal fixture that mirrors the real cache breakpoint function structure:
// - A function body containing the "tengu_api_cache_breakpoints" marker call
// - A Set of message indexes whose size is reported as markerCount
// - A .map() callback with a variable assigned from `markerIndexes.has(index)`
// - A return statement calling a builder function with (item, tailVar)
// - A second return in an if-branch calling a "user" builder (should be skipped)
const CACHE_TAIL_FIXTURE = `
function buildCacheBreakpoints(messages, cachingEnabled, ttl, includeEdits = false, editBlock, pinnedEdits, skipCacheWrite = false, forkPointId) {
  let findCacheableIndex = (startIndex) => {
    let candidate = startIndex;
    while (candidate >= 0 && messages[candidate].type === "api_system") candidate--;
    return candidate;
  };
  let tailIndex = findCacheableIndex(messages.length - 1);
  if (skipCacheWrite) tailIndex = findCacheableIndex(tailIndex - 1);
  let markerIndexes = new Set();
  if (tailIndex >= 0) markerIndexes.add(tailIndex);
  let forkPointPinned = false;
  if (multiCacheEnabled()) {
    if (forkPointId) {
      let forkIndex = messages.findLastIndex((message) => message.uuid === forkPointId);
      if (forkIndex >= 0 && forkIndex <= tailIndex) (markerIndexes.add(forkIndex), (forkPointPinned = true));
    } else if (!skipCacheWrite) {
      let previousIndex = findCacheableIndex(tailIndex - 1);
      if (previousIndex >= 0) (markerIndexes.add(previousIndex), (forkPointPinned = true));
    }
  }
  gate("tengu_api_cache_breakpoints", {
    totalMessageCount: messages.length,
    cachingEnabled,
    skipCacheWrite,
    forkPointPinned,
    markerCount: markerIndexes.size,
  });
  return messages.map(function(message, index) {
    let shouldCache = markerIndexes.has(index);
    if (message.type === "user") {
      return buildUser(message, shouldCache, cachingEnabled, ttl);
    }
    if (message.type === "api_system") return { role: "system", content: message.message.content };
    return buildAssistant(message, shouldCache, cachingEnabled, ttl);
  });
}
`;

const CACHE_TAIL_SPLIT_HELPER_FIXTURE = `
function computeMarkerIndices({ messages, enablePromptCaching, skipCacheWrite, forkPointUuid, canMarkApiSystem, forkCachePin, isForkPinStepBackEnabled }) {
  let isCacheable = (message) => message.type !== "assistant";
  let findCacheableIndex = (startIndex) => {
    let candidate = startIndex;
    while (candidate >= 0 && (messages[candidate].type === "api_system" || !isCacheable(messages[candidate]))) candidate--;
    return candidate;
  };
  let tailIndex = findCacheableIndex(messages.length - 1);
  if (skipCacheWrite) tailIndex = findCacheableIndex(tailIndex - 1);
  let lastIndex = messages.length - 1,
    lastMessage = messages[lastIndex],
    hasTrailingSystem = lastMessage !== undefined && lastMessage.type === "api_system",
    primaryIndex = canMarkApiSystem && enablePromptCaching && !skipCacheWrite && tailIndex >= 0 && hasTrailingSystem ? lastIndex : tailIndex,
    markerIndexes = new Set();
  if (primaryIndex >= 0) markerIndexes.add(primaryIndex);
  let forkPointPinned = false;
  if (forkCachePin && forkPointUuid && isForkPinStepBackEnabled()) forkPointPinned = true;
  return { markerIndices: markerIndexes, forkPointPinned };
}

function buildCacheBreakpoints(messages, cachingEnabled, ttl, skipCacheWrite = false, forkPointId) {
  let { markerIndices, forkPointPinned } = computeMarkerIndices({
    messages,
    enablePromptCaching: cachingEnabled,
    skipCacheWrite,
    forkPointUuid: forkPointId,
    canMarkApiSystem: true,
    forkCachePin: false,
    isForkPinStepBackEnabled() { return false; },
  });
  return (
    gate("tengu_api_cache_breakpoints", {
      totalMessageCount: messages.length,
      cachingEnabled,
      skipCacheWrite,
      forkPointPinned,
      markerCount: markerIndices.size,
    }),
    messages.map((message, index) => {
      let shouldCache = markerIndices.has(index);
      if (message.type === "user") return buildUser(message, shouldCache, cachingEnabled, ttl);
      if (message.type === "api_system") return { role: "system", content: message.message.content };
      return buildAssistant(message, shouldCache, cachingEnabled, ttl);
    })
  );
}
`;

async function buildCacheTailRuntime() {
	const ast = parse(CACHE_TAIL_FIXTURE);
	await runCacheTailViaPasses(ast, [0]);
	const output = print(ast);
	return new Function(`
function gate() {}
function multiCacheEnabled() { return true; }
function buildUser(message, shouldCache) {
  return {
    role: "user",
    content: message.content.map((block) =>
      shouldCache
        ? { ...block, cache_control: { type: "ephemeral" } }
        : block
    ),
  };
}
function buildAssistant(message, shouldCache) {
  return {
    role: "assistant",
    content: message.content.map((block) =>
      shouldCache
        ? { ...block, cache_control: { type: "ephemeral" } }
        : block
    ),
  };
}
${output}
return { buildCacheBreakpoints };
`)() as {
		buildCacheBreakpoints: (messages: any[], cachingEnabled: boolean) => any[];
	};
}

test("cache-tail-policy marks the last two user messages when an assistant is last", async () => {
	const runtime = await buildCacheTailRuntime();
	const result = runtime.buildCacheBreakpoints(
		[
			{ type: "user", content: [{ type: "text", text: "u0" }] },
			{ type: "assistant", content: [{ type: "text", text: "a1" }] },
			{ type: "user", content: [{ type: "text", text: "u2" }] },
			{ type: "assistant", content: [{ type: "text", text: "a3" }] },
		],
		true,
	);

	assert.deepEqual(result[0].content[0].cache_control, {
		type: "ephemeral",
	});
	assert.deepEqual(result[2].content[0].cache_control, {
		type: "ephemeral",
	});
});

test("cache-tail-policy patches a marker set returned by the current helper topology", async () => {
	const ast = parse(CACHE_TAIL_SPLIT_HELPER_FIXTURE);
	await runCacheTailViaPasses(ast, [0]);
	const output = print(ast);

	assert.match(output, /cacheTailCount < cacheTailWindow/);
	assert.match(output, /markerIndices\.add\(cacheTailIndex\)/);
});

test("cache-tail-policy leaves assistant tail messages uncached", async () => {
	const runtime = await buildCacheTailRuntime();
	const result = runtime.buildCacheBreakpoints(
		[
			{ type: "user", content: [{ type: "text", text: "u0" }] },
			{ type: "assistant", content: [{ type: "text", text: "a1" }] },
			{ type: "user", content: [{ type: "text", text: "u2" }] },
			{ type: "assistant", content: [{ type: "text", text: "a3" }] },
		],
		true,
	);

	assert.equal(result[1].content[0].cache_control, undefined);
	assert.equal(result[3].content[0].cache_control, undefined);
});

const CACHE_TAIL_SEQUENCE_RETURN_FIXTURE = `
function buildCacheBreakpoints(messages, cachingEnabled, ttl, skipCacheWrite = false, forkPointId) {
  let findCacheableIndex = (startIndex) => {
    let candidate = startIndex;
    while (candidate >= 0 && messages[candidate].type === "api_system") candidate--;
    return candidate;
  };
  let tailIndex = findCacheableIndex(messages.length - 1);
  if (skipCacheWrite) tailIndex = findCacheableIndex(tailIndex - 1);
  let markerIndexes = new Set();
  if (tailIndex >= 0) markerIndexes.add(tailIndex);
  let forkPointPinned = false;
  if (multiCacheEnabled()) {
    if (forkPointId) {
      let forkIndex = messages.findLastIndex((message) => message.uuid === forkPointId);
      if (forkIndex >= 0 && forkIndex <= tailIndex) (markerIndexes.add(forkIndex), (forkPointPinned = true));
    } else if (!skipCacheWrite) {
      let previousIndex = findCacheableIndex(tailIndex - 1);
      if (previousIndex >= 0) (markerIndexes.add(previousIndex), (forkPointPinned = true));
    }
  }
  return (
    gate("tengu_api_cache_breakpoints", {
      totalMessageCount: messages.length,
      cachingEnabled,
      skipCacheWrite,
      forkPointPinned,
      markerCount: markerIndexes.size,
    }),
    messages.map((message, index) => {
      let shouldCache = markerIndexes.has(index);
      if (message.type === "user") return buildUser(message, shouldCache, cachingEnabled, ttl);
      if (message.type === "api_system") return { role: "system", content: message.message.content };
      return buildAssistant(message, shouldCache, cachingEnabled, ttl);
    })
  );
}
`;

test("cache-tail-policy handles marker embedded in a sequence return", async () => {
	const ast = parse(CACHE_TAIL_SEQUENCE_RETURN_FIXTURE);
	await runCacheTailViaPasses(ast, [0]);
	const output = print(ast);

	assert.equal(output.includes("var cacheTailWindow = 2;"), true);
	assert.equal(output.includes("var cacheUserOnly = true;"), true);
	assert.equal(output.includes("cacheTailCount < cacheTailWindow"), true);
	assert.equal(output.includes("cacheUserOnly ? false : shouldCache"), true);
});

// Mirrors the current upstream shape where the primary cache index is produced
// by a conditional select (`cond ? lastIndex : tailIndex`) instead of a direct
// helper call, and the marker Set is not the first declarator. The tail helper
// must still be resolved from its `helper(messages.length - 1)` seed call so the
// window loop can step back from a non-call primary index.
const CACHE_TAIL_CONDITIONAL_INDEX_FIXTURE = `
function buildCacheBreakpoints(messages, cachingEnabled, ttl, skipCacheWrite = false, foldTurnStartId, forkPointId) {
  let findCacheableIndex = (startIndex) => {
    let candidate = startIndex;
    while (candidate >= 0 && messages[candidate].type === "api_system") candidate--;
    return candidate;
  };
  let tailIndex = findCacheableIndex(messages.length - 1);
  if (skipCacheWrite) tailIndex = findCacheableIndex(tailIndex - 1);
  let systemTailEnabled = featureA() && featureB() && featureC(),
    lastIndex = messages.length - 1,
    lastMessage = messages[lastIndex],
    hasTrailingSystem = lastMessage !== undefined && lastMessage.type === "api_system" && typeof lastMessage.message.content === "string" && lastMessage.message.content.trim() !== "",
    primaryIndex = systemTailEnabled && cachingEnabled && !skipCacheWrite && tailIndex >= 0 && hasTrailingSystem ? lastIndex : tailIndex,
    markerIndexes = new Set();
  if (primaryIndex >= 0) markerIndexes.add(primaryIndex);
  let forkPointPinned = false, foldIndex = -1;
  gate("tengu_api_cache_breakpoints", {
    totalMessageCount: messages.length,
    cachingEnabled,
    skipCacheWrite,
    forkPointPinned,
    markerCount: markerIndexes.size,
  });
  return messages.map((message, index) => {
    let shouldCache = markerIndexes.has(index);
    if (message.type === "user") return buildUser(message, shouldCache, cachingEnabled, ttl);
    if (message.type === "api_system")
      return { role: "system", content: shouldCache && cachingEnabled && systemTailEnabled ? [{ type: "text", text: message.message.content, cache_control: buildCC({ ttl }) }] : message.message.content };
    return buildAssistant(message, shouldCache, cachingEnabled, ttl);
  });
}
`;

test("cache-tail-policy bounds the tail window to the highest returned marker", async () => {
	const ast = parse(CACHE_TAIL_CONDITIONAL_INDEX_FIXTURE);
	await runCacheTailViaPasses(ast, [0]);
	const output = print(ast);

	assert.equal(output.includes("var cacheTailWindow = 2;"), true);
	assert.equal(output.includes("var cacheUserOnly = true;"), true);
	assert.equal(output.includes("var cacheTailCount = 0;"), true);
	assert.equal(
		output.includes(
			"cachePrimaryIndex = markerIndexes.size > 0 ? Math.max(...markerIndexes) : -1",
		),
		true,
	);
	assert.equal(output.includes("cacheTailCount < cacheTailWindow"), true);
	assert.equal(output.includes("markerIndexes.add(cacheTailIndex)"), true);
	assert.equal(
		output.includes('messages[cacheTailIndex].type === "user"'),
		true,
	);
	// Assistant breakpoint is still gated to user-only.
	assert.equal(output.includes("cacheUserOnly ? false : shouldCache"), true);
});

test("cache-tail-policy applies declarations, window gate, and user-only conditional", async () => {
	const ast = parse(CACHE_TAIL_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast);

	// Declarations injected
	assert.equal(output.includes("var cacheTailWindow = 2;"), true);
	assert.equal(output.includes("var cacheUserOnly = true;"), true);

	// The Set-based tail window loop was inserted before the marker report.
	assert.equal(output.includes("var cacheTailCount = 0;"), true);
	assert.equal(
		output.includes(
			"cachePrimaryIndex = markerIndexes.size > 0 ? Math.max(...markerIndexes) : -1",
		),
		true,
	);
	assert.equal(output.includes("cacheTailCount < cacheTailWindow"), true);
	assert.equal(output.includes("markerIndexes.add(cacheTailIndex)"), true);
	assert.equal(
		output.includes('messages[cacheTailIndex].type === "user"'),
		true,
	);

	// The assistant return got the cacheUserOnly conditional
	assert.equal(output.includes("cacheUserOnly ? false : shouldCache"), true);

	// The user return was NOT wrapped (buildUser is the userFnName)
	assert.equal(
		output.includes("buildUser(message, shouldCache, cachingEnabled, ttl)"),
		true,
	);
});

test("cache-tail-policy verify rejects unpatched full fixture", () => {
	const ast = parse(FULL_VERIFY_FIXTURE);
	const result = cacheTailPolicy.verify(FULL_VERIFY_FIXTURE, ast);
	assert.equal(typeof result, "string");
	assert.equal(
		typeof result === "string" &&
			(result.includes("Missing") ||
				result.includes("not patched") ||
				result.includes("Legacy") ||
				result.includes("ambiguous")),
		true,
		`Expected a meaningful failure reason, got: ${result}`,
	);
});

test("cache-tail-policy verify detects cache tail window regression", async () => {
	const ast = parse(FULL_VERIFY_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast);

	// Regress the loop condition so it no longer references cacheTailWindow.
	const regressed = output.replace(
		"cacheTailCount < cacheTailWindow",
		"cacheTailCount < 1",
	);
	assert.notEqual(regressed, output);

	const regressedAst = parse(regressed);
	const result = cacheTailPolicy.verify(regressed, regressedAst);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("not patched"),
		true,
		`Expected tail window not-patched failure, got: ${result}`,
	);
});

test("cache-tail-policy verify rejects unpatched Set-based tail gate", () => {
	const ast = parse(FULL_VERIFY_FIXTURE);
	const result = cacheTailPolicy.verify(FULL_VERIFY_FIXTURE, ast);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("Missing") ||
			String(result).includes("not patched"),
		true,
		`Expected a meaningful rejection, got: ${result}`,
	);
});

test("cache-tail-policy verify rejects code without cache anchor", () => {
	const result = cacheTailPolicy.verify("code");
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("locate") || String(result).includes("anchor"),
		true,
		`Expected anchor-missing failure, got: ${result}`,
	);
});

// Fixture with a ternary return structure (user vs assistant in one return)
const TERNARY_FIXTURE = `
function buildCacheBreakpoints(messages) {
  let findCacheableIndex = (startIndex) => {
    let candidate = startIndex;
    while (candidate >= 0 && messages[candidate].type === "api_system") candidate--;
    return candidate;
  };
  let tailIndex = findCacheableIndex(messages.length - 1);
  let markerIndexes = new Set();
  if (tailIndex >= 0) markerIndexes.add(tailIndex);
  gate("tengu_api_cache_breakpoints", {
    totalMessageCount: messages.length,
    markerCount: markerIndexes.size,
  });
  return messages.map(function(item, idx) {
    var isTail = markerIndexes.has(idx);
    return item.role === "user" ? buildUser(item, isTail) : buildAssistant(item, isTail);
  });
}
`;

test("cache-tail-policy handles ternary return pattern", async () => {
	const ast = parse(TERNARY_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast);

	// Declarations injected
	assert.equal(output.includes("var cacheTailWindow = 2;"), true);
	assert.equal(output.includes("var cacheUserOnly = true;"), true);

	// Gate was patched before the marker report.
	assert.equal(output.includes("cacheTailCount < cacheTailWindow"), true);

	// The assistant branch got the user-only conditional
	assert.equal(output.includes("cacheUserOnly ? false :"), true);
});

// ---------------------------------------------------------------------------
// Sysprompt global scope fixtures
// ---------------------------------------------------------------------------

const SYSPROMPT_SCOPE_FIXTURE = `
function buildSystemPromptBlocks(parts, opts) {
  var isGlobal = checkGlobal();
  if (isGlobal && opts.skipGlobalCacheForSystemPrompt) {
    c("tengu_sysprompt_using_tool_based_cache", { promptBlockCount: parts.length });
    var billing, identity, rest = [];
    for (var item of parts) {
      if (!item) continue;
      if (item.startsWith("x-anthropic-billing-header")) billing = item;
      else if (identitySet.has(item)) identity = item;
      else rest.push(item);
    }
    var result = [];
    if (billing) result.push({ text: billing, cacheScope: null });
    if (identity) result.push({ text: identity, cacheScope: "org" });
    var joined = rest.join("\\n\\n");
    if (joined) result.push({ text: joined, cacheScope: "org" });
    return result;
  }
  return parts;
}
`;

test("cache-tail-policy patches sysprompt identity block to global scope", async () => {
	const ast = parse(SYSPROMPT_SCOPE_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast);

	// The first cacheScope: "org" (identity) should now be "global"
	assert.equal(output.includes('cacheScope: "global"'), true);

	// The second cacheScope: "org" (remaining prompt) should stay "org"
	const globalIdx = output.indexOf('cacheScope: "global"');
	const orgIdx = output.indexOf('cacheScope: "org"', globalIdx);
	assert.equal(
		orgIdx > globalIdx,
		true,
		"remaining prompt should keep org scope",
	);
});

test("cache-tail-policy verify rejects unpatched sysprompt scope in combined fixture", async () => {
	const ast = parse(FULL_VERIFY_FIXTURE);
	await runCacheTailViaPasses(ast, [0, 2, 3]);
	const output = print(ast);
	const result = cacheTailPolicy.verify(output, parse(output));
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("global") || String(result).includes("cacheScope"),
		true,
		`Expected scope-related failure, got: ${result}`,
	);
});

// ---------------------------------------------------------------------------
// Cache control 1h TTL fixtures
// ---------------------------------------------------------------------------

const CACHE_CONTROL_BUILDER_FIXTURE = `
function buildCacheControl({ scope: H, ttl: $ } = {}) {
  return { type: "ephemeral", ...($ && { ttl: $ }), ...(H === "global" && { scope: H }) };
}
`;

const CACHE_TTL_ALLOWLIST_FIXTURE = `
function shouldUseOneHourCache(querySource) {
  if (truthy(process.env.FORCE_PROMPT_CACHING_5M)) return false;
  if (truthy(process.env.ENABLE_PROMPT_CACHING_1H)) return true;
  if (!promptCachingAvailable() || account.isUsingOverage) return false;
  let allowlist = getCachedAllowlist();
  if (allowlist === null)
    ((allowlist =
      flag("tengu_prompt_cache_1h_config", { allowlist: ["repl_main_thread*", "sdk", "auto_mode"] })
        .allowlist ?? []),
      setCachedAllowlist(allowlist));
  return querySource !== void 0 && allowlist.some((entry) => (entry.endsWith("*") ? querySource.startsWith(entry.slice(0, -1)) : querySource === entry));
}
`;

const CACHE_TTL_REBUNDLED_ALLOWLIST_FIXTURE = `
var defaultAllowlist;
function initializeCacheDefaults() {
  defaultAllowlist = ["repl_main_thread*", "sdk", "auto_mode", "memdir_relevance"];
}
function shouldUseOneHourCache(querySource) {
  let allowlist = getCachedAllowlist();
  if (allowlist === null)
    ((allowlist =
      flag("tengu_prompt_cache_1h_config", { allowlist: [...defaultAllowlist] })
        .allowlist ?? []),
      setCachedAllowlist(allowlist));
  return matchesQuerySource(querySource, allowlist)
    ? { ttl: "1h" }
    : { ttl: "5m" };
}
`;

test("cache-tail-policy preserves caller-controlled cache control TTL", async () => {
	const ast = parse(CACHE_CONTROL_BUILDER_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast);

	assert.equal(output.includes("$ && { ttl: $ }"), true);
	assert.equal(output.includes("H || $"), false);
	assert.equal(output.includes('H ? "1h" : $'), false);
});

test("cache-tail-policy extends 1h TTL allowlist to subagent query sources", async () => {
	const ast = parse(CACHE_TTL_ALLOWLIST_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast);

	assert.equal(output.includes('"agent:*"'), true);
	assert.equal(output.includes('allowlist.push("agent:*")'), true);
	assert.equal(output.includes('"hook_agent"'), false);
	assert.equal(output.includes('"verification_agent"'), false);
	assert.equal(output.includes('"agent_summary"'), false);
	assert.equal(output.includes('"agent_creation"'), false);
});

test("cache-tail-policy extends a rebundled spread allowlist", async () => {
	const ast = parse(CACHE_TTL_REBUNDLED_ALLOWLIST_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast);

	assert.equal(output.includes('"agent:*"'), true);
	assert.equal(output.includes('allowlist.push("agent:*")'), true);
	const inventory = collectCacheTailVerificationInventory(parse(output));
	assert.deepEqual(
		inventory.checks.find((check) => check.id === "agent-allowlist"),
		{ id: "agent-allowlist", result: true },
	);
});

test("cache-tail-policy 1h allowlist matches only real subagent query sources", async () => {
	const ast = parse(CACHE_TTL_ALLOWLIST_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast);
	const runtime = new Function(`
let cachedAllowlist = null;
const process = { env: {} };
function truthy(value) { return Boolean(value); }
function promptCachingAvailable() { return true; }
const account = { isUsingOverage: false };
function getCachedAllowlist() { return cachedAllowlist; }
function setCachedAllowlist(value) { cachedAllowlist = value; }
function flag(_name, fallback) { return fallback; }
${output}
return { shouldUseOneHourCache };
`)() as { shouldUseOneHourCache: (source: string) => boolean };

	assert.equal(runtime.shouldUseOneHourCache("agent:custom"), true);
	assert.equal(runtime.shouldUseOneHourCache("agent:default"), true);
	assert.equal(runtime.shouldUseOneHourCache("agent:builtin:explore"), true);
	assert.equal(runtime.shouldUseOneHourCache("hook_agent"), false);
	assert.equal(runtime.shouldUseOneHourCache("verification_agent"), false);
	assert.equal(runtime.shouldUseOneHourCache("agent_summary"), false);
	assert.equal(runtime.shouldUseOneHourCache("agent_creation"), false);
});

test("cache-tail-policy patches all required features in full fixture", async () => {
	const ast = parse(FULL_VERIFY_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes("var cacheTailWindow = 2;"),
		true,
		"tail window decl",
	);
	assert.equal(
		output.includes('cacheScope: "global"'),
		true,
		"global scope on identity",
	);
	assert.equal(
		output.includes("$ && { ttl: $ }"),
		true,
		"cache_control builder keeps caller-controlled TTL",
	);
	assert.equal(
		output.includes('H ? "1h" : $'),
		false,
		"scope alone must not force 1h TTL",
	);
	assert.equal(
		output.includes('"agent:*"'),
		true,
		"subagent query sources get 1h TTL",
	);
	assert.equal(
		output.includes("let maxMsgCheckpoints = 4 - systemToolsCount;"),
		true,
		"cache_control block cap",
	);

	// Full verify should pass
	assert.equal(cacheTailPolicy.verify(output, parse(output)), true);
});

test("cache-tail-policy reports semantic verifier coverage", async () => {
	const ast = parse(FULL_VERIFY_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast);

	assert.ok(cacheTailPolicy.verifyWithWitness);
	assert.deepEqual(cacheTailPolicy.verifyWithWitness(output, parse(output)), {
		passed: true,
		issues: [],
		witness: {
			semanticChecksPassed: 6,
			semanticChecksRequired: 6,
		},
	});
});

test("cache-tail-policy records real outcomes across its mutate visitors", async () => {
	const ast = parse(FULL_VERIFY_FIXTURE);
	const recorder = createPatchOutcomeRecorder();
	await runCacheTailViaPasses(ast, undefined, recorder);
	const first = recorder.snapshot();
	assert.ok(first.matched >= 3);
	assert.equal(first.mutated, first.matched);
	assert.equal(first.alreadySatisfied, 0);

	const secondRecorder = createPatchOutcomeRecorder();
	await runCacheTailViaPasses(ast, undefined, secondRecorder);
	const second = secondRecorder.snapshot();
	assert.ok(second.alreadySatisfied >= 3);
	assert.equal(
		second.mutated + second.alreadySatisfied <= second.matched,
		true,
	);
});

test("cache-tail-policy classifies ambiguous semantic candidates", async () => {
	const ast = parse(FULL_VERIFY_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast).replace(
		"var cacheTailWindow = 2;",
		"var cacheTailWindow = 2; var cacheTailWindow = 2;",
	);
	assert.ok(cacheTailPolicy.verifyWithWitness);
	const result = cacheTailPolicy.verifyWithWitness(output, parse(output));
	assert.equal("passed" in result, true);
	if (!("passed" in result)) throw new Error("expected structured result");
	assert.equal(result.passed, false);
	assert.deepEqual(result.issues, ["match-ambiguous"]);
});

test("cache-tail-policy collects one ordered verification inventory", async () => {
	const ast = parse(FULL_VERIFY_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast);
	const module = await import("./cache-tail-policy.js");
	const collect = (
		module as unknown as {
			collectCacheTailVerificationInventory?: (
				ast: ReturnType<typeof parse>,
			) => {
				checks: Array<{ id: string; result: true | string }>;
			};
		}
	).collectCacheTailVerificationInventory;

	assert.equal(typeof collect, "function");
	assert.ok(collect);

	const cachedInventory = collect(ast);
	const freshInventory = collect(parse(output));

	assert.deepEqual(cachedInventory, freshInventory);
	assert.deepEqual(
		cachedInventory.checks.map(({ id, result }) => [id, result]),
		[
			["tail-window", true],
			["sysprompt-scope", true],
			["caller-ttl", true],
			["agent-allowlist", true],
			["block-cap", true],
			["one-hour-ttl", true],
		],
	);
});

test("cache-tail-policy preserves verifier failure order and witnesses", async () => {
	const ast = parse(FULL_VERIFY_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast);
	const cases = [
		{
			label: "tail window",
			regress: (code: string) =>
				code.replace("cacheTailCount < cacheTailWindow", "cacheTailCount < 1"),
			result: "Tail cache window was not patched",
			passed: 0,
		},
		{
			label: "sysprompt scope",
			regress: (code: string) =>
				code.replace('cacheScope: "global"', 'cacheScope: "org"'),
			result: 'Sysprompt identity block not patched to cacheScope: "global"',
			passed: 1,
		},
		{
			label: "caller TTL",
			regress: (code: string) =>
				code.replace("$ && { ttl: $ }", '(H || $) && { ttl: H ? "1h" : $ }'),
			result:
				"Cache control builder forces 1h TTL from scope instead of respecting caller TTL",
			passed: 2,
		},
		{
			label: "agent allowlist",
			regress: (code: string) =>
				code.replaceAll('"agent:*"', '"agent:missing"'),
			result: '1h cache TTL allowlist missing "agent:*" query source',
			passed: 3,
		},
		{
			label: "block cap",
			regress: (code: string) =>
				code.replace(
					"let maxMsgCheckpoints = 4 - systemToolsCount;",
					"let maxMsgCheckpoints = 5 - systemToolsCount;",
				),
			result: "Request clamp helper missing fixed maxMsgCheckpoints block cap",
			passed: 4,
		},
		{
			label: "deferred tool exclusion",
			regress: (code: string) => code.replaceAll(" && !tool.defer_loading", ""),
			result: "Tools array 1h TTL enforcement must skip defer_loading tools",
			passed: 5,
		},
	] as const;

	assert.ok(cacheTailPolicy.verifyWithWitness);
	for (const scenario of cases) {
		const regressed = scenario.regress(output);
		assert.notEqual(regressed, output, scenario.label);
		assert.deepEqual(
			cacheTailPolicy.verifyWithWitness(regressed, parse(regressed)),
			{
				passed: false,
				issues: ["mutation-missing"],
				diagnostic: scenario.result,
				witness: {
					semanticChecksPassed: scenario.passed,
					semanticChecksRequired: cases.length,
				},
			},
			scenario.label,
		);
	}
});

test("cache-tail-policy keeps clamp evidence scoped to its anchor", async () => {
	const ast = parse(FULL_VERIFY_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast);
	const regressed = `${output.replace("delete cp.block.cache_control;", "")}
function unrelated(cp) {
  delete cp.block.cache_control;
}
`;

	assert.notEqual(regressed, output);
	assert.ok(cacheTailPolicy.verifyWithWitness);
	assert.deepEqual(
		cacheTailPolicy.verifyWithWitness(regressed, parse(regressed)),
		{
			passed: false,
			issues: ["mutation-missing"],
			diagnostic:
				"Request clamp helper missing delete cp.block.cache_control statement",
			witness: {
				semanticChecksPassed: 4,
				semanticChecksRequired: 6,
			},
		},
	);
});

test("cache-tail-policy rejects the wrong block-cap subtraction source", async () => {
	const ast = parse(FULL_VERIFY_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast);
	const regressed = output.replace(
		"let maxMsgCheckpoints = 4 - systemToolsCount;",
		"let maxMsgCheckpoints = 4 - wrongCount;",
	);

	assert.notEqual(regressed, output);
	assert.ok(cacheTailPolicy.verifyWithWitness);
	assert.deepEqual(
		cacheTailPolicy.verifyWithWitness(regressed, parse(regressed)),
		{
			passed: false,
			issues: ["mutation-missing"],
			diagnostic:
				"Request clamp helper missing fixed maxMsgCheckpoints block cap",
			witness: {
				semanticChecksPassed: 4,
				semanticChecksRequired: 6,
			},
		},
	);
});

test("cache-tail-policy rejects a same-function cache-control delete decoy", async () => {
	const ast = parse(FULL_VERIFY_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast);
	const regressed = output.replace(
		"delete cp.block.cache_control;",
		"delete unrelated.cache_control;",
	);

	assert.notEqual(regressed, output);
	assert.ok(cacheTailPolicy.verifyWithWitness);
	assert.deepEqual(
		cacheTailPolicy.verifyWithWitness(regressed, parse(regressed)),
		{
			passed: false,
			issues: ["mutation-missing"],
			diagnostic:
				"Request clamp helper missing delete cp.block.cache_control statement",
			witness: {
				semanticChecksPassed: 4,
				semanticChecksRequired: 6,
			},
		},
	);
});

test("cache-tail-policy verify rejects decimation beyond the primary cache boundary", async () => {
	const ast = parse(FULL_VERIFY_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast);
	const regressed = output.replaceAll(
		"idx <= cachePrimaryIndex && idx < messages.length",
		"idx < messages.length",
	);

	assert.notEqual(regressed, output);
	const result = cacheTailPolicy.verify(regressed, parse(regressed));
	assert.equal(typeof result, "string");
	assert.match(String(result), /primary cache boundary/);
});

test("cache-tail-policy verify rejects missing deferred-tool cleanup", async () => {
	const ast = parse(FULL_VERIFY_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast);
	const regressed = output.replaceAll("delete tool.cache_control;", "");

	assert.notEqual(regressed, output);
	const result = cacheTailPolicy.verify(regressed, parse(regressed));
	assert.equal(typeof result, "string");
	assert.match(String(result), /deferred tool cache_control cleanup/);
});

test("cache-tail-policy verify rejects a regressed system-tool cap", async () => {
	const ast = parse(FULL_VERIFY_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast);
	const regressed = output.replaceAll(
		"let systemToolsExcess = -4;",
		"let systemToolsExcess = -5;",
	);

	assert.notEqual(regressed, output);
	const result = cacheTailPolicy.verify(regressed, parse(regressed));
	assert.equal(typeof result, "string");
	assert.match(String(result), /system and tool cache_control cap/);
});

test("cache-tail-policy verify rejects missing or duplicate overflow increments", async () => {
	const ast = parse(FULL_VERIFY_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast);
	const increment = "systemToolsExcess++;";
	const occurrences = [...output.matchAll(/systemToolsExcess\+\+;/g)];

	assert.equal(
		occurrences.length,
		4,
		"each request owner should count system and tool cache_control blocks",
	);

	for (const match of occurrences) {
		assert.notEqual(match.index, undefined);
		const offset = match.index ?? 0;
		for (const replacement of ["", `${increment}\n${increment}`]) {
			const regressed =
				output.slice(0, offset) +
				replacement +
				output.slice(offset + increment.length);
			const result = cacheTailPolicy.verify(regressed, parse(regressed));
			assert.equal(typeof result, "string");
			assert.match(String(result), /system and tool cache_control cap/);
		}
	}
});

test("cache-tail-policy verify rejects missing positive overflow guards", async () => {
	const ast = parse(FULL_VERIFY_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast);
	const regressed = output.replaceAll("systemToolsExcess > 0", "true");

	assert.notEqual(regressed, output);
	const result = cacheTailPolicy.verify(regressed, parse(regressed));
	assert.equal(typeof result, "string");
	assert.match(String(result), /system and tool cache_control cap/);
});

test("cache-tail-policy verify rejects property-presence-only accounting", async () => {
	const ast = parse(FULL_VERIFY_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast);
	const regressed = output
		.replaceAll(
			'cacheBlock.cache_control && typeof cacheBlock.cache_control === "object"',
			'"cache_control" in cacheBlock',
		)
		.replaceAll(
			'cacheTool.cache_control && typeof cacheTool.cache_control === "object"',
			'"cache_control" in cacheTool',
		);

	assert.notEqual(regressed, output);
	const result = cacheTailPolicy.verify(regressed, parse(regressed));
	assert.equal(typeof result, "string");
	assert.match(String(result), /system and tool cache_control cap/);
});

test("cache-tail-policy verify rejects overflow decrements detached from deletes", async () => {
	const ast = parse(FULL_VERIFY_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast);
	const regressed = output
		.replaceAll(
			"delete cacheTool.cache_control;systemToolsExcess--;",
			"delete cacheTool.cache_control;}systemToolsExcess--;if (false) {",
		)
		.replaceAll(
			"delete cacheBlock.cache_control;systemToolsExcess--;",
			"delete cacheBlock.cache_control;}systemToolsExcess--;if (false) {",
		);

	assert.notEqual(regressed, output);
	const result = cacheTailPolicy.verify(regressed, parse(regressed));
	assert.equal(typeof result, "string");
	assert.match(String(result), /system and tool cache_control cap/);
});

test("cache-tail-policy verify rejects missing stable-checkpoint priority", async () => {
	const ast = parse(FULL_VERIFY_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast);
	const regressed = output.replaceAll(
		"if (latestStableCheckpoint) {addKeep(latestStableCheckpoint.block);}",
		"",
	);

	assert.notEqual(regressed, output);
	const result = cacheTailPolicy.verify(regressed, parse(regressed));
	assert.equal(typeof result, "string");
	assert.match(String(result), /stable message checkpoint priority/);
});

test("cache-tail-policy verify keeps system TTL evidence scoped to request owners", async () => {
	const ast = parse(FULL_VERIFY_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast);
	const regressed = `${output.replaceAll(
		'cacheBlock.cache_control.ttl = "1h";',
		"",
	)}
function unrelated(cacheBlock) {
  cacheBlock.cache_control.ttl = "1h";
}
`;

	assert.notEqual(regressed, output);
	const result = cacheTailPolicy.verify(regressed, parse(regressed));
	assert.equal(typeof result, "string");
	assert.match(String(result), /System prompt 1h TTL enforcement/);
});

test("cache-tail-policy verify rejects scope-forced 1h cache control builder", async () => {
	const ast = parse(FULL_VERIFY_FIXTURE);
	await runCacheTailViaPasses(ast);
	let output = print(ast);

	// Sanity: fully patched passes
	assert.equal(
		output.includes('cacheScope: "global"'),
		true,
		"scope mutation applied",
	);
	assert.equal(
		cacheTailPolicy.verify(output, parse(output)),
		true,
		"fully patched passes",
	);

	output = output.replace(
		"$ && { ttl: $ }",
		'(H || $) && { ttl: H ? "1h" : $ }',
	);
	const result = cacheTailPolicy.verify(output, parse(output));
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("forces 1h TTL"),
		true,
		`Expected TTL-related failure, got: ${result}`,
	);
});

test("cache-tail-policy verify rejects unpatched 1h TTL subagent allowlist in combined fixture", async () => {
	const ast = parse(FULL_VERIFY_FIXTURE);
	await runCacheTailViaPasses(ast);
	let output = print(ast);

	assert.equal(
		cacheTailPolicy.verify(output, parse(output)),
		true,
		"fully patched passes",
	);

	output = output.replaceAll('"agent:*"', '"agent:missing"');
	const result = cacheTailPolicy.verify(output, parse(output));
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("agent:*") || String(result).includes("allowlist"),
		true,
		`Expected subagent allowlist failure, got: ${result}`,
	);
});

test("cache-tail-policy verify rejects regressed cache_control block cap in combined fixture", async () => {
	const ast = parse(FULL_VERIFY_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast);

	const regressed = output.replace(
		"let maxMsgCheckpoints = 4 - systemToolsCount;",
		"let maxMsgCheckpoints = 5 - systemToolsCount;",
	);
	assert.notEqual(regressed, output);

	const result = cacheTailPolicy.verify(regressed, parse(regressed));
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("maxMsgCheckpoints"),
		true,
		`Expected cache_control cap failure, got: ${result}`,
	);
});

// ---------------------------------------------------------------------------
// Cache control block cap fixtures
// ---------------------------------------------------------------------------

const CACHE_CONTROL_BLOCK_CAP_FIXTURE = `
var V_M = 21333;

function clampRequest(H, $) {
  let A = Math.min(H.max_tokens, $),
    L = { ...H };
  if (L.thinking?.type === "enabled" && L.thinking.budget_tokens) {
    L.thinking = { ...L.thinking, budget_tokens: Math.min(L.thinking.budget_tokens, A - 1) };
  }
  return { ...L, max_tokens: A };
}

function buildRequest(messages, system, tools, model, maxTokens, betas, cacheEnabled, ttl, cacheEdits, pinnedEdits, skipCacheWrite) {
  betas = [];
  let requestPayload = {
      model: model,
      messages: buildCacheBreakpoints(messages, cacheEnabled, ttl, true, cacheEdits, pinnedEdits, skipCacheWrite),
      system: system,
      tools: tools,
      tool_choice: undefined,
      metadata: {},
      max_tokens: maxTokens,
      ...(betas.length > 0 && { betas }),
    },
    requestEffort = requestPayload.output_config?.effort;
  if (requestPayload.thinking?.type === "enabled") requestPayload.thinking = { ...requestPayload.thinking };
  return (requestEffort = typeof requestEffort === "string" ? requestEffort : undefined), requestPayload;
}

async function sendNonStream(client, request) {
  return await client.beta.messages.create({ ...clampRequest(request, V_M) });
}

async function sendStream(client, request, signal) {
  return await client.beta.messages.stream({ ...buildRequest(request.messages, request.system, request.tools, request.model, request.max_tokens, request.betas, request.cacheEnabled, request.ttl, request.cacheEdits, request.pinnedEdits, request.skipCacheWrite), stream: true }, { signal });
}
`;

const STARTUP_MOCK_FIXTURE = `
async function sideQueryFn(arg) {
  var q = "sideQuery";
  var s = "tengu_lone_surrogate_sanitized";
}

function startup(opts) {
  let { resolvedInitialModel } = opts;
  program.action(async (cmd, options) => {
    telemetry("tengu_startup_manual_model_config");
  });
}
`;

const FULL_VERIFY_FIXTURE =
	CACHE_TAIL_FIXTURE +
	SYSPROMPT_SCOPE_FIXTURE +
	CACHE_CONTROL_BUILDER_FIXTURE +
	CACHE_TTL_ALLOWLIST_FIXTURE +
	CACHE_CONTROL_BLOCK_CAP_FIXTURE;

const PARTIAL_DECL_FIXTURE =
	`
function buildCacheBreakpoints(messages) {
  var cacheUserOnly = true;
  let findCacheableIndex = (startIndex) => {
    let candidate = startIndex;
    while (candidate >= 0 && messages[candidate].type === "api_system") candidate--;
    return candidate;
  };
  let tailIndex = findCacheableIndex(messages.length - 1);
  let markerIndexes = new Set();
  if (tailIndex >= 0) markerIndexes.add(tailIndex);
  gate("tengu_api_cache_breakpoints", {
    totalMessageCount: messages.length,
    markerCount: markerIndexes.size,
  });
  return messages.map(function(item, idx) {
    var isTail = markerIndexes.has(idx);
    return buildAssistant(item, isTail);
  });
}
` +
	SYSPROMPT_SCOPE_FIXTURE +
	CACHE_CONTROL_BUILDER_FIXTURE +
	CACHE_TTL_ALLOWLIST_FIXTURE +
	CACHE_CONTROL_BLOCK_CAP_FIXTURE;

async function buildCacheControlRuntime() {
	const ast = parse(CACHE_TAIL_FIXTURE + CACHE_CONTROL_BLOCK_CAP_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast);

	return new Function(`
let totalMessageCount, cachingEnabled, skipCacheWrite, forkPointPinned, markerCount;
function gate(name, meta) {
  totalMessageCount = meta.totalMessageCount;
  cachingEnabled = meta.cachingEnabled;
  skipCacheWrite = meta.skipCacheWrite;
  forkPointPinned = meta.forkPointPinned;
  markerCount = meta.markerCount;
}
function multiCacheEnabled() { return true; }
function buildUser(msg, shouldCache) {
  return { role: "user", content: msg.content.map(b => shouldCache ? { ...b, cache_control: { type: "ephemeral" } } : b) };
}
function buildAssistant(msg, shouldCache) {
  return { role: "assistant", content: msg.content.map(b => shouldCache ? { ...b, cache_control: { type: "ephemeral" } } : b) };
}
${output}
return { clampRequest, buildRequest, buildCacheBreakpoints };
	`)() as {
		clampRequest: (req: any, limit: number) => any;
		buildRequest: (...args: any[]) => any;
		buildCacheBreakpoints: (...args: any[]) => any[];
	};
}

function countCacheControls(request: any) {
	const system = request.system.filter(
		(block: any) => block.cache_control,
	).length;
	const tools = request.tools.filter((tool: any) => tool.cache_control).length;
	let messages = 0;
	for (const msg of request.messages) {
		for (const block of msg.content) {
			if (block.cache_control) messages++;
		}
	}
	return { system, tools, messages, total: system + tools + messages };
}

test("cache-tail-policy does not issue a synthetic request during CLI startup", async () => {
	const ast = parse(STARTUP_MOCK_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes('content: "warm"') || output.includes("max_tokens: 0"),
		false,
		"startup must not issue a synthetic side query before the UI initializes",
	);
});

test("cache-tail-policy caps cache_control blocks in the live request builder and request clamp helper", async () => {
	const ast = parse(CACHE_TAIL_FIXTURE + CACHE_CONTROL_BLOCK_CAP_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast);

	assert.equal(
		(output.match(/let maxMsgCheckpoints = 4 - systemToolsCount;/g) ?? [])
			.length,
		2,
		"live request builder and request clamp helper should compute maxMsgCheckpoints",
	);
	assert.match(
		output,
		/let requestPayload =/,
		"live request builder should patch the materialized request object",
	);
	assert.equal(
		output.includes("delete cp.block.cache_control;"),
		true,
		"should delete excess message checkpoints",
	);
	assert.equal(
		output.includes('cacheBlock.cache_control.ttl = "1h";'),
		true,
		"should enforce 1h TTL on system blocks",
	);
	assert.equal(
		output.includes('tool.cache_control = { type: "ephemeral", ttl: "1h" };'),
		true,
		"should enforce ephemeral 1h TTL on tools",
	);
	assert.equal(
		output.includes("!tool.defer_loading"),
		true,
		"tools cache_control assignment should skip deferred tools",
	);
	assert.equal(
		output.includes("Array.isArray(L.tools)") &&
			output.includes("Array.isArray(requestPayload.tools)"),
		true,
		"tools array should be counted for cache_control blocks",
	);
});

test("cache-tail-policy does not match a request object whose tools/tool_choice are conditional spreads", async () => {
	const SPREAD_KEY_BUILDER = `
function buildSpreadRequest(model, messages, system, tools, toolChoice) {
  return {
    model,
    messages,
    system,
    metadata: {},
    max_tokens: 1024,
    ...(tools && { tools }),
    ...(toolChoice && { tool_choice: toolChoice }),
  };
}
`;
	const ast = parse(CACHE_TAIL_FIXTURE + SPREAD_KEY_BUILDER);
	await runCacheTailViaPasses(ast);
	const output = print(ast);
	// The spread-key builder must NOT receive the cache_control cap injection.
	assert.equal(
		output.includes("maxMsgCheckpoints"),
		false,
		"object with conditional-spread tools/tool_choice must not be treated as the live request builder",
	);
});

test("cache-tail-policy does not match a request object that is not the final sequence expression", async () => {
	const WRONG_SEQUENCE_TAIL_BUILDER = `
function buildWrongSequenceRequest(model, messages, system, tools, toolChoice) {
  let requestDecoy = {
      model,
      messages,
      system,
      tools,
      tool_choice: toolChoice,
      metadata: {},
      max_tokens: 1024,
    },
    alternateRequest = { ...requestDecoy };
  return requestDecoy, alternateRequest;
}
`;
	const ast = parse(CACHE_TAIL_FIXTURE + WRONG_SEQUENCE_TAIL_BUILDER);
	await runCacheTailViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes("Array.isArray(requestDecoy.messages)"),
		false,
		"a non-final request identifier must not identify the live request builder",
	);
});

test("cache-tail-policy injects the live request builder cap exactly once even with a second request-shaped object", async () => {
	const SECOND_BUILDER = `
function buildRequestTwo(messages, system, tools, model, maxTokens) {
  let requestPayloadTwo = {
    model: model,
    messages: messages,
    system: system,
    tools: tools,
    tool_choice: undefined,
    metadata: {},
    max_tokens: maxTokens,
  };
  return requestPayloadTwo;
}
`;
	const ast = parse(
		CACHE_TAIL_FIXTURE + CACHE_CONTROL_BLOCK_CAP_FIXTURE + SECOND_BUILDER,
	);
	await runCacheTailViaPasses(ast);
	const output = print(ast);
	// Clamp helper (1) + first live request builder (1) = 2; the injector stops
	// on the first request-builder match, so the second must stay un-injected.
	assert.equal(
		(output.match(/let maxMsgCheckpoints = 4 - systemToolsCount;/g) ?? [])
			.length,
		2,
		"exactly one live-request-builder injection plus one clamp injection",
	);
	// The block-cap verifier alone must accept this output: the live builder and
	// clamp helper each carry exactly one fixed cap, and the second request
	// object stays un-injected. (Full verify() is not used here because this
	// fixture intentionally omits the sysprompt/TTL surfaces.)
	const blockCapResult = cacheTailPolicy.verify(output, parse(output));
	assert.equal(
		typeof blockCapResult === "string"
			? !blockCapResult.toLowerCase().includes("maxmsgcheckpoints") &&
					!blockCapResult.toLowerCase().includes("request builder") &&
					!blockCapResult.toLowerCase().includes("request clamp")
			: blockCapResult === true,
		true,
		`block-cap surface must not be the failing check, got: ${blockCapResult}`,
	);
});

test("cache-tail-policy caps a live request builder declared as the first of multiple declarators", async () => {
	// The live builder shares its `let` with a trailing non-request declarator,
	// then returns the request as the final expression in a sequence. This locks
	// that the injector's per-declarator loop + splice-after-stmt correctly caps
	// a request object that is the first of several declarators.
	const MULTI_DECL_BUILDER = `
function buildRequestMulti(messages, system, tools, model, maxTokens) {
  let requestMulti = {
    model: model,
    messages: buildCacheBreakpoints(messages, true, undefined, true),
    system: system,
    tools: tools,
    tool_choice: undefined,
    metadata: {},
    max_tokens: maxTokens,
  },
    sanitized = requestMulti.thinking;
  if (sanitized !== requestMulti.thinking) requestMulti.thinking = sanitized;
  return (sanitized = typeof sanitized === "string" ? sanitized : undefined), requestMulti;
}
`;
	const ast = parse(
		CACHE_TAIL_FIXTURE + CACHE_CONTROL_BLOCK_CAP_FIXTURE + MULTI_DECL_BUILDER,
	);
	await runCacheTailViaPasses(ast);
	const output = print(ast);
	// The injector stops on the first request-builder match (requestPayload),
	// so requestMulti stays un-injected here; assert the first builder is still
	// capped against its own var.
	assert.match(
		output,
		/let maxMsgCheckpoints = 4 - systemToolsCount;[\s\S]*Array\.isArray\(requestPayload\.messages\)/,
		"single-declarator builder is still capped against its own var",
	);
	// Prove the multi-declarator-first object is itself a valid injection target
	// by running it as the only request builder present.
	const soloAst = parse(CACHE_TAIL_FIXTURE + MULTI_DECL_BUILDER);
	await runCacheTailViaPasses(soloAst);
	const soloOutput = print(soloAst);
	assert.match(
		soloOutput,
		/Array\.isArray\(requestMulti\.messages\)/,
		"multi-declarator-first request object must receive the cache_control cap when it is the first matched builder",
	);
});

test("cache-tail-policy caps only the first of two distinct 7-key request builders", async () => {
	// The mutator and verifier both rely on a 7-key SUBSET match; the only guard
	// against mis-targeting a different 7-key object is that the injector stops
	// on the first match. Pin that a second distinct request-shaped builder stays
	// structurally un-capped by name.
	const SECOND_REQUEST_BUILDER = `
function buildRequestAlt(messages, system, tools, model, maxTokens) {
  let requestAlt = {
    model: model,
    messages: messages,
    system: system,
    tools: tools,
    tool_choice: undefined,
    metadata: {},
    max_tokens: maxTokens,
  };
  return requestAlt;
}
`;
	const ast = parse(
		CACHE_TAIL_FIXTURE +
			CACHE_CONTROL_BLOCK_CAP_FIXTURE +
			SECOND_REQUEST_BUILDER,
	);
	await runCacheTailViaPasses(ast);
	const output = print(ast);
	// Clamp helper (1) + first live builder requestPayload (1) = 2, never 3.
	assert.equal(
		(output.match(/let maxMsgCheckpoints = 4 - systemToolsCount;/g) ?? [])
			.length,
		2,
		"only the first matched request builder is capped",
	);
	// The second builder must remain structurally un-capped.
	assert.equal(
		output.includes("requestAlt.system"),
		false,
		"second 7-key builder must not receive a cache_control cap",
	);
});

test("cache-tail-policy caps cache_control blocks dynamically during runtime execution", async () => {
	const runtime = await buildCacheControlRuntime();

	const runScenario = ({
		label,
		systemCount,
		toolCount,
		messageCount,
		expectedMaxMessages,
		deferLoadingLastTool = false,
	}: {
		label: string;
		systemCount: number;
		toolCount: number;
		messageCount: number;
		expectedMaxMessages: number;
		deferLoadingLastTool?: boolean;
	}) => {
		const system = Array.from({ length: systemCount }, (_, index) => ({
			type: "text",
			text: `sys${index}`,
			cache_control: { type: "ephemeral" },
		}));
		const tools = Array.from({ length: toolCount }, (_, index) => {
			const isLast = index === toolCount - 1;
			const isDeferred = deferLoadingLastTool && isLast;
			return {
				name: `tool${index}`,
				...(isDeferred
					? { defer_loading: true }
					: deferLoadingLastTool
						? {}
						: { cache_control: { type: "ephemeral" } }),
			};
		});
		const messages = Array.from({ length: messageCount }, (_, index) => ({
			type: "user",
			content: [{ type: "text", text: `u${index}` }],
		}));

		const request = runtime.buildRequest(
			messages,
			system,
			tools,
			"model",
			1024,
			[],
			true,
			"1h",
			true,
			[],
			false,
		);
		const clamped = runtime.clampRequest(request, 2048);
		const counts = countCacheControls(clamped);

		assert.equal(
			counts.system,
			systemCount,
			`${label}: system cache_control should be preserved`,
		);
		assert.equal(
			counts.tools,
			deferLoadingLastTool ? 1 : toolCount,
			`${label}: tools cache_control count mismatch`,
		);
		assert.equal(
			counts.messages <= expectedMaxMessages,
			true,
			`${label}: message checkpoints should be capped at ${expectedMaxMessages}, got ${counts.messages}`,
		);
		assert.equal(
			counts.total <= 4,
			true,
			`${label}: total checkpoints must not exceed 4, got ${counts.total}`,
		);

		if (deferLoadingLastTool && toolCount >= 2) {
			assert.equal(
				clamped.tools[toolCount - 1].cache_control,
				undefined,
				"Deferred tool should not have cache_control set",
			);
			assert.deepEqual(
				clamped.tools[toolCount - 2].cache_control,
				{ type: "ephemeral", ttl: "1h" },
				"Second-to-last (non-deferred) tool should receive 1h cache_control",
			);
		}
	};

	runScenario({
		label: "system and tools leave two message slots",
		systemCount: 1,
		toolCount: 1,
		messageCount: 6,
		expectedMaxMessages: 2,
	});
	runScenario({
		label: "system and tools consume all checkpoint slots",
		systemCount: 2,
		toolCount: 2,
		messageCount: 6,
		expectedMaxMessages: 0,
	});
	runScenario({
		label: "one message slot with multiple message checkpoints",
		systemCount: 2,
		toolCount: 1,
		messageCount: 17,
		expectedMaxMessages: 1,
	});
	runScenario({
		label: "deferred last tool is skipped for cache_control",
		systemCount: 1,
		toolCount: 2,
		messageCount: 6,
		expectedMaxMessages: 2,
		deferLoadingLastTool: true,
	});
});

test("cache-tail-policy does not re-add a skipped 15th-user cache write as decimation", async () => {
	const runtime = await buildCacheControlRuntime();
	const messages = Array.from({ length: 15 }, (_, index) => ({
		type: "user",
		content: [{ type: "text", text: `u${index}` }],
	}));

	const result = runtime.buildCacheBreakpoints(
		messages,
		true,
		undefined,
		false,
		undefined,
		undefined,
		true,
	);

	assert.equal(
		result[14].content[0].cache_control,
		undefined,
		"skipCacheWrite should keep the skipped 15th user free of cache_control",
	);
});

test("cache-tail-policy caps combined system and tool cache_control blocks at four", async () => {
	const runtime = await buildCacheControlRuntime();
	const system = Array.from({ length: 3 }, (_, index) => ({
		type: "text",
		text: `sys${index}`,
		cache_control: { type: "ephemeral" },
	}));
	const tools = Array.from({ length: 3 }, (_, index) => ({
		name: `tool${index}`,
		cache_control: { type: "ephemeral" },
	}));
	const request = runtime.buildRequest(
		[],
		system,
		tools,
		"model",
		1024,
		[],
		true,
		"1h",
		false,
		[],
		false,
	);

	const clamped = runtime.clampRequest(request, 2048);

	assert.equal(
		countCacheControls(clamped).total,
		4,
		"combined system and tool cache_control blocks should be capped at four",
	);
});

async function assertAbsentCacheControlsDoNotConsumeBudget(
	cacheControlValue: null | undefined,
	label: string,
) {
	const runtime = await buildCacheControlRuntime();
	const system = Array.from({ length: 4 }, (_, index) => ({
		type: "text",
		text: `sys${index}`,
		cache_control: cacheControlValue,
	}));
	const messages = [
		{
			type: "user",
			content: [{ type: "text", text: "keep this checkpoint" }],
		},
	];

	const built = runtime.buildRequest(
		messages,
		system,
		[],
		"model",
		1024,
		[],
		true,
		"1h",
		true,
		[],
		false,
	);
	assert.equal(
		countCacheControls(built).messages,
		1,
		`${label}: the live request builder must preserve the real message checkpoint`,
	);

	const clamped = runtime.clampRequest(
		{
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "keep this checkpoint",
							cache_control: { type: "ephemeral" },
						},
					],
				},
			],
			system,
			tools: [],
			max_tokens: 1024,
		},
		2048,
	);
	assert.equal(
		countCacheControls(clamped).messages,
		1,
		`${label}: the request clamp helper must preserve the real message checkpoint`,
	);
}

test("cache-tail-policy treats null cache_control values as absent", async () => {
	await assertAbsentCacheControlsDoNotConsumeBudget(null, "null cache_control");
});

test("cache-tail-policy treats undefined cache_control values as absent", async () => {
	await assertAbsentCacheControlsDoNotConsumeBudget(
		undefined,
		"undefined cache_control",
	);
});

test("cache-tail-policy removes incoming cache_control from deferred tools", async () => {
	const runtime = await buildCacheControlRuntime();
	const request = runtime.buildRequest(
		[],
		[],
		[
			{
				name: "deferred-tool",
				defer_loading: true,
				cache_control: { type: "ephemeral" },
			},
		],
		"model",
		1024,
		[],
		true,
		"1h",
		false,
		[],
		false,
	);

	const clamped = runtime.clampRequest(request, 2048);

	assert.equal(
		clamped.tools[0].cache_control,
		undefined,
		"defer_loading tools must not retain caller-supplied cache_control",
	);
});

test("cache-tail-policy prioritizes an explicit fork checkpoint when one message slot remains", async () => {
	const runtime = await buildCacheControlRuntime();
	const forkPointId = "fork-point";
	const messages = Array.from({ length: 17 }, (_, index) => ({
		type: "user",
		uuid: index === 15 ? forkPointId : `message-${index}`,
		content: [{ type: "text", text: `u${index}` }],
	}));
	const transformedMessages = runtime.buildCacheBreakpoints(
		messages,
		true,
		undefined,
		false,
		undefined,
		undefined,
		false,
		forkPointId,
	);
	const request = {
		messages: transformedMessages,
		system: Array.from({ length: 2 }, (_, index) => ({
			type: "text",
			text: `sys${index}`,
			cache_control: { type: "ephemeral" },
		})),
		tools: [
			{
				name: "tool",
				cache_control: { type: "ephemeral" },
			},
		],
		max_tokens: 1024,
	};

	const clamped = runtime.clampRequest(request, 2048);
	const retainedMessageIndexes = clamped.messages.flatMap(
		(message: any, index: number) =>
			message.content.some((block: any) => block.cache_control) ? [index] : [],
	);

	assert.deepEqual(
		retainedMessageIndexes,
		[15],
		"the explicit fork checkpoint should outrank generic decimation and tail checkpoints",
	);
});

test("cache-tail-policy verify rejects sysprompt rewrite that clobbers the later org scope", async () => {
	const ast = parse(FULL_VERIFY_FIXTURE);
	await runCacheTailViaPasses(ast);
	let output = print(ast);
	assert.equal(
		cacheTailPolicy.verify(output, parse(output)),
		true,
		"fully patched passes",
	);
	// Force BOTH cacheScope pushes to global (the later org block is now gone).
	output = output.replaceAll('cacheScope: "org"', 'cacheScope: "global"');
	const result = cacheTailPolicy.verify(output, parse(output));
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes('cacheScope: "org"') ||
			String(result).includes("org"),
		true,
		`Expected later-org preservation failure, got: ${result}`,
	);
});

test("cache-tail-policy verify rejects tool cache_control without defer_loading guard", async () => {
	const ast = parse(FULL_VERIFY_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast);
	assert.equal(cacheTailPolicy.verify(output, parse(output)), true);

	const unsafeOutput = output.replaceAll(" && !tool.defer_loading", "");
	const result = cacheTailPolicy.verify(unsafeOutput, parse(unsafeOutput));

	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("defer_loading"),
		true,
		`Expected defer_loading guard failure, got: ${result}`,
	);
});

test("cache-tail-policy sysprompt rewrite yields global identity block and a preserved org block", async () => {
	// The other sysprompt tests prove later-org preservation only via a negative
	// clobber. Positively assert the real post-state: the identity push becomes
	// global while a later org push survives, and the combined output verifies.
	const ast = parse(FULL_VERIFY_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast);
	assert.equal(
		output.includes('cacheScope: "global"'),
		true,
		"identity block rewritten to global",
	);
	assert.equal(
		output.includes('cacheScope: "org"'),
		true,
		"later org block preserved (not over-rewritten to global)",
	);
	assert.equal(cacheTailPolicy.verify(output, parse(output)), true);
});

const NESTED_MARKER_FIXTURE = `
function outer() {
  function nested() {
    gate("tengu_api_cache_breakpoints", !1);
  }
  let findCacheableIndex = (startIndex) => startIndex;
  let tailIndex = findCacheableIndex(2);
  let markerIndexes = new Set();
  if (tailIndex >= 0) markerIndexes.add(tailIndex);
  gate("tengu_api_cache_breakpoints", {
    totalMessageCount: 3,
    markerCount: markerIndexes.size,
  });
  return [1, 2, 3].map(function(item, idx) {
    var isTail = markerIndexes.has(idx);
    return buildAssistant(item, isTail);
  });
}
`;

test("cache-tail-policy does not insert duplicate declarations when nested functions also contain the marker", async () => {
	const ast = parse(NESTED_MARKER_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast);

	assert.equal(
		(output.match(/var cacheTailWindow = 2;/g) ?? []).length,
		1,
		"cacheTailWindow should be declared once",
	);
	assert.equal(
		(output.match(/var cacheUserOnly = true;/g) ?? []).length,
		1,
		"cacheUserOnly should be declared once",
	);
});

test("cache-tail-policy is idempotent on already-patched input", async () => {
	const ast = parse(FULL_VERIFY_FIXTURE);
	await runCacheTailViaPasses(ast);
	await runCacheTailViaPasses(ast);
	const output = print(ast);

	assert.equal(
		(output.match(/var cacheTailWindow = 2;/g) ?? []).length,
		1,
		"cacheTailWindow should not be reinserted on reapply",
	);
	assert.equal(
		(output.match(/var cacheUserOnly = true;/g) ?? []).length,
		1,
		"cacheUserOnly should not be reinserted on reapply",
	);
	assert.equal(cacheTailPolicy.verify(output, parse(output)), true);
});

test("cache-tail-policy only injects missing tail policy declarations", async () => {
	const ast = parse(PARTIAL_DECL_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast);

	assert.equal(
		(output.match(/var cacheTailWindow = 2;/g) ?? []).length,
		1,
		"missing cacheTailWindow should be inserted once",
	);
	assert.equal(
		(output.match(/var cacheUserOnly = true;/g) ?? []).length,
		1,
		"existing cacheUserOnly should not be duplicated",
	);
	assert.equal(cacheTailPolicy.verify(output, parse(output)), true);
});

test("cache-tail-policy verify rejects patched code missing required anchors", async () => {
	const ast = parse(CACHE_TAIL_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast);
	const result = cacheTailPolicy.verify(output, parse(output));

	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("sysprompt") ||
			String(result).includes("request clamp helper"),
		true,
		`Expected missing-anchor failure, got: ${result}`,
	);
});
