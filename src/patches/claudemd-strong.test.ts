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
  let HH = H.omitClaudeMd && !f?.userContext && Z$("tengu_slim_subagent_claudemd", !0),
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

test("claudemd-strong disables slim subagent CLAUDE.md omission", async () => {
	const ast = parse(SUBAGENT_OMIT_FIXTURE);
	await runClaudeMdStrongViaPasses(ast);
	const output = print(ast);

	assert.equal(output.includes("tengu_slim_subagent_claudemd"), false);
	assert.equal(output.includes("HH = false"), true);

	const verifiedCode = `${STRONG_DISCLAIMER_LINES.join("\n")}\n${output}`;
	assert.equal(claudeMdSystemPrompt.verify(verifiedCode, ast), true);
});

test("claudemd-strong verify rejects slim subagent CLAUDE.md omission", () => {
	const ast = parse(SUBAGENT_OMIT_FIXTURE);
	const result = claudeMdSystemPrompt.verify(
		`${STRONG_DISCLAIMER_LINES.join("\n")}\n${SUBAGENT_OMIT_FIXTURE}`,
		ast,
	);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("Slim subagent CLAUDE.md omission gate"),
		true,
	);
});

test("claudemd-strong disables every slim subagent CLAUDE.md omission gate", async () => {
	const twoGates = `
function a(H, f) {
  let G1 = H.omitClaudeMd && !f?.userContext && Z$("tengu_slim_subagent_claudemd", !0);
  return G1;
}
function b(H, f) {
  let G2 = H.omitClaudeMd && !f?.userContext && Z$("tengu_slim_subagent_claudemd", !0);
  return G2;
}
`;
	const ast = parse(twoGates);
	await runClaudeMdStrongViaPasses(ast);
	const output = print(ast);
	assert.equal(output.includes("tengu_slim_subagent_claudemd"), false);
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
  let G = H.omitClaudeMd && !f?.userContext && Z$("tengu_slim_subagent_claudemd", !0);
  return G;
}
`;
	const ast = parse(withDecoy);
	await runClaudeMdStrongViaPasses(ast);
	const output = print(ast);
	assert.equal(output.includes("omitClaudeMd: !0"), true);
	assert.equal(output.includes("tengu_slim_subagent_claudemd"), false);
});

test("claudemd-strong verify fails when any slim subagent gate survives", () => {
	const oneLive = `
let G1 = false;
let G2 = H.omitClaudeMd && !f?.userContext && Z$("tengu_slim_subagent_claudemd", !0);
`;
	const ast = parse(oneLive);
	const result = claudeMdSystemPrompt.verify(
		`${STRONG_DISCLAIMER_LINES.join("\n")}\n${oneLive}`,
		ast,
	);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("Slim subagent CLAUDE.md omission gate"),
		true,
	);
});
