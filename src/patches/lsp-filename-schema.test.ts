import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { lspFilenameSchema } from "./lsp-filename-schema.js";

async function runViaPasses(ast: any): Promise<void> {
	const passes = (await lspFilenameSchema.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: lspFilenameSchema.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

const count = (haystack: string, needle: string): number =>
	haystack.split(needle).length - 1;

// Mimics the per-server LSP plugin schema (Zod strictObject carrying both
// `command` and `extensionToLanguage`) alongside decoys that must stay
// untouched: an MCP-style strictObject (has `command`, no `extensionToLanguage`)
// and a loose object.
const SCHEMA_FIXTURE = `
const A = z;
const lms = () => A.string().min(1);
const v_u = () => A.string().min(2);
const KXe = A.strictObject({
  command: A.string().min(1),
  args: A.array(lms()).optional(),
  extensionToLanguage: A.record(v_u(), lms()).refine((e) => Object.keys(e).length > 0),
  startupTimeout: A.number().int().positive().optional(),
});
const McpServer = A.strictObject({
  command: A.string(),
  args: A.array(A.string()).optional(),
});
const Plain = A.object({ name: A.string() });
`;

test("lsp-filename-schema verify rejects the unpatched schema", () => {
	const ast = parse(SCHEMA_FIXTURE);
	const code = print(ast);
	const result = lspFilenameSchema.verify(code, ast);
	assert.notEqual(result, true);
	assert.equal(typeof result, "string");
	assert.match(String(result), /filenames\/filenamePatterns not added/);
});

test("lsp-filename-schema adds filenames + filenamePatterns to the LSP schema", async () => {
	const ast = parse(SCHEMA_FIXTURE);
	await runViaPasses(ast);
	const output = print(ast);

	assert.equal(output.includes("filenames:"), true);
	assert.equal(output.includes("filenamePatterns:"), true);
	// Emitted as record(...).optional(), mirroring extensionToLanguage.
	assert.match(output, /filenames:\s*A\.record\(/);
	assert.match(output, /filenamePatterns:\s*A\.record\(/);
	assert.match(output, /\.optional\(\)/);

	assert.equal(lspFilenameSchema.verify(output, ast), true);
	assert.equal(lspFilenameSchema.verify(output), true);
});

test("lsp-filename-schema leaves non-LSP strictObjects untouched", async () => {
	const ast = parse(SCHEMA_FIXTURE);
	await runViaPasses(ast);
	const output = print(ast);

	// Only the schema with extensionToLanguage (KXe) is extended; the MCP-style
	// strictObject (command, no extensionToLanguage) and the loose object are not.
	assert.equal(
		count(output, "filenames:"),
		1,
		"exactly one schema should gain filenames",
	);
	assert.equal(count(output, "filenamePatterns:"), 1);
});

test("lsp-filename-schema is idempotent", async () => {
	const ast = parse(SCHEMA_FIXTURE);
	await runViaPasses(ast);
	await runViaPasses(ast);
	const output = print(ast);

	assert.equal(
		count(output, "filenames:"),
		1,
		"re-running must not duplicate fields",
	);
	assert.equal(count(output, "filenamePatterns:"), 1);
	assert.equal(lspFilenameSchema.verify(output, ast), true);
});
