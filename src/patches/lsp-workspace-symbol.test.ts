import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { lspWorkspaceSymbol } from "./lsp-workspace-symbol.js";

async function runViaPasses(ast: any): Promise<void> {
	const passes = (await lspWorkspaceSymbol.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: lspWorkspaceSymbol.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

// Minimal fixture reproducing the workspaceSymbol schema + mapping.
const WORKSPACE_SYMBOL_FIXTURE =
	`
const DESCRIPTION = ` +
	"`" +
	`Interact with Language Server Protocol (LSP) servers to get code intelligence features.

Supported operations:
- goToDefinition: Find where a symbol is defined
- findReferences: Find all references to a symbol
- hover: Get hover information (documentation, type info) for a symbol
- documentSymbol: Get all symbols (functions, classes, variables) in a document
- workspaceSymbol: Search for symbols across the entire workspace
- goToImplementation: Find implementations of an interface or abstract method
- prepareCallHierarchy: Get call hierarchy item at a position (functions/methods)
- incomingCalls: Find all functions/methods that call the function at a position
- outgoingCalls: Find all functions/methods called by the function at a position

All operations require:
- filePath: The file to operate on
- line: The line number (1-based, as shown in editors)
- character: The character offset (1-based, as shown in editors)

Note: LSP servers must be configured for the file type. If no server is available, an error will be returned.` +
	"`" +
	`;

var h = {
  strictObject: (obj) => obj,
  literal: (v) => v,
  string: () => ({ describe: (d) => d, int: () => ({ positive: () => ({ describe: (d) => d }) }) }),
  number: () => ({ int: () => ({ positive: () => ({ describe: (d) => d }) }) }),
  discriminatedUnion: (key, variants) => variants,
};

var schema = h.discriminatedUnion("operation", [
  h.strictObject({
    operation: h.literal("goToDefinition"),
    filePath: h.string().describe("The absolute or relative path to the file"),
    line: h.number().int().positive().describe("The line number"),
    character: h.number().int().positive().describe("The character offset"),
  }),
  h.strictObject({
    operation: h.literal("workspaceSymbol"),
    filePath: h.string().describe("The absolute or relative path to the file"),
    line: h.number().int().positive().describe("The line number"),
    character: h.number().int().positive().describe("The character offset"),
  }),
]);

function buildRequest(H) {
  var A = "file://" + H.filePath;
  var L = { line: H.line - 1, character: H.character - 1 };
  switch (H.operation) {
    case "goToDefinition":
      return { method: "textDocument/definition", params: { textDocument: { uri: A }, position: L } };
    case "workspaceSymbol":
      return { method: "workspace/symbol", params: { query: "" } };
  }
}
`;

test("verify rejects unpatched workspaceSymbol code", () => {
	const ast = parse(WORKSPACE_SYMBOL_FIXTURE);
	const code = print(ast);
	const result = lspWorkspaceSymbol.verify(code, ast);
	assert.notEqual(result, true, "verify should reject unpatched code");
	assert.equal(typeof result, "string");
});

test("lsp-workspace-symbol adds query to schema and mapping", async () => {
	const ast = parse(WORKSPACE_SYMBOL_FIXTURE);
	await runViaPasses(ast);
	const output = print(ast);

	// Schema should now have a query field
	assert.equal(
		output.includes("query:"),
		true,
		"schema should have query field",
	);
	assert.equal(
		output.includes('"Symbol name to search for"'),
		true,
		"query field should have describe text",
	);

	// Mapping should use H.query || "" instead of ""
	assert.equal(
		output.includes("H.query"),
		true,
		"mapping should reference H.query",
	);
	assert.equal(
		output.includes("workspaceSymbol optionally accepts:"),
		true,
		"prompt should document workspaceSymbol query guidance",
	);
	assert.equal(
		output.includes("- query: Symbol name to search for across the workspace"),
		true,
		"prompt should mention the workspaceSymbol query parameter",
	);
	// The hardcoded empty string in params should be replaced
	assert.equal(
		/params:\s*\{\s*query:\s*""\s*\}/.test(output),
		false,
		'params should not have hardcoded query: ""',
	);

	assert.equal(lspWorkspaceSymbol.verify(output, ast), true);
	assert.equal(lspWorkspaceSymbol.verify(output), true);
});

test("verify detects missing query in schema", () => {
	// Has the mapping fix but not the schema fix
	const partial = WORKSPACE_SYMBOL_FIXTURE.replace(
		'query: ""',
		'query: H.query || ""',
	);
	const ast = parse(partial);
	const result = lspWorkspaceSymbol.verify(partial, ast);
	assert.equal(typeof result, "string");
	assert.match(String(result), /schema.*query/i);
});

test("verify detects hardcoded empty query in mapping", () => {
	// Has the schema fix but not the mapping fix
	const partial = WORKSPACE_SYMBOL_FIXTURE.replace(
		'operation: h.literal("workspaceSymbol"),',
		'operation: h.literal("workspaceSymbol"), query: h.string().optional().describe("Symbol name to search for"),',
	);
	const ast = parse(partial);
	const result = lspWorkspaceSymbol.verify(partial, ast);
	assert.equal(typeof result, "string");
	assert.match(String(result), /hardcoded/i);
});

test("verify detects missing workspaceSymbol query prompt guidance", async () => {
	const ast = parse(WORKSPACE_SYMBOL_FIXTURE);
	await runViaPasses(ast);
	const output = print(ast);
	const mutated = output.replace(
		"- query: Symbol name to search for across the workspace",
		"- query guidance removed",
	);
	assert.notEqual(mutated, output);

	const result = lspWorkspaceSymbol.verify(mutated);
	assert.equal(typeof result, "string");
	assert.match(String(result), /prompt missing query guidance/i);
});

test("lsp-workspace-symbol is idempotent", async () => {
	const ast = parse(WORKSPACE_SYMBOL_FIXTURE);
	await runViaPasses(ast);
	const firstPass = print(ast);

	// Run again on already-patched code
	const ast2 = parse(firstPass);
	await runViaPasses(ast2);
	const secondPass = print(ast2);

	assert.equal(firstPass, secondPass, "second pass should be identical");
	assert.equal(lspWorkspaceSymbol.verify(secondPass, ast2), true);
});

test("lsp-workspace-symbol does not touch other operations", async () => {
	const ast = parse(WORKSPACE_SYMBOL_FIXTURE);
	await runViaPasses(ast);
	const output = print(ast);

	// goToDefinition should be untouched
	assert.equal(output.includes('"textDocument/definition"'), true);
	assert.equal(
		output.includes("goToDefinition"),
		true,
		"other operations should be preserved",
	);
});
