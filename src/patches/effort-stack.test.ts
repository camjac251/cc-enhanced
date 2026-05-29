import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { effortStack } from "./effort-stack.js";

async function runEffortStackViaPasses(ast: any): Promise<void> {
	const passes = (await effortStack.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: effortStack.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

const EFFORT_STACK_FIXTURE = `
function resolveEffortLevel(H) {
  if (H.settings.ultracode === !0) return "xhigh";
  return H.settings.effortLevel ?? "high";
}

function notify(EL) {
  EL({
    key: "ultrathink-active",
    text: "Deeper reasoning requested for this turn",
    priority: "immediate",
    timeoutMs: 5000,
  });
}
`;

test("verify rejects unpatched ultracode resolver", () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	const code = print(ast);
	const result = effortStack.verify(code, ast);
	assert.notEqual(result, true);
	assert.equal(typeof result, "string");
});

test("effort-stack patches resolver to honor CLAUDE_CODE_EFFORT_LEVEL=max", async () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	await runEffortStackViaPasses(ast);
	const output = print(ast);

	assert.match(
		output,
		/H\.settings\.ultracode === !0 && process\.env\.CLAUDE_CODE_EFFORT_LEVEL !== "max"/,
	);
	assert.equal(
		output.includes('text: "Effort set to max for this turn"'),
		true,
	);
	assert.equal(effortStack.verify(output, ast), true);
});

test("effort-stack is idempotent", async () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	await runEffortStackViaPasses(ast);
	const once = print(ast);
	await runEffortStackViaPasses(ast);
	const twice = print(ast);
	assert.equal(twice, once);
	assert.equal(effortStack.verify(twice), true);
});

test("effort-stack verify rejects regression where env guard is dropped", async () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	await runEffortStackViaPasses(ast);
	const output = print(ast);
	const regressed = output.replace(
		' && process.env.CLAUDE_CODE_EFFORT_LEVEL !== "max"',
		"",
	);

	const result = effortStack.verify(regressed);
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("still ignores"), true);
});

test("effort-stack verify fails closed when anchors are absent", () => {
	const drifted = `
function unrelated() {
  return "no ultracode here";
}
`;
	const ast = parse(drifted);
	const result = effortStack.verify(print(ast), ast);
	assert.equal(typeof result, "string");
});
