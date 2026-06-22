import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { sessionMemory } from "./session-mem.js";

async function runSessionMemoryViaPasses(ast: any): Promise<void> {
	const passes = (await sessionMemory.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: sessionMemory.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

const SESSION_MEMORY_FIXTURE = `
function settings() { return { autoDreamEnabled: true }; }
function hasDreamRollout() { return false; }

function autoDreamEnabled() {
  if (!hasDreamRollout()) return !1;
  let enabled = settings().autoDreamEnabled;
  if (enabled !== void 0) return enabled;
  return false;
}
`;

test("verify rejects unpatched code", () => {
	const ast = parse(SESSION_MEMORY_FIXTURE);
	const code = print(ast);
	const result = sessionMemory.verify(code, ast);
	assert.notEqual(
		result,
		true,
		"verify should reject unpatched code but got true",
	);
	assert.equal(typeof result, "string");
});

test("session-memory patches auto-dream availability gate", async () => {
	const ast = parse(SESSION_MEMORY_FIXTURE);
	await runSessionMemoryViaPasses(ast);
	const output = print(ast);

	assert.match(
		output,
		/settings\(\)\.autoDreamEnabled !== true && !hasDreamRollout\(\)\) return !1;/,
	);
	assert.equal(sessionMemory.verify(output, ast), true);
	assert.equal(sessionMemory.verify(output), true);
});

test("session-memory verify detects a gate that lost its force-on prefix", async () => {
	const ast = parse(SESSION_MEMORY_FIXTURE);
	await runSessionMemoryViaPasses(ast);
	const output = print(ast);
	// Strip only the force-on prefix. The gate (and its autoDreamEnabled
	// sibling var-decl) remain, so verify must still locate it and flag it as
	// present-but-not-force-on rather than treating it as absent.
	const mutated = output.replace(
		/settings\(\)\.autoDreamEnabled !== true && !hasDreamRollout\(\)/,
		"!hasDreamRollout()",
	);
	assert.notEqual(mutated, output);

	const result = sessionMemory.verify(mutated);
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("not force-on"), true);
});

test("session-memory patches every auto-dream availability gate, not just the first", async () => {
	const TWO_GATE_FIXTURE = `
function settings() { return { autoDreamEnabled: true }; }
function hasDreamRolloutA() { return false; }
function hasDreamRolloutB() { return false; }
function autoDreamEnabledA() {
  if (!hasDreamRolloutA()) return !1;
  let a = settings().autoDreamEnabled;
  if (a !== void 0) return a;
  return false;
}
function autoDreamEnabledB() {
  if (!hasDreamRolloutB()) return !1;
  let b = settings().autoDreamEnabled;
  if (b !== void 0) return b;
  return false;
}
`;
	const ast = parse(TWO_GATE_FIXTURE);
	await runSessionMemoryViaPasses(ast);
	const output = print(ast);
	const wrapped = output.match(/autoDreamEnabled !== true &&/g) ?? [];
	assert.equal(
		wrapped.length,
		2,
		"both auto-dream gates should be force-on wrapped",
	);
	assert.equal(sessionMemory.verify(output, ast), true);
});

test("session-memory patches gates that return null or use a block-wrapped return", async () => {
	const VARIANT_FIXTURE = `
function settings() { return { autoDreamEnabled: true }; }
function hasDreamRollout() { return false; }
function autoDreamEnabled() {
  if (!hasDreamRollout()) { return null; }
  let enabled = settings().autoDreamEnabled;
  if (enabled !== void 0) return enabled;
  return null;
}
`;
	const ast = parse(VARIANT_FIXTURE);
	await runSessionMemoryViaPasses(ast);
	const output = print(ast);
	assert.match(output, /settings\(\)\.autoDreamEnabled !== true &&/);
	assert.equal(sessionMemory.verify(output, ast), true);
});

test("session-memory mutator is idempotent on an already-patched gate", async () => {
	const ast = parse(SESSION_MEMORY_FIXTURE);
	await runSessionMemoryViaPasses(ast);
	const once = print(ast);
	await runSessionMemoryViaPasses(ast);
	const twice = print(ast);
	const prefixes = twice.match(/autoDreamEnabled !== true &&/g) ?? [];
	assert.equal(prefixes.length, 1, "gate must not be double-wrapped");
	assert.equal(sessionMemory.verify(twice, ast), true);
	assert.equal(once, twice, "second pass must be a no-op");
});

test("session-memory verify ignores autoDreamEnabled outside an if-return gate", () => {
	const NON_GATE_FIXTURE = `
let schema = { autoDreamEnabled: boolField().optional() };
function toggle(on, current) {
  let firstEnable = on && current.autoDreamEnabled === void 0;
  save({ autoDreamEnabled: on });
  return firstEnable;
}
`;
	const ast = parse(NON_GATE_FIXTURE);
	const code = print(ast);
	const result = sessionMemory.verify(code, ast);
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("Missing autoDreamEnabled"), true);
});

test("session-memory does not wrap when a statement separates the guard from the autoDreamEnabled read", async () => {
	const SEPARATED_FIXTURE = `
function settings() { return { autoDreamEnabled: true }; }
function hasDreamRollout() { return false; }
function autoDreamEnabled() {
  if (!hasDreamRollout()) return !1;
  let probe = checkSomething();
  let enabled = settings().autoDreamEnabled;
  if (enabled !== void 0) return enabled;
  return false;
}
`;
	const ast = parse(SEPARATED_FIXTURE);
	await runSessionMemoryViaPasses(ast);
	const output = print(ast);
	const wrapped = output.match(/autoDreamEnabled !== true &&/g) ?? [];
	assert.equal(
		wrapped.length,
		0,
		"separated read must not be detected as the immediate gate sibling",
	);
	assert.equal(typeof sessionMemory.verify(output, ast), "string");
});

test("session-memory wraps a gate that has extra statements after the autoDreamEnabled read", async () => {
	const TRAILING_FIXTURE = `
function settings() { return { autoDreamEnabled: true }; }
function hasDreamRollout() { return false; }
function onyx() { return { enabled: true }; }
function fallback() { return false; }
function autoDreamEnabled() {
  if (!hasDreamRollout()) return !1;
  let enabled = settings().autoDreamEnabled;
  if (enabled !== void 0) return enabled;
  if (onyx()?.enabled === true) return true;
  return fallback();
}
`;
	const ast = parse(TRAILING_FIXTURE);
	await runSessionMemoryViaPasses(ast);
	const output = print(ast);
	assert.match(
		output,
		/settings\(\)\.autoDreamEnabled !== true && !hasDreamRollout\(\)\) return !1;/,
	);
	const wrapped = output.match(/autoDreamEnabled !== true &&/g) ?? [];
	assert.equal(
		wrapped.length,
		1,
		"exactly one wrap even with trailing gate statements",
	);
	assert.equal(sessionMemory.verify(output, ast), true);
});

test("session-memory ignores a bare argumentless return guard preceding an autoDreamEnabled read", () => {
	const BARE_RETURN_FIXTURE = `
function settings() { return { autoDreamEnabled: true }; }
function handler(active) {
  if (!active) return;
  let firstEnable = !active, flag = firstEnable && settings().autoDreamEnabled === void 0;
  save({ autoDreamEnabled: active });
  return flag;
}
`;
	const ast = parse(BARE_RETURN_FIXTURE);
	const code = print(ast);
	const result = sessionMemory.verify(code, ast);
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("Missing autoDreamEnabled"), true);
});
