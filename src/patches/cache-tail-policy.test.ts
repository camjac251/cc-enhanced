import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { cacheTailPolicy } from "./cache-tail-policy.js";

async function runCacheTailViaPasses(ast: any): Promise<void> {
	const passes = (await cacheTailPolicy.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: cacheTailPolicy.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
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

	// Verify passes on patched output
	assert.equal(cacheTailPolicy.verify(output, ast), true);
});

test("cache-tail-policy verify rejects unpatched fixture", () => {
	const ast = parse(CACHE_TAIL_FIXTURE);
	const result = cacheTailPolicy.verify(CACHE_TAIL_FIXTURE, ast);
	assert.equal(typeof result, "string");
	// Should fail on missing declarations or legacy gate
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
	const ast = parse(CACHE_TAIL_FIXTURE);
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
	// Verify that the original unpatched form (=== length - 1) is flagged
	const ast = parse(CACHE_TAIL_FIXTURE);
	const result = cacheTailPolicy.verify(CACHE_TAIL_FIXTURE, ast);
	assert.equal(typeof result, "string");
	// The unpatched fixture has === length - 1 which triggers the legacy check
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

	// Verify passes
	assert.equal(cacheTailPolicy.verify(output, ast), true);
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
	// Combine tail-window fixture + sysprompt fixture so tail-window checks pass
	const combined = CACHE_TAIL_FIXTURE + SYSPROMPT_SCOPE_FIXTURE;
	const ast = parse(combined);
	// Only run the tail-window passes (not the scope mutator) so scope stays "org"
	const tailVisitor = (await cacheTailPolicy.astPasses?.(ast))?.[0];
	if (tailVisitor) {
		await runCombinedAstPasses(
			ast,
			[{ tag: cacheTailPolicy.tag, pass: tailVisitor }],
			() => {},
			() => {},
			(_tag, error) => {
				throw error;
			},
		);
	}
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
function buildCacheControl({ scope: H, querySource: $ } = {}) {
  return {
    type: "ephemeral",
    ...(checkAllowlist($) ? { ttl: "1h" } : {}),
    ...(H === "global" ? { scope: H } : {}),
  };
}
`;

test("cache-tail-policy patches cache control builder for 1h TTL on scoped blocks", async () => {
	const ast = parse(CACHE_CONTROL_BUILDER_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast);

	// The TTL conditional should now include the scope parameter: (H || checkAllowlist($))
	assert.equal(output.includes("H || checkAllowlist"), true);
});

test("cache-tail-policy patches all three features in combined fixture", async () => {
	const combined =
		CACHE_TAIL_FIXTURE +
		SYSPROMPT_SCOPE_FIXTURE +
		CACHE_CONTROL_BUILDER_FIXTURE;
	const ast = parse(combined);
	await runCacheTailViaPasses(ast);
	const output = print(ast);

	// All three mutations should be present
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
		output.includes("H || checkAllowlist"),
		true,
		"scope-gated 1h TTL",
	);

	// Full verify should pass
	assert.equal(cacheTailPolicy.verify(output, parse(output)), true);
});

test("cache-tail-policy verify rejects unpatched cache control builder in combined fixture", async () => {
	// Combine all fixtures, patch fully, then revert TTL to simulate drift
	const combined =
		CACHE_TAIL_FIXTURE +
		SYSPROMPT_SCOPE_FIXTURE +
		CACHE_CONTROL_BUILDER_FIXTURE;
	const ast = parse(combined);
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

	// Revert the TTL patch: (H || checkAllowlist($)) -> checkAllowlist($)
	output = output.replace("H || checkAllowlist", "checkAllowlist");
	const result = cacheTailPolicy.verify(output, parse(output));
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("1h TTL"),
		true,
		`Expected TTL-related failure, got: ${result}`,
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

async function sendNonStream(client, request) {
  return await client.beta.messages.create({ ...clampRequest(request, V_M) });
}

async function sendStream(client, request, signal) {
  return await client.beta.messages.stream({ ...request }, { signal });
}
`;

test("cache-tail-policy caps cache_control blocks in the request clamp helper", async () => {
	const ast = parse(CACHE_TAIL_FIXTURE + CACHE_CONTROL_BLOCK_CAP_FIXTURE);
	await runCacheTailViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes("let cacheControlExcess = -4;"),
		true,
		"request clamp helper should count excess cache_control blocks",
	);
	assert.match(
		output,
		/\.beta\.messages\.stream\(\{\s*\.\.\.request\s*\},\s*\{\s*signal\s*\}\)/,
		"streaming request should remain unchanged",
	);
	assert.equal(
		output.indexOf(".messages = ") < output.indexOf(".system = "),
		true,
		"message breakpoints should be evicted before system breakpoints",
	);
	assert.equal(cacheTailPolicy.verify(output, parse(output)), true);
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
	assert.equal(cacheTailPolicy.verify(output, parse(output)), true);
});
