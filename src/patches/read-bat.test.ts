import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
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

const READ_IDENTIFIER_PROMPT_FIXTURE = `
const z = {
  strictObject(x) { return x; },
  string() { return { optional() { return this; }, describe() { return this; } }; },
  number() { return { optional() { return this; }, describe() { return this; } }; },
  boolean() { return { optional() { return this; }, describe() { return this; } }; },
};

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
`;

const READ_RUNTIME_FIXTURE = `
const z = {
  strictObject(x) { return x; },
  string() { return { optional() { return this; }, describe() { return this; } }; },
  number() { return { optional() { return this; }, describe() { return this; } }; },
  boolean() { return { optional() { return this; }, describe() { return this; } }; },
};
function eG1() { return false; }
const MAX_BYTES = 4096;
const SIGNAL = { tag: "signal" };
const EXTRA1 = {};
const EXTRA2 = {};

async function D2I(filePath, offset, limit, maxBytes, signal) {
  globalThis.__fallbackCalls = globalThis.__fallbackCalls || [];
  globalThis.__fallbackCalls.push({ filePath, offset, limit, maxBytes, signal });
  return { content: "1 fallback\\n2 text\\n", lineCount: 2, totalLines: 9 };
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

async function loadPatchedReadRuntimeModule() {
	const ast = parse(READ_RUNTIME_FIXTURE);
	await runReadWithBatViaPasses(ast);
	const output = print(ast);
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-bat-runtime-"));
	const modulePath = path.join(tempDir, "patched-read-runtime.mjs");
	await fs.writeFile(
		modulePath,
		`${output}
export { ReadTool, helperRead };`,
		"utf8",
	);
	const mod = await import(pathToFileURL(modulePath).href);
	return {
		mod,
		cleanup: async () => {
			await fs.rm(tempDir, { recursive: true, force: true });
		},
	};
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
	assert.equal(output.includes("...(await fallbackFn("), true);
	assert.equal(output.includes("changedSnippetRaw"), true);
	assert.equal(output.includes("maxChangedSnippetChars = 8000"), true);
	assert.equal(
		output.includes("[TRUNCATED - changed-file diff head+tail summary]"),
		true,
	);
	assert.equal(output.includes('var style = "numbers"'), true);
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
	const originalPath = process.env.PATH ?? "";
	try {
		const filePath = path.join(tempDir, "sample.txt");
		const batPath = path.join(tempDir, "bat");
		await fs.writeFile(filePath, "alpha\nbeta\n", "utf8");
		await fs.writeFile(
			batPath,
			"#!/usr/bin/env bash\nprintf '1 alpha\\n2 beta\\n'\n",
			{ encoding: "utf8", mode: 0o755 },
		);
		process.env.PATH = `${tempDir}:${originalPath}`;
		(globalThis as any).__fallbackCalls = [];

		const ctx = { readFileState: new Map() };
		const result = await mod.helperRead(
			filePath,
			1,
			undefined,
			4096,
			{ tag: "signal" },
			ctx,
			{},
			{},
			"1:2",
			false,
		);

		assert.deepEqual((globalThis as any).__fallbackCalls, []);
		assert.equal(ctx.readFileState.get(filePath).content, "1 alpha\n2 beta\n");
		assert.deepEqual(result.file, {
			filePath,
			numLines: 2,
			totalLines: 2,
			startLine: 1,
		});
	} finally {
		process.env.PATH = originalPath;
		await cleanup();
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("read-bat runtime preserves fallback range and size-limit semantics when bat fails", async () => {
    const { mod, cleanup } = await loadPatchedReadRuntimeModule();
    const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "read-bat-fallback-"),
	);
	const originalPath = process.env.PATH ?? "";
	try {
		const filePath = path.join(tempDir, "sample.txt");
		const batPath = path.join(tempDir, "bat");
		await fs.writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");
		await fs.writeFile(batPath, "#!/usr/bin/env bash\nexit 1\n", {
			encoding: "utf8",
			mode: 0o755,
		});
		process.env.PATH = `${tempDir}:${originalPath}`;

		const ctx = { readFileState: new Map() };
		(globalThis as any).__fallbackCalls = [];
		const ranged = await mod.helperRead(
			filePath,
			1,
			undefined,
			4096,
			{ tag: "signal" },
			ctx,
			{},
			{},
			"5",
			false,
		);
		assert.deepEqual((globalThis as any).__fallbackCalls[0], {
			filePath,
			offset: 4,
			limit: 1,
			maxBytes: undefined,
			signal: { tag: "signal" },
		});
		assert.equal(ranged.file.startLine, 5);

		(globalThis as any).__fallbackCalls = [];
		const unbounded = await mod.helperRead(
			filePath,
			1,
			undefined,
			4096,
			{ tag: "signal" },
			ctx,
			{},
			{},
			undefined,
			false,
		);
		assert.deepEqual((globalThis as any).__fallbackCalls[0], {
			filePath,
			offset: 0,
			limit: undefined,
			maxBytes: 4096,
			signal: { tag: "signal" },
		});
		assert.equal(unbounded.file.startLine, 1);
	} finally {
		process.env.PATH = originalPath;
		await cleanup();
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test("read-bat runtime defaults .output reads to tail range and forwards show_whitespace to bat", async () => {
    const { mod, cleanup } = await loadPatchedReadRuntimeModule();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-bat-tail-"));
    const originalPath = process.env.PATH ?? "";
    try {
        const filePath = path.join(tempDir, "build.output");
        const batPath = path.join(tempDir, "bat");
        const argsPath = path.join(tempDir, "bat-args.txt");
        await fs.writeFile(filePath, "alpha\nbeta\n", "utf8");
        await fs.writeFile(
            batPath,
            `#!/usr/bin/env bash
printf '%s\n' "$@" > ${JSON.stringify(argsPath)}
printf '1 alpha\\n2 beta\\n'
`,
            { encoding: "utf8", mode: 0o755 },
        );
        process.env.PATH = `${tempDir}:${originalPath}`;

        const ctx = { readFileState: new Map() };
        await mod.helperRead(
            filePath,
            1,
            undefined,
            4096,
            { tag: "signal" },
            ctx,
            {},
            {},
            undefined,
            true,
        );

        const batArgs = await fs.readFile(argsPath, "utf8");
        assert.equal(batArgs.includes("-A"), true);
        assert.equal(batArgs.includes("-r"), true);
        assert.equal(batArgs.includes("-500:"), true);
    } finally {
        process.env.PATH = originalPath;
        await cleanup();
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});
