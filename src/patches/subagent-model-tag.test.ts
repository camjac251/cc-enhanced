import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { subagentModelTag } from "./subagent-model-tag.js";

async function runSubagentModelTagViaPasses(ast: any): Promise<void> {
	const passes = (await subagentModelTag.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: subagentModelTag.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

const SUBAGENT_FIXTURE = `
function renderRows(entry, rows) {
  if (entry.model) {
    rows.push(renderRow({ key: "model", dimColor: true, value: formatModel(entry.model) }));
  }
}
`;

test("verify rejects unpatched code", () => {
	const ast = parse(SUBAGENT_FIXTURE);
	const code = print(ast);
	const result = subagentModelTag.verify(code, ast);
	assert.notEqual(
		result,
		true,
		"verify should reject unpatched code but got true",
	);
	assert.equal(typeof result, "string");
});

test("subagent-model-tag patches unique Agent model branch", async () => {
	const input = SUBAGENT_FIXTURE;
	const ast = parse(input);
	await runSubagentModelTagViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes("&& !process.env.CLAUDE_CODE_SUBAGENT_MODEL"),
		true,
	);
	assert.equal(subagentModelTag.verify(output, ast), true);
});

test("subagent-model-tag fails closed on ambiguous Agent model branches", async () => {
	const input = `
function renderRows(entry, rows) {
  if (entry.model) {
    rows.push(renderRow({ key: "model", dimColor: true, value: formatModel(entry.model) }));
  }
  if (entry.model) {
    rows.push(renderRow({ key: "model", dimColor: true, value: formatModel(entry.model) }));
  }
}
`;
	const ast = parse(input);
	await runSubagentModelTagViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes("&& !process.env.CLAUDE_CODE_SUBAGENT_MODEL"),
		false,
	);
	const verifyResult = subagentModelTag.verify(output, ast);
	assert.equal(typeof verifyResult, "string");
	assert.equal(String(verifyResult).includes("ambiguous"), true);
});

test("subagent-model-tag patches modern model-row branch without Task label", async () => {
	const input = `
function renderRows(entry, rows) {
  if (entry.model) {
    let A = normalizeModel(entry.model), L = currentModel();
    if (A !== L) {
      rows.push(renderRow({ key: "model", dimColor: true, value: formatModel(A) }));
    }
  }
}
`;
	const ast = parse(input);
	await runSubagentModelTagViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes("entry.model && !process.env.CLAUDE_CODE_SUBAGENT_MODEL"),
		true,
	);
	assert.equal(subagentModelTag.verify(output, ast), true);
});

test("subagent-model-tag ignores legacy Task-label-only model rows", async () => {
	const input = `
function renderRows(entry, rows) {
  if (entry.model) {
    rows.push(renderRow({ key: "model", label: "Task", value: formatModel(entry.model) }));
  }
}
`;
	const ast = parse(input);
	await runSubagentModelTagViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes("&& !process.env.CLAUDE_CODE_SUBAGENT_MODEL"),
		false,
	);
	const verifyResult = subagentModelTag.verify(output, ast);
	assert.equal(typeof verifyResult, "string");
	assert.equal(String(verifyResult).includes("not found"), true);
});

test("subagent-model-tag ignores local CLAUDE_CODE_SUBAGENT_MODEL identifiers", async () => {
	const input = `
function renderRows(entry, rows) {
  const CLAUDE_CODE_SUBAGENT_MODEL = false;
  if (entry.model && !CLAUDE_CODE_SUBAGENT_MODEL) {
    rows.push(renderRow({ key: "model", dimColor: true, value: formatModel(entry.model) }));
  }
}
`;
	const ast = parse(input);
	await runSubagentModelTagViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes("&& !process.env.CLAUDE_CODE_SUBAGENT_MODEL"),
		true,
	);
	assert.equal(subagentModelTag.verify(output, ast), true);
});
