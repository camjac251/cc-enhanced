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

	assert.equal(output.includes("reviewCommand,"), true);
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

test("commands-off removes a command whose binding is assigned via a constant violation (var + later assignment)", async () => {
	const constViolationFixture = `
function makeBuiltinCommand({ name: H, description: $, getPromptWhileMarketplaceIsPrivate: f }) {
  return { type: "prompt", name: H, description: $, source: "builtin", async getPromptForCommand(_, M) { return f(_, M); } };
}
var keepCmd, dropCmd;
function init() {
  (keepCmd = makeBuiltinCommand({ name: "review", description: "Review a pull request", async getPromptWhileMarketplaceIsPrivate(H) { return [{ type: "text", text: H }]; } }));
  (dropCmd = makeBuiltinCommand({ name: "security-review", description: "Complete a security review", async getPromptWhileMarketplaceIsPrivate(H) { return [{ type: "text", text: H }]; } }));
}
const COMMANDS = memoize(() => [keepCmd, dropCmd]);
`;
	const ast = parse(constViolationFixture);
	await runCommandsOffViaPasses(ast);
	const output = print(ast);
	// keepCmd's binding stays in the bundle; the registry array drops dropCmd.
	// The dropCmd assignment statement legitimately survives, so assert on the
	// registry array contents directly rather than the whole-file token set.
	const registry = output.match(/memoize\(\(\) => (\[[\s\S]*?\])\)/);
	assert.ok(registry, "registry array not found in patched output");
	assert.equal(registry[1].includes("keepCmd"), true);
	assert.equal(
		/\bdropCmd\b/.test(registry[1]),
		false,
		"dropCmd identifier must be removed from the registry array",
	);
	assert.equal(commandsOff.verify(output, ast), true);
});

test("commands-off verify flags a constant-violation-bound disabled command left in the registry", () => {
	const leakFixture = `
function makeBuiltinCommand({ name: H, description: $ }) {
  return { type: "prompt", name: H, description: $, source: "builtin" };
}
var dropCmd;
function init() { (dropCmd = makeBuiltinCommand({ name: "security-review", description: "Complete a security review" })); }
const COMMANDS = memoize(() => [dropCmd]);
`;
	const ast = parse(leakFixture);
	const result = commandsOff.verify(leakFixture, ast);
	assert.equal(typeof result, "string");
	assert.match(String(result), /security-review/);
});

test("commands-off preserves spread and call-expression registry elements while removing the target", async () => {
	const mixedFixture = `
function makeBuiltinCommand({ name: H, description: $ }) {
  return { type: "prompt", name: H, description: $, source: "builtin" };
}
var dropCmd, keepCmd;
function init() {
  (keepCmd = makeBuiltinCommand({ name: "review", description: "Review a pull request" }));
  (dropCmd = makeBuiltinCommand({ name: "security-review", description: "Complete a security review" }));
}
const extra = [];
const flag = true;
function buildOne() { return { type: "prompt", name: "built", source: "builtin" }; }
const COMMANDS = memoize(() => [keepCmd, dropCmd, buildOne(), ...(flag ? [keepCmd] : []), ...extra]);
`;
	const ast = parse(mixedFixture);
	await runCommandsOffViaPasses(ast);
	const output = print(ast);
	assert.equal(
		output.includes("buildOne()"),
		true,
		"call-expression element must survive",
	);
	assert.equal(
		output.includes("...extra"),
		true,
		"spread element must survive",
	);
	assert.equal(
		output.includes("flag ?"),
		true,
		"spread-conditional must survive",
	);
	assert.equal(commandsOff.verify(output, ast), true);
});

test("commands-off leaves alias-form registry identifiers intact and still removes the target", async () => {
	// A resolvable command (keepCmd) keeps the registry recognizable to verify
	// after the target is removed; alias-form bindings (aliasCmd = base) resolve
	// to null and must be left untouched rather than chased or thrown on.
	const aliasFixture = `
function makeBuiltinCommand({ name: H, description: $ }) {
  return { type: "prompt", name: H, description: $, source: "builtin" };
}
var base, aliasCmd, keepCmd, dropCmd;
function init() {
  (base = { type: "local-jsx", name: "add-dir", description: "Add a new working directory" });
  (aliasCmd = base);
  (keepCmd = makeBuiltinCommand({ name: "review", description: "Review a pull request" }));
  (dropCmd = makeBuiltinCommand({ name: "security-review", description: "Complete a security review" }));
}
const COMMANDS = memoize(() => [aliasCmd, keepCmd, dropCmd]);
`;
	const ast = parse(aliasFixture);
	await runCommandsOffViaPasses(ast);
	const output = print(ast);
	assert.equal(
		output.includes("aliasCmd"),
		true,
		"alias-form element must be preserved",
	);
	const registry = output.match(/memoize\(\(\) => (\[[\s\S]*?\])\)/);
	assert.ok(registry, "registry array not found in patched output");
	assert.equal(
		registry[1].includes("aliasCmd"),
		true,
		"alias element must survive in the registry",
	);
	assert.equal(
		/\bdropCmd\b/.test(registry[1]),
		false,
		"dropCmd must be removed from the array",
	);
	assert.equal(commandsOff.verify(output, ast), true);
});

test("commands-off verify flags an inline-object disabled command in the registry", () => {
	// Some registries hold command object literals directly rather than
	// identifier references. An inline disabled command must still be caught.
	const inlineLeakFixture = `
const COMMANDS = memoize(() => [
  { type: "prompt", name: "review", description: "Review a pull request", source: "builtin" },
  { type: "prompt", name: "security-review", description: "Complete a security review", source: "builtin" },
]);
`;
	const ast = parse(inlineLeakFixture);
	const result = commandsOff.verify(inlineLeakFixture, ast);
	assert.equal(typeof result, "string");
	assert.match(String(result), /security-review/);
});

test("commands-off removes exactly the target and no adjacent registry element", async () => {
	// Pin the removal COUNT, not just the absence of the target. An over-removal
	// regression (dropping an adjacent identifier element) or a multi-match
	// regression would still satisfy the "target absent" checks; counting the
	// surviving elements in the printed registry catches it.
	const twoKeepFixture = `
function makeBuiltinCommand({ name: H, description: $ }) {
  return { type: "prompt", name: H, description: $, source: "builtin" };
}
var a, b, c;
function init() {
  (a = makeBuiltinCommand({ name: "review", description: "Review a pull request" }));
  (b = makeBuiltinCommand({ name: "security-review", description: "Complete a security review" }));
  (c = makeBuiltinCommand({ name: "compact", description: "Compact the conversation" }));
}
const COMMANDS = memoize(() => [a, b, c]);
`;
	const ast = parse(twoKeepFixture);
	await runCommandsOffViaPasses(ast);
	const output = print(ast);
	const registry = output.match(/memoize\(\(\) => (\[[\s\S]*?\])\)/);
	assert.ok(registry, "registry array not found in patched output");
	const elementCount = (registry[1].match(/\b[abc]\b/g) ?? []).length;
	assert.equal(
		elementCount,
		2,
		"exactly one element (security-review) must be removed, leaving two",
	);
	assert.equal(/\ba\b/.test(registry[1]), true, "review binding must survive");
	assert.equal(
		/\bb\b/.test(registry[1]),
		false,
		"security-review binding must be removed",
	);
	assert.equal(/\bc\b/.test(registry[1]), true, "compact binding must survive");
	assert.equal(commandsOff.verify(output, ast), true);
});

test("commands-off keeps verify recognizing the registry when only an inline-object sibling resolves after removal", async () => {
	// Reproduce the real bundle survival path: the removed command and an alias
	// sibling are constant-violation / alias forms (resolve to null after
	// removal), while the registry stays recognizable ONLY because a
	// directly-assigned inline-object command resolves to a non-null name.
	const inlineSurvivorFixture = `
function makeBuiltinCommand({ name: H, description: $ }) {
  return { type: "prompt", name: H, description: $, source: "builtin" };
}
var base, aliasCmd, inlineCmd, dropCmd;
function init() {
  (base = { type: "local-jsx", name: "add-dir", description: "Add a new working directory" });
  (aliasCmd = base);
  (inlineCmd = { type: "local-jsx", name: "autocompact", description: "Set how full the context gets" });
  (dropCmd = makeBuiltinCommand({ name: "security-review", description: "Complete a security review" }));
}
const COMMANDS = memoize(() => [aliasCmd, inlineCmd, dropCmd]);
`;
	const ast = parse(inlineSurvivorFixture);
	await runCommandsOffViaPasses(ast);
	const output = print(ast);
	const registry = output.match(/memoize\(\(\) => (\[[\s\S]*?\])\)/);
	assert.ok(registry, "registry array not found in patched output");
	assert.equal(
		/\bdropCmd\b/.test(registry[1]),
		false,
		"security-review element must be removed",
	);
	assert.equal(
		registry[1].includes("inlineCmd"),
		true,
		"inline-object sibling must survive",
	);
	// Load-bearing: verify must return true (registry recognized via the
	// inline-object sibling), not "Built-in command registry not found".
	assert.equal(commandsOff.verify(output, ast), true);
});

test("commands-off post-removal registry recognition does not depend on the removed command", async () => {
	const mixedSurvivorFixture = `
function makeBuiltinCommand({ name: H, description: $ }) {
  return { type: "prompt", name: H, description: $, source: "builtin" };
}
var base, aliasCmd, keepCmd, dropCmd;
function init() {
  (base = { type: "local-jsx", name: "add-dir", description: "Add a new working directory" });
  (aliasCmd = base);
  (keepCmd = makeBuiltinCommand({ name: "review", description: "Review a pull request" }));
  (dropCmd = makeBuiltinCommand({ name: "security-review", description: "Complete a security review" }));
}
const COMMANDS = memoize(() => [aliasCmd, keepCmd, dropCmd]);
`;
	const ast = parse(mixedSurvivorFixture);
	// Pre-removal: verify must already FAIL (definition present + target in registry).
	assert.notEqual(commandsOff.verify(mixedSurvivorFixture, ast), true);
	await runCommandsOffViaPasses(ast);
	const output = print(ast);
	// Post-removal: the security-review definition survives outside the array, so
	// the definition signal stays true; verify must pass via registry recognition
	// plus no leak, exercising the load-bearing branch rather than a
	// fully-absent short-circuit.
	assert.match(
		output,
		/name: "security-review"/,
		"definition statement must survive outside the registry",
	);
	assert.equal(commandsOff.verify(output, ast), true);
});
