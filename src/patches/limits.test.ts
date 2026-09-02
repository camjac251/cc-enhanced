import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { getLimitsChanged, limits } from "./limits.js";

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
// - byteCeiling: async function(file, limit = VAR) with inline stat(file).size <= limit
// - resultSizeCap: helper with third param defaulting to VAR and returning Math.min(secondParam, thirdParam)
// - readMaxResultSize: object with name:"Read" and maxResultSizeChars:100000
// - linesCap: template literal with "Reads a file" trigger + interpolated var
const LIMITS_FIXTURE = `
var bYC = 262144;
var ZPA = 50000;
var lNC = 2000;

async function checkFileSize(filePath, maxSize = bYC) {
  if ((await require("fs").stat(filePath)).size <= maxSize) {
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
The file reads up to \${lNC} lines of content.\`;
`;

test("limits patch modifies the current numeric targets via combined AST passes", async () => {
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

	assert.deepEqual(getLimitsChanged(), {
		byteCeiling: ["262144", "1048576"],
		resultSizeCap: ["50000", "120000"],
		readMaxResultSize: ["100000", "250000"],
		linesCap: ["2000", "5000"],
	});
});

test("limits patches the Read prompt's lexical binding", async () => {
	const scopedFixture = LIMITS_FIXTURE.replace(
		"var lNC = 2000;",
		"function unrelated() {\n  var lNC = 123;\n  return lNC;\n}",
	).replace(
		"var readPromptText = `Reads a file from the local filesystem.\nThe file reads up to ${lNC} lines of content.`;",
		"function buildReadPrompt() {\n  var lNC = 2000;\n  return `Reads a file from the local filesystem.\nThe file reads up to ${lNC} lines of content.`;\n}",
	);
	assert.notEqual(scopedFixture, LIMITS_FIXTURE);

	const ast = parse(scopedFixture);
	await runLimitsViaPasses(ast);
	const output = print(ast);

	assert.match(output, /function unrelated\(\) \{\s*var lNC = 123;/);
	assert.match(output, /function buildReadPrompt\(\) \{\s*var lNC = 5000;/);
	assert.equal(limits.verify(output, ast), true);
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

async function checkFileSize(filePath, maxSize = bYC) {
  if ((await require("fs").stat(filePath)).size <= maxSize) {
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

test("limits identifies the rebundled Read tool by its search hint", async () => {
	const ast = parse(`
var readToolName;
function initializeReadTool() {
  readToolName = "Read";
}
var readToolDef = {
  name: readToolName,
  searchHint: "read files, images, PDFs, notebooks",
  maxResultSizeChars: 100000,
};
`);
	await runLimitsViaPasses(ast);
	const output = print(ast);

	assert.match(output, /maxResultSizeChars: 250000/);
});

test("limits leaves an already-Infinity maxResultSizeChars untouched and still verifies", async () => {
	const infinityFixture = `
var bYC = 262144;
var ZPA = 50000;
var lNC = 2000;
var readPromptText = \`Reads a file from the local filesystem.
The file reads up to \${lNC} lines of content.\`;
function getMaxOutputTokens() {
  let env = process.env.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS;
  if (env) { let p = Number(env); if (!Number.isNaN(p) && p > 0) return p; }
  return;
}
var rTI = 25000;
async function checkFileSize(filePath, maxSize = bYC) {
  return (await require("fs").stat(filePath)).size <= maxSize;
}
var readToolName = "Read";
var readToolDef = {
  name: readToolName,
  searchHint: "read files, images, PDFs, notebooks",
  maxResultSizeChars: Infinity,
  description: "Read files"
};
function getPersistenceThreshold(toolName, maxResultSizeChars, ceiling = ZPA) {
  if (!Number.isFinite(maxResultSizeChars)) return maxResultSizeChars;
  return Math.min(maxResultSizeChars, ceiling);
}
`;
	const ast = parse(infinityFixture);
	await runLimitsViaPasses(ast);
	const output = print(ast);
	// Infinity cap must be preserved (patch records no-op, never writes 250000 here)
	assert.equal(
		output.includes("maxResultSizeChars: Infinity"),
		true,
		"Infinity maxResultSizeChars should be preserved",
	);
	assert.equal(
		output.includes("maxResultSizeChars: 250000"),
		false,
		"should not rewrite an already-Infinity cap",
	);
	// verify accepts >= target, so an Infinity cap still passes
	assert.equal(
		limits.verify(output, ast),
		true,
		"verify should pass with Infinity readMaxResultSize",
	);
});

test("limits supports the current Read prompt without a per-line character limit", async () => {
	const currentReadPromptFixture = `
var bYC = 262144;
var ZPA = 50000;
var lNC = 2000;
function getMaxOutputTokens() {
  let env = process.env.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS;
  if (env) { let p = Number(env); if (!Number.isNaN(p) && p > 0) return p; }
  return;
}
var rTI = 25000;
async function checkFileSize(filePath, maxSize = bYC) {
  return (await require("fs").stat(filePath)).size <= maxSize;
}
var readToolDef = { name: "Read", searchHint: "read files, images, PDFs, notebooks", maxResultSizeChars: 100000, description: "Read files" };
function getPersistenceThreshold(toolName, maxResultSizeChars, ceiling = ZPA) {
  if (!Number.isFinite(maxResultSizeChars)) return maxResultSizeChars;
  return Math.min(maxResultSizeChars, ceiling);
}
var readPromptText = \`Reads a file from the local filesystem.
The file reads up to \${lNC} lines of content.\`;
`;
	const ast = parse(currentReadPromptFixture);
	await runLimitsViaPasses(ast);
	const output = print(ast);
	assert.equal(output.includes("lNC = 5000"), true);
	assert.equal(limits.verify(output, ast), true);
});

test("limits resultSizeCap ignores a 50000-default function that is not a Math.min clamp", async () => {
	const decoyFixture = `
var bYC = 262144;
var ZPA = 50000;
var lNC = 2000;
var readPromptText = \`Reads a file from the local filesystem.
The file reads up to \${lNC} lines of content.\`;
var DEC = 50000;
function getMaxOutputTokens() {
  let env = process.env.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS;
  if (env) { let p = Number(env); if (!Number.isNaN(p) && p > 0) return p; }
  return;
}
var rTI = 25000;
async function checkFileSize(filePath, maxSize = bYC) {
  return (await require("fs").stat(filePath)).size <= maxSize;
}
var readToolDef = { name: "Read", searchHint: "read files, images, PDFs, notebooks", maxResultSizeChars: 100000, description: "Read files" };
function decoyCap(a, b, c = DEC) {
  if (a > c) return c;
  return b + c;
}
function getPersistenceThreshold(toolName, maxResultSizeChars, ceiling = ZPA) {
  if (!Number.isFinite(maxResultSizeChars)) return maxResultSizeChars;
  return Math.min(maxResultSizeChars, ceiling);
}
`;
	const ast = parse(decoyFixture);
	await runLimitsViaPasses(ast);
	const output = print(ast);
	// real persistence ceiling rewritten
	assert.equal(
		output.includes("ZPA = 120000"),
		true,
		"real resultSizeCap ceiling should be patched",
	);
	// decoy 50000-default left untouched
	assert.equal(
		output.includes("DEC = 50000"),
		true,
		"decoy 50000 default must not be rewritten",
	);
	assert.equal(
		limits.verify(output, ast),
		true,
		"verify should pass with the decoy present",
	);
});

test("limits patches linesCap when the Read prompt has a capital-R branch plus a lowercase 'reads up to' branch sharing one lines var", async () => {
	// Mirrors the real prompt shape: two branches, one shared lines variable,
	// only the lowercase "it reads up to" branch carrying the matchable quasi.
	// Guards against a future release flipping the casing of either branch.
	const twoBranchFixture = `
var bYC = 262144;
var ZPA = 50000;
var lNC = 2000;
function getMaxOutputTokens() {
  let env = process.env.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS;
  if (env) { let p = Number(env); if (!Number.isNaN(p) && p > 0) return p; }
  return;
}
var rTI = 25000;
async function checkFileSize(filePath, maxSize = bYC) {
  return (await require("fs").stat(filePath)).size <= maxSize;
}
var readToolDef = { name: "Read", searchHint: "read files, images, PDFs, notebooks", maxResultSizeChars: 1 / 0, description: "Read files" };
function getPersistenceThreshold(toolName, maxResultSizeChars, ceiling = ZPA) {
  if (!Number.isFinite(maxResultSizeChars)) return maxResultSizeChars;
  return Math.min(maxResultSizeChars, ceiling);
}
function readPrompt(cond) {
  if (cond)
    return \`Reads a file from the local filesystem.
- Reads up to \${lNC} lines by default.\`;
  return \`Reads a file from the local filesystem. You can access any file directly.
- it reads up to \${lNC} lines starting from the beginning of the file\`;
}
`;
	const ast = parse(twoBranchFixture);
	await runLimitsViaPasses(ast);
	const output = print(ast);
	// Single shared lines var: rewriting it updates the value for both branches.
	assert.equal(
		output.includes("lNC = 5000"),
		true,
		"shared lines var should be raised to 5000",
	);
	assert.equal(
		output.includes("lNC = 2000"),
		false,
		"old lines value should be gone",
	);
	assert.equal(
		limits.verify(output, ast),
		true,
		"verify should pass on the two-branch prompt",
	);
});

test("limits raises the shared byteCeiling constant so a second consumer sees the new value", async () => {
	// Real topology: the byte-ceiling constant is referenced both by the
	// async stat "<=" gate and by a separate config default. Rewriting the
	// shared declaration must update every reference site at once.
	const sharedCeilingFixture = `
var bYC = 262144;
var ZPA = 50000;
var lNC = 2000;
var readPromptText = \`Reads a file from the local filesystem.
The file reads up to \${lNC} lines of content.\`;
function getMaxOutputTokens() {
  let env = process.env.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS;
  if (env) { let p = Number(env); if (!Number.isNaN(p) && p > 0) return p; }
  return;
}
var rTI = 25000;
async function checkFileSize(filePath, maxSize = bYC) {
  return (await require("fs").stat(filePath)).size <= maxSize;
}
function readToolConfig(cfg) {
  return { maxSizeBytes: typeof cfg?.maxSizeBytes === "number" ? cfg.maxSizeBytes : bYC };
}
var readToolDef = { name: "Read", searchHint: "read files", maxResultSizeChars: 1 / 0, description: "Read files" };
function getPersistenceThreshold(toolName, maxResultSizeChars, ceiling = ZPA) {
  if (!Number.isFinite(maxResultSizeChars)) return maxResultSizeChars;
  return Math.min(maxResultSizeChars, ceiling);
}
`;
	const ast = parse(sharedCeilingFixture);
	await runLimitsViaPasses(ast);
	const output = print(ast);
	// The declaration is rewritten once; both the gate default and the config
	// default now read the raised value.
	assert.equal(
		output.includes("bYC = 1048576"),
		true,
		"shared ceiling decl should be raised",
	);
	assert.equal(
		output.includes("262144"),
		false,
		"no 262144 should remain for the shared ceiling",
	);
	// Both reference sites still point at the (now raised) symbol.
	assert.equal(
		output.includes("maxSize = bYC"),
		true,
		"gate default still references the raised symbol",
	);
	assert.equal(
		output.includes(": bYC"),
		true,
		"config consumer still references the raised symbol",
	);
	assert.equal(
		limits.verify(output, ast),
		true,
		"verify should pass with the shared ceiling",
	);
});

test("limits byteCeiling ignores an unrelated synchronous size check", async () => {
	// A separate file-size gate uses statSync(e).size > ceiling with its own
	// 262144 constant. The matcher requires "<=", so the ">" gate's ceiling
	// must be left untouched.
	const decoyGateFixture = `
var bYC = 262144;
var GHI = 262144;
var ZPA = 50000;
var lNC = 2000;
var readPromptText = \`Reads a file from the local filesystem.
The file reads up to \${lNC} lines of content.\`;
function getMaxOutputTokens() {
  let env = process.env.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS;
  if (env) { let p = Number(env); if (!Number.isNaN(p) && p > 0) return p; }
  return;
}
var rTI = 25000;
function themeGate(themePath, ceiling = GHI) {
  if (require("fs").statSync(themePath).size > ceiling) return;
  return true;
}
async function checkFileSize(filePath, maxSize = bYC) {
  return (await require("fs").stat(filePath)).size <= maxSize;
}
var readToolDef = { name: "Read", searchHint: "read files", maxResultSizeChars: 1 / 0, description: "Read files" };
function getPersistenceThreshold(toolName, maxResultSizeChars, ceiling = ZPA) {
  if (!Number.isFinite(maxResultSizeChars)) return maxResultSizeChars;
  return Math.min(maxResultSizeChars, ceiling);
}
`;
	const ast = parse(decoyGateFixture);
	await runLimitsViaPasses(ast);
	const output = print(ast);
	// The "<=" Read gate ceiling is raised...
	assert.equal(
		output.includes("bYC = 1048576"),
		true,
		"the '<=' gate ceiling should be raised",
	);
	// ...but the ">" theme gate ceiling must remain 262144.
	assert.equal(
		output.includes("GHI = 262144"),
		true,
		"the '>' theme gate ceiling must be untouched",
	);
	assert.equal(
		limits.verify(output, ast),
		true,
		"verify should pass with the decoy '>' gate present",
	);
});
