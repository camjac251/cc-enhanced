import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { skillPathsInvoke } from "./skill-paths-invoke.js";

async function runSkillPathsInvokeViaPasses(ast: any): Promise<void> {
	const passes = (await skillPathsInvoke.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: skillPathsInvoke.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

// Synthetic loader that mirrors the structural shape the patch anchors on:
// a function logging the "conditional skills stored ..." fragment, an
// if/else that splits entries by .paths into two push buckets, and a final
// return that yields the unconditional bucket. Names are semantic so the
// fixture does not double as a hint about upstream variable naming.
const SKILL_PATHS_FIXTURE = `
function loadSkills() {
  let discovered = discoverSkills();
  let unconditional = [],
    conditional = [];
  for (let entry of discovered)
    if (
      entry.type === "prompt" &&
      entry.paths &&
      entry.paths.length > 0 &&
      !state.activatedConditionalSkillNames.has(entry.name)
    )
      conditional.push(entry);
    else unconditional.push(entry);
  for (let entry of conditional) state.conditionalSkills.set(entry.name, entry);
  if (conditional.length > 0)
    log(
      \`[skills] \${conditional.length} conditional skills stored (activated when matching files are touched)\`,
    );
  return (
    log(
      \`Loaded \${discovered.length} unique skills (\${unconditional.length} unconditional, \${conditional.length} conditional)\`,
    ),
    unconditional
  );
}
`;

test("skill-paths-invoke tag matches registration name", () => {
	assert.equal(skillPathsInvoke.tag, "skill-paths-invoke");
});

test("verify rejects unpatched path-scoped skill loader", () => {
	const ast = parse(SKILL_PATHS_FIXTURE);
	const code = print(ast);
	const result = skillPathsInvoke.verify(code, ast);
	assert.notEqual(result, true, "verify should reject unpatched code");
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("still returns only unconditional skills"),
		true,
	);
});

test("skill-paths-invoke returns unconditional and path-scoped skills", async () => {
	const ast = parse(SKILL_PATHS_FIXTURE);
	await runSkillPathsInvokeViaPasses(ast);
	const output = print(ast);

	assert.equal(output.includes("[...unconditional, ...conditional]"), true);
	assert.equal(skillPathsInvoke.verify(output, ast), true);
});

test("skill-paths-invoke leaves unrelated path buckets unchanged", async () => {
	const ast = parse(`
function unrelated() {
  let unconditional = [], conditional = [];
  for (let entry of discover())
    if (entry.paths && entry.paths.length > 0) conditional.push(entry);
    else unconditional.push(entry);
  return unconditional;
}
`);
	await runSkillPathsInvokeViaPasses(ast);
	const output = print(ast);

	assert.equal(output.includes("[...unconditional, ...conditional]"), false);
	assert.equal(
		skillPathsInvoke.verify(output),
		"Could not find the path-scoped skill loader",
	);
});
