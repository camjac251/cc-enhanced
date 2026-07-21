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

// Minimal fixture that mirrors the structural patterns the patch targets:
//
// 1. collapse metadata guard: an if-statement with `A.isCollapsible || A.isREPL` that returns
//    an object containing isSearch, isRead, isREPL, isMemoryWrite properties.
//
// 2. central classification function: returns an object with
//    `isCollapsible: obj.isSearch || obj.isRead` alongside isSearch, isRead,
//    isREPL, isMemoryWrite properties. This must be PRESERVED (not patched).
const NO_COLLAPSE_FIXTURE = `
function classifyToolResult(H, $, A) {
  var obj = { type: H.type, name: H.name };
  return {
    isSearch: obj.isSearch,
    isRead: obj.isRead,
    isREPL: obj.isREPL,
    isMemoryWrite: obj.isMemoryWrite,
    isCollapsible: obj.isSearch || obj.isRead,
    isBash: obj.isBash ? !0 : void 0
  };
}

function getCollapseMetadata(H) {
  if (H && H.type === "tool_use" && H.name) {
    var A = classifyToolResult(H, null, null);
    if (A.isCollapsible || A.isREPL) {
      return { isSearch: A.isSearch, isRead: A.isRead, isREPL: A.isREPL, isMemoryWrite: A.isMemoryWrite };
    }
  }
  return null;
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

test("no-collapse patches guard while preserving classification isCollapsible", async () => {
	const ast = parse(NO_COLLAPSE_FIXTURE);
	await runNoCollapseViaPasses(ast);
	const output = print(ast);

	// Guard was changed from isCollapsible||isREPL to isREPL||isMemoryWrite
	assert.equal(output.includes("A.isCollapsible || A.isREPL"), false);
	assert.equal(output.includes("A.isREPL || A.isMemoryWrite"), true);

	// Classification isCollapsible property is preserved (cache tail eviction)
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
	// Should detect the original guard or unpatched memory write flags.
	assert.equal(
		typeof result === "string" &&
			(result.includes("Original collapse-metadata guard") ||
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

test("no-collapse verify detects missing classification isCollapsible", async () => {
	const fixtureNoClassification = `
function innerClassifyToolResult(H, $, A) {
  return { isSearch: true, isRead: false, isREPL: false, isMemoryWrite: false };
}

function getCollapseMetadata(H) {
  if (H && H.type === "tool_use" && H.name) {
    var A = innerClassifyToolResult(H, null, null);
    if (A.isREPL || A.isMemoryWrite) {
      return { isSearch: A.isSearch, isRead: A.isRead, isREPL: A.isREPL, isMemoryWrite: A.isMemoryWrite };
    }
  }
  return null;
}

function renderMemoryWriteResult(H, A) {
  return { filePath: A, isCollapsible: !1, isMemoryWrite: !1, isSearch: !1, isRead: !1, isREPL: !1 };
}
`;
	const ast = parse(fixtureNoClassification);
	const result = noCollapse.verify(fixtureNoClassification, ast);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("Result-object factory isCollapsible"),
		true,
		`Expected classification preservation failure, got: ${result}`,
	);
});

test("no-collapse mutator is single-shot: a second guard site is left unpatched", async () => {
	const twoGuardFixture = `
function classifyToolResult(H, $, A) {
  var obj = { type: H.type, name: H.name };
  return {
    isSearch: obj.isSearch,
    isRead: obj.isRead,
    isREPL: obj.isREPL,
    isMemoryWrite: obj.isMemoryWrite,
    isCollapsible: obj.isSearch || obj.isRead,
    isBash: obj.isBash ? !0 : void 0
  };
}
function guardOne(H) {
  var A = classifyToolResult(H, null, null);
  if (A.isCollapsible || A.isREPL) {
    return { isSearch: A.isSearch, isRead: A.isRead, isREPL: A.isREPL, isMemoryWrite: A.isMemoryWrite };
  }
  return null;
}
function guardTwo(B) {
  if (B.isCollapsible || B.isREPL) {
    return { isSearch: B.isSearch, isRead: B.isRead, isREPL: B.isREPL, isMemoryWrite: B.isMemoryWrite };
  }
  return null;
}
function renderMemoryWriteResult(H, A) {
  return { filePath: A, isCollapsible: !0, isMemoryWrite: !0, isSearch: !1, isRead: !1, isREPL: !1 };
}
`;
	const ast = parse(twoGuardFixture);
	await runNoCollapseViaPasses(ast);
	const output = print(ast);
	// Exactly one guard is rewritten; the second original guard survives.
	const patchedCount = output.split("isREPL || ").length - 1;
	const originalCount = output.split("isCollapsible || ").length - 1;
	assert.equal(
		patchedCount,
		1,
		"only the first guard should be rewritten (single-shot)",
	);
	assert.equal(
		originalCount,
		1,
		"the second guard is left in its original shape (documents the limitation)",
	);
});

test("no-collapse verify tolerates a conditional-expression factory isCollapsible value", async () => {
	const conditionalValueFixture = `
function classifyToolResult(H, $, A) {
  var obj = { type: H.type, name: H.name };
  return {
    isSearch: obj.isSearch,
    isRead: obj.isRead,
    isList: obj.isList,
    isREPL: obj.isREPL,
    isMemoryWrite: obj.isMemoryWrite,
    isCollapsible: obj.isSearch ? !0 : obj.isRead,
    isBash: obj.isBash ? !0 : void 0
  };
}
function getCollapseMetadata(H) {
  if (H && H.type === "tool_use" && H.name) {
    var A = classifyToolResult(H, null, null);
    if (A.isCollapsible || A.isREPL) {
      return { isSearch: A.isSearch, isRead: A.isRead, isREPL: A.isREPL, isMemoryWrite: A.isMemoryWrite };
    }
  }
  return null;
}
function renderMemoryWriteResult(H, A) {
  return { filePath: A, isCollapsible: !0, isMemoryWrite: !0, isSearch: !1, isRead: !1, isREPL: !1 };
}
`;
	const ast = parse(conditionalValueFixture);
	await runNoCollapseViaPasses(ast);
	const output = print(ast);
	// Conditional-valued isCollapsible is preserved verbatim (not mutated).
	assert.equal(
		output.includes("isCollapsible: obj.isSearch ? !0 : obj.isRead"),
		true,
	);
	// And verify accepts it: non-literal value plus four sibling props.
	assert.equal(noCollapse.verify(output, ast), true);
});

test("no-collapse verify accepts a negated-identifier factory isCollapsible value", async () => {
	const negatedIdentFixture = `
function classifyToolResult(H, $, A) {
  var hidden = H.hidden;
  return {
    isSearch: H.isSearch,
    isRead: H.isRead,
    isList: H.isList,
    isREPL: H.isREPL,
    isMemoryWrite: H.isMemoryWrite,
    isCollapsible: !hidden,
    isBash: H.isBash ? !0 : void 0
  };
}
function getCollapseMetadata(H) {
  if (H && H.type === "tool_use" && H.name) {
    var A = classifyToolResult(H, null, null);
    if (A.isCollapsible || A.isREPL) {
      return { isSearch: A.isSearch, isRead: A.isRead, isREPL: A.isREPL, isMemoryWrite: A.isMemoryWrite };
    }
  }
  return null;
}
function renderMemoryWriteResult(H, A) {
  return { filePath: A, isCollapsible: !0, isMemoryWrite: !0, isSearch: !1, isRead: !1, isREPL: !1 };
}
`;
	const ast = parse(negatedIdentFixture);
	await runNoCollapseViaPasses(ast);
	const output = print(ast);
	// Negated-identifier isCollapsible is preserved verbatim (not mutated).
	assert.equal(output.includes("isCollapsible: !hidden"), true);
	// And verify accepts it: a negated identifier is non-literal with 4 siblings.
	assert.equal(noCollapse.verify(output, ast), true);
});

test("no-collapse verify is satisfied by any one non-literal isCollapsible factory object (two present)", async () => {
	const twoFactoryFixture = `
function classifyA(H) {
  var hidden = H.hidden;
  return {
    isSearch: H.isSearch,
    isRead: H.isRead,
    isList: H.isList,
    isREPL: H.isREPL,
    isMemoryWrite: H.isMemoryWrite,
    isCollapsible: !hidden,
    isBash: H.isBash ? !0 : void 0
  };
}
function classifyB(H) {
  var a = H.a, b = H.b;
  return {
    isSearch: H.isSearch,
    isRead: H.isRead,
    isList: H.isList,
    isREPL: H.isREPL,
    isMemoryWrite: H.isMemoryWrite,
    isCollapsible: a || (b ? !0 : !1),
    isBash: H.isBash ? !0 : void 0
  };
}
function getCollapseMetadata(H) {
  if (H && H.type === "tool_use" && H.name) {
    var A = classifyA(H);
    if (A.isCollapsible || A.isREPL) {
      return { isSearch: A.isSearch, isRead: A.isRead, isREPL: A.isREPL, isMemoryWrite: A.isMemoryWrite };
    }
  }
  return null;
}
function renderMemoryWriteResult(H, A) {
  return { filePath: A, isCollapsible: !0, isMemoryWrite: !0, isSearch: !1, isRead: !1, isREPL: !1 };
}
`;
	const ast = parse(twoFactoryFixture);
	await runNoCollapseViaPasses(ast);
	const output = print(ast);
	// Both non-literal factory values survive (neither is mutated).
	assert.equal(output.includes("isCollapsible: !hidden"), true);
	assert.equal(output.includes("isCollapsible: a || (b ? !0 : !1)"), true);
	// Check 2 is an existence check over isBash-bearing containers: passes
	// with either/both present.
	assert.equal(noCollapse.verify(output, ast), true);
});

test("no-collapse verify rejects a literal factory isCollapsible value even with all sibling props present", () => {
	const literalValueFixture = `
function classifyToolResult(H, $, A) {
  return {
    isSearch: !1,
    isRead: !1,
    isList: !1,
    isREPL: !1,
    isMemoryWrite: !1,
    isCollapsible: !0
  };
}
function getCollapseMetadata(H) {
  if (H && H.type === "tool_use" && H.name) {
    var A = classifyToolResult(H, null, null);
    if (A.isREPL || A.isMemoryWrite) {
      return { isSearch: A.isSearch, isRead: A.isRead, isREPL: A.isREPL, isMemoryWrite: A.isMemoryWrite };
    }
  }
  return null;
}
function renderMemoryWriteResult(H, A) {
  return { filePath: A, isCollapsible: !1, isMemoryWrite: !1, isSearch: !1, isRead: !1, isREPL: !1 };
}
`;
	const ast = parse(literalValueFixture);
	const result = noCollapse.verify(literalValueFixture, ast);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("Result-object factory isCollapsible"),
		true,
		`Expected factory-preservation failure for literal value, got: ${result}`,
	);
});
