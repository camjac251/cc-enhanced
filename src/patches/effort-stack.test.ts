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

function pickUltracode() {
  return {
    message: \`CLAUDE_CODE_EFFORT_LEVEL=\${process.env.CLAUDE_CODE_EFFORT_LEVEL} overrides effort this session — clear it and ultracode takes over\`,
    effortUpdate: { value: "xhigh", ultracode: !0 },
  };
}

function pickEffort(H) {
  let Y = process.env.CLAUDE_CODE_EFFORT_LEVEL;
  return {
    message: \`CLAUDE_CODE_EFFORT_LEVEL=\${Y} overrides this session — clear it and \${labelFor(H)} takes over\`,
    effortUpdate: { value: H, ultracode: !1 },
  };
}

function currentEffort(H, $, q) {
  if (isUltracodeActive($, H, q))
    return {
      message: "Current effort level: ultracode (xhigh + dynamic workflow orchestration; this session only)",
    };
  return { message: "Effort level: auto" };
}

function describeOption(H, $ = !1) {
  if (!H) return;
  if ($) return \`\${ULTRACODE_ICON} ultracode · xhigh effort + dynamic workflows for maximum thoroughness\`;
  return \`option: \${H}\`;
}
`;

test("verify rejects unpatched fixture", () => {
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
});

test("effort-stack rewrites the ultrathink notification text", async () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	await runEffortStackViaPasses(ast);
	const output = print(ast);
	assert.equal(
		output.includes('text: "Effort set to max for this turn"'),
		true,
	);
});

test("effort-stack rewrites BYz override warning into a stacked-state message", async () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	await runEffortStackViaPasses(ast);
	const output = print(ast);
	assert.equal(
		output.includes(
			"Ultracode active. Effort stays at ${process.env.CLAUDE_CODE_EFFORT_LEVEL} via env (stacked); workflow guidance is armed for this session.",
		),
		true,
	);
	assert.equal(
		output.includes("overrides effort this session"),
		false,
		"legacy BYz warning text should be gone",
	);
});

test("effort-stack rewrites uYz override warning into an honest 'still wins' message", async () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	await runEffortStackViaPasses(ast);
	const output = print(ast);
	assert.equal(
		output.includes(
			"CLAUDE_CODE_EFFORT_LEVEL=${Y} still wins this session. Stored ${labelFor(H)} for next session (clear the env var to drop the override).",
		),
		true,
	);
	assert.equal(
		output.includes(" overrides this session "),
		false,
		"legacy uYz warning text should be gone",
	);
});

test("effort-stack prepends env-stacking branch to current-effort display", async () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	await runEffortStackViaPasses(ast);
	const output = print(ast);
	assert.match(
		output,
		/if \(q === true && process\.env\.CLAUDE_CODE_EFFORT_LEVEL === "max"\)\s+return \{\s+message: "Current effort level: max effort \+ ultracode workflows \(env-stacked, this session only\)"/,
	);
});

test("effort-stack wraps ultracode description in env-aware conditional", async () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	await runEffortStackViaPasses(ast);
	const output = print(ast);
	assert.equal(
		output.includes(
			'process.env.CLAUDE_CODE_EFFORT_LEVEL === "max" ? `${ULTRACODE_ICON} ultracode · max effort + dynamic workflows for maximum thoroughness` : `${ULTRACODE_ICON} ultracode · xhigh effort + dynamic workflows for maximum thoroughness`',
		),
		true,
	);
});

test("effort-stack full pipeline verifies clean", async () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	await runEffortStackViaPasses(ast);
	const output = print(ast);
	assert.equal(effortStack.verify(output, ast), true);
});

test("effort-stack is idempotent across all mutations", async () => {
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

test("effort-stack verify rejects regression where BYz reverts", async () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	await runEffortStackViaPasses(ast);
	const output = print(ast);
	const regressed = output.replace(
		"Ultracode active. Effort stays at ${process.env.CLAUDE_CODE_EFFORT_LEVEL} via env (stacked); workflow guidance is armed for this session.",
		`CLAUDE_CODE_EFFORT_LEVEL=\${process.env.CLAUDE_CODE_EFFORT_LEVEL} overrides effort this session — clear it and ultracode takes over`,
	);
	const result = effortStack.verify(regressed);
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("misleading"), true);
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
