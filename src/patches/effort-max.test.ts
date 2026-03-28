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
function wS(H) {
  return H.includes("sonnet-4-6") || H.includes("opus-4-6");
}

function DSH(H) {
  return H.toLowerCase().includes("opus-4-6");
}

const ZfH = ["low", "medium", "high", "max"];

function picker() {
  return [
    { label: createElement(QoA, { level: "medium", text: "Medium (recommended)" }), value: "medium" },
    { label: createElement(QoA, { level: "high", text: "High" }), value: "high" },
    { label: createElement(QoA, { level: "low", text: "Low" }), value: "low" },
  ];
}

function describeModel(QH) {
  return {
    supportedEffortLevels: DSH(QH) ? [...ZfH] : ZfH.filter((iH) => iH !== "max"),
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

test("verify rejects unpatched 2.1.72-style max-effort code", () => {
	const ast = parse(EFFORT_MAX_FIXTURE);
	const code = print(ast);
	const result = effortMax.verify(code, ast);
	assert.notEqual(result, true);
	assert.equal(typeof result, "string");
});

test("effort-max patches the 2.1.72-style gate, picker, and ultrathink affordances", async () => {
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

test("effort-max matcher handles expression-bodied gate functions structurally", async () => {
	const structuralFixture = `
const DSH = (ModelId) => ModelId.toLowerCase().includes("opus-4-6");
function wS(H) {
  return H.includes("sonnet-4-6") || H.includes("opus-4-6");
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

test("effort-max patches helper gates that use if-return true/false blocks", async () => {
	const blockGateFixture = `
function wS(H) {
  return H.includes("sonnet-4-6") || H.includes("opus-4-6");
}
function OCH(H) {
  if (H.toLowerCase().includes("opus-4-6")) return true;
  return false;
}
function WfH(H, level) {
  if (level === "max" && !OCH(H)) return "high";
  return level;
}
const picker = () => [
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
  { label: "Low", value: "low" },
  { label: "Max", value: "max" },
];
function Ex1() {
  return [{ type: "ultrathink_effort", level: "high" }];
}
function notify(EL) {
  EL({ key: "ultrathink-active", text: "Effort set to high for this turn" });
}
`;
	const ast = parse(blockGateFixture);
	await runEffortMaxViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes('if (H.toLowerCase().includes("opus-4-6"))'),
		false,
	);
	assert.equal(output.includes("return true;"), true);
	assert.equal(output.includes('level: "max"'), true);
	assert.equal(
		output.includes('text: "Effort set to max for this turn"'),
		true,
	);
	assert.equal(effortMax.verify(output, ast), true);
});
