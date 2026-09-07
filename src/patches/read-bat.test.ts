import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { MODERN_READ_CODE_FILE_CAVEAT } from "./prompt-policy.js";
import { collectReadVerificationInventory, readWithBat } from "./read-bat.js";

// Bun snapshots PATH at process startup and ignores later mutations of
// process.env.PATH for child_process spawn lookups, so PATH-based stubs of
// `bat` are unreliable. Both bun and node also freeze the namespace binding
// returned from the first `await import("child_process")`, so swapping
// `cp.execFileSync` between tests does not propagate to a previously imported
// module. Install one persistent interceptor here that routes through a
// closure-captured active stub; each test swaps that stub via withStubbedBat.
type BatStub = (
	args: readonly string[],
	opts: Record<string, unknown> | undefined,
) => string;

const childProcess = createRequire(import.meta.url)("child_process");
const originalExecFileSync = childProcess.execFileSync;
let activeBatStub: BatStub | null = null;
const TEST_READ_SIGNAL = new AbortController().signal;
childProcess.execFileSync = (
	cmd: string,
	args: readonly string[],
	opts: Record<string, unknown> | undefined,
) => {
	if (cmd === "bat" && activeBatStub) return activeBatStub(args ?? [], opts);
	return originalExecFileSync(cmd, args, opts);
};

async function withStubbedBat<T>(
	stub: BatStub,
	body: () => Promise<T>,
): Promise<T> {
	const previous = activeBatStub;
	activeBatStub = stub;
	try {
		return await body();
	} finally {
		activeBatStub = previous;
	}
}

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

function editBooleanSchemaAnchor() {
  return { replace_all: z.boolean().default(false) };
}

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

const READ_CURRENT_DIRECT_SCHEMA_FIXTURE = `
function memoize(factory) { return factory; }
function strictObjectSchema(value) { return value; }
function stringSchema() { return { optional() { return this; }, describe() { return this; } }; }
function numberSchema() { return { int() { return this; }, nonnegative() { return this; }, positive() { return this; }, optional() { return this; } }; }
function booleanSchema() { return { default() { return this; }, optional() { return this; } }; }
function coerceNumber(value) { return { describe() { return value; } }; }
function coerceBoolean(value) { return { describe() { return value; } }; }

const EditSchema = memoize(() => strictObjectSchema({
  file_path: stringSchema().describe("The absolute path to the file to modify"),
  old_string: stringSchema().describe("The text to replace"),
  new_string: stringSchema().describe("The replacement text"),
  replace_all: coerceBoolean(booleanSchema().default(false).optional()).describe("Replace all matches"),
}));

const ReadTool = {
  name: "Read",
  description() { return "A tool for reading files"; },
  prompt() { return "Use offset and limit parameters to read specific portions of the file, or use the GrepTool to search for specific content"; },
  input_examples: [{ file_path: "/workspace/README.md", limit: 100, offset: 50 }],
  input_schema: strictObjectSchema({
    file_path: stringSchema().describe("The absolute path to the file to read"),
    offset: coerceNumber(numberSchema().int().nonnegative().optional()).describe("Legacy offset"),
    limit: coerceNumber(numberSchema().int().positive().optional()).describe("Legacy limit"),
    pages: stringSchema().optional().describe("Use the pages parameter to read specific page ranges"),
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

function editBooleanSchemaAnchor() {
  return { replace_all: z.boolean().default(false) };
}

function eG1() { return false; }
function normalizeReadInput(input) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const normalized = { ...input };
  const repairs = [];
  return repairs.length ? { input: normalized, shapeClass: repairs.join(",") } : null;
}

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
  coerceInput: normalizeReadInput,
  async validateInput({ file_path: A, offset: Q, limit: B, pages: Y }, G) {
    if (!eG1(Y) && !Q && !B) return { result: false };
    return { result: true };
  },
  async call(INPUT, G, UNUSED, EXTRA) {
    return readCallImplementation(INPUT, G, EXTRA);
  },
};

async function readCallImplementation(
  { file_path: A, offset: Q = 1, limit: B = void 0, ...READ_COMPAT },
  G,
  EXTRA,
) {
  if (R === void 0 && READ_COMPAT.offset !== void 0 && READ_COMPAT.limit !== void 0) {
    R = String(READ_COMPAT.offset) + ":" + String(READ_COMPAT.limit);
  }
  return await helperRead(A, Q, B, MAX_BYTES, SIGNAL, G, EXTRA1, EXTRA2);
}

async function helperRead(filePath, offset, limit, maxBytes, signal, ctx, extra1, extra2) {
  let W = offset === 0 ? 0 : offset - 1, READ_RESULT = await D2I(filePath, W, limit, maxBytes, signal, { handle: ctx.approvedHandle ?? await openApprovedHandle(filePath), maxSelectedBytes: 16384 }), { lineCount: O, totalLines: T, totalBytes: TOTAL_BYTES, readBytes: READ_BYTES, mtimeMs: MTIME } = READ_RESULT, K = READ_RESULT.content;
  ctx.readFileState.set(filePath, { content: K, timestamp: Date.now(), offset, limit });
  return { type: "text", file: { filePath, numLines: O, totalLines: T, startLine: offset } };
}

function changedFileGuard(S) {
  if (S.offset !== void 0 || S.limit !== void 0) return null;
  return S;
}

function rebuildReadState(messages) {
  const reads = new Map();
  for (const message of messages) {
    if (message.type === "assistant" && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (block.type !== "tool_use") continue;
        if (block.name === READ_TOOL_NAME) {
          let input = normalizeReadInput(block.input)?.input ?? block.input,
            offset = parseReadNumber(input?.offset),
            limit = parseReadNumber(input?.limit);
          if (
            typeof input?.file_path === "string" &&
            (offset === void 0 || (typeof offset === "number" && Number.isInteger(offset) && offset >= 0)) &&
            (limit === void 0 || (typeof limit === "number" && Number.isInteger(limit) && limit >= 1))
          ) {
            reads.set(block.id, {
              filePath: resolvePath(input.file_path),
              offset,
              limit,
            });
          }
        }
      }
    }
  }
  return reads;
}

function Gc(OLD, NEXT) {
  return OLD === NEXT;
}

async function changedSnippet(ATT, S, F) {
  if ((await statMtime(F)) <= S.timestamp) return null;
  if (ATT.type === "text") {
    if (ATT.file.truncatedByTokenCap === !0) return null;
    if (Gc(S, ATT.file.content)) return null;
    let w = GwA(S.content, ATT.file.content);
    if (w === "") return null;
    return { snippet: w };
  }
  return null;
}

function renderToolUseMessage({ file_path: A, offset: Q, limit: B, pages: Y }, { verbose: G }) {
  if (!A) return null;
  if (eG1(A)) return "";
  let Z = G ? A : eG1(A);
  return RC.jsx(FileComp, { filePath: A, children: Z });
}
`;

function readObjectDelegationFixture(): string {
	return READ_DELEGATION_FIXTURE.replace(
		`  async validateInput({ file_path: A, offset: Q, limit: B, pages: Y }, G) {
    if (!eG1(Y) && !Q && !B) return { result: false };
    return { result: true };
  },
  async call(INPUT, G, UNUSED, EXTRA) {
    return readCallImplementation(INPUT, G, EXTRA);
  },
};

async function readCallImplementation(
  { file_path: A, offset: Q = 1, limit: B = void 0, ...READ_COMPAT },
  G,
  EXTRA,
) {
  if (R === void 0 && READ_COMPAT.offset !== void 0 && READ_COMPAT.limit !== void 0) {
    R = String(READ_COMPAT.offset) + ":" + String(READ_COMPAT.limit);
  }
  return await helperRead(A, Q, B, MAX_BYTES, SIGNAL, G, EXTRA1, EXTRA2);
}

async function helperRead(filePath, offset, limit, maxBytes, signal, ctx, extra1, extra2) {
  let W = offset === 0 ? 0 : offset - 1, READ_RESULT = await D2I(filePath, W, limit, maxBytes, signal, { handle: ctx.approvedHandle ?? await openApprovedHandle(filePath), maxSelectedBytes: 16384 }), { lineCount: O, totalLines: T, totalBytes: TOTAL_BYTES, readBytes: READ_BYTES, mtimeMs: MTIME } = READ_RESULT, K = READ_RESULT.content;
  ctx.readFileState.set(filePath, { content: K, timestamp: Date.now(), offset, limit });
  return { type: "text", file: { filePath, numLines: O, totalLines: T, startLine: offset } };
}`,
		`  async validateInput({ file_path: A, pages: Y }, G) {
    return { result: true };
  },
  async call(INPUT, G, UNUSED, EXTRA) {
    return readCallImplementation(INPUT, G, EXTRA);
  },
};

async function readCallImplementation(
  { file_path: A, offset: Q = 1, limit: B = void 0, pages: Y, ...READ_COMPAT },
  G,
  EXTRA,
) {
  let F = A;
  if (A.endsWith(".ipynb")) Q = 1, B = undefined;
  let S = G.readFileState.get(F);
  if (S && S.seededFromContext && !S.isPartialView && Q === 1 && B === undefined) return { data: { type: "file_unchanged" } };
  if (S && !S.isPartialView && S.offset !== undefined) {
    if (S.offset === Q && S.limit === B) return { data: { type: "file_unchanged" } };
  }
  let request = {
      file_path: A,
      fullFilePath: F,
      ext: "txt",
      offset: Q,
      limit: B,
      pages: Y,
      maxSizeBytes: MAX_BYTES,
      maxTokens: MAX_TOKENS,
      context: G,
      messageId: MSG,
  };
  try {
    return await helperRead({ ...request, resolvedFilePath: F });
  } catch (E) {
    return await helperRead({ ...request, resolvedFilePath: A });
  }
}

async function helperRead(input) {
  return await readBody({ ...input, io: () => {} });
}

async function readBody(input) {
  let {
      file_path: A,
      fullFilePath: F,
      resolvedFilePath: N,
      ext: EXT,
      offset: Q,
      limit: B,
      pages: Y,
      maxSizeBytes: MAX_BYTES,
      maxTokens: MAX_TOKENS,
      context: G,
      messageId: MSG,
    } = input,
    { readFileState: state } = G;
  let W = Q === 0 ? 0 : Q - 1,
    RESULT = await D2I(
      N,
      W,
      B,
      B === void 0 ? MAX_BYTES : void 0,
      G.abortController.signal,
      B === void 0 ? { handle: G.approvedHandle } : { maxSelectedBytes: MAX_TOKENS * 4, handle: G.approvedHandle },
    ),
    { lineCount: O, totalLines: T, totalBytes: TOTAL_BYTES, readBytes: READ_BYTES, mtimeMs: M } = RESULT,
    K = RESULT.content,
    OUT = K,
    NUM = O,
    CAP,
    FULL = (Q ?? 1) <= 1 && B === void 0 && Y === void 0;
  state.set(F, {
    content: OUT,
    timestamp: Math.floor(M),
    offset: Q,
    limit: B,
    ...(CAP !== void 0 && { isPartialView: true }),
  });
  return {
    type: "text",
    file: {
      filePath: A,
      content: OUT,
      numLines: NUM,
      startLine: CAP !== void 0 ? Math.max(1, Q) : Q,
      totalLines: T,
    },
  };
}`,
	);
}

const READ_IDENTIFIER_PROMPT_FIXTURE = `
const z = {
  strictObject(x) { return x; },
  string() { return { optional() { return this; }, describe() { return this; } }; },
  number() { return { optional() { return this; }, describe() { return this; } }; },
  boolean() { return { optional() { return this; }, describe() { return this; } }; },
};

function editBooleanSchemaAnchor() {
  return { replace_all: z.boolean().default(false) };
}

const READ_DESCRIPTION = "Read a file from the local filesystem.";
const READ_PROMPT = \`Reads a file from the local filesystem. You can access any file directly by using this tool.
Usage:
- The file_path parameter must be an absolute path, not a relative path
- By default, it reads up to 2000 lines starting from the beginning of the file
- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters
- Results are returned using cat -n format, with line numbers starting at 1\`;

const ReadTool = {
  name: "Read",
  description: READ_DESCRIPTION,
  prompt: READ_PROMPT,
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

const READ_SHARED_BINDING_FIXTURE = `
const z = {
  strictObject(x) { return x; },
  string() { return { optional() { return this; }, describe() { return this; } }; },
  number() { return { optional() { return this; }, describe() { return this; } }; },
  boolean() { return { optional() { return this; }, describe() { return this; } }; },
};

function editBooleanSchemaAnchor() {
  return { replace_all: z.boolean().default(false) };
}

const SHARED_PROMPT = "Use offset and limit parameters to read specific portions of the file, or use the GrepTool to search for specific content";
const SHARED_DESCRIPTION = "Read a file from the local filesystem.";

const ReadTool = {
  name: "Read",
  description: SHARED_DESCRIPTION,
  prompt: SHARED_PROMPT,
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

const OtherTool = {
  name: "Other",
  description: SHARED_DESCRIPTION,
  prompt: SHARED_PROMPT,
};
`;

const READ_UNSUPPORTED_PROMPT_FIXTURE = `
const z = {
  strictObject(x) { return x; },
  string() { return { optional() { return this; }, describe() { return this; } }; },
  number() { return { optional() { return this; }, describe() { return this; } }; },
  boolean() { return { optional() { return this; }, describe() { return this; } }; },
};

function editBooleanSchemaAnchor() {
  return { replace_all: z.boolean().default(false) };
}

const maybePrompt = () => "shared";

const ReadTool = {
  name: "Read",
  description: maybePrompt(),
  prompt: maybePrompt(),
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
    return { result: true };
  },
  async call(INPUT, G, UNUSED, EXTRA) {
    return readCallImplementation(INPUT, G, EXTRA);
  },
};

async function readCallImplementation(
  { file_path: A, offset: Q = 1, limit: B = void 0, ...READ_COMPAT },
  G,
  EXTRA,
) {
  if (R === void 0 && READ_COMPAT.offset !== void 0 && READ_COMPAT.limit !== void 0) {
    R = String(READ_COMPAT.offset) + ":" + String(READ_COMPAT.limit);
  }
  return await helperRead(A, Q, B, MAX_BYTES, SIGNAL, G, EXTRA1, EXTRA2);
}

async function helperRead(filePath, offset, limit, maxBytes, signal, ctx, extra1, extra2) {
  let W = offset === 0 ? 0 : offset - 1, READ_RESULT = await D2I(filePath, W, limit, maxBytes, signal, { handle: ctx.approvedHandle ?? await openApprovedHandle(filePath), maxSelectedBytes: 16384 }), { lineCount: O, totalLines: T, totalBytes: TOTAL_BYTES, readBytes: READ_BYTES, mtimeMs: MTIME } = READ_RESULT, K = READ_RESULT.content;
  ctx.readFileState.set(filePath, { content: K, timestamp: Date.now(), offset, limit });
  return { type: "text", file: { filePath, numLines: O, totalLines: T, startLine: offset } };
}
`;

const READ_RUNTIME_FIXTURE = `
const z = {
  strictObject(x) { return x; },
  string() { return { optional() { return this; }, describe() { return this; } }; },
  number() { return { optional() { return this; }, describe() { return this; } }; },
  boolean() { return { optional() { return this; }, describe() { return this; } }; },
};

function editBooleanSchemaAnchor() {
  return { replace_all: z.boolean().default(false) };
}

function eG1() { return false; }
function normalizeReadInput(input) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const normalized = { ...input };
  const repairs = [];
  return repairs.length ? { input: normalized, shapeClass: repairs.join(",") } : null;
}
const MAX_BYTES = 4096;
const SIGNAL = new AbortController().signal;
const EXTRA1 = {};
const EXTRA2 = {};

const approvedHandles = [];
async function openApprovedHandle(filePath) {
  const handle = await (await import("node:fs/promises")).open(filePath, "r");
  approvedHandles.push(handle);
  return handle;
}
async function closeApprovedHandles() {
  await Promise.all(approvedHandles.splice(0).map((handle) => handle.close()));
}
async function D2I(filePath, offset, limit, maxBytes, signal, options) {
  globalThis.__fallbackCalls = globalThis.__fallbackCalls || [];
  globalThis.__fallbackCalls.push({ filePath, offset, limit, maxBytes, signal });
  const stat = await options.handle.stat();
  const text = await options.handle.readFile({ encoding: "utf8" });
  const lines = text.endsWith("\\n") ? text.slice(0, -1).split("\\n") : text.split("\\n");
  const selected = lines.slice(offset, limit === void 0 ? void 0 : offset + limit);
  const content = selected.join("\\n");
  return { content, lineCount: selected.length, totalLines: lines.length, totalBytes: stat.size, readBytes: Buffer.byteLength(content), mtimeMs: stat.mtimeMs };
}

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
  coerceInput: normalizeReadInput,
  async validateInput({ file_path: A, offset: Q, limit: B, pages: Y }, G) {
    if (!eG1(Y) && !Q && !B) return { result: false };
    return { result: true };
  },
  async call(INPUT, G, UNUSED, EXTRA) {
    return readCallImplementation(INPUT, G, EXTRA);
  },
};

async function readCallImplementation(
  { file_path: A, offset: Q = 1, limit: B = void 0, ...READ_COMPAT },
  G,
  EXTRA,
) {
  if (R === void 0 && READ_COMPAT.offset !== void 0 && READ_COMPAT.limit !== void 0) {
    R = String(READ_COMPAT.offset) + ":" + String(READ_COMPAT.limit);
  }
  return await helperRead(A, Q, B, MAX_BYTES, SIGNAL, G, EXTRA1, EXTRA2);
}

async function helperRead(filePath, offset, limit, maxBytes, signal, ctx, extra1, extra2) {
  let W = offset === 0 ? 0 : offset - 1, READ_RESULT = await D2I(filePath, W, limit, maxBytes, signal, { handle: ctx.approvedHandle ?? await openApprovedHandle(filePath), maxSelectedBytes: 16384 }), { lineCount: O, totalLines: T, totalBytes: TOTAL_BYTES, readBytes: READ_BYTES, mtimeMs: MTIME } = READ_RESULT, K = READ_RESULT.content;
  ctx.readFileState.set(filePath, { content: K, timestamp: Date.now(), offset, limit });
  return { type: "text", file: { filePath, numLines: O, totalLines: T, startLine: offset } };
}

let CURRENT_MTIME = 0;
function setChangedFileMtime(value) { CURRENT_MTIME = value; }
async function statMtime(filePath) { return CURRENT_MTIME; }
function Gc(S, content) { return S.content === content; }
function GwA(oldContent, newContent) { return oldContent === newContent ? "" : "@@ " + newContent; }

async function changedSnippet(ATT, S, F) {
  if ((await statMtime(F)) <= S.timestamp) return null;
  if (ATT.type === "text") {
    if (ATT.file.truncatedByTokenCap === !0) return null;
    if (Gc(S, ATT.file.content)) return null;
    let w = GwA(S.content, ATT.file.content);
    if (w === "") return null;
    return { snippet: w };
  }
  return null;
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

test("read-bat collects its global verification markers in one inventory", async () => {
	const output = await getPatchedDelegationOutput();
	const inventory = collectReadVerificationInventory(parse(output), "R");

	assert.deepEqual(inventory, {
		hasBatCall: true,
		hasFallbackFnBoundedArgs: true,
		hasCallCompatRangeBridge: true,
		hasEnsureTotalLinesHelper: true,
		hasNormalizedRangeTotalLinesRefresh: true,
		hasReadFileStateRange: true,
		hasReadFileStateOffsetCompat: true,
		hasReadFileStateLimitCompat: true,
		hasReadStateRebuildRangeGuard: true,
		hasChangedSnippetCap8000: true,
		hasAutoRangeTokenBudget50000: true,
		hasChangedHeadBudgetMultiplier: true,
		hasSnippetSourceCall: true,
		hasChangedSnippetReturnBinding: true,
		hasChangedFileSeenTimestampBump: true,
		hasNumericRangeRegex: true,
		hasFromStartRegex: true,
		hasNegativeTailRegex: true,
		hasFallbackSingleLineLimit: true,
		hasFallbackSizeLimitBinding: true,
	});
});

test("read-bat keeps partial reads out of rebuilt full-file state", async () => {
	const output = await getPatchedDelegationOutput();

	assert.match(output, /input\?\.range\s*===\s*void 0/);
	assert.match(
		output,
		/!String\(input\?\.file_path\s*\?\?\s*""\)\.endsWith\("\.output"\)/,
	);

	const withoutRange = output.replace(
		/\s*&&\s*input\?\.range\s*===\s*void 0/,
		"",
	);
	assert.notEqual(withoutRange, output);
	assert.equal(typeof readWithBat.verify(withoutRange), "string");

	const withoutOutputExclusion = output.replace(
		/\s*&&\s*!String\(input\?\.file_path\s*\?\?\s*""\)\.endsWith\("\.output"\)/,
		"",
	);
	assert.notEqual(withoutOutputExclusion, output);
	assert.equal(typeof readWithBat.verify(withoutOutputExclusion), "string");
});

test("read-bat ignores non-state lookalikes when finding the rebuild guard", async () => {
	const fixture = `${READ_DELEGATION_FIXTURE}
function readStateDecoy(decoyInput) {
  if (typeof decoyInput?.file_path === "string") {
    return {
      filePath: resolvePath(decoyInput.file_path),
      offset: decoyInput.offset,
      limit: decoyInput.limit,
    };
  }
  return null;
}
`;
	const ast = parse(fixture);
	await runReadWithBatViaPasses(ast);
	const output = print(ast);

	assert.equal(readWithBat.verify(output), true);
	assert.doesNotMatch(output, /decoyInput\?\.range/);
});

async function loadPatchedReadRuntimeModule() {
	const ast = parse(READ_RUNTIME_FIXTURE);
	await runReadWithBatViaPasses(ast);
	const output = print(ast);
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-bat-runtime-"));
	const modulePath = path.join(tempDir, "patched-read-runtime.mjs");
	await fs.writeFile(
		modulePath,
		`${output}
export { ReadTool, helperRead, changedSnippet, setChangedFileMtime, closeApprovedHandles };`,
		"utf8",
	);
	const mod = await import(pathToFileURL(modulePath).href);
	return {
		mod,
		output,
		cleanup: async () => {
			await mod.closeApprovedHandles();
			await fs.rm(tempDir, { recursive: true, force: true });
		},
	};
}

test("read-bat drops blank optional string inputs before validation", async () => {
	const { mod, output, cleanup } = await loadPatchedReadRuntimeModule();
	try {
		assert.deepEqual(
			mod.ReadTool.coerceInput({
				file_path: "/tmp/example.txt",
				pages: "",
				range: "1:20",
			}),
			{
				input: {
					file_path: "/tmp/example.txt",
					range: "1:20",
				},
				shapeClass: "pages_empty",
			},
		);
		assert.deepEqual(
			mod.ReadTool.coerceInput({
				file_path: "/tmp/example.txt",
				pages: "  ",
				range: "\t",
			}),
			{
				input: { file_path: "/tmp/example.txt" },
				shapeClass: "pages_empty,range_empty",
			},
		);
		assert.equal(
			mod.ReadTool.coerceInput({
				file_path: "/tmp/example.pdf",
				pages: "1-2",
				range: "1:20",
			}),
			null,
		);

		const weakened = output.replace('"pages_empty"', '"pages_ignored"');
		assert.notEqual(weakened, output);
		assert.match(String(readWithBat.verify(weakened)), /blank pages/);
	} finally {
		await cleanup();
	}
});

test("read-bat migrates schema and prompt from offset/limit to range/show_whitespace", async () => {
	const ast = parse(READ_SCHEMA_FIXTURE);
	await runReadWithBatViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes("Line range using supported bat-style forms"),
		true,
	);
	assert.equal(output.includes(MODERN_READ_CODE_FILE_CAVEAT), true);
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
	assert.equal(
		output.includes(
			"Use the output file path from the original background-task result or completion notification",
		),
		true,
	);
	assert.equal(
		output.includes("use TaskOutput to get the `output_file` path"),
		false,
	);
	assert.equal(
		output.includes(
			"read that file by explicit non-overlapping ranges instead of rediscovering the path",
		),
		true,
	);
	assert.equal(
		output.includes("Use TaskOutput only for an explicit wait"),
		false,
	);
	assert.equal(output.includes("TaskOutput"), false);
});

test("read-bat resolves the direct boolean schema factory from current tool schemas", async () => {
	const ast = parse(READ_CURRENT_DIRECT_SCHEMA_FIXTURE);
	await runReadWithBatViaPasses(ast);
	const output = print(ast);

	assert.match(output, /range: stringSchema\(\)\.optional\(\)/);
	assert.match(output, /show_whitespace: booleanSchema\(\)\.optional\(\)/);
});

test("read-bat verify rejects weakened background task routing", async () => {
	const output = await getPatchedDelegationOutput();
	const weakened = output
		.split(
			"read that file by explicit non-overlapping ranges instead of rediscovering the path or re-reading a tail you already have",
		)
		.join("read it however you like");
	assert.notEqual(weakened, output);

	const result = readWithBat.verify(weakened);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("background task routing"),
		true,
		`Expected background-task routing failure, got: ${result}`,
	);
});

test("read-bat patches identifier-backed prompt/description bindings used by the current bundle shape", async () => {
	const ast = parse(READ_IDENTIFIER_PROMPT_FIXTURE);
	await runReadWithBatViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes(
			'const READ_DESCRIPTION = "Read a file from the local filesystem."',
		),
		true,
	);
	assert.equal(
		output.includes("Line range using supported bat-style forms"),
		true,
	);
	assert.equal(
		output.includes(
			'const READ_PROMPT = "Read files from the local filesystem.',
		),
		true,
	);
});

test("read-bat replaces Read properties directly when prompt bindings are shared", async () => {
	const ast = parse(READ_SHARED_BINDING_FIXTURE);
	await runReadWithBatViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes('prompt: "Read files from the local filesystem.'),
		true,
	);
	assert.equal(
		output.includes(
			'OtherTool = {\n  name: "Other",\n  description: SHARED_DESCRIPTION,\n  prompt: SHARED_PROMPT',
		),
		true,
	);
	assert.equal(
		output.includes(
			'const SHARED_PROMPT = "Use offset and limit parameters to read specific portions of the file, or use the GrepTool to search for specific content";',
		),
		true,
	);
});

test("read-bat replaces unsupported Read prompt expressions directly on the tool object", async () => {
	const ast = parse(READ_UNSUPPORTED_PROMPT_FIXTURE);
	await runReadWithBatViaPasses(ast);
	const output = print(ast);
	assert.equal(
		output.includes("description: _claudePatchReadDescription(maybePrompt())"),
		true,
	);
	assert.equal(
		output.includes("prompt: _claudePatchReadPrompt(maybePrompt())"),
		true,
	);
	assert.equal(
		output.includes("function _claudePatchReadPrompt(prompt)"),
		true,
	);
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
	assert.equal(output.includes("changedSnippetRaw"), true);
	assert.equal(output.includes("maxChangedSnippetChars = 8000"), true);
	assert.equal(
		output.includes("[TRUNCATED - changed-file diff head+tail summary]"),
		true,
	);
	// The seen bump hoists the observed mtime out of the staleness gate and
	// records that value, keeping the gate's comparison on the mtime clock.
	// Layout-agnostic assertions: retainLines may wrap the declaration.
	assert.equal(output.includes("let __ccChangedFileMtime ="), true);
	assert.equal(output.includes("await statMtime(F)"), true);
	assert.equal(output.includes("__ccChangedFileMtime <= S.timestamp"), true);
	assert.equal(output.includes("S.timestamp = __ccChangedFileMtime"), true);
	assert.equal(output.includes('var style = "numbers"'), true);
});

test("read-bat follows the Read.call delegated implementation", async () => {
	const ast = parse(READ_DELEGATION_FIXTURE);
	await runReadWithBatViaPasses(ast);
	const output = print(ast);

	assert.match(output, /async call\(INPUT, G, UNUSED, EXTRA\)/);
	assert.equal(readWithBat.verify(output, ast), true);
});

test("read-bat patches object-payload delegated read helpers", async () => {
	const ast = parse(readObjectDelegationFixture());
	await runReadWithBatViaPasses(ast);
	const output = print(ast);

	assert.equal(output.includes("execFileSync"), true);
	assert.equal(output.includes('var style = "numbers"'), true);
	assert.equal(output.includes("range: R"), true);
	assert.equal(output.includes("show_whitespace: WSPC"), true);
	assert.equal(output.includes("Q === 1 && B === void 0"), false);
	assert.equal(output.includes("startLine: START_LINE"), true);
	assert.equal(readWithBat.verify(output), true);
});

test("read-bat verify fails when content-identical re-reads are not marked seen", async () => {
	const output = await getPatchedDelegationOutput();
	const mutated = output.replace("S.timestamp = __ccChangedFileMtime;", "");
	assert.notEqual(mutated, output);

	const result = readWithBat.verify(mutated);
	assert.equal(
		result,
		"changed-file watcher does not mark content-identical re-reads as seen",
	);
});

test("read-bat verify fails when the seen bump uses wall-clock time", async () => {
	const output = await getPatchedDelegationOutput();
	const mutated = output.replace(
		"S.timestamp = __ccChangedFileMtime;",
		"S.timestamp = Date.now();",
	);
	assert.notEqual(mutated, output);

	const result = readWithBat.verify(mutated);
	assert.equal(
		result,
		"changed-file watcher does not mark content-identical re-reads as seen",
	);
});

test("read-bat seen bump is idempotent across a double pass", async () => {
	const ast = parse(READ_DELEGATION_FIXTURE);
	await runReadWithBatViaPasses(ast);
	await runReadWithBatViaPasses(ast);
	const output = print(ast);
	assert.equal(output.split("let __ccChangedFileMtime").length - 1, 1);
	assert.equal(
		output.split("S.timestamp = __ccChangedFileMtime").length - 1,
		1,
	);
});

test("read-bat avoids delegated helper parameter name collisions", async () => {
	const fixture = READ_DELEGATION_FIXTURE.replace(
		"async function helperRead(filePath, offset, limit, maxBytes, signal, ctx, extra1, extra2) {\n  let W = offset === 0 ? 0 : offset - 1",
		"async function helperRead(filePath, offset, limit, maxBytes, signal, ctx, extra1, extra2) {\n  let R = ctx?.rangeSentinel;\n  let W = offset === 0 ? 0 : offset - 1",
	);
	const ast = parse(fixture);
	await runReadWithBatViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes(
			"helperRead(filePath, offset, limit, maxBytes, signal, ctx, extra1, extra2, R, WSPC)",
		),
		false,
	);
	assert.match(
		output,
		/helperRead\(filePath, offset, limit, maxBytes, signal, ctx, extra1, extra2, R_2, WSPC\)/,
	);
	assert.doesNotThrow(() => parse(output));
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

test("read-bat verify fails when code-file tool caveat is removed", async () => {
	const output = await getPatchedDelegationOutput();
	const mutated = output
		.split(MODERN_READ_CODE_FILE_CAVEAT)
		.join("For code files, read the file directly.");
	assert.notEqual(mutated, output);

	const result = readWithBat.verify(mutated);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("Missing code-file tool-choice caveat"),
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

// Section 6 changed-file guard test removed. Guard was redundant with
// readFileState compatibility markers and was removed from the patch.

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

test("read-bat verify fails when bat success path drops numbered style", async () => {
	const output = await getPatchedDelegationOutput();
	const mutated = output.replace(
		'var style = "numbers"',
		'var style = "plain"',
	);
	assert.notEqual(mutated, output);

	const result = readWithBat.verify(mutated);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes(
			"Bat success path is not configured to emit numbered lines",
		),
		true,
	);
});

test("read-bat runtime uses numbered bat output when bat succeeds", async () => {
	const { mod, cleanup } = await loadPatchedReadRuntimeModule();
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-bat-success-"));
	try {
		const filePath = path.join(tempDir, "sample.txt");
		await fs.writeFile(filePath, "alpha\nbeta\n", "utf8");
		(globalThis as any).__fallbackCalls = [];

		const ctx = { readFileState: new Map() };
		const result = (await withStubbedBat(
			() => "1 alpha\n2 beta\n",
			() =>
				mod.helperRead(
					filePath,
					1,
					undefined,
					4096,
					TEST_READ_SIGNAL,
					ctx,
					{},
					{},
					"1:2",
					false,
				),
		)) as any;

		assert.equal((globalThis as any).__fallbackCalls[0].offset, 0);
		assert.equal((globalThis as any).__fallbackCalls[0].limit, 2);
		assert.equal(ctx.readFileState.get(filePath).content, "1 alpha\n2 beta\n");
		assert.deepEqual(result.file, {
			filePath,
			numLines: 2,
			totalLines: 2,
			startLine: 1,
		});
	} finally {
		await cleanup();
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("read-bat runtime preserves fallback range and size-limit semantics when bat fails", async () => {
	const { mod, cleanup } = await loadPatchedReadRuntimeModule();
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "read-bat-fallback-"),
	);
	try {
		const filePath = path.join(tempDir, "sample.txt");
		await fs.writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");
		const failBat: BatStub = () => {
			throw new Error("bat exited 1");
		};

		const ctx = { readFileState: new Map() };
		(globalThis as any).__fallbackCalls = [];
		const ranged = (await withStubbedBat(failBat, () =>
			mod.helperRead(
				filePath,
				1,
				undefined,
				4096,
				TEST_READ_SIGNAL,
				ctx,
				{},
				{},
				"5",
				false,
			),
		)) as any;
		assert.deepEqual((globalThis as any).__fallbackCalls[0], {
			filePath,
			offset: 4,
			limit: 1,
			maxBytes: undefined,
			signal: TEST_READ_SIGNAL,
		});
		assert.equal(ranged.file.startLine, 5);

		(globalThis as any).__fallbackCalls = [];
		const unbounded = (await withStubbedBat(failBat, () =>
			mod.helperRead(
				filePath,
				1,
				undefined,
				4096,
				TEST_READ_SIGNAL,
				ctx,
				{},
				{},
				undefined,
				false,
			),
		)) as any;
		assert.deepEqual((globalThis as any).__fallbackCalls[0], {
			filePath,
			offset: 0,
			limit: undefined,
			maxBytes: 4096,
			signal: TEST_READ_SIGNAL,
		});
		assert.equal(unbounded.file.startLine, 1);
	} finally {
		await cleanup();
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("read-bat runtime tolerates stray wrapper characters around ranges", async () => {
	const { mod, cleanup } = await loadPatchedReadRuntimeModule();
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "read-bat-range-repair-"),
	);
	try {
		const filePath = path.join(tempDir, "sample.txt");
		await fs.writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");
		const failBat: BatStub = () => {
			throw new Error("bat exited 1");
		};

		const ctx = { readFileState: new Map() };
		(globalThis as any).__fallbackCalls = [];
		await withStubbedBat(failBat, () =>
			mod.helperRead(
				filePath,
				1,
				undefined,
				4096,
				TEST_READ_SIGNAL,
				ctx,
				{},
				{},
				'25:45")',
				false,
			),
		);
		assert.deepEqual((globalThis as any).__fallbackCalls[0], {
			filePath,
			offset: 24,
			limit: 21,
			maxBytes: undefined,
			signal: TEST_READ_SIGNAL,
		});

		await withStubbedBat(failBat, async () => {
			await assert.rejects(
				mod.helperRead(
					filePath,
					1,
					undefined,
					4096,
					TEST_READ_SIGNAL,
					ctx,
					{},
					{},
					"25:45abc",
					false,
				),
				/Invalid range format/,
			);
		});
	} finally {
		await cleanup();
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("read-bat runtime defaults .output reads to tail range and forwards show_whitespace to bat", async () => {
	const { mod, cleanup } = await loadPatchedReadRuntimeModule();
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-bat-tail-"));
	try {
		const filePath = path.join(tempDir, "build.output");
		await fs.writeFile(filePath, "alpha\nbeta\n", "utf8");

		let capturedArgs: readonly string[] = [];
		const captureBat: BatStub = (args) => {
			capturedArgs = args;
			return "1 alpha\n2 beta\n";
		};

		const ctx = { readFileState: new Map() };
		await withStubbedBat(captureBat, () =>
			mod.helperRead(
				filePath,
				1,
				undefined,
				4096,
				TEST_READ_SIGNAL,
				ctx,
				{},
				{},
				undefined,
				true,
			),
		);

		assert.equal(capturedArgs.includes("-A"), true);
		assert.equal((globalThis as any).__fallbackCalls.at(-1).offset, 0);
		assert.equal((globalThis as any).__fallbackCalls.at(-1).limit, 500);
	} finally {
		await cleanup();
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("read-bat runtime: content-identical re-read bumps timestamp to observed mtime", async () => {
	const { mod, cleanup } = await loadPatchedReadRuntimeModule();
	try {
		mod.setChangedFileMtime(500);
		const state = { content: "same", timestamp: 100 };
		const att = {
			type: "text",
			file: { content: "same", truncatedByTokenCap: false },
		};
		assert.equal(await mod.changedSnippet(att, state, "/tmp/watched.md"), null);
		// Bumped to the observed mtime, not wall-clock time.
		assert.equal(state.timestamp, 500);
		// Marked seen: the same mtime no longer passes the staleness gate.
		assert.equal(await mod.changedSnippet(att, state, "/tmp/watched.md"), null);
		assert.equal(state.timestamp, 500);

		// A real change with a newer mtime still produces a snippet and does
		// not bump the recorded timestamp.
		mod.setChangedFileMtime(600);
		const changedState = { content: "same", timestamp: 500 };
		const changedAtt = {
			type: "text",
			file: { content: "different", truncatedByTokenCap: false },
		};
		const result = await mod.changedSnippet(
			changedAtt,
			changedState,
			"/tmp/watched.md",
		);
		assert.ok(result && typeof result.snippet === "string");
		assert.ok(result.snippet.length > 0);
		assert.equal(changedState.timestamp, 500);
	} finally {
		await cleanup();
	}
});

test("read-bat threads range/whitespace through EVERY delegation call site", async () => {
	const twoCallFixture = READ_DELEGATION_FIXTURE.replace(
		"  return await helperRead(A, Q, B, MAX_BYTES, SIGNAL, G, EXTRA1, EXTRA2);\n}",
		"  try {\n    return await helperRead(A, Q, B, MAX_BYTES, SIGNAL, G, EXTRA1, EXTRA2);\n  } catch (E) {\n    return await helperRead(A, Q, B, MAX_BYTES, SIGNAL, G, EXTRA1, EXTRA2);\n  }\n}",
	);
	assert.notEqual(twoCallFixture, READ_DELEGATION_FIXTURE);
	const ast = parse(twoCallFixture);
	await runReadWithBatViaPasses(ast);
	const output = print(ast);
	// Both delegation calls must be threaded with the appended range/whitespace params.
	assert.equal(
		output.split(
			"helperRead(filePath, offset, limit, maxBytes, signal, ctx, extra1, extra2, R, WSPC)",
		).length - 1,
		1,
		"helper definition param list rewritten exactly once",
	);
	assert.equal(
		output.split(
			"await helperRead(A, void 0, void 0, MAX_BYTES, SIGNAL, G, EXTRA1, EXTRA2, R, WSPC)",
		).length - 1,
		2,
		"both delegation call sites must void-0 offset/limit and append R, WSPC",
	);
	assert.equal(readWithBat.verify(output), true);
});

test("read-bat rewrites readFileState.set compat markers at every offset/limit site", async () => {
	const twoSetFixture = READ_DELEGATION_FIXTURE.replace(
		"  ctx.readFileState.set(filePath, { content: K, timestamp: Date.now(), offset, limit });",
		"  ctx.readFileState.set(filePath, { content: K, timestamp: Date.now(), offset, limit });\n  ctx.readFileState.set(filePath, { content: K, timestamp: Date.now() + 1, offset, limit });",
	);
	assert.notEqual(twoSetFixture, READ_DELEGATION_FIXTURE);
	const ast = parse(twoSetFixture);
	await runReadWithBatViaPasses(ast);
	const output = print(ast);
	// Neither .set may retain a bare `offset, limit` shorthand; both become compat conditionals + range.
	assert.equal(
		output.includes("timestamp: Date.now(), offset, limit }"),
		false,
	);
	assert.equal(
		output.includes("timestamp: Date.now() + 1, offset, limit }"),
		false,
	);
	// Both state-write sites gain a range compat field.
	assert.ok(
		output.split("range: R !== void 0 ? R").length - 1 >= 2,
		"both state-write sites should gain a range compat field",
	);
	assert.equal(readWithBat.verify(output), true);
});

test("read-bat verify fails when the auto-range token budget is drifted", async () => {
	const output = await getPatchedDelegationOutput();
	const mutated = output.replace(
		"autoRangeTokenBudget = 50000",
		"autoRangeTokenBudget = 25000",
	);
	assert.notEqual(mutated, output);
	const result = readWithBat.verify(mutated);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("Auto-range token budget is not tuned to 50000"),
		true,
	);
});

test("read-bat verify fails when the changed-file head budget multiplier is drifted", async () => {
	const output = await getPatchedDelegationOutput();
	const mutated = output.replace(
		"changedSnippetBudget * 0.65",
		"changedSnippetBudget * 0.5",
	);
	assert.notEqual(mutated, output);
	const result = readWithBat.verify(mutated);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes(
			"changed-file watcher head budget multiplier drifted from 0.65",
		),
		true,
	);
});

test("read-bat wraps a non-resolvable description METHOD return and statics the prompt method", async () => {
	// The real bundle exposes the Read prompt/description as object METHODS whose
	// return value is a non-resolvable call. The description method-form is
	// wrapped with the description helper; the prompt method-form is replaced
	// outright with the static prompt (it is never wrapped). The other
	// unsupported-prompt coverage exercises the property branch only.
	const fixture = READ_UNSUPPORTED_PROMPT_FIXTURE.replace(
		"description: maybePrompt(),",
		"async description() { return maybePrompt(); },",
	).replace(
		"prompt: maybePrompt(),",
		"async prompt() { return maybePrompt(); },",
	);
	assert.notEqual(fixture, READ_UNSUPPORTED_PROMPT_FIXTURE);
	const ast = parse(fixture);
	await runReadWithBatViaPasses(ast);
	const output = print(ast);
	assert.equal(
		output.includes("return _claudePatchReadDescription(maybePrompt())"),
		true,
		"description method-form return should be wrapped with the description helper",
	);
	assert.equal(
		output.includes("return _claudePatchReadPrompt(maybePrompt())"),
		false,
		"prompt method-form return is staticized, not wrapped",
	);
	assert.equal(
		output.includes('return "Read files from the local filesystem.'),
		true,
		"prompt method-form return should be replaced with the static Read prompt",
	);
	assert.equal(
		output.includes("function _claudePatchReadDescription(description)"),
		true,
	);
});

test("read-bat handles validateInput without offset/limit and still adds range param", async () => {
	// validateInput destructures only { file_path, pages }. The large-file guard
	// rewrite is a no-op on this shape; only the additive range parameter lands.
	const fixture = READ_DELEGATION_FIXTURE.replace(
		"async validateInput({ file_path: A, offset: Q, limit: B, pages: Y }, G) {\n    if (!eG1(Y) && !Q && !B) return { result: false };\n    return { result: true };\n  },",
		"async validateInput({ file_path: A, pages: Y }, G) {\n    return { result: true };\n  },",
	);
	assert.notEqual(fixture, READ_DELEGATION_FIXTURE);
	const ast = parse(fixture);
	await runReadWithBatViaPasses(ast);
	const output = print(ast);
	assert.match(
		output,
		/async validateInput\(\{ file_path: A, pages: Y, range: R \}/,
	);
	assert.equal(readWithBat.verify(output), true);
});

test("read-bat patches a validateInput body destructure", async () => {
	const fixture = READ_DELEGATION_FIXTURE.replace(
		"async validateInput({ file_path: A, offset: Q, limit: B, pages: Y }, G) {\n    if (!eG1(Y) && !Q && !B) return { result: false };",
		"async validateInput(INPUT, G) {\n    let { file_path: A, offset: Q, limit: B, pages: Y } = INPUT;\n    if (!eG1(Y) && !Q && !B) return { result: false };",
	);
	assert.notEqual(fixture, READ_DELEGATION_FIXTURE);
	const ast = parse(fixture);
	await runReadWithBatViaPasses(ast);
	const output = print(ast);

	assert.match(output, /let \{ file_path: A, pages: Y, range: R \} = INPUT/);
	assert.equal(readWithBat.verify(output), true);
});

async function loadLatestReadRuntimeModule() {
	const source =
		`
const MAX_BYTES = 4096, MAX_TOKENS = 10000, MSG = "read-message";
const observations = [];
async function D2I(filePath, offset, limit, maxBytes, signal, options) {
  signal.throwIfAborted();
  const stat = await options.handle.stat();
  const text = await options.handle.readFile({ encoding: "utf8" });
  const lines = text.endsWith("\\n") ? text.slice(0, -1).split("\\n") : text.split("\\n");
  const selected = lines.slice(offset, limit === void 0 ? void 0 : offset + limit);
  const content = selected.join("\\n");
  if (options.maxSelectedBytes !== void 0 && Buffer.byteLength(content) > options.maxSelectedBytes) throw new Error("selected bytes exceeded");
  observations.push({ offset, limit, maxBytes, options });
  return { content, lineCount: selected.length, totalLines: lines.length, totalBytes: stat.size, readBytes: Buffer.byteLength(content), mtimeMs: stat.mtimeMs };
}
` +
		readObjectDelegationFixture().replace(
			"  state.set(F, {",
			"  observations[observations.length - 1].full = FULL;\n  observations[observations.length - 1].firstLine = W;\n  observations[observations.length - 1].receivedTotalBytes = TOTAL_BYTES;\n  observations[observations.length - 1].receivedReadBytes = READ_BYTES;\n  state.set(F, {",
		);
	const ast = parse(source);
	await runReadWithBatViaPasses(ast);
	const output = print(ast);
	assert.equal(readWithBat.verify(output, ast), true);
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "read-latest-runtime-"));
	const modulePath = path.join(dir, "read.mjs");
	await fs.writeFile(
		modulePath,
		`${output}\nexport { ReadTool, observations };`,
	);
	return {
		mod: await import(pathToFileURL(modulePath).href),
		cleanup: () => fs.rm(dir, { recursive: true, force: true }),
	};
}

test("read-bat preserves approved content and marks automatic previews partial through Read.call", async () => {
	const { mod, cleanup } = await loadLatestReadRuntimeModule();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "read-approved-"));
	const filePath = path.join(dir, "source.txt");
	const original = Array.from(
		{ length: 260 },
		(_, index) => `approved ${index}${" ".repeat(20)}`,
	).join("\n");
	await fs.writeFile(filePath, original);
	const approvedHandle = await fs.open(filePath, "r");
	const stat = await approvedHandle.stat();
	try {
		await fs.rename(filePath, path.join(dir, "approved.txt"));
		await fs.writeFile(filePath, "unapproved replacement");
		const ctx = {
			readFileState: new Map(),
			approvedHandle,
			abortController: new AbortController(),
		};
		const result: any = await withStubbedBat(
			(_args, options) => {
				assert.equal(
					options?.input,
					original.split("\n").slice(0, 200).join("\n"),
				);
				return String(options?.input)
					.split("\n")
					.map((line, index) => `${index + 1} ${line}`)
					.join("\n");
			},
			() => mod.ReadTool.call({ file_path: filePath }, ctx, null, null),
		);
		assert.equal(result.file.numLines, 200);
		assert.equal(result.file.totalLines, 260);
		assert.equal(result.file.startLine, 1);
		assert.match(result.file.content, /FILE TRUNCATED/);
		assert.doesNotMatch(result.file.content, /unapproved/);
		assert.equal(
			ctx.readFileState.get(filePath).timestamp,
			Math.floor(stat.mtimeMs),
		);
		assert.equal(ctx.readFileState.get(filePath).isPartialView, true);
		assert.equal(ctx.readFileState.get(filePath).offset, 1);
		assert.equal(ctx.readFileState.get(filePath).limit, 1);
		assert.equal(mod.observations[0].full, false);
		assert.equal(mod.observations[0].options.handle, approvedHandle);
		assert.equal(mod.observations[0].options.maxSelectedBytes, 40000);
		assert.equal(
			mod.observations[0].receivedTotalBytes,
			Buffer.byteLength(original),
		);
	} finally {
		await approvedHandle.close();
		await cleanup();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("read-bat retains range metadata and whitespace formatting when bat succeeds or fails", async () => {
	const { mod, cleanup } = await loadLatestReadRuntimeModule();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "read-latest-range-"));
	const filePath = path.join(dir, "source.txt");
	await fs.writeFile(filePath, "zero\n\talpha\nbeta\nlast");
	try {
		for (const fails of [false, true]) {
			const approvedHandle = await fs.open(filePath, "r");
			try {
				const ctx = {
					readFileState: new Map(),
					approvedHandle,
					abortController: new AbortController(),
				};
				const result: any = await withStubbedBat(
					(args, options) => {
						assert.ok(args.includes("-A"));
						assert.equal(options?.input, "\talpha\nbeta");
						if (fails) throw new Error("bat unavailable");
						return "1 →alpha\n2 beta";
					},
					() =>
						mod.ReadTool.call(
							{ file_path: filePath, range: "2:3", show_whitespace: true },
							ctx,
							null,
							null,
						),
				);
				assert.equal(
					result.file.content,
					fails ? "\talpha\nbeta" : "2 →alpha\n3 beta",
				);
				assert.equal(result.file.startLine, 2);
				assert.equal(result.file.numLines, 2);
				assert.equal(result.file.totalLines, 4);
				assert.equal(ctx.readFileState.get(filePath).isPartialView, true);
				assert.equal(
					mod.observations.at(-1).receivedReadBytes,
					Buffer.byteLength("\talpha\nbeta"),
				);
				assert.equal(mod.observations.at(-1).full, false);
				assert.equal(mod.observations.at(-1).firstLine, 1);
			} finally {
				await approvedHandle.close();
			}
		}
	} finally {
		await cleanup();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("read-bat keeps failed-bat automatic previews partial", async () => {
	const { mod, cleanup } = await loadLatestReadRuntimeModule();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "read-auto-fallback-"));
	const filePath = path.join(dir, "source.txt");
	const original = Array.from(
		{ length: 260 },
		(_, index) => `line ${index}${" ".repeat(20)}`,
	).join("\n");
	await fs.writeFile(filePath, original);
	const approvedHandle = await fs.open(filePath, "r");
	try {
		const ctx = {
			readFileState: new Map(),
			approvedHandle,
			abortController: new AbortController(),
		};
		const result: any = await withStubbedBat(
			() => {
				throw new Error("bat unavailable");
			},
			() => mod.ReadTool.call({ file_path: filePath }, ctx, null, null),
		);
		assert.equal(result.file.numLines, 200);
		assert.equal(result.file.totalLines, 260);
		assert.match(result.file.content, /FILE TRUNCATED/);
		assert.equal(ctx.readFileState.get(filePath).isPartialView, true);
		assert.equal(mod.observations[0].full, false);
		assert.equal(mod.observations[0].limit, 200);
	} finally {
		await approvedHandle.close();
		await cleanup();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("read-bat verifier rejects lost approved-read transport", async () => {
	const output = await getPatchedDelegationOutput();
	const mutations = [
		["...rawResult,", "...{},"],
		[
			"fallbackSizeLimit, fallbackSignal, readOptions",
			"fallbackSizeLimit, fallbackSignal, {}",
		],
		["input: rawResult.content", 'input: "wrong content"'],
		[
			"normalizedRange !== null || rawResult.truncatedByBytes === true",
			"false",
		],
	];
	for (const [before, after] of mutations) {
		const mutated = output.replace(before, after);
		assert.notEqual(mutated, output, before);
		assert.equal(typeof readWithBat.verify(mutated), "string", before);
	}
});

test("read-bat threads both delegation sites in the implementation catch block", async () => {
	// The implementation's missing-file path delegates again from a catch block.
	// This mirrors that nesting so the threading loop catches a third or missed
	// call site.
	const fixture = READ_DELEGATION_FIXTURE.replace(
		"  return await helperRead(A, Q, B, MAX_BYTES, SIGNAL, G, EXTRA1, EXTRA2);\n}",
		"  try {\n    return await helperRead(A, Q, B, MAX_BYTES, SIGNAL, G, EXTRA1, EXTRA2);\n  } catch (ENOENT_E) {\n    return await helperRead(A, Q, B, MAX_BYTES, SIGNAL, G, EXTRA1, EXTRA2);\n  }\n}",
	);
	assert.notEqual(fixture, READ_DELEGATION_FIXTURE);
	const ast = parse(fixture);
	await runReadWithBatViaPasses(ast);
	const output = print(ast);
	assert.equal(
		output.split(
			"await helperRead(A, void 0, void 0, MAX_BYTES, SIGNAL, G, EXTRA1, EXTRA2, R, WSPC)",
		).length - 1,
		2,
		"both delegation sites (try + catch) must be threaded exactly once each",
	);
	assert.equal(
		output.split(
			"helperRead(filePath, offset, limit, maxBytes, signal, ctx, extra1, extra2, R, WSPC)",
		).length - 1,
		1,
		"helper definition param list rewritten exactly once",
	);
	assert.equal(readWithBat.verify(output), true);
});

test("notebook Read returns before text-result state exists", async () => {
	const fixture = readObjectDelegationFixture().replace(
		"  let W = Q === 0 ? 0 : Q - 1,",
		`
  if (F.endsWith(".ipynb")) {
    const content = await G.approvedHandle.readFile({encoding: "utf8"});
    const notebook = JSON.parse(content);
    state.set(F, {content, timestamp: 1, offset: Q, limit: B});
    return {type: "notebook", file: {filePath: A, cells: notebook.cells}};
  }
  let W = Q === 0 ? 0 : Q - 1,`,
	);
	const ast = parse(
		`const MAX_BYTES = 4096, MAX_TOKENS = 10000, MSG = "read"; async function D2I() { throw new Error("text reader must not run"); }\n${fixture}`,
	);
	await runReadWithBatViaPasses(ast);
	const output = print(ast);
	const runtime = new Function(`${output}; return ReadTool;`)();
	const cells = [{ cell_type: "markdown", source: ["hello"] }];
	const content = JSON.stringify({
		cells,
		metadata: {},
		nbformat: 4,
		nbformat_minor: 5,
	});
	const state = new Map();
	const result = await runtime.call(
		{ file_path: "/work/example.ipynb" },
		{
			readFileState: state,
			approvedHandle: { readFile: async () => content },
			abortController: new AbortController(),
		},
	);
	assert.equal(result.type, "notebook");
	assert.deepEqual(result.file.cells, cells);
	assert.equal(state.get("/work/example.ipynb").content, content);
	assert.equal(readWithBat.verify(output, ast), true);
});

test("Read verification rejects dangling native range reset bindings", async () => {
	const ast = parse(readObjectDelegationFixture());
	await runReadWithBatViaPasses(ast);
	const output = print(ast);
	const broken = output.replace(
		"let F = A;",
		'let F = A; if (A.endsWith(".ipynb")) removedOffset = 1;',
	);
	assert.notEqual(broken, output);
	assert.equal(typeof readWithBat.verify(broken, parse(broken)), "string");
});
