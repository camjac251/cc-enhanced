import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { noCollapse } from "./no-collapse.js";

async function runNoCollapseViaPasses(ast: any): Promise<void> {
	const passes = (await noCollapse.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: noCollapse.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

// Minimal fixture that mirrors the three structural patterns the patch targets:
//
// 1. _pH guard: an if-statement with `A.isCollapsible || A.isREPL` that returns
//    an object containing isSearch, isRead, isREPL, isMemoryWrite properties.
//
// 2. UT$ wrapper: a 3-param function whose sole statement is
//    `return Z8H(H, $, A).isCollapsible`
//
// 3. Z8H central function: returns an object with
//    `isCollapsible: obj.isSearch || obj.isRead` alongside isSearch, isRead,
//    isREPL, isMemoryWrite properties. This must be PRESERVED (not patched).
//
// The verifier also checks that the patched wrapper (UT$) is called somewhere
// with 3 args where the second is a `.input` member expression, so we include
// a call site: `UT$(block, msg.input, ctx)`.
const NO_COLLAPSE_FIXTURE = `
function Z8H(H, $, A) {
  var obj = { type: H.type, name: H.name };
  return {
    isSearch: obj.isSearch,
    isRead: obj.isRead,
    isREPL: obj.isREPL,
    isMemoryWrite: obj.isMemoryWrite,
    isCollapsible: obj.isSearch || obj.isRead
  };
}

function _pH(H) {
  if (H && H.type === "tool_use" && H.name) {
    var A = Z8H(H, null, null);
    if (A.isCollapsible || A.isREPL) {
      return { isSearch: A.isSearch, isRead: A.isRead, isREPL: A.isREPL, isMemoryWrite: A.isMemoryWrite };
    }
  }
  return null;
}

function UT$(H, $, A) {
  return Z8H(H, $, A).isCollapsible;
}

function renderUI(block, msg, ctx) {
  var collapsed = UT$(block, msg.input, ctx);
  return collapsed;
}

function renderMemoryWriteResult(H, A) {
  if (H.type !== "memory_write") return null;
  return {
    filePath: A,
    isCollapsible: !0,
    isMemoryWrite: !0,
    isSearch: !1,
    isRead: !1,
    isREPL: !1,
  };
}
`;

test("no-collapse patches guard and wrapper while preserving Z8H isCollapsible", async () => {
	const ast = parse(NO_COLLAPSE_FIXTURE);
	await runNoCollapseViaPasses(ast);
	const output = print(ast);

	// Guard was changed from isCollapsible||isREPL to isREPL||isMemoryWrite
	assert.equal(output.includes("A.isCollapsible || A.isREPL"), false);
	assert.equal(output.includes("A.isREPL || A.isMemoryWrite"), true);

	// Wrapper now returns false instead of Z8H(...).isCollapsible
	assert.equal(output.includes("Z8H(H, $, A).isCollapsible"), false);
	assert.equal(output.includes("return false;"), true);

	// Z8H isCollapsible property is preserved (cache tail eviction)
	assert.equal(
		output.includes("isCollapsible: obj.isSearch || obj.isRead"),
		true,
	);

	// Memory write flags flipped to false
	assert.equal(output.includes("isCollapsible: !1"), true);
	assert.equal(output.includes("isMemoryWrite: !1"), true);

	// Verify passes on patched output
	assert.equal(noCollapse.verify(output, ast), true);
});

test("no-collapse verify rejects unpatched fixture", () => {
	const ast = parse(NO_COLLAPSE_FIXTURE);
	const result = noCollapse.verify(NO_COLLAPSE_FIXTURE, ast);
	assert.equal(typeof result, "string");
	// Should detect original guard, wrapper, or unpatched memory write
	assert.equal(
		typeof result === "string" &&
			(result.includes("Original collapse-metadata guard") ||
				result.includes("Original isCollapsible wrapper") ||
				result.includes("Unpatched memory write result object")),
		true,
		`Expected unpatched pattern failure, got: ${result}`,
	);
});

test("no-collapse verify detects guard regression", async () => {
	const ast = parse(NO_COLLAPSE_FIXTURE);
	await runNoCollapseViaPasses(ast);
	const output = print(ast);

	// Revert guard back to original
	const regressed = output.replace(
		"A.isREPL || A.isMemoryWrite",
		"A.isCollapsible || A.isREPL",
	);
	assert.notEqual(regressed, output);

	const regressedAst = parse(regressed);
	const result = noCollapse.verify(regressed, regressedAst);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("Original collapse-metadata guard"),
		true,
		`Expected guard regression failure, got: ${result}`,
	);
});

test("no-collapse verify detects wrapper regression", async () => {
	const ast = parse(NO_COLLAPSE_FIXTURE);
	await runNoCollapseViaPasses(ast);
	const output = print(ast);

	// Revert wrapper back to original
	const regressed = output.replace(
		/function UT\$\(H, \$, A\) \{\s*return false;\s*\}/,
		"function UT$(H, $, A) { return Z8H(H, $, A).isCollapsible; }",
	);
	assert.notEqual(regressed, output);

	const regressedAst = parse(regressed);
	const result = noCollapse.verify(regressed, regressedAst);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("Original isCollapsible wrapper"),
		true,
		`Expected wrapper regression failure, got: ${result}`,
	);
});

test("no-collapse verify requires AST argument", () => {
	const result = noCollapse.verify("code");
	assert.equal(result, "Missing AST for no-collapse verification");
});

// ---------------------------------------------------------------------------
// Memory write UI tests
// ---------------------------------------------------------------------------

test("no-collapse flips memory-write result flags to false", async () => {
	// NO_COLLAPSE_FIXTURE already includes the memory write result object
	const ast = parse(NO_COLLAPSE_FIXTURE);
	await runNoCollapseViaPasses(ast);
	const output = print(ast);

	assert.equal(output.includes("isCollapsible: !1"), true);
	assert.equal(output.includes("isMemoryWrite: !1"), true);
	assert.equal(noCollapse.verify(output, ast), true);
});

test("no-collapse verify detects missing Z8H isCollapsible", async () => {
	// Fixture missing the Z8H central function entirely but has memory write result
	const fixtureNoZ8H = `
function innerZ8H(H, $, A) {
  return { isSearch: true, isRead: false, isREPL: false, isMemoryWrite: false };
}

function _pH(H) {
  if (H && H.type === "tool_use" && H.name) {
    var A = innerZ8H(H, null, null);
    if (A.isREPL || A.isMemoryWrite) {
      return { isSearch: A.isSearch, isRead: A.isRead, isREPL: A.isREPL, isMemoryWrite: A.isMemoryWrite };
    }
  }
  return null;
}

function UT$(H, $, A) {
  return false;
}

function renderUI(block, msg, ctx) {
  var collapsed = UT$(block, msg.input, ctx);
  return collapsed;
}

function renderMemoryWriteResult(H, A) {
  return { filePath: A, isCollapsible: !1, isMemoryWrite: !1, isSearch: !1, isRead: !1, isREPL: !1 };
}
`;
	const ast = parse(fixtureNoZ8H);
	const result = noCollapse.verify(fixtureNoZ8H, ast);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("Result-object factory isCollapsible"),
		true,
		`Expected Z8H preservation failure, got: ${result}`,
	);
});
