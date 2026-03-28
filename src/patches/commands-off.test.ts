import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { commandsOff } from "./commands-off.js";

async function runCommandsOffViaPasses(ast: any): Promise<void> {
	const passes = (await commandsOff.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: commandsOff.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

const BUILTIN_COMMAND_FACTORY_FIXTURE = `
function makeBuiltinCommand({
  name: H,
  description: $,
  progressMessage: A,
  pluginName: L,
  pluginCommand: D,
  getPromptWhileMarketplaceIsPrivate: f,
}) {
  return {
    type: "prompt",
    name: H,
    description: $,
    progressMessage: A,
    contentLength: 0,
    isEnabled: () => !0,
    isHidden: !1,
    userFacingName() { return H; },
    source: "builtin",
    async getPromptForCommand(_, M) { return f(_, M); },
  };
}

var prComments = makeBuiltinCommand({
  name: "pr-comments",
  description: "Get comments from a GitHub pull request",
  progressMessage: "fetching PR comments",
  pluginName: "pr-comments",
  pluginCommand: "pr-comments",
  async getPromptWhileMarketplaceIsPrivate(H) {
    return [{ type: "text", text: "fetch pr comments: " + H }];
  },
});

var reviewCmd = makeBuiltinCommand({
  name: "review",
  description: "Review a pull request",
  progressMessage: "reviewing pull request",
  pluginName: "code-review",
  pluginCommand: "code-review",
  async getPromptWhileMarketplaceIsPrivate(H) {
    return [{ type: "text", text: "review: " + H }];
  },
});

var secReview = makeBuiltinCommand({
  name: "security-review",
  description: "Complete a security review",
  progressMessage: "analyzing code changes",
  pluginName: "security-review",
  pluginCommand: "security-review",
  async getPromptWhileMarketplaceIsPrivate(H) {
    return [{ type: "text", text: "security review: " + H }];
  },
});
`;

test("commands-off verify rejects unpatched fixture", () => {
	const ast = parse(BUILTIN_COMMAND_FACTORY_FIXTURE);
	const result = commandsOff.verify(BUILTIN_COMMAND_FACTORY_FIXTURE, ast);
	assert.notEqual(result, true);
	assert.equal(typeof result, "string");
});

test("commands-off disables all three built-in commands", async () => {
	const ast = parse(BUILTIN_COMMAND_FACTORY_FIXTURE);
	await runCommandsOffViaPasses(ast);
	const output = print(ast);

	// The factory should now have a guard that checks the name
	assert.equal(output.includes("indexOf"), true, "Should have indexOf check");
	assert.equal(
		output.includes('"pr-comments"'),
		true,
		"Should reference pr-comments",
	);
	assert.equal(output.includes('"review"'), true, "Should reference review");
	assert.equal(
		output.includes('"security-review"'),
		true,
		"Should reference security-review",
	);

	// Verify the patch passes verification
	const verifyResult = commandsOff.verify(output, ast);
	assert.equal(verifyResult, true, `Verify failed: ${verifyResult}`);
});

test("commands-off is idempotent", async () => {
	const ast = parse(BUILTIN_COMMAND_FACTORY_FIXTURE);
	await runCommandsOffViaPasses(ast);
	const firstPass = print(ast);

	const ast2 = parse(firstPass);
	await runCommandsOffViaPasses(ast2);
	const secondPass = print(ast2);

	assert.equal(firstPass, secondPass);
	assert.equal(commandsOff.verify(secondPass, ast2), true);
});

test("commands-off does not affect non-disabled commands", async () => {
	const fixture =
		BUILTIN_COMMAND_FACTORY_FIXTURE +
		`
var otherCmd = makeBuiltinCommand({
  name: "some-other-command",
  description: "A custom command",
  progressMessage: "doing stuff",
  pluginName: "other",
  pluginCommand: "other",
  async getPromptWhileMarketplaceIsPrivate(H) {
    return [{ type: "text", text: "other: " + H }];
  },
});
`;
	const ast = parse(fixture);
	await runCommandsOffViaPasses(ast);
	const output = print(ast);

	// The other command should still have isEnabled: () => !0
	// (the factory returns it from the original return path)
	assert.equal(
		output.includes('"some-other-command"'),
		true,
		"Other command should still be present",
	);
});
