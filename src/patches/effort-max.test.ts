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
function A6H(H, key) {
  return undefined;
}

function Vu(value) {
  return false;
}

function Hj(value) {
  return value;
}

function normalizeModel(H) {
  let $ = H.toLowerCase(),
    q = $.match(/claude-[a-z0-9-]+/),
    K = q ? q[0] : $;
  return ((K = K.replace(/-v\\d+(:\\d+)?$/, "")), (K = K.replace(/-\\d{8}$/, "")), K);
}

const BLOCKED_MODELS = new Set([
  "claude-3-opus",
  "claude-3-sonnet",
  "claude-3-5-sonnet",
  "claude-3-7-sonnet",
  "claude-sonnet-4",
  "claude-sonnet-4-0",
  "claude-sonnet-4-5",
  "claude-opus-4",
  "claude-opus-4-0",
  "claude-opus-4-1",
  "claude-opus-4-5",
]);

const ZfH = ["low", "medium", "high", "max"];

const picker = [
  { value: "low", color: "warning" },
  { value: "medium", color: "success" },
  { value: "high", color: "permission" },
  { value: "xhigh", color: "autoAccept-shimmer" },
  { value: "max", color: "rainbow-animated" },
];

function znH(H) {
  let $ = A6H(H, "max_effort");
  if ($ !== void 0) return $;
  if (H.toLowerCase().includes("haiku")) return !1;
  return !BLOCKED_MODELS.has(normalizeModel(H));
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
  return [{ type: "ultrathink_effort" }];
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
	assert.equal(
		output.includes('text: "Effort set to max for this turn"'),
		true,
	);

	assert.equal(effortMax.verify(output, ast), true);
	assert.equal(effortMax.verify(output), true);
});

test("effort-max matches the current denylist gate structurally", async () => {
	const structuralFixture = `
function lookup(modelId, key) {
  return undefined;
}
function normalize(modelId) {
  let lowered = modelId.toLowerCase(),
    match = lowered.match(/claude-[a-z0-9-]+/),
    normalized = match ? match[0] : lowered;
  return (
    (normalized = normalized.replace(/-v\\d+(:\\d+)?$/, "")),
    (normalized = normalized.replace(/-\\d{8}$/, "")),
    normalized
  );
}
const blockedModels = new Set(["claude-opus-4-5"]);
function OCH(ModelId) {
  let configured = lookup(ModelId, "max_effort");
  if (configured !== void 0) return configured;
  if (ModelId.toLowerCase().includes("haiku")) return !1;
  return !blockedModels.has(normalize(ModelId));
}
const picker = [
  { value: "low", color: "warning" },
  { value: "medium", color: "success" },
  { value: "high", color: "permission" },
  { value: "xhigh", color: "autoAccept-shimmer" },
  { value: "max", color: "rainbow-animated" },
];
function Ex1() {
  return [{ type: "ultrathink_effort" }];
}
function notify(EL) {
  EL({ key: "ultrathink-active", text: "Effort set to high for this turn" });
}
`;
	const ast = parse(structuralFixture);
	await runEffortMaxViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes('toLowerCase().includes("haiku")'),
		false,
	);
	assert.equal(output.includes(".has(normalize(ModelId))"), false);
	assert.equal(output.includes("return true;"), true);
	assert.equal(output.includes('value: "max"'), true);
	assert.equal(effortMax.verify(output, ast), true);
});
