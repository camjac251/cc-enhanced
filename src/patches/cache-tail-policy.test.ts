import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { cacheTailPolicy } from "./cache-tail-policy.js";

async function runCacheTailViaPasses(
	ast: any,
	passIndexes?: number[],
): Promise<void> {
	const passes = (await cacheTailPolicy.astPasses?.(ast)) ?? [];
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
// - A .map() callback with a variable assigned from `=== arr.length - 1`
// - A return statement calling a builder function with (item, tailVar)
// - A second return in an if-branch calling a "user" builder (should be skipped)
const CACHE_TAIL_FIXTURE = `
function buildCacheBreakpoints(messages) {
  var marker = gate("tengu_api_cache_breakpoints", !1);
  var arr = messages.filter(function(m) { return m.role; });
  return arr.map(function(item, idx, list) {
    var isTail = idx === list.length - 1;
    if (item.role === "user") {
      return buildUser(item, isTail);
    }
    return buildAssistant(item, isTail);
  });
}
`;

test("cache-tail-policy applies declarations, window gate, and user-only conditional", async () => {
	const ast = parse(CACHE_TAIL_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast);

	// Declarations injected
	assert.equal(output.includes("var cacheTailWindow = 2;"), true);
	assert.equal(output.includes("var cacheUserOnly = true;"), true);

	// The === operator was replaced with >
	assert.equal(output.includes("=== list.length - 1"), false);
	assert.equal(output.includes("> list.length - (cacheTailWindow + 1)"), true);

	// The assistant return got the cacheUserOnly conditional
	assert.equal(output.includes("cacheUserOnly ? false : isTail"), true);

	// The user return was NOT wrapped (buildUser is the userFnName)
	assert.equal(output.includes("buildUser(item, isTail)"), true);
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

test("cache-tail-policy verify detects === operator regression", async () => {
	const ast = parse(FULL_VERIFY_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast);

	// Revert the > operator back to === to simulate regression.
	// The verifier expects `> length - (cacheTailWindow + 1)`, so reverting
	// to === means it no longer finds the patched `>` gate form.
	const regressed = output.replace(
		"> list.length - (cacheTailWindow + 1)",
		"=== list.length - (cacheTailWindow + 1)",
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

test("cache-tail-policy verify detects legacy === length - 1 gate", () => {
	const ast = parse(FULL_VERIFY_FIXTURE);
	const result = cacheTailPolicy.verify(FULL_VERIFY_FIXTURE, ast);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("Legacy tail cache gate") ||
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
  var marker = gate("tengu_api_cache_breakpoints", !1);
  var arr = messages.filter(function(m) { return m.role; });
  return arr.map(function(item, idx, list) {
    var isTail = idx === list.length - 1;
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

	// Gate was patched in ternary branches
	assert.equal(output.includes("=== list.length - 1"), false);
	assert.equal(output.includes("> list.length - (cacheTailWindow + 1)"), true);

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

test("cache-tail-policy patches cache control builder for 1h TTL on scoped blocks", async () => {
	const ast = parse(CACHE_CONTROL_BUILDER_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast);

	// Post-patch: `(H || $) && { ttl: H ? "1h" : $ }`.
	assert.equal(output.includes("H || $"), true);
	assert.equal(output.includes('H ? "1h" : $'), true);
});

test("cache-tail-policy extends 1h TTL allowlist to subagent query sources", async () => {
	const ast = parse(CACHE_TTL_ALLOWLIST_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast);

	assert.equal(output.includes('"agent:*"'), true);
	assert.equal(output.includes('allowlist.push("agent:*")'), true);
	assert.equal(output.includes('"hook_agent"'), false);
	assert.equal(output.includes('"verification_agent"'), false);
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
		output.includes("H || $"),
		true,
		"scope-gated 1h TTL left operand",
	);
	assert.equal(
		output.includes('H ? "1h" : $'),
		true,
		"scope-gated 1h TTL ternary value",
	);
	assert.equal(
		output.includes('"agent:*"'),
		true,
		"subagent query sources get 1h TTL",
	);
	assert.equal(
		output.includes("let cacheControlExcess = -4;"),
		true,
		"cache_control block cap",
	);

	// Full verify should pass
	assert.equal(cacheTailPolicy.verify(output, parse(output)), true);
});

test("cache-tail-policy verify rejects unpatched cache control builder in combined fixture", async () => {
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

	// Revert the TTL patch: `(H || $) && { ttl: H ? "1h" : $ }` -> `$ && { ttl: $ }`
	output = output.replace("H || $", "$").replace('H ? "1h" : $', "$");
	const result = cacheTailPolicy.verify(output, parse(output));
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("1h TTL"),
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
		"let cacheControlExcess = -4;",
		"let cacheControlExcess = -3;",
	);
	assert.notEqual(regressed, output);

	const result = cacheTailPolicy.verify(regressed, parse(regressed));
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("cacheControlExcess"),
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
  return (
    betas = [],
    {
      model: model,
      messages: buildCacheBreakpoints(messages, cacheEnabled, ttl, true, cacheEdits, pinnedEdits, skipCacheWrite),
      system: system,
      tools: tools,
      tool_choice: undefined,
      metadata: {},
      max_tokens: maxTokens,
      ...(betas.length > 0 && { betas }),
    }
  );
}

async function sendNonStream(client, request) {
  return await client.beta.messages.create({ ...clampRequest(request, V_M) });
}

async function sendStream(client, request, signal) {
  return await client.beta.messages.stream({ ...buildRequest(request.messages, request.system, request.tools, request.model, request.max_tokens, request.betas, request.cacheEnabled, request.ttl, request.cacheEdits, request.pinnedEdits, request.skipCacheWrite), stream: true }, { signal });
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
  var marker = gate("tengu_api_cache_breakpoints", !1);
  var cacheUserOnly = true;
  var arr = messages.filter(function(m) { return m.role; });
  return arr.map(function(item, idx, list) {
    var isTail = idx === list.length - 1;
    return buildAssistant(item, isTail);
  });
}
` +
	SYSPROMPT_SCOPE_FIXTURE +
	CACHE_CONTROL_BUILDER_FIXTURE +
	CACHE_TTL_ALLOWLIST_FIXTURE +
	CACHE_CONTROL_BLOCK_CAP_FIXTURE;

test("cache-tail-policy caps cache_control blocks in the live request builder and request clamp helper", async () => {
	const ast = parse(CACHE_TAIL_FIXTURE + CACHE_CONTROL_BLOCK_CAP_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast);

	assert.equal(
		(output.match(/let cacheControlExcess = -4;/g) ?? []).length,
		2,
		"live request builder and request clamp helper should count excess cache_control blocks",
	);
	assert.match(
		output,
		/let _cacheControlledRequest =/,
		"live request builder should materialize the request before stripping excess cache_control blocks",
	);
	assert.equal(
		output.indexOf(".messages = ") < output.indexOf(".system = "),
		true,
		"message breakpoints should be evicted before system breakpoints",
	);
	assert.equal(
		output.indexOf(".system = ") < output.indexOf(".tools = "),
		true,
		"system breakpoints should be evicted before tool breakpoints",
	);
	assert.equal(
		output.includes("Array.isArray(L.tools)"),
		true,
		"tools array should be counted for cache_control blocks",
	);
});

const NESTED_MARKER_FIXTURE = `
function outer() {
  function nested() {
    gate("tengu_api_cache_breakpoints", !1);
  }
  var marker = gate("tengu_api_cache_breakpoints", !1);
  return [1, 2, 3].map(function(item, idx, list) {
    var isTail = idx === list.length - 1;
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
			String(result).includes("cache control builder") ||
			String(result).includes("request clamp helper"),
		true,
		`Expected missing-anchor failure, got: ${result}`,
	);
});
