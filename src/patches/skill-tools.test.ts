import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { skillAllowedTools } from "./skill-tools.js";

async function runSkillAllowedToolsViaPasses(ast: any): Promise<void> {
	const passes = (await skillAllowedTools.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: skillAllowedTools.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

async function applyPatch(
	input: string,
): Promise<{ output: string; ast: any }> {
	const stringPatched = skillAllowedTools.string?.(input) ?? input;
	const ast = parse(stringPatched);
	await runSkillAllowedToolsViaPasses(ast);
	return { output: print(ast), ast };
}

test("skill-tools rewrites matcher docs to Agent and strips forbidden tools", async () => {
	const input = `
const docs = "**Common tool matchers:** \\\`Bash\\\`, \\\`Write\\\`, \\\`Edit\\\`, \\\`Read\\\`, \\\`Glob\\\`, \\\`Grep\\\`";
const webfetchHeader = "## When to Use WebFetch";
const skill = {
  name: "claude-api",
  allowedTools: ["Read", "Grep", "Glob", "WebFetch"],
  filePatternTools: ["Read", "Glob", "Grep"]
};
`;
	const { output, ast } = await applyPatch(input);

	assert.match(output, /\*\*Common tool matchers:\*\*[^\n"]*Agent/);
	assert.doesNotMatch(output, /\*\*Common tool matchers:\*\*[^\n"]*Task/);
	assert.doesNotMatch(output, /\*\*Common tool matchers:\*\*[^\n"]*Glob/);
	assert.doesNotMatch(output, /\*\*Common tool matchers:\*\*[^\n"]*Grep/);
	assert.equal(output.includes("## When to Use WebFetch"), false);
	assert.equal(output.includes("## When to Fetch Live Documentation"), true);
	assert.equal(output.includes('allowedTools: ["Read", "Bash"]'), true);
	assert.equal(output.includes('filePatternTools: ["Read"]'), true);
	assert.equal(skillAllowedTools.verify(output, ast), true);
});

test("skill-tools does not carry forward legacy Task matcher text", async () => {
	const input = `
const docs = "**Common tool matchers:** \\\`Bash\\\`, \\\`Write\\\`, \\\`Edit\\\`, \\\`Read\\\`, \\\`Task\\\`";
const skill = { filePatternTools: ["Read"] };
`;
	const { output, ast } = await applyPatch(input);

	assert.match(output, /\*\*Common tool matchers:\*\*[^\n"]*Task/);
	const result = skillAllowedTools.verify(output, ast);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("missing Agent in common tool matchers line"),
		true,
	);
});

test("skill-tools verify fails when markers exist but string coverage is too low", async () => {
	const input = `
const docs = "allowed-tools:\\n  - Read";
const skill = { filePatternTools: ["Read"] };
`;
	const { output, ast } = await applyPatch(input);
	const result = skillAllowedTools.verify(output, ast);
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("verification exercised only"), true);
});
