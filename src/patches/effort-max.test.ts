import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { effortMax } from "./effort-max.js";

async function runEffortMaxViaPasses(ast: any): Promise<void> {
	const passes = (await effortMax.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: effortMax.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

const EFFORT_MAX_FIXTURE = `
function m8() { return !1; }
function L8() { return !1; }

function cli(K, qH, process, w$) {
  if (K.effort === "max" && (!qH || L8())) {
    let S$ = !qH
      ? 'Effort level "max" is not available in interactive mode.'
      : 'Effort level "max" is not available for Claude.ai subscribers.';
    process.stderr.write(w$.red(\`Error: \${S$} Please use "low", "medium", or "high".\`));
    process.exit(1);
  }
}

function picker() {
  return [
    { label: "Use medium effort (recommended)", value: "medium" },
    { label: "Use high effort", value: "high" },
    { label: "Use low effort", value: "low" },
  ];
}

function ghq(H) {
  switch (H) {
    case "low":
      return 1;
    case "medium":
      return 2;
    case "high":
      return 3;
    case "max":
      return 3;
  }
}

var Uhq = 3;
var HELP = "Effort level for the current session (low, medium, high)";

function uM1(H) {
  return [{ type: "ultrathink_effort", level: "high" }];
}

function notify(EL) {
  EL({
    key: "ultrathink-active",
    text: "Effort set to high for this turn",
    priority: "immediate",
    timeoutMs: 5000,
  });
}
`;

test("verify rejects unpatched interactive max-effort code", () => {
	const ast = parse(EFFORT_MAX_FIXTURE);
	const code = print(ast);
	const result = effortMax.verify(code, ast);
	assert.notEqual(result, true);
	assert.equal(typeof result, "string");
});

test("effort-max enables interactive max effort and updates UI affordances", async () => {
	const ast = parse(EFFORT_MAX_FIXTURE);
	await runEffortMaxViaPasses(ast);
	const output = print(ast);

	assert.equal(output.includes('if (false) {'), true);
	assert.equal(output.includes('label: "Use max effort"'), true);
	assert.equal(output.includes('level: "max"'), true);
	assert.equal(output.includes('text: "Effort set to max for this turn"'), true);
	assert.equal(output.includes('case "max"'), true);
	assert.equal(output.includes("return 4;"), true);
	assert.equal(output.includes("var Uhq = 4;"), true);
	assert.equal(
		output.includes(
			'"Effort level for the current session (low, medium, high, max)"',
		),
		true,
	);

	assert.equal(effortMax.verify(output, ast), true);
	assert.equal(effortMax.verify(output), true);
});
