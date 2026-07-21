import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import {
	claudeMdSystemPrompt,
	STRONG_DISCLAIMER_LINES,
} from "./claudemd-strong.js";

const WEAK =
	"IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.";
const STRONG =
	"The instructions above are MANDATORY when they apply to your current task. Follow them exactly as written.";
const SUBAGENT_OMIT_FIXTURE = `
function launchSubagent(H, f, r) {
  let HH = H.omitClaudeMd && !f?.userContext,
    { claudeMd: t, ...e } = r,
    fH = HH ? e : r;
  return fH;
}
`;

async function runClaudeMdStrongViaPasses(ast: any): Promise<void> {
	const passes = (await claudeMdSystemPrompt.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: claudeMdSystemPrompt.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

test("claudemd-strong replaces weak disclaimer", () => {
	const input = `prefix\n${WEAK}\nsuffix`;
	const output = claudeMdSystemPrompt.string?.(input) ?? input;
	assert.equal(output.includes(WEAK), false);
	assert.equal(output.includes(STRONG), true);
	assert.equal(claudeMdSystemPrompt.verify(output), true);
});

test("claudemd-strong verify fails when weak disclaimer remains", () => {
	const result = claudeMdSystemPrompt.verify(WEAK);
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("Weak CLAUDE.md disclaimer"), true);
});

test("claudemd-strong verify fails when weak disclaimer is absent but strong markers are missing", () => {
	const input = "no system reminder disclaimer present";
	const result = claudeMdSystemPrompt.verify(input);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("Strong CLAUDE.md disclaimer lines are missing"),
		true,
	);
});

test("claudemd-strong verify accepts the exact shared strong disclaimer lines", () => {
	const input = STRONG_DISCLAIMER_LINES.join("\n");
	assert.equal(claudeMdSystemPrompt.verify(input), true);
});

test("claudemd-strong line checks reject incomplete strong wrapper text", () => {
	const input = STRONG_DISCLAIMER_LINES.slice(0, -1).join("\n");
	const result = claudeMdSystemPrompt.verify(input);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("Strong CLAUDE.md disclaimer lines are missing"),
		true,
	);
});

test("claudemd-strong disables subagent CLAUDE.md omission", async () => {
	const ast = parse(SUBAGENT_OMIT_FIXTURE);
	await runClaudeMdStrongViaPasses(ast);
	const output = print(ast);

	assert.equal(output.includes("omitClaudeMd &&"), false);
	assert.equal(output.includes("HH = false"), true);

	const verifiedCode = `${STRONG_DISCLAIMER_LINES.join("\n")}\n${output}`;
	assert.equal(claudeMdSystemPrompt.verify(verifiedCode, ast), true);
});

test("claudemd-strong verify rejects a surviving subagent CLAUDE.md omission gate", () => {
	const ast = parse(SUBAGENT_OMIT_FIXTURE);
	const result = claudeMdSystemPrompt.verify(
		`${STRONG_DISCLAIMER_LINES.join("\n")}\n${SUBAGENT_OMIT_FIXTURE}`,
		ast,
	);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("Subagent CLAUDE.md omission gate"),
		true,
	);
});

test("claudemd-strong disables every subagent CLAUDE.md omission gate", async () => {
	const twoGates = `
function a(H, f) {
  let G1 = H.omitClaudeMd && !f?.userContext;
  return G1;
}
function b(H, f) {
  let G2 = H.omitClaudeMd && !f?.userContext;
  return G2;
}
`;
	const ast = parse(twoGates);
	await runClaudeMdStrongViaPasses(ast);
	const output = print(ast);
	assert.equal(output.includes("omitClaudeMd &&"), false);
	assert.equal((output.match(/=\s*false/g) ?? []).length >= 2, true);
	assert.equal(
		claudeMdSystemPrompt.verify(
			`${STRONG_DISCLAIMER_LINES.join("\n")}\n${output}`,
			ast,
		),
		true,
	);
});

test("claudemd-strong leaves non-gate omitClaudeMd object properties untouched", async () => {
	const withDecoy = `
let agent = { model: "haiku", omitClaudeMd: !0, getSystemPrompt: () => x() };
function launch(H, f) {
  let G = H.omitClaudeMd && !f?.userContext;
  return G;
}
`;
	const ast = parse(withDecoy);
	await runClaudeMdStrongViaPasses(ast);
	const output = print(ast);
	assert.equal(output.includes("omitClaudeMd: !0"), true);
	assert.equal(output.includes("G = false"), true);
});

test("claudemd-strong verify fails when any subagent gate survives", () => {
	const oneLive = `
let G1 = false;
let G2 = H.omitClaudeMd && !f?.userContext;
`;
	const ast = parse(oneLive);
	const result = claudeMdSystemPrompt.verify(
		`${STRONG_DISCLAIMER_LINES.join("\n")}\n${oneLive}`,
		ast,
	);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("Subagent CLAUDE.md omission gate"),
		true,
	);
});

test("claudemd-strong verify fails when a run neutralizes no gate", async () => {
	const ifGate = `
function launch(H, f) {
  if (H.omitClaudeMd && !f?.userContext) return slim();
  return full();
}
`;
	const ast = parse(ifGate);
	await runClaudeMdStrongViaPasses(ast);
	const output = print(ast);
	// The mutator targets VariableDeclarator-init gates; a bundle whose only
	// gate sits in an if-test yields zero neutralizations and must fail verify
	// loudly instead of shipping the omission behavior live.
	const result = claudeMdSystemPrompt.verify(
		`${STRONG_DISCLAIMER_LINES.join("\n")}\n${output}`,
		ast,
	);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("No subagent CLAUDE.md omission gate"),
		true,
	);
});

test("claudemd-strong neutralizes exactly one gate on the single-gate fixture", async () => {
	const ast = parse(SUBAGENT_OMIT_FIXTURE);
	await runClaudeMdStrongViaPasses(ast);
	const output = print(ast);
	assert.equal((output.match(/=\s*false/g) ?? []).length, 1);
	assert.equal(output.includes("omitClaudeMd &&"), false);
});
