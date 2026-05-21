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
function eH(v) { return !!v; }
function gate(name, fallbackValue) { return fallbackValue; }
function settings() { return { autoDreamEnabled: true }; }
function hasDreamRollout() { return false; }

function includePastContext() {
  if (!gate("tengu_coral_fern", !1)) return [];
  return ["ok"];
}

function autoDreamEnabled() {
  if (!hasDreamRollout()) return !1;
  let enabled = settings().autoDreamEnabled;
  if (enabled !== void 0) return enabled;
  return false;
}

if (eH(process.env.DUMMY_ENV)) {}
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

test("session-memory patches memory and auto-dream gates", async () => {
	const ast = parse(SESSION_MEMORY_FIXTURE);
	await runSessionMemoryViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes(
			'if (!eH(process.env.ENABLE_SESSION_MEMORY_PAST) && !gate("tengu_coral_fern", !1)) return [];',
		),
		true,
	);
	assert.equal(output.includes("ENABLE_SESSION_MEMORY_PAST"), true);
	assert.equal(
		output.includes('if (!gate("tengu_coral_fern", !1)) return [];'),
		false,
	);
	assert.match(
		output,
		/settings\(\)\.autoDreamEnabled !== true && !hasDreamRollout\(\)\) return !1;/,
	);
	assert.equal(sessionMemory.verify(output, ast), true);
	assert.equal(sessionMemory.verify(output), true);
});

test("session-memory verify detects old coral-fern return[] guard regression", async () => {
	const ast = parse(SESSION_MEMORY_FIXTURE);
	await runSessionMemoryViaPasses(ast);
	const output = print(ast);

	const patchedGuard =
		'if (!eH(process.env.ENABLE_SESSION_MEMORY_PAST) && !gate("tengu_coral_fern", !1)) return [];';
	assert.equal(output.includes(patchedGuard), true);

	const mutated = output.replace(
		patchedGuard,
		'if (!gate("tengu_coral_fern", !1)) return [];',
	);
	assert.notEqual(mutated, output);

	const result = sessionMemory.verify(mutated);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("Old tengu_coral_fern gate still present"),
		true,
	);
});

test("session-memory verify detects missing past-context env override", async () => {
	const ast = parse(SESSION_MEMORY_FIXTURE);
	await runSessionMemoryViaPasses(ast);
	const output = print(ast);
	const mutated = output.replace(
		"ENABLE_SESSION_MEMORY_PAST",
		"ENABLE_SESSION_MEMORY_PAST_BROKEN",
	);
	assert.notEqual(mutated, output);

	const result = sessionMemory.verify(mutated);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("Missing ENABLE_SESSION_MEMORY_PAST"),
		true,
	);
});

test("session-memory verify detects missing auto-dream local setting gate", async () => {
	const ast = parse(SESSION_MEMORY_FIXTURE);
	await runSessionMemoryViaPasses(ast);
	const output = print(ast);
	const mutated = output.replace(
		/settings\(\)\.autoDreamEnabled !== true && !hasDreamRollout\(\)/,
		"!hasDreamRollout()",
	);
	assert.notEqual(mutated, output);

	const result = sessionMemory.verify(mutated);
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("Missing autoDreamEnabled"), true);
});
