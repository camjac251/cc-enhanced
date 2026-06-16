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

test("subagent-model-tag matches nested-createElement dimColor and !0 truthy form", async () => {
	const input = `
function renderRows(H) {
  let q = [];
  if (H.model && H.model !== "inherit") {
    let K = current();
    if (K) {
      q.push(C.createElement(P, { key: "model", flexWrap: "nowrap", marginLeft: 1 }, C.createElement(Y, { dimColor: !0 }, label(K))));
    }
  }
}
`;
	const ast = parse(input);
	await runSubagentModelTagViaPasses(ast);
	const output = print(ast);
	assert.equal(
		output.includes(
			'H.model && H.model !== "inherit" && !process.env.CLAUDE_CODE_SUBAGENT_MODEL',
		),
		true,
		"guard must wrap the outer .model-bearing if even when dimColor is nested and written as !0",
	);
	assert.equal(subagentModelTag.verify(output, ast), true);
});

test("subagent-model-tag adds the env guard exactly once", async () => {
	const ast = parse(SUBAGENT_FIXTURE);
	await runSubagentModelTagViaPasses(ast);
	const output = print(ast);
	const occurrences =
		output.split("!process.env.CLAUDE_CODE_SUBAGENT_MODEL").length - 1;
	assert.equal(
		occurrences,
		1,
		`expected exactly one env guard, found ${occurrences}`,
	);
});

test("subagent-model-tag is idempotent on already-guarded code", async () => {
	const ast1 = parse(SUBAGENT_FIXTURE);
	await runSubagentModelTagViaPasses(ast1);
	const once = print(ast1);
	const ast2 = parse(once);
	await runSubagentModelTagViaPasses(ast2);
	const twice = print(ast2);
	const occurrences =
		twice.split("!process.env.CLAUDE_CODE_SUBAGENT_MODEL").length - 1;
	assert.equal(occurrences, 1, "second pass must not add a second guard");
	assert.equal(subagentModelTag.verify(twice, ast2), true);
});

test("subagent-model-tag ignores a key:model push with no dimColor in its element tree", async () => {
	const input = `
function renderRows(H) {
  let q = [];
  if (H.model && H.model !== "inherit") {
    q.push(C.createElement(P, { key: "model", flexWrap: "nowrap" }, C.createElement(Y, null, label(H.model))));
  }
}
`;
	const ast = parse(input);
	await runSubagentModelTagViaPasses(ast);
	const output = print(ast);
	assert.equal(
		output.includes("!process.env.CLAUDE_CODE_SUBAGENT_MODEL"),
		false,
	);
	const verifyResult = subagentModelTag.verify(output, ast);
	assert.equal(typeof verifyResult, "string");
	assert.equal(String(verifyResult).includes("not found"), true);
});
