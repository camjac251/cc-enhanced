import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { skillActivationNotice } from "./skill-activation-notice.js";

async function runViaPasses(ast: any): Promise<void> {
	const passes = (await skillActivationNotice.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: skillActivationNotice.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

// Synthetic fixture mirroring the two upstream shapes the patch anchors on:
//   - the conditional-skill activation matcher: a function whose first param is
//     the touched files, with a `for...of` over conditionalSkills and a trailing
//     `if (q.length > 0)` branch that emits a change event;
//   - the dynamic_skill attachment producer: builds an array, pushes a
//     `{ type: "dynamic_skill", ... }` object, returns the array.
const FIXTURE = `
function activate(H, $) {
  if ((state()?.conditionalSkills.size ?? 0) === 0) return [];
  let q = [];
  for (let [K, _] of state().conditionalSkills) {
    if (_.type !== "prompt" || !_.paths || _.paths.length === 0) continue;
    let A = ig.default().add(_.paths);
    for (let z of H) {
      let f = pathmod.isAbsolute(z) ? pathmod.relative($, z) : z;
      if (!f || f.startsWith("..")) continue;
      if (A.ignores(f)) {
        state().dynamicSkills.set(K, _),
          state().conditionalSkills.delete(K),
          state().activatedConditionalSkillNames.add(K),
          q.push(K);
        break;
      }
    }
  }
  if (q.length > 0)
    track("changed", { added: q.length }), emitter.emit();
  return q;
}

async function produce(H) {
  let attachments = [];
  let triggers = H.dynamicSkillDirTriggers;
  if (triggers && triggers.length > 0) {
    for (let dir of triggers) {
      attachments.push({
        type: "dynamic_skill",
        skillDir: dir,
        skillNames: ["x"],
        displayPath: dir,
      });
    }
  }
  return attachments;
}
`;

test("skill-activation-notice tag matches registration name", () => {
	assert.equal(skillActivationNotice.tag, "skill-activation-notice");
});

test("verify rejects unpatched code", () => {
	const ast = parse(FIXTURE);
	const result = skillActivationNotice.verify(print(ast), ast);
	assert.equal(typeof result, "string");
});

test("patch injects state, records activations, drains into producer, verifies", async () => {
	const ast = parse(FIXTURE);
	await runViaPasses(ast);
	const output = print(ast);

	// Module-level pending list injected.
	assert.ok(output.includes("var __ccPathActivations = []"));
	// Matcher records the activated names + first touched file.
	assert.ok(output.includes("__ccPathActivations.push("));
	assert.ok(output.includes("names: q.slice()"));
	assert.ok(output.includes("file: H[0]"));
	// Producer drains the pending list into dynamic_skill attachments.
	assert.ok(output.includes("__ccPathActivations.splice(0)"));
	assert.ok(output.includes('type: "dynamic_skill"'));

	assert.equal(skillActivationNotice.verify(output, ast), true);
});

test("idempotent: re-running does not double-wrap", async () => {
	const ast = parse(FIXTURE);
	await runViaPasses(ast);
	await runViaPasses(ast);
	const output = print(ast);
	assert.equal(output.split("__ccPathActivations.push(").length - 1, 1);
	assert.equal(output.split("__ccPathActivations.splice(0)").length - 1, 1);
});

test("does not touch a matcher with no conditionalSkills loop", async () => {
	const ast = parse(`
function unrelated(H) {
  let q = [];
  for (let z of H) if (z) q.push(z);
  if (q.length > 0) emitter.emit();
  return q;
}
`);
	await runViaPasses(ast);
	const output = print(ast);
	assert.equal(output.includes("__ccPathActivations.push("), false);
});

test("does not touch a producer with no dynamic_skill attachment", async () => {
	const ast = parse(`
function other(H) {
  let out = [];
  out.push({ type: "file", path: "x" });
  return out;
}
`);
	await runViaPasses(ast);
	const output = print(ast);
	assert.equal(output.includes("__ccPathActivations.splice(0)"), false);
});
