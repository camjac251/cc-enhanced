import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { readWithBat } from "./read-bat.js";

async function runReadWithBatViaPasses(ast: any): Promise<void> {
	const passes = (await readWithBat.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: readWithBat.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

const READ_SCHEMA_FIXTURE = `
const z = {
  strictObject(x) { return x; },
  string() { return { optional() { return this; }, describe() { return this; } }; },
  number() { return { optional() { return this; }, describe() { return this; } }; },
  boolean() { return { optional() { return this; }, describe() { return this; } }; },
};

const ReadTool = {
  name: "Read",
  description() {
    return "A tool for reading files";
  },
  prompt() {
    return "Use offset and limit parameters to read specific portions of the file, or use the GrepTool to search for specific content";
  },
  input_examples: [
    { file_path: "/Users/username/project/README.md", limit: 100, offset: 50 },
  ],
  input_schema: z.strictObject({
    file_path: z.string().describe("The absolute path to the file to read"),
    offset: z.number().optional().describe("Legacy offset"),
    limit: z.number().optional().describe("Legacy limit"),
    pages: z.string().optional().describe("Use the pages parameter to read specific page ranges"),
  }),
};
`;

const READ_DELEGATION_FIXTURE = `
const z = {
  strictObject(x) { return x; },
  string() { return { optional() { return this; }, describe() { return this; } }; },
  number() { return { optional() { return this; }, describe() { return this; } }; },
  boolean() { return { optional() { return this; }, describe() { return this; } }; },
};
function eG1() { return false; }

const ReadTool = {
  name: "Read",
  description() {
    return "A tool for reading files";
  },
  prompt() {
    return "Use offset and limit parameters to read specific portions of the file, or use the GrepTool to search for specific content";
  },
  input_examples: [
    { file_path: "/Users/username/project/README.md", limit: 100, offset: 50 },
  ],
  input_schema: z.strictObject({
    file_path: z.string().describe("The absolute path to the file to read"),
    offset: z.number().optional().describe("Legacy offset"),
    limit: z.number().optional().describe("Legacy limit"),
    pages: z.string().optional().describe("Use the pages parameter to read specific page ranges"),
  }),
  async validateInput({ file_path: A, offset: Q, limit: B, pages: Y }, G) {
    if (!eG1(Y) && !Q && !B) return { result: false };
    return { result: true };
  },
  async call({ file_path: A, offset: Q = 1, limit: B = void 0, ...READ_COMPAT }, G) {
    if (R === void 0 && READ_COMPAT.offset !== void 0 && READ_COMPAT.limit !== void 0) {
      R = String(READ_COMPAT.offset) + ":" + String(READ_COMPAT.limit);
    }
    return await helperRead(A, Q, B, MAX_BYTES, SIGNAL, G, EXTRA1, EXTRA2);
  },
};

async function helperRead(filePath, offset, limit, maxBytes, signal, ctx, extra1, extra2) {
  let W = offset === 0 ? 0 : offset - 1, { content: K, lineCount: O, totalLines: T } = await D2I(filePath, W, limit, maxBytes, signal);
  ctx.readFileState.set(filePath, { content: K, timestamp: Date.now(), offset, limit });
  return { type: "text", file: { filePath, numLines: O, totalLines: T, startLine: offset } };
}

function changedFileGuard(S) {
  if (S.offset !== void 0 || S.limit !== void 0) return null;
  return S;
}

function rebuildReadState(A) {
  if (A?.file_path && A?.offset === void 0 && A?.limit === void 0) {
    return A;
  }
  return null;
}

function changedSnippet(ATT, OLD, NEXT) {
  if (ATT.type === "text") {
    if (GwA(OLD, NEXT) === "") return null;
    return { snippet: GwA(OLD, NEXT) };
  }
  return null;
}

function renderToolUseMessage({ file_path: A, offset: Q, limit: B, pages: Y }, { verbose: G }) {
  if (!A) return null;
  if (eG1(A)) return "";
  let Z = G ? A : eG1(A);
  if (Y) return A + " pages " + Y;
  return A;
}
`;

test("verify rejects unpatched code", () => {
	const ast = parse(READ_DELEGATION_FIXTURE);
	const code = print(ast);
	const result = readWithBat.verify(code, ast);
	assert.notEqual(
		result,
		true,
		"verify should reject unpatched code but got true",
	);
	assert.equal(typeof result, "string");
});

async function getPatchedDelegationOutput(): Promise<string> {
	const ast = parse(READ_DELEGATION_FIXTURE);
	await runReadWithBatViaPasses(ast);
	const output = print(ast);
	assert.equal(readWithBat.verify(output), true);
	return output;
}

test("read-bat migrates schema and prompt from offset/limit to range/show_whitespace", async () => {
	const ast = parse(READ_SCHEMA_FIXTURE);
	await runReadWithBatViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes("Line range using supported bat-style forms"),
		true,
	);
	assert.equal(output.includes("show_whitespace: true"), true);
	assert.equal(output.includes("offset and limit parameters"), false);
	assert.equal(output.includes("range: z.string().optional()"), true);
	assert.equal(
		output.includes("show_whitespace: z.boolean().optional()"),
		true,
	);
	assert.equal(
		output.includes('/Users/username/project/README.md", range: "50:+100"'),
		true,
	);
	assert.equal(output.includes("Jupyter notebooks (.ipynb)"), true);
	assert.equal(output.includes("limit: 100, offset: 50"), false);
});

test("read-bat patches delegated helper calls and appends range/whitespace params", async () => {
	const ast = parse(READ_DELEGATION_FIXTURE);
	await runReadWithBatViaPasses(ast);
	const output = print(ast);

	assert.equal(output.includes("await helperRead(A, void 0, void 0"), true);
	assert.equal(
		output.includes(
			"helperRead(filePath, offset, limit, maxBytes, signal, ctx, extra1, extra2, R, WSPC)",
		),
		true,
	);
	assert.equal(output.includes("execFileSync"), true);
	assert.equal(output.includes("...(await fallbackFn("), true);
	assert.equal(output.includes("changedSnippetRaw"), true);
	assert.equal(output.includes("maxChangedSnippetChars = 8000"), true);
	assert.equal(
		output.includes("[TRUNCATED - changed-file diff head+tail summary]"),
		true,
	);
	assert.equal(
		output.includes(
			"S.offset !== void 0 || S.limit !== void 0 || S.range !== void 0",
		),
		true,
	);
});

test("read-bat verify fails when changed-snippet cap is altered", async () => {
	const output = await getPatchedDelegationOutput();
	const mutated = output.replace(
		"maxChangedSnippetChars = 8000",
		"maxChangedSnippetChars = 7000",
	);
	assert.notEqual(mutated, output);

	const result = readWithBat.verify(mutated);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes(
			"changed-file watcher snippet cap is not tuned to 8000 chars",
		),
		true,
	);
});

test("read-bat verify fails when show_whitespace default is not void 0", async () => {
	const output = await getPatchedDelegationOutput();
	const mutated = output.replace(
		"show_whitespace: WSPC = void 0",
		"show_whitespace: WSPC = false",
	);
	assert.notEqual(mutated, output);

	const result = readWithBat.verify(mutated);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes(
			"Call signature show_whitespace parameter missing void 0 default",
		),
		true,
	);
});

test("read-bat verify fails when readFileState range marker is removed", async () => {
	const output = await getPatchedDelegationOutput();
	const mutated = output.replace(
		'range: R !== void 0 ? R : typeof A === "string" && A.endsWith(".output") ? "-500:" : void 0',
		'ranged: R !== void 0 ? R : typeof A === "string" && A.endsWith(".output") ? "-500:" : void 0',
	);
	assert.notEqual(mutated, output);

	const result = readWithBat.verify(mutated);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("readFileState.set missing range field"),
		true,
	);
});

test("read-bat verify fails when changed-file guard drops range partial-read check", async () => {
	const output = await getPatchedDelegationOutput();
	const mutated = output.replace("|| S.range !== void 0", "");
	assert.notEqual(mutated, output);

	const result = readWithBat.verify(mutated);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes(
			"changed-file watcher guard missing range partial-read check",
		),
		true,
	);
});

test("read-bat verify fails when plain N range fallback limit is drifted", async () => {
	const output = await getPatchedDelegationOutput();
	const mutated = output.replace("fallbackLimit = 1;", "fallbackLimit = 2;");
	assert.notEqual(mutated, output);

	const result = readWithBat.verify(mutated);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes(
			"Missing single-line fallback limit for plain 'N' bat ranges",
		),
		true,
	);
});
