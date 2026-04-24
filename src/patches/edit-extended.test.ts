import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { editTool } from "./edit-extended.js";

async function runEditToolViaPasses(ast: any): Promise<void> {
	const passes = (await editTool.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: editTool.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

async function loadPatchedEditRuntimeModule() {
	const ast = parse(EDIT_FIXTURE);
	await runEditToolViaPasses(ast);
	const output = print(ast);
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "edit-extended-"));
	const modulePath = path.join(tempDir, "patched-edit-runtime.mjs");

	await fs.writeFile(
		modulePath,
		`const toolChoice = { name: "Other" };
const incoming = {};
${output}
export { EditTool, EditRenderer, GenericRenderer, renderEditDialog, renderEditMessage, _claudeEditNormalizeEdits, _claudeApplyExtendedFileEdits, _claudeDecodeExtendedEditTransport, kB, Pj, S6_, yD7, jM_, v58 };`,
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

const EDIT_FIXTURE = `
function makeSchema(shape) {
  return {
    shape,
    parse(value) { return value; },
    extend(extra) { return makeSchema({ ...(this.shape || {}), ...(extra || {}) }); },
    optional() { return this; },
    default() { return this; },
    describe() { return this; },
    int() { return this; },
    positive() { return this; },
    min() { return this; },
  };
}

const z = {
  strictObject(x) { return makeSchema(x); },
  object(x) { return makeSchema(x); },
  string() { return makeSchema(); },
  boolean() { return makeSchema(); },
  enum() { return makeSchema(); },
  array() { return makeSchema(); },
  coerce: {
    number() {
      return makeSchema();
    },
  },
};

const EditRenderer = { id: "edit" };
const GenericRenderer = { id: "generic" };
const BashTool = { name: "Bash" };
const ReadTool = { name: "Read" };
const OtherTool = { name: "Other" };

const EditTool = {
  name: "Edit",
  description() {
    return "A tool for editing files";
  },
  prompt() {
    return "Performs exact string replacements in files";
  },
  input_schema: z.strictObject({
    file_path: z.string().describe("The absolute path to the file to modify"),
    old_string: z.string().describe("Original text"),
    new_string: z.string().describe("Replacement text"),
    replace_all: z.boolean().default(false),
  }),
  get inputSchema() {
    return this.input_schema;
  },
  validateInput({ file_path: A, old_string: B, new_string: C }, context) {
    if (!context) {
      return { result: false, behavior: "ask", message: "File has not been read yet", errorCode: 5 };
    }
    return { result: true };
  },
  call({ file_path: A, old_string: B, new_string: C, replace_all: D, structuredPatch: P }, context) {
    const transformed = P.reduce((acc, next) => acc.concat(next), []).map((x) => x);
    if (!context || Date.now() > context.timestamp) {
      throw Error("File must be read first");
    }
    return { transformed, observed: { old_string: B, new_string: C, replace_all: D } };
  },
  mapToolResultToToolResultBlockParam({ output }, id) {
    return { output, id };
  },
  toAutoClassifierInput(H) {
    return H.file_path + ": " + H.new_string;
  },
  inputsEquivalent(left, right) {
    return left.old_string === right.old_string && left.new_string === right.new_string;
  },
};

function renderEditDialog(ARG) {
  const before = "alpha";
  const after = "beta";
  const rows = [{ old_string: before, new_string: after, replace_all: false }];
  return { title: "Edit file", rows };
}

function renderGenericToolConfirm(toolUseConfirm, ideDiffSupport, parseInput, context) {
  const parsed = parseInput(toolUseConfirm.input);
  const diffConfig = ideDiffSupport ? ideDiffSupport.getConfig(parsed) : null;
  return { parsed, diffConfig, context };
}

function dEH(list) {
  return list;
}

function kB() {
  return [BashTool, EditTool, OtherTool];
}

function Pj(H) {
  return dEH([BashTool, ReadTool, EditTool], H);
}

function S6_(H) {
  return EditTool.inputSchema.parse(H);
}

function czD(input) {
  return {
    file_path: input.file_path,
    edits: input.edits,
  };
}

function yD7(tool, input) {
  if (tool === EditTool && input && typeof input === "object" && Array.isArray(input.edits)) {
    const { old_string, new_string, replace_all, ...rest } = input;
    return rest;
  }
  return input;
}

function v58(H, $, A) {
  switch (H.name) {
    case EditTool.name: {
      let L = EditTool.inputSchema.parse($),
        { file_path: D, edits: f } = czD({
          file_path: L.file_path,
          edits: [
            { old_string: L.old_string, new_string: L.new_string, replace_all: L.replace_all },
          ],
        });
      return {
        replace_all: f[0].replace_all,
        file_path: D,
        old_string: f[0].old_string,
        new_string: f[0].new_string,
      };
    }
    default:
      return $;
  }
}

function jM_(H) {
  switch (H) {
    case EditTool:
      return EditRenderer;
    default:
      return GenericRenderer;
  }
}

switch (toolChoice.name) {
  case EditTool.name:
    {
      const rawInput = incoming;
      const { old_string, new_string } = rawInput;
      const untouched = 1;
      const marker = untouched;
      void marker;
    }
}

function renderEditMessage({ file_path: f }, { verbose: v }) {
  if (!f) return null;
  if (f.startsWith("/tmp/plan/")) return "";
  if (f.length > 100) {
    return { type: "Text", props: { children: [f.slice(0, 100), "\\u2026"] } };
  }
  return v ? f : f.split("/").pop();
}
`;

test("verify rejects unpatched code", () => {
	const ast = parse(EDIT_FIXTURE);
	const code = print(ast);
	const result = editTool.verify(code, ast);
	assert.notEqual(
		result,
		true,
		"verify should reject unpatched code but got true",
	);
	assert.equal(typeof result, "string");
});

test("edit-extended injects unified preview via normalize+apply pipeline", async () => {
	const ast = parse(EDIT_FIXTURE);
	await runEditToolViaPasses(ast);
	const output = print(ast);

	assert.equal(output.includes("EXTENDED_EDIT_PREVIEW_v1"), true);
	assert.equal(output.includes("_claudeEditNormalizeEdits"), true);
	assert.equal(output.includes("_claudeApplyExtendedFileEdits"), true);
	assert.equal(output.includes("_claudeEditCanonicalizeInput"), true);
	assert.equal(
		output.includes("old_string and new_string cannot both be empty."),
		true,
	);
	assert.equal(
		output.includes("Edit files using string replace or batch"),
		true,
	);
	assert.equal(output.includes("sd 'pattern' 'replacement'"), true);
});

test("edit-extended verify accepts escaped Bash guidance in emitted prompt strings", async () => {
	const ast = parse(EDIT_FIXTURE);
	await runEditToolViaPasses(ast);
	const output = print(ast);
	const escaped = output.replace(
		"sd 'pattern' 'replacement'",
		"sd \\'pattern\\' \\'replacement\\'",
	);

	assert.notEqual(escaped, output);
	assert.equal(editTool.verify(escaped, parse(escaped)), true);
});

test("edit-extended keeps Edit identity while preserving structured edits through normalization", async () => {
	const ast = parse(EDIT_FIXTURE);
	await runEditToolViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes("function _claudeEncodeExtendedEditTransport(INPUT)"),
		false,
	);
	assert.equal(
		output.includes("function _claudeDecodeExtendedEditTransport(INPUT)"),
		true,
	);
	assert.equal(
		output.includes("function _claudeGetExtendedEditToolSchema()"),
		false,
	);
	assert.equal(output.includes("function _claudeGetExtendedEditTool()"), false);
	assert.equal(output.includes("_args[0] = _input;"), true);
	assert.equal(
		output.includes("inputSchema.parse(_claudeEncodeExtendedEditTransport(H))"),
		false,
	);
	assert.equal(
		output.includes("_input = _claudeDecodeExtendedEditTransport(_input);"),
		true,
	);
	assert.equal(
		output.includes("_claudeEditHasExtendedFields(L) ? L.edits : ["),
		true,
	);
	assert.equal(
		output.includes("...(_claudeEditHasExtendedFields(L) ? { edits: f } : {})"),
		true,
	);
	assert.equal(output.includes("_claudeEditInputsEquivalent"), true);
	assert.equal(output.includes("JSON.stringify(_leftInput)"), false);
	assert.equal(output.includes("return EditTool.inputSchema.parse(H);"), true);
});

test("edit-extended bypasses ideDiffSupport.getConfig for structured edit confirmations", async () => {
	const ast = parse(EDIT_FIXTURE);
	await runEditToolViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes(
			"ideDiffSupport ? _claudeEditHasExtendedFields(_claudeDecodeExtendedEditTransport(parsed)) ? null : ideDiffSupport.getConfig(parsed) : null",
		),
		true,
	);
});

test("edit-extended verify fails when structured edit wiring is broken", async () => {
	const ast = parse(EDIT_FIXTURE);
	await runEditToolViaPasses(ast);
	const output = print(ast);
	const mutated = output.replaceAll(
		"_claudeDecodeExtendedEditTransport",
		"_claudeDecodeExtendedEditTransportBroken",
	);
	assert.notEqual(mutated, output);

	const result = editTool.verify(mutated);
	assert.equal(typeof result, "string");
});

test("edit-extended runtime normalizes batch string edits and applies them in order", async () => {
	const { mod, cleanup } = await loadPatchedEditRuntimeModule();
	try {
		const normalized = mod._claudeEditNormalizeEdits({
			edits: [
				{ oldString: "alpha", newString: "ALPHA" },
				{ oldString: "gamma", newString: "GAMMA" },
			],
		});
		assert.ok(!normalized.error);
		assert.equal(normalized.edits.length, 2);
		assert.equal(normalized.edits[0].mode, "string");
		assert.equal(normalized.edits[0].oldString, "alpha");
		assert.equal(normalized.edits[0].newString, "ALPHA");
		assert.equal(normalized.edits[1].mode, "string");
		assert.equal(normalized.edits[1].oldString, "gamma");
		assert.equal(normalized.edits[1].newString, "GAMMA");

		const applied = mod._claudeApplyExtendedFileEdits(
			"alpha\nbeta\ngamma",
			normalized.edits,
		);
		assert.equal(applied.error, undefined);
		assert.equal(applied.content, "ALPHA\nbeta\nGAMMA");
	} finally {
		await cleanup();
	}
});

test("edit-extended runtime rejects empty old_string and new_string in batch", async () => {
	const { mod, cleanup } = await loadPatchedEditRuntimeModule();
	try {
		const normalized = mod._claudeEditNormalizeEdits({
			edits: [{ oldString: "", newString: "" }],
		});
		assert.ok(normalized.error);
		assert.equal(normalized.error.errorCode, 26);
		assert.ok(
			normalized.error.message.includes(
				"old_string and new_string cannot both be empty",
			),
		);
	} finally {
		await cleanup();
	}
});

test("edit-extended original Edit tool preserves raw batch input parsing", async () => {
	const { mod, cleanup } = await loadPatchedEditRuntimeModule();
	try {
		assert.equal(typeof mod._claudeDecodeExtendedEditTransport, "function");
		assert.equal(mod.kB()[1], mod.EditTool);
		assert.equal(mod.Pj()[2], mod.EditTool);
		assert.equal(mod.jM_(mod.EditTool), mod.EditRenderer);

		const parsed = mod.S6_({
			file_path: "/tmp/example.ts",
			edits: [{ old_string: "foo", new_string: "bar" }],
		});
		assert.equal(parsed.file_path, "/tmp/example.ts");
		assert.deepEqual(parsed.edits, [{ old_string: "foo", new_string: "bar" }]);
		assert.equal("old_string" in parsed, false);
	} finally {
		await cleanup();
	}
});

test("edit-extended runtime preserves structured edits through source-like normalization", async () => {
	const { mod, cleanup } = await loadPatchedEditRuntimeModule();
	try {
		const normalized = mod.v58(mod.EditTool, {
			file_path: "/tmp/example.ts",
			edits: [{ old_string: "foo", new_string: "bar", replace_all: true }],
		});
		assert.deepEqual(normalized, {
			file_path: "/tmp/example.ts",
			old_string: "foo",
			new_string: "bar",
			replace_all: true,
			edits: [{ old_string: "foo", new_string: "bar", replace_all: true }],
		});

		const transcriptInput = mod.yD7(mod.EditTool, normalized);
		assert.deepEqual(transcriptInput, {
			file_path: "/tmp/example.ts",
			edits: [{ old_string: "foo", new_string: "bar", replace_all: true }],
		});
	} finally {
		await cleanup();
	}
});

test("edit-extended runtime builds auto-classifier input from structured edits", async () => {
	const { mod, cleanup } = await loadPatchedEditRuntimeModule();
	try {
		const autoClassifierInput = mod.EditTool.toAutoClassifierInput({
			file_path: "/tmp/example.ts",
			edits: [
				{ oldString: "foo", newString: "bar" },
				{ old_string: "baz", new_string: "qux" },
			],
		});
		assert.equal(autoClassifierInput, "/tmp/example.ts: bar\nqux");
	} finally {
		await cleanup();
	}
});

test("edit-extended runtime preserves notebook rejection via batch edits", async () => {
	const { mod, cleanup } = await loadPatchedEditRuntimeModule();
	try {
		const notebookValidation = mod.EditTool.validateInput(
			{
				file_path: "/tmp/example.ipynb",
				edits: [{ old_string: "x", new_string: "y" }],
			},
			{},
		);
		assert.deepEqual(notebookValidation, {
			result: false,
			behavior: "ask",
			message:
				"File is a Jupyter Notebook. Use the NotebookEdit tool to edit this file.",
			errorCode: 5,
		});
	} finally {
		await cleanup();
	}
});

test("edit-extended runtime keeps structured batch validation on the legacy read-state path", async () => {
	const { mod, cleanup } = await loadPatchedEditRuntimeModule();
	try {
		const validateWithoutContext = mod.EditTool.validateInput(
			{
				file_path: "/tmp/example.txt",
				edits: [{ old_string: "alpha", new_string: "beta" }],
			},
			null,
		);
		assert.deepEqual(validateWithoutContext, {
			result: false,
			behavior: "ask",
			message: "Read-state validation failed",
			errorCode: 5,
		});
	} finally {
		await cleanup();
	}
});

test("edit-extended runtime keeps plain string mode read-state guards intact", async () => {
	const { mod, cleanup } = await loadPatchedEditRuntimeModule();
	try {
		const validateWithoutContext = mod.EditTool.validateInput(
			{
				file_path: "/tmp/example.txt",
				old_string: "alpha",
				new_string: "beta",
			},
			null,
		);
		assert.deepEqual(validateWithoutContext, {
			result: false,
			behavior: "ask",
			message: "Read-state validation failed",
			errorCode: 5,
		});

		await assert.rejects(
			async () =>
				mod.EditTool.call({
					file_path: "/tmp/example.txt",
					old_string: "alpha",
					new_string: "beta",
					structuredPatch: [],
				}),
			/Error editing file/,
		);
	} finally {
		await cleanup();
	}
});

test("edit-extended runtime preserves CRLF semantics in batch call canonicalization", async () => {
	const { mod, cleanup } = await loadPatchedEditRuntimeModule();
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "edit-extended-crlf-"),
	);
	try {
		const filePath = path.join(tempDir, "example.txt");
		await fs.writeFile(filePath, "alpha\r\nbeta\r\n", "utf8");

		const result = await mod.EditTool.call(
			{
				file_path: filePath,
				edits: [{ oldString: "beta", newString: "BETA" }],
				structuredPatch: [],
			},
			{ timestamp: Date.now() + 60_000 },
		);

		assert.deepEqual(result.observed, {
			old_string: "alpha\r\nbeta\r\n",
			new_string: "alpha\r\nBETA\r\n",
			replace_all: false,
		});
	} finally {
		await cleanup();
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("edit-extended runtime preserves content-addressed batch order", async () => {
	const { mod, cleanup } = await loadPatchedEditRuntimeModule();
	try {
		// String edits should run in user-provided order, not sorted
		const normalized = mod._claudeEditNormalizeEdits({
			edits: [
				{ oldString: "alpha", newString: "ALPHA" },
				{ oldString: "beta", newString: "BETA" },
				{ oldString: "gamma", newString: "GAMMA" },
			],
		});
		assert.ok(!normalized.error);

		const applied = mod._claudeApplyExtendedFileEdits(
			"alpha beta gamma",
			normalized.edits,
		);
		assert.equal(applied.error, undefined);
		assert.equal(applied.content, "ALPHA BETA GAMMA");
	} finally {
		await cleanup();
	}
});

test("edit-extended runtime preserves curly quote style when fuzzy matching smart quotes", async () => {
	const { mod, cleanup } = await loadPatchedEditRuntimeModule();
	try {
		const normalized = mod._claudeEditNormalizeEdits({
			edits: [{ oldString: '"alpha"', newString: '"beta"' }],
		});
		assert.ok(!normalized.error);

		const applied = mod._claudeApplyExtendedFileEdits(
			"const title = “alpha”;",
			normalized.edits,
		);
		assert.equal(applied.error, undefined);
		assert.equal(applied.content, "const title = “beta”;");
	} finally {
		await cleanup();
	}
});

test("edit-extended runtime rejects substring edits from prior replacements", async () => {
	const { mod, cleanup } = await loadPatchedEditRuntimeModule();
	try {
		const normalized = mod._claudeEditNormalizeEdits({
			edits: [
				{ oldString: "alpha", newString: "ALPHA BETA" },
				{ oldString: "BETA", newString: "gamma" },
			],
		});
		assert.ok(!normalized.error);

		const applied = mod._claudeApplyExtendedFileEdits(
			"alpha",
			normalized.edits,
		);
		assert.ok(applied.error);
		assert.match(
			String(applied.error.message),
			/substring of a new_string from a previous edit/i,
		);
	} finally {
		await cleanup();
	}
});

test("edit-extended runtime strips trailing whitespace for non-markdown batch edits", async () => {
	const { mod, cleanup } = await loadPatchedEditRuntimeModule();
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "edit-extended-whitespace-"),
	);
	try {
		const filePath = path.join(tempDir, "example.txt");
		await fs.writeFile(filePath, "alpha\nbeta\n", "utf8");

		const result = await mod.EditTool.call(
			{
				file_path: filePath,
				edits: [{ oldString: "beta", newString: "BETA  " }],
				structuredPatch: [],
			},
			{ timestamp: Date.now() + 60_000 },
		);

		assert.deepEqual(result.observed, {
			old_string: "alpha\nbeta\n",
			new_string: "alpha\nBETA\n",
			replace_all: false,
		});
	} finally {
		await cleanup();
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("edit-extended runtime preserves markdown hard breaks in batch edits", async () => {
	const { mod, cleanup } = await loadPatchedEditRuntimeModule();
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "edit-extended-markdown-"),
	);
	try {
		const filePath = path.join(tempDir, "example.md");
		await fs.writeFile(filePath, "alpha\nbeta\n", "utf8");

		const result = await mod.EditTool.call(
			{
				file_path: filePath,
				edits: [{ oldString: "beta", newString: "BETA  " }],
				structuredPatch: [],
			},
			{ timestamp: Date.now() + 60_000 },
		);

		assert.deepEqual(result.observed, {
			old_string: "alpha\nbeta\n",
			new_string: "alpha\nBETA  \n",
			replace_all: false,
		});
	} finally {
		await cleanup();
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("edit-extended runtime uses semantic equality for structured edits", async () => {
	const { mod, cleanup } = await loadPatchedEditRuntimeModule();
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "edit-extended-eq-"));
	try {
		const filePath = path.join(tempDir, "example.txt");
		await fs.writeFile(filePath, "alpha alpha\n", "utf8");

		const equivalent = mod.EditTool.inputsEquivalent(
			{
				file_path: filePath,
				edits: [{ oldString: "alpha", newString: "ALPHA", replaceAll: true }],
			},
			{
				file_path: filePath,
				edits: [{ oldString: "alpha alpha\n", newString: "ALPHA ALPHA\n" }],
			},
		);

		assert.equal(equivalent, true);
	} finally {
		await cleanup();
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("edit-extended runtime surfaces batch and replace_all opts in tool chip", async () => {
	const { mod, cleanup } = await loadPatchedEditRuntimeModule();
	try {
		const ctx = { verbose: false };
		assert.equal(
			mod.renderEditMessage({ file_path: "/home/me/src/index.ts" }, ctx),
			"index.ts",
		);
		assert.equal(mod.renderEditMessage({}, ctx), null);
		assert.equal(
			mod.renderEditMessage({ file_path: "/tmp/plan/scratch.md" }, ctx),
			"",
		);
		assert.equal(
			mod.renderEditMessage(
				{
					file_path: "/tmp/plan/scratch.md",
					edits: [{ old_string: "a", new_string: "b" }],
				},
				ctx,
			),
			"",
			"plan-preview suppression must win over opts suffix",
		);
		assert.equal(
			mod.renderEditMessage(
				{ file_path: "/home/me/src/index.ts", replace_all: true },
				ctx,
			),
			"index.ts · replace_all",
		);
		assert.equal(
			mod.renderEditMessage(
				{
					file_path: "/home/me/src/index.ts",
					edits: [
						{ old_string: "a", new_string: "A" },
						{ old_string: "b", new_string: "B" },
						{ old_string: "c", new_string: "C" },
					],
				},
				ctx,
			),
			"index.ts · batch(3)",
		);
		assert.equal(
			mod.renderEditMessage(
				{
					file_path: "/home/me/src/index.ts",
					edits: [{ old_string: "a", new_string: "A" }],
					replace_all: true,
				},
				ctx,
			),
			"index.ts · batch(1), replace_all",
		);
		assert.equal(
			mod.renderEditMessage(
				{ file_path: "/home/me/src/index.ts", edits: [] },
				ctx,
			),
			"index.ts",
			"empty edits array must not trigger batch suffix",
		);
		const longPath = "/home/me/" + "x".repeat(200) + ".ts";
		const el = mod.renderEditMessage(
			{ file_path: longPath, replace_all: true },
			ctx,
		);
		assert.equal(el.type, "Text");
		assert.equal(Array.isArray(el.props.children), true);
		assert.equal(
			el.props.children[el.props.children.length - 1],
			" · replace_all",
		);
	} finally {
		await cleanup();
	}
});
