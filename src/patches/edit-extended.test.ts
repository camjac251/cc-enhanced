import assert from "node:assert/strict";
import { test } from "node:test";
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

const EDIT_FIXTURE = `
const z = {
  strictObject(x) { return x; },
  string() { return { optional() { return this; }, describe() { return this; } }; },
  boolean() { return { optional() { return this; }, default() { return this; }, describe() { return this; } }; },
  enum() { return { optional() { return this; }, default() { return this; }, describe() { return this; } }; },
  array() { return { min() { return this; }, optional() { return this; }, describe() { return this; } }; },
  coerce: {
    number() {
      return {
        int() { return this; },
        positive() { return this; },
        optional() { return this; },
        describe() { return this; },
      };
    },
  },
};

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
    return { transformed };
  },
  mapToolResultToToolResultBlockParam({ output }, id) {
    return { output, id };
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
	assert.equal(
		output.includes("Each edit must specify exactly one explicit mode"),
		true,
	);
	assert.equal(
		output.includes(
			"old_string and new_string cannot both be empty. Use range/line mode for positional edits.",
		),
		true,
	);
});

test("edit-extended hardens schema and alias normalization for structured modes", async () => {
	const ast = parse(EDIT_FIXTURE);
	await runEditToolViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes("line_number: z.coerce.number().int().positive()"),
		true,
	);
	assert.equal(
		output.includes("start_line: z.coerce.number().int().positive()"),
		true,
	);
	assert.equal(
		output.includes("end_line: z.coerce.number().int().positive()"),
		true,
	);
	assert.equal(output.includes("diff: z.string().optional()"), true);
	assert.equal(output.includes("edits: z.array(z.strictObject"), true);
	assert.equal(
		output.includes(
			"obj.lineNumber !== undefined && obj.line_number === undefined",
		),
		true,
	);
	assert.equal(
		output.includes(
			"obj.startLine !== undefined && obj.start_line === undefined",
		),
		true,
	);
	assert.equal(
		output.includes("obj.endLine !== undefined && obj.end_line === undefined"),
		true,
	);
	assert.equal(output.includes("_args[0] = _input;"), true);
});

test("edit-extended verify fails when regex global-flag strip guard is broken", async () => {
	const ast = parse(EDIT_FIXTURE);
	await runEditToolViaPasses(ast);
	const output = print(ast);
	const mutated = output.replace('replace(/g/g, "")', 'replace(/g/g, "g")');
	assert.notEqual(mutated, output);

	const result = editTool.verify(mutated);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes(
			"Regex mode still allows /.../g to bypass replace_all semantics",
		),
		true,
	);
});
