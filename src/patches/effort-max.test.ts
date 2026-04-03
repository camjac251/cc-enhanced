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
function O8H(H, key) {
  return undefined;
}

const ZfH = ["low", "medium", "high", "max"];

function picker() {
  return [
    { label: createElement(QoA, { level: "medium", text: "Medium (recommended)" }), value: "medium" },
    { label: createElement(QoA, { level: "high", text: "High" }), value: "high" },
    { label: createElement(QoA, { level: "low", text: "Low" }), value: "low" },
  ];
}

function znH(H) {
  let $ = O8H(H, "max_effort");
  if ($ !== void 0) return $;
  if (H.toLowerCase().includes("opus-4-6")) return true;
  return false;
}

function describeModel(QH) {
  return {
    supportedEffortLevels: znH(QH) ? [...ZfH] : ZfH.filter((iH) => iH !== "max"),
  };
}

function cliHelp() {
  return "Effort level for the current session (low, medium, high, max)";
}

function Ex1() {
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

test("verify rejects unpatched current max-effort code", () => {
	const ast = parse(EFFORT_MAX_FIXTURE);
	const code = print(ast);
	const result = effortMax.verify(code, ast);
	assert.notEqual(result, true);
	assert.equal(typeof result, "string");
});

test("effort-max patches the current gate, picker, and ultrathink affordances", async () => {
	const ast = parse(EFFORT_MAX_FIXTURE);
	await runEffortMaxViaPasses(ast);
	const output = print(ast);

	assert.equal(output.includes("return true;"), true);
	assert.equal(output.includes('value: "max"'), true);
	assert.equal(output.includes('level: "max"'), true);
	assert.equal(
		output.includes('text: "Effort set to max for this turn"'),
		true,
	);

	assert.equal(effortMax.verify(output, ast), true);
	assert.equal(effortMax.verify(output), true);
});

test("effort-max matches the current server-flag-prefixed gate structurally", async () => {
	const structuralFixture = `
function lookup(modelId, key) {
  return undefined;
}
function OCH(ModelId) {
  let configured = lookup(ModelId, "max_effort");
  if (configured !== void 0) return configured;
  if (ModelId.toLowerCase().includes("opus-4-6")) return true;
  return false;
}
const picker = () => [
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
  { label: "Low", value: "low" },
];
function Ex1() {
  return [{ type: "ultrathink_effort", level: "high" }];
}
function notify(EL) {
  EL({ key: "ultrathink-active", text: "Effort set to high for this turn" });
}
`;
	const ast = parse(structuralFixture);
	await runEffortMaxViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes('ModelId.toLowerCase().includes("opus-4-6")'),
		false,
	);
	assert.equal(output.includes("return true;"), true);
	assert.equal(output.includes('value: "max"'), true);
	assert.equal(effortMax.verify(output, ast), true);
});
