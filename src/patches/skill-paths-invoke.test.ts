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
// return that yields the unconditional bucket. The two reset functions mirror
// the cache reset (no dynamic-skill reference) and the full session reset
// (clears the dynamic-skill map too). Names are semantic so the fixture does
// not double as a hint about upstream variable naming.
const SKILL_PATHS_FIXTURE = `
function resetSkillCaches() {
  loaderMemo.cache?.clear?.(), promptMemo.cache?.clear?.();
  let snapshot = getState();
  if (snapshot) snapshot.conditionalSkills.clear(), snapshot.activatedConditionalSkillNames.clear();
}

function resetAllSkillState() {
  let snapshot = getState();
  if (!snapshot) return;
  snapshot.dynamicSkillDirs.clear(),
    snapshot.dynamicSkills.clear(),
    snapshot.conditionalSkills.clear(),
    snapshot.activatedConditionalSkillNames.clear();
}

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

test("skill-paths-invoke keeps the activation guard across the cache reset only", async () => {
	const ast = parse(SKILL_PATHS_FIXTURE);
	await runSkillPathsInvokeViaPasses(ast);
	const output = print(ast);

	const cacheResetStart = output.indexOf("function resetSkillCaches");
	const fullResetStart = output.indexOf("function resetAllSkillState");
	assert.ok(cacheResetStart >= 0 && fullResetStart > cacheResetStart);
	const cacheReset = output.slice(cacheResetStart, fullResetStart);
	const fullReset = output.slice(fullResetStart);

	// Cache reset still clears the conditional bucket but no longer wipes the
	// activated-names guard; the full session reset keeps both clears.
	assert.equal(cacheReset.includes("conditionalSkills.clear()"), true);
	assert.equal(
		cacheReset.includes("activatedConditionalSkillNames.clear()"),
		false,
	);
	assert.equal(
		fullReset.includes("activatedConditionalSkillNames.clear()"),
		true,
	);
});

test("cache-reset guard removal is idempotent across a double pass", async () => {
	const ast = parse(SKILL_PATHS_FIXTURE);
	await runSkillPathsInvokeViaPasses(ast);
	await runSkillPathsInvokeViaPasses(ast);
	const output = print(ast);

	const cacheReset = output.slice(
		output.indexOf("function resetSkillCaches"),
		output.indexOf("function resetAllSkillState"),
	);
	assert.equal(
		cacheReset.includes("activatedConditionalSkillNames.clear()"),
		false,
	);
	assert.equal(cacheReset.split("conditionalSkills.clear()").length - 1, 1);
	assert.equal(
		output.split("[...unconditional, ...conditional]").length - 1,
		1,
	);
	assert.equal(skillPathsInvoke.verify(output, ast), true);
});

test("verify fails when the cache reset is missing entirely", async () => {
	const ast = parse(SKILL_PATHS_FIXTURE);
	await runSkillPathsInvokeViaPasses(ast);
	const output = print(ast);
	const mutated = output.replace(
		"if (snapshot) snapshot.conditionalSkills.clear();",
		'if (snapshot) snapshot.conditionalSkills.delete("x");',
	);
	assert.notEqual(mutated, output, "fixture mutation should apply");
	assert.equal(
		skillPathsInvoke.verify(mutated),
		"Could not find the conditional-skill cache reset",
	);
});

test("verify fails when the full reset loses its activation-guard clear", async () => {
	const ast = parse(SKILL_PATHS_FIXTURE);
	await runSkillPathsInvokeViaPasses(ast);
	const output = print(ast);
	// After patching, the only remaining guard clear is the full reset's.
	const mutated = output.replace(
		".activatedConditionalSkillNames.clear()",
		".activatedConditionalSkillNames.size",
	);
	assert.notEqual(mutated, output, "fixture mutation should apply");
	assert.equal(
		skillPathsInvoke.verify(mutated),
		"Full skill-state reset no longer clears the conditional-activation guard",
	);
});

test("verify fails when the cache reset still clears the activation guard", async () => {
	const ast = parse(SKILL_PATHS_FIXTURE);
	await runSkillPathsInvokeViaPasses(ast);
	const output = print(ast);
	const mutated = output.replace(
		"if (snapshot) snapshot.conditionalSkills.clear();",
		"if (snapshot) snapshot.conditionalSkills.clear(), snapshot.activatedConditionalSkillNames.clear();",
	);
	assert.notEqual(mutated, output, "fixture mutation should apply");
	assert.equal(
		skillPathsInvoke.verify(mutated),
		"Skill-cache reset still clears the conditional-activation guard",
	);
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
