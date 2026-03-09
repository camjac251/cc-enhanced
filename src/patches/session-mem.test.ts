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

function extractionEnabled() {
  return gate("tengu_session_memory", !1);
}

function includePastContextA() {
  if (gate("tengu_coral_fern", !1)) return ["ok"];
  return [];
}

function includePastContextB() {
  if (!gate("tengu_coral_fern", !1)) return [];
  return ["ok"];
}

var U2$ = 2000,
  NBD = 12000,
  OBD = \`# Session Title
_Template_\`;

var NgH = {
  minimumMessageTokensToInit: 10000,
  minimumTokensBetweenUpdate: 5000,
  toolCallsBetweenUpdates: 3,
};

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

test("session-memory patches extraction, coral-fern paths, and env-tunable limits", async () => {
	const ast = parse(SESSION_MEMORY_FIXTURE);
	await runSessionMemoryViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes(
			'return eH(process.env.ENABLE_SESSION_MEMORY) || gate("tengu_session_memory", !1);',
		),
		true,
	);
	assert.equal(output.includes("ENABLE_SESSION_MEMORY_PAST"), true);
	assert.equal(
		output.includes('if (!gate("tengu_coral_fern", !1)) return [];'),
		false,
	);
	assert.equal(output.includes("CC_SM_PER_SECTION_TOKENS"), true);
	assert.equal(output.includes("CC_SM_TOTAL_FILE_LIMIT"), true);
	assert.equal(output.includes("CC_SM_MINIMUM_MESSAGE_TOKENS_TO_INIT"), true);
	assert.equal(output.includes("CC_SM_MINIMUM_TOKENS_BETWEEN_UPDATE"), true);
	assert.equal(output.includes("CC_SM_TOOL_CALLS_BETWEEN_UPDATES"), true);

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
