import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { limits } from "./limits.js";

async function runLimitsViaPasses(ast: any): Promise<void> {
	const passes = (await limits.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: limits.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

// Minimal fixture mimicking the structures that collectCurrentLimits and runLimitsPatch find.
// Uses realistic variable names that differ from patch constants (minified-like).
//
// Key structural requirements the patch traversal expects:
// - byteCeiling: function(file, limit = VAR) with inline statSync(file).size <= limit
// - tokenBudget: function containing CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS env ref + sibling default var after the function
// - resultSizeCap: helper with third param defaulting to VAR and returning Math.min(secondParam, thirdParam)
// - readMaxResultSize: object with name:"Read" and maxResultSizeChars:100000
// - linesCap/lineChars: template literal with "Reads a file" trigger + interpolated vars
const LIMITS_FIXTURE = `
var bYC = 262144;
var ZPA = 50000;
var lNC = 2000;
var lCC = 500;

function getMaxOutputTokens() {
  let env = process.env.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS;
  if (env) {
    let parsed = Number(env);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return;
}
var rTI = 25000;

function checkFileSize(filePath, maxSize = bYC) {
  if (require("fs").statSync(filePath).size <= maxSize) {
    return true;
  }
  return false;
}

var readToolDef = {
  name: "Read",
  maxResultSizeChars: 100000,
  description: "Read files"
};

function getPersistenceThreshold(toolName, maxResultSizeChars, persistenceThresholdCeiling = ZPA) {
  if (!Number.isFinite(maxResultSizeChars)) return maxResultSizeChars;
  return Math.min(maxResultSizeChars, persistenceThresholdCeiling);
}

var readPromptText = \`Reads a file from the local filesystem.
The file reads up to \${lNC} lines of content.
Lines longer than \${lCC} characters are truncated.\`;
`;

test("limits patch modifies all six numeric targets via combined AST passes", async () => {
	const ast = parse(LIMITS_FIXTURE);
	await runLimitsViaPasses(ast);
	const output = print(ast);

	// byteCeiling: 262144 -> 1048576
	assert.equal(
		output.includes("262144"),
		false,
		"old byteCeiling should be gone",
	);
	assert.equal(
		output.includes("1048576"),
		true,
		"new byteCeiling should be present",
	);

	// tokenBudget: 25000 -> 50000
	assert.equal(
		output.includes("rTI = 25000"),
		false,
		"old tokenBudget should be gone",
	);
	assert.equal(
		output.includes("rTI = 50000"),
		true,
		"new tokenBudget should be present",
	);

	// resultSizeCap: 50000 -> 120000
	assert.equal(
		output.includes("ZPA = 50000"),
		false,
		"old resultSizeCap should be gone",
	);
	assert.equal(
		output.includes("ZPA = 120000"),
		true,
		"new resultSizeCap should be present",
	);

	// readMaxResultSize: 100000 -> 250000
	assert.equal(
		output.includes("maxResultSizeChars: 100000"),
		false,
		"old readMaxResultSize should be gone",
	);
	assert.equal(
		output.includes("maxResultSizeChars: 250000"),
		true,
		"new readMaxResultSize should be present",
	);

	// linesCap: 2000 -> 5000
	assert.equal(
		output.includes("lNC = 2000"),
		false,
		"old linesCap should be gone",
	);
	assert.equal(
		output.includes("lNC = 5000"),
		true,
		"new linesCap should be present",
	);

	// lineChars: 500 -> 5000 (use word boundary to avoid substring match with 5000)
	assert.equal(
		output.includes("lCC = 500;"),
		false,
		"old lineChars should be gone",
	);
	assert.equal(
		output.includes("lCC = 5000"),
		true,
		"new lineChars should be present",
	);
});

test("limits verify returns true on patched AST", async () => {
	const ast = parse(LIMITS_FIXTURE);
	await runLimitsViaPasses(ast);
	const output = print(ast);

	const result = limits.verify(output, ast);
	assert.equal(result, true);
});

test("limits verify detects unpatched byteCeiling", () => {
	const ast = parse(LIMITS_FIXTURE);
	const output = print(ast);

	const result = limits.verify(output, ast);
	assert.equal(
		typeof result,
		"string",
		"verify should fail on unpatched fixture",
	);
	assert.equal(
		String(result).includes("byteCeiling"),
		true,
		"failure should mention byteCeiling",
	);
});

test("limits verify detects wrong tokenBudget value", async () => {
	// Patch it, then manually revert just the token budget
	const ast = parse(LIMITS_FIXTURE);
	await runLimitsViaPasses(ast);
	const output = print(ast);

	const tampered = output.replace("rTI = 50000", "rTI = 30000");
	const tamperedAst = parse(tampered);
	const result = limits.verify(tampered, tamperedAst);
	assert.equal(
		typeof result,
		"string",
		"verify should fail on wrong tokenBudget",
	);
	assert.equal(String(result).includes("tokenBudget"), true);
});

test("limits verify requires resultSizeCap < readMaxResultSize", async () => {
	// After patching, resultSizeCap=120000 and readMaxResultSize=250000 (120000 < 250000 = OK).
	// Manually set readMaxResultSize to 120000 in the patched output to trigger the invariant.
	const ast = parse(LIMITS_FIXTURE);
	await runLimitsViaPasses(ast);
	const output = print(ast);

	// Tamper: replace patched readMaxResultSize (250000) with resultSizeCap value (120000)
	const tampered = output.replace(
		"maxResultSizeChars: 250000",
		"maxResultSizeChars: 120000",
	);
	const tamperedAst = parse(tampered);
	const result = limits.verify(tampered, tamperedAst);
	assert.equal(
		typeof result,
		"string",
		"verify should fail when readMaxResultSize is too small",
	);
	assert.equal(
		String(result).includes("readMaxResultSize"),
		true,
		"should reference readMaxResultSize in failure",
	);
});

test("limits verify requires CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS env var reference", async () => {
	// First fully patch the fixture, then remove the env var reference.
	// The verify check for the env var (line 618+) runs after the numeric limit checks,
	// so we need all numeric limits to be correct first.
	const ast = parse(LIMITS_FIXTURE);
	await runLimitsViaPasses(ast);
	const output = print(ast);
	assert.equal(
		limits.verify(output, ast),
		true,
		"sanity: patched fixture should pass",
	);

	// Strip the env var name from the output. collectCurrentLimits also uses
	// this env var to find the token budget function, so it won't find tokenBudget.
	// The verify will fail on "Could not resolve limit tokenBudget" first.
	// That's still a valid failure. Verify catches the env var removal indirectly.
	const stripped = output.replaceAll(
		"CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS",
		"SOME_OTHER_ENV_VAR",
	);
	const strippedAst = parse(stripped);
	const result = limits.verify(stripped, strippedAst);
	assert.equal(
		typeof result,
		"string",
		"verify should fail when env var is removed",
	);
	// The failure is about tokenBudget resolution (which depends on the env var function)
	assert.equal(
		String(result).includes("tokenBudget"),
		true,
		"should fail to resolve tokenBudget without the env var",
	);
});

test("limits verify returns failure string when AST is missing", () => {
	const result = limits.verify("some code");
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("Missing AST"), true);
});

test("limits patch is idempotent (running twice produces same output)", async () => {
	const ast1 = parse(LIMITS_FIXTURE);
	await runLimitsViaPasses(ast1);
	const output1 = print(ast1);

	// Parse the already-patched output and run again
	const ast2 = parse(output1);
	await runLimitsViaPasses(ast2);
	const output2 = print(ast2);

	// The numeric values should be unchanged (patch guards on original values)
	assert.equal(
		output2.includes("rTI = 50000"),
		true,
		"tokenBudget should remain 50000",
	);
	assert.equal(
		output2.includes("1048576"),
		true,
		"byteCeiling should remain 1048576",
	);
	assert.equal(
		output2.includes("ZPA = 120000"),
		true,
		"resultSizeCap should remain 120000",
	);
});

test("limits patch handles Read tool name via identifier binding", async () => {
	// Variant: name property uses an identifier resolved via variable binding
	const indirectFixture = `
var bYC = 262144;
var ZPA = 50000;

function getMaxOutputTokens() {
  let env = process.env.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS;
  if (env) {
    let parsed = Number(env);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return;
}
var rTI = 25000;

function checkFileSize(filePath, maxSize = bYC) {
  if (require("fs").statSync(filePath).size <= maxSize) {
    return true;
  }
  return false;
}

var readToolName = "Read";
var readToolDef = {
  name: readToolName,
  maxResultSizeChars: 100000,
  description: "Read files"
};

function getPersistenceThreshold(toolName, maxResultSizeChars, persistenceThresholdCeiling = ZPA) {
  if (!Number.isFinite(maxResultSizeChars)) return maxResultSizeChars;
  return Math.min(maxResultSizeChars, persistenceThresholdCeiling);
}
`;
	const ast = parse(indirectFixture);
	await runLimitsViaPasses(ast);
	const output = print(ast);

	// readMaxResultSize should still be patched via identifier binding resolution
	assert.equal(
		output.includes("maxResultSizeChars: 250000"),
		true,
		"readMaxResultSize should be patched via indirect name binding",
	);
});
