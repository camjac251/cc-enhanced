import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { alwaysLoadMcp } from "./always-load-mcp.js";

async function applyAlwaysLoadMcp(source: string): Promise<string> {
	const ast = parse(source);
	const passes = (await alwaysLoadMcp.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: alwaysLoadMcp.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
	return print(ast);
}

const MINIFIED_QP = `
function qp(H) {
  if (H.alwaysLoad === !0) return !1;
  if (H.isMcp === !0) return !0;
  if (H.name === _w) return !1;
  if (H.name === IK) {
    if ((v5H(), b6(UVK)).isForkSubagentEnabled()) return !1;
  }
  return H.shouldDefer === !0;
}
`;

const EXPLICIT_QP = `
function isDeferredTool(tool) {
  if (tool.alwaysLoad === true) return false;
  if (tool.isMcp === true) return true;
  if (tool.name === "ToolSearch") return false;
  return tool.shouldDefer === true;
}
`;

const NO_MATCH_FN = `
function unrelated(H) {
  if (H.foo === !0) return !1;
  if (H.bar === !0) return !0;
  return H.baz === !0;
}
`;

test("always-load-mcp injects allowlist check between alwaysLoad and isMcp guards (minified form)", async () => {
	const output = await applyAlwaysLoadMcp(MINIFIED_QP);
	assert.match(output, /process\.env\.CLAUDE_ALWAYS_LOAD_MCP/);
	assert.match(
		output,
		/\.startsWith\("mcp__"\)|\.indexOf\("mcp__"\)\s*===\s*0/,
	);

	const ast = parse(output);
	assert.equal(alwaysLoadMcp.verify(output, ast), true);

	const alwaysLoadIdx = output.indexOf("alwaysLoad");
	const envCheckIdx = output.indexOf("CLAUDE_ALWAYS_LOAD_MCP");
	const originalIsMcpIdx = output.indexOf("H.isMcp === !0");

	assert.ok(alwaysLoadIdx > -1, "alwaysLoad guard preserved");
	assert.ok(envCheckIdx > alwaysLoadIdx, "env check inserted after alwaysLoad");
	assert.ok(
		originalIsMcpIdx > envCheckIdx,
		"original minified isMcp guard remains after the new check",
	);
});

test("always-load-mcp also matches the unminified shape (true/false literals)", async () => {
	const output = await applyAlwaysLoadMcp(EXPLICIT_QP);
	assert.match(output, /process\.env\.CLAUDE_ALWAYS_LOAD_MCP/);
	const ast = parse(output);
	assert.equal(alwaysLoadMcp.verify(output, ast), true);
});

test("always-load-mcp leaves unrelated functions alone", async () => {
	const output = await applyAlwaysLoadMcp(NO_MATCH_FN);
	assert.equal(
		output.includes("CLAUDE_ALWAYS_LOAD_MCP"),
		false,
		"no env-var ref should appear",
	);
	const ast = parse(output);
	const result = alwaysLoadMcp.verify(output, ast);
	assert.equal(
		typeof result,
		"string",
		"verifier should reject input where qp was never found",
	);
});

test("always-load-mcp verify rejects unpatched fixture", () => {
	const ast = parse(MINIFIED_QP);
	const result = alwaysLoadMcp.verify(MINIFIED_QP, ast);
	assert.equal(typeof result, "string");
});

test("always-load-mcp is idempotent", async () => {
	const once = await applyAlwaysLoadMcp(MINIFIED_QP);
	const twice = await applyAlwaysLoadMcp(once);
	assert.equal(once, twice, "second pass must not double-inject");

	const occurrences = (twice.match(/CLAUDE_ALWAYS_LOAD_MCP/g) ?? []).length;
	assert.equal(occurrences, 2, "exactly two env-var refs after one injection");
});

test("always-load-mcp does not match when first two stmts use different params", async () => {
	const MIXED_PARAMS = `
function bogus(H) {
  if (H.alwaysLoad === !0) return !1;
  if (X.isMcp === !0) return !0;
  return H.shouldDefer === !0;
}
`;
	const output = await applyAlwaysLoadMcp(MIXED_PARAMS);
	assert.equal(output.includes("CLAUDE_ALWAYS_LOAD_MCP"), false);
});

test("always-load-mcp does not match when alwaysLoad return value is wrong", async () => {
	const WRONG_RETURN = `
function bogus(H) {
  if (H.alwaysLoad === !0) return !0;
  if (H.isMcp === !0) return !0;
  return H.shouldDefer === !0;
}
`;
	const output = await applyAlwaysLoadMcp(WRONG_RETURN);
	assert.equal(output.includes("CLAUDE_ALWAYS_LOAD_MCP"), false);
});

test("always-load-mcp injected check uses the same param name as the original function", async () => {
	const output = await applyAlwaysLoadMcp(EXPLICIT_QP);
	assert.match(
		output,
		/tool\.isMcp\s*===\s*true\s*&&\s*process\.env\.CLAUDE_ALWAYS_LOAD_MCP/,
		"injected condition references the original parameter name (`tool`)",
	);
});

test("always-load-mcp matches against the real cli.js qp shape including subsequent guards", async () => {
	const REAL_SHAPE = `
function qp(H) {
  if (H.alwaysLoad === !0) return !1;
  if (H.isMcp === !0) return !0;
  if (H.name === _w) return !1;
  if (H.name === IK) {
    if ((v5H(), b6(UVK)).isForkSubagentEnabled()) return !1;
  }
  if (QVK && H.name === QVK) return !1;
  if (cVK && H.name === cVK) {
    if ((LbH(), b6(JbH)).isLoopDynamicEnabled()) return !1;
  }
  return H.shouldDefer === !0;
}
`;
	const output = await applyAlwaysLoadMcp(REAL_SHAPE);
	const ast = parse(output);
	assert.equal(alwaysLoadMcp.verify(output, ast), true);
	assert.match(output, /H\.alwaysLoad/);
	assert.match(output, /H\.isMcp/);
	assert.match(output, /H\.name === _w/);
	assert.match(output, /H\.shouldDefer/);
});

test("always-load-mcp runtime: env var allowlist returns false for matched server", async () => {
	const output = await applyAlwaysLoadMcp(MINIFIED_QP);
	const _w = "ToolSearch";
	const IK = "Task";
	const fn = new Function(
		"_w",
		"IK",
		"v5H",
		"b6",
		"UVK",
		"QVK",
		"cVK",
		"LbH",
		"JbH",
		`${output}\nreturn qp;`,
	)(
		_w,
		IK,
		() => {},
		() => ({ isForkSubagentEnabled: () => false }),
		{},
		null,
		null,
		() => {},
		{},
	);

	const prev = process.env.CLAUDE_ALWAYS_LOAD_MCP;
	try {
		process.env.CLAUDE_ALWAYS_LOAD_MCP = "probe,chunkhound";

		const probeTool = { name: "mcp__probe__search_code", isMcp: true };
		assert.equal(fn(probeTool), false, "probe tool should NOT be deferred");

		const chunkhoundTool = { name: "mcp__chunkhound__search", isMcp: true };
		assert.equal(
			fn(chunkhoundTool),
			false,
			"chunkhound should NOT be deferred",
		);

		const niaTool = { name: "mcp__nia__search", isMcp: true };
		assert.equal(fn(niaTool), true, "nia tool SHOULD remain deferred");

		const builtin = { name: "Read", isMcp: false, shouldDefer: false };
		assert.equal(fn(builtin), false, "non-MCP tool stays non-deferred");
	} finally {
		if (prev === undefined) delete process.env.CLAUDE_ALWAYS_LOAD_MCP;
		else process.env.CLAUDE_ALWAYS_LOAD_MCP = prev;
	}
});

test("always-load-mcp runtime: trims whitespace in env list", async () => {
	const output = await applyAlwaysLoadMcp(MINIFIED_QP);
	const fn = new Function(
		"_w",
		"IK",
		"v5H",
		"b6",
		"UVK",
		"QVK",
		"cVK",
		"LbH",
		"JbH",
		`${output}\nreturn qp;`,
	)(
		"ToolSearch",
		"Task",
		() => {},
		() => ({ isForkSubagentEnabled: () => false }),
		{},
		null,
		null,
		() => {},
		{},
	);

	const prev = process.env.CLAUDE_ALWAYS_LOAD_MCP;
	try {
		process.env.CLAUDE_ALWAYS_LOAD_MCP = "  probe ,  chunkhound  ";
		const probeTool = { name: "mcp__probe__search_code", isMcp: true };
		assert.equal(
			fn(probeTool),
			false,
			"whitespace-padded entries should still match",
		);
	} finally {
		if (prev === undefined) delete process.env.CLAUDE_ALWAYS_LOAD_MCP;
		else process.env.CLAUDE_ALWAYS_LOAD_MCP = prev;
	}
});

test("always-load-mcp runtime: unset env var is a no-op", async () => {
	const output = await applyAlwaysLoadMcp(MINIFIED_QP);
	const fn = new Function(
		"_w",
		"IK",
		"v5H",
		"b6",
		"UVK",
		"QVK",
		"cVK",
		"LbH",
		"JbH",
		`${output}\nreturn qp;`,
	)(
		"ToolSearch",
		"Task",
		() => {},
		() => ({ isForkSubagentEnabled: () => false }),
		{},
		null,
		null,
		() => {},
		{},
	);

	const prev = process.env.CLAUDE_ALWAYS_LOAD_MCP;
	try {
		delete process.env.CLAUDE_ALWAYS_LOAD_MCP;
		const probeTool = { name: "mcp__probe__search_code", isMcp: true };
		assert.equal(
			fn(probeTool),
			true,
			"with env var unset, MCP tool stays deferred",
		);
	} finally {
		if (prev !== undefined) process.env.CLAUDE_ALWAYS_LOAD_MCP = prev;
	}
});

test("always-load-mcp runtime: tool name without mcp__ prefix is not promoted", async () => {
	const output = await applyAlwaysLoadMcp(MINIFIED_QP);
	const fn = new Function(
		"_w",
		"IK",
		"v5H",
		"b6",
		"UVK",
		"QVK",
		"cVK",
		"LbH",
		"JbH",
		`${output}\nreturn qp;`,
	)(
		"ToolSearch",
		"Task",
		() => {},
		() => ({ isForkSubagentEnabled: () => false }),
		{},
		null,
		null,
		() => {},
		{},
	);

	const prev = process.env.CLAUDE_ALWAYS_LOAD_MCP;
	try {
		process.env.CLAUDE_ALWAYS_LOAD_MCP = "probe";
		const oddName = { name: "probe", isMcp: true };
		assert.equal(
			fn(oddName),
			true,
			"a tool whose name does not start with mcp__ stays deferred",
		);
	} finally {
		if (prev === undefined) delete process.env.CLAUDE_ALWAYS_LOAD_MCP;
		else process.env.CLAUDE_ALWAYS_LOAD_MCP = prev;
	}
});
