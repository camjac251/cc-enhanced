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

test("mcp-server-name verify rejects new pattern with non-canonical message", () => {
	const output = `
const allowedSchema = z.string().regex(/^[a-zA-Z0-9_:./-]+$/, "Server name can only contain letters, numbers, hyphens, underscores, colons, dots, slashes, and more");
const deniedSchema = z.string().regex(/^[a-zA-Z0-9_:./-]+$/, "Server name can only contain letters, numbers, hyphens, underscores, colons, dots, and slashes");
`;
	const ast = parse(output);
	const result = mcpServerName.verify(output, ast);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("does not match the patched wording"),
		true,
		`expected mismatched-shape error, got: ${result}`,
	);
});

test("mcp-server-name mutator leaves same-pattern different-message regex untouched", async () => {
	const input = `
const decoy = z.string().regex(/^[a-zA-Z0-9_-]+$/, "Some unrelated validator message");
const allowedSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/, "Server name can only contain letters, numbers, hyphens, and underscores");
const deniedSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/, "Server name can only contain letters, numbers, hyphens, and underscores");
`;
	const ast = parse(input);
	await runMcpServerNameViaPasses(ast);
	const output = print(ast);
	// Decoy keeps the old pattern; only the two server-name validators are rewritten.
	assert.equal(output.includes("Some unrelated validator message"), true);
	assert.equal(
		(output.match(/\^\[a-zA-Z0-9_:\.\/-\]\+\$/g) ?? []).length,
		2,
		"exactly the two server-name patterns should be widened",
	);
	assert.equal(
		(output.match(/\^\[a-zA-Z0-9_-\]\+\$/g) ?? []).length,
		1,
		"the decoy's old pattern must remain",
	);
});

test("mcp-server-name mutator ignores single-argument regex calls", async () => {
	const input = `
const idOnly = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const allowedSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/, "Server name can only contain letters, numbers, hyphens, and underscores");
const deniedSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/, "Server name can only contain letters, numbers, hyphens, and underscores");
`;
	const ast = parse(input);
	await runMcpServerNameViaPasses(ast);
	const output = print(ast);
	// The single-arg regex keeps the old pattern; only the two paired validators widen.
	assert.equal(
		(output.match(/\^\[a-zA-Z0-9_-\]\+\$/g) ?? []).length,
		1,
		"single-arg regex must be left untouched",
	);
	assert.equal(mcpServerName.verify(output, ast), true);
});

test("mcp-server-name mutator patches exactly two sites on the canonical fixture", async () => {
	const ast = parse(MCP_FIXTURE);
	await runMcpServerNameViaPasses(ast);
	const output = print(ast);
	assert.equal(
		(output.match(/colons, dots, and slashes/g) ?? []).length,
		2,
		"both schemas in the two-schema fixture must be rewritten",
	);
});
