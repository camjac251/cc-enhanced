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

const BUILTIN_COMMAND_REGISTRY_FIXTURE = `
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
    source: "builtin",
    async getPromptForCommand(_, M) { return f(_, M); },
  };
}

const reviewCommand = {
  type: "prompt",
  name: "review",
  description: "Review a pull request",
  progressMessage: "reviewing pull request",
  contentLength: 0,
  source: "builtin",
  async getPromptForCommand(H) {
    return [{ type: "text", text: "review: " + H }];
  },
};

const securityReview = makeBuiltinCommand({
  name: "security-review",
  description: "Complete a security review",
  progressMessage: "analyzing code changes",
  pluginName: "security-review",
  pluginCommand: "security-review",
  async getPromptWhileMarketplaceIsPrivate(H) {
    return [{ type: "text", text: "security review: " + H }];
  },
});

const otherCommand = {
  type: "prompt",
  name: "help",
  description: "Show help",
  source: "builtin",
};

const COMMANDS = memoize(() => [
  reviewCommand,
  securityReview,
  otherCommand,
]);
`;

test("commands-off verify rejects unpatched registry fixture", () => {
	const ast = parse(BUILTIN_COMMAND_REGISTRY_FIXTURE);
	const result = commandsOff.verify(BUILTIN_COMMAND_REGISTRY_FIXTURE, ast);
	assert.notEqual(result, true);
	assert.equal(typeof result, "string");
});

test("commands-off removes superseded commands from the central registry", async () => {
	const ast = parse(BUILTIN_COMMAND_REGISTRY_FIXTURE);
	await runCommandsOffViaPasses(ast);
	const output = print(ast);

	assert.equal(output.includes("reviewCommand,"), false);
	assert.equal(output.includes("securityReview,"), false);
	assert.equal(output.includes("otherCommand"), true);
	assert.equal(commandsOff.verify(output, ast), true);
});

test("commands-off is idempotent against the registry shape", async () => {
	const ast = parse(BUILTIN_COMMAND_REGISTRY_FIXTURE);
	await runCommandsOffViaPasses(ast);
	const firstPass = print(ast);

	const ast2 = parse(firstPass);
	await runCommandsOffViaPasses(ast2);
	const secondPass = print(ast2);

	assert.equal(firstPass, secondPass);
	assert.equal(commandsOff.verify(secondPass, ast2), true);
});

test("commands-off passes when the current bundle already omits those commands", () => {
	const alreadyAbsentFixture = `
const COMMANDS = memoize(() => [
  {
    type: "prompt",
    name: "help",
    description: "Show help",
    source: "builtin",
  },
]);
`;

	const ast = parse(alreadyAbsentFixture);
	assert.equal(commandsOff.verify(alreadyAbsentFixture, ast), true);
});
