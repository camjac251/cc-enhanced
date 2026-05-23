import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { mcpServerName } from "./mcp-server-name.js";

async function runMcpServerNameViaPasses(ast: any): Promise<void> {
	const passes = (await mcpServerName.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: mcpServerName.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

// Real upstream ships the same validator pair on both allowedMcpServers and
// deniedMcpServers schemas. Reflect that here so the verifier's site-count
// check matches production.
const MCP_FIXTURE = `
const allowedSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/, "Server name can only contain letters, numbers, hyphens, and underscores");
const deniedSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/, "Server name can only contain letters, numbers, hyphens, and underscores");
`;

test("verify rejects unpatched code", () => {
	const ast = parse(MCP_FIXTURE);
	const code = print(ast);
	const result = mcpServerName.verify(code, ast);
	assert.notEqual(
		result,
		true,
		"verify should reject unpatched code but got true",
	);
	assert.equal(typeof result, "string");
});

test("mcp-server-name patches known legacy pattern+message pair", async () => {
	const input = MCP_FIXTURE;
	const ast = parse(input);
	await runMcpServerNameViaPasses(ast);
	const output = print(ast);

	assert.equal(output.includes("^[a-zA-Z0-9_:./-]+$"), true);
	assert.equal(
		output.includes(
			"Server name can only contain letters, numbers, hyphens, underscores, colons, dots, and slashes",
		),
		true,
	);
	assert.equal(mcpServerName.verify(output, ast), true);
});

test("mcp-server-name verify rejects partial coverage (one schema patched, other untouched)", () => {
	// Simulates a regression where the mutation only lands in one schema; the
	// audit's site-count concern is that an asymmetric updatedCount check
	// (updatedCount >= 1) would silently accept this and the unpatched schema
	// would still reject plugin server names.
	const output = `
const allowedSchema = z.string().regex(/^[a-zA-Z0-9_:./-]+$/, "Server name can only contain letters, numbers, hyphens, underscores, colons, dots, and slashes");
const deniedSchema = z.string().regex(/^[a-zA-Z0-9_:./-]+$/, "Server name can only contain letters, numbers, hyphens, underscores, colons, dots, and slashes");
`;
	const ast = parse(output);
	// Both sites patched: verify must accept.
	assert.equal(mcpServerName.verify(output, ast), true);
	const oneSite = `
const allowedSchema = z.string().regex(/^[a-zA-Z0-9_:./-]+$/, "Server name can only contain letters, numbers, hyphens, underscores, colons, dots, and slashes");
`;
	const oneAst = parse(oneSite);
	const oneResult = mcpServerName.verify(oneSite, oneAst);
	assert.equal(typeof oneResult, "string");
	assert.equal(
		String(oneResult).includes("both allowedMcpServers and deniedMcpServers"),
		true,
		`expected site-count error, got: ${oneResult}`,
	);
});

test("mcp-server-name verify fails when old regex remains with drifted message", () => {
	const output = `
const schema = z.string().regex(/^[a-zA-Z0-9_-]+$/, "Server name can only contain letters, numbers, hyphens, underscores, and dots");
const schema2 = z.string().regex(/^[a-zA-Z0-9_:./-]+$/, "Server name can only contain letters, numbers, hyphens, underscores, colons, dots, and slashes");
`;
	const ast = parse(output);
	const result = mcpServerName.verify(output, ast);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes(
			"Old MCP serverName regex validation still present",
		),
		true,
	);
});
