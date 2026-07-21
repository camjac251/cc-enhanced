import assert from "node:assert/strict";
import { test } from "node:test";
import type * as t from "@babel/types";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { editTool } from "./edit-extended.js";
import { allPatches } from "./index.js";
import { planDiffUi } from "./plan-diff-ui.js";
import { skillActivationNotice } from "./skill-activation-notice.js";
import { skillGlobalPaths } from "./skill-global-paths.js";
import { skillPathsInvoke } from "./skill-paths-invoke.js";

// Combined-engine collision guards. Several patches register visitors for the
// same node kinds in the same `mutate` pass. The combined engine merges them
// into one traversal with no source-order guarantee between sibling handlers,
// so these tests run the colliding patches together through one shared pass and
// assert they do not mutate each other's surfaces.

async function runMutateTogether(
	ast: t.File,
	patches: {
		tag: string;
		astPasses?: (ast: t.File) => Promise<unknown> | unknown;
	}[],
): Promise<void> {
	const entries: { tag: string; pass: unknown }[] = [];
	for (const patch of patches) {
		const passes = (await patch.astPasses?.(ast)) ?? [];
		for (const pass of passes as unknown[]) {
			entries.push({ tag: patch.tag, pass });
		}
	}
	await runCombinedAstPasses(
		ast,
		entries as never,
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

// --- skill triad: shared conditional-skill activation matcher ---
// skill-paths-invoke, skill-global-paths, and skill-activation-notice all mutate
// the conditional-skill subsystem in the same pass (registration order 17/18/19).
// skill-global-paths reshapes the `q.length > 0` emit branch *before*
// skill-activation-notice anchors on it. This fixture models only the shared
// matcher + dynamic_skill producer (the path-scoped loader surface that
// skill-paths-invoke / skill-global-paths also patch is exercised by their own
// tests and by `mise run verify:patches`).
const SKILL_MATCHER_FIXTURE = `
function activate(H, $) {
  if ((state()?.conditionalSkills.size ?? 0) === 0) return [];
  let q = [];
  for (let [K, _] of state().conditionalSkills) {
    if (_.type !== "prompt" || !_.paths || _.paths.length === 0) continue;
    let A = ig.default().add(normalizeGlobs(_.paths, "skill_paths"));
    for (let z of H) {
      let f = pathmod.isAbsolute(z) ? pathmod.relative($, z) : z;
      if (!f || f.startsWith("..")) continue;
      if (A.ignores(f)) {
        state().dynamicSkills.set(K, _), state().conditionalSkills.delete(K), state().activatedConditionalSkillNames.add(K), q.push(K);
        break;
      }
    }
  }
  if (q.length > 0) track("changed", { added: q.length }), emitter.emit();
  return q;
}
async function produce(H) {
  let attachments = [];
  let triggers = H.dynamicSkillDirTriggers;
  if (triggers && triggers.length > 0) {
    for (let dir of triggers) {
      attachments.push({ type: "dynamic_skill", skillDir: dir, skillNames: ["x"], displayPath: dir });
    }
  }
  return attachments;
}
`;

test("skill-global-paths reshaping the matcher does not break the activation notice anchor", async () => {
	const ast = parse(SKILL_MATCHER_FIXTURE);
	// Registration order: skill-paths-invoke, skill-global-paths,
	// skill-activation-notice. global-paths runs before the notice patch.
	await runMutateTogether(ast, [
		skillPathsInvoke,
		skillGlobalPaths,
		skillActivationNotice,
	]);
	const output = print(ast);

	// skill-global-paths reshaped the conditional-skill matcher...
	assert.ok(
		output.includes("_claudeGpIgnore") || output.includes("_claudeGpSplit"),
		"skill-global-paths must reshape the conditional-skill matcher",
	);
	// ...and skill-activation-notice still finds and wraps the emit branch after
	// that reshaping, so the documented collision does not silently make the
	// notice patch miss.
	assert.equal(
		skillActivationNotice.verify(output, parse(output)),
		true,
		"activation notice must still verify after global-paths reshapes the matcher",
	);
	assert.ok(
		output.includes("__ccPathActivations.push("),
		"activation notice record must be injected",
	);
	assert.ok(
		/q\.length > 0[\s\S]{0,500}__ccPathActivations\.push/.test(output),
		"notice record must land inside the q.length>0 emit branch after global-paths reshaping",
	);
});

// --- plan-diff-ui neutralizes Edit's plan-preview guard before edit-extended ---
// plan-diff-ui rewrites `if (f.startsWith(v6())) return "";` to `if (false)
// return "";` in its mutate pass. edit-extended appends the batch/replace_all
// chip to the same Edit renderer at Program.exit of the same pass, so it must
// anchor on the durable `if (!f) return null;` early guard plus the shape of a
// second empty-string guard rather than on the startsWith test that plan-diff-ui
// destroys. This is the one cross-patch cascade that has regressed in practice.
const EDIT_RENDER_FIXTURE = `
function renderEditMessage({ file_path: f }, { verbose: v }) {
  if (!f) return null;
  if (f.startsWith(v6())) return "";
  return v ? f : f.split("/").pop();
}
`;

test("edit-extended still tags the Edit chip after plan-diff-ui rewrites the plan-preview guard", async () => {
	const ast = parse(EDIT_RENDER_FIXTURE);
	// Registration order runs plan-diff-ui's guard rewrite before edit-extended's
	// Program.exit render patch consumes the same function.
	await runMutateTogether(ast, [planDiffUi, editTool]);
	const output = print(ast);

	// plan-diff-ui neutralized the plan-preview guard...
	assert.ok(
		!output.includes('f.startsWith(v6())) return "";'),
		"plan-diff-ui must rewrite the startsWith plan-preview guard",
	);
	// ...and edit-extended still located the renderer and injected its chip
	// helper despite the guard test being gone.
	assert.ok(
		output.includes("_editAppendOpts"),
		"edit-extended must still inject its chip helper into the Edit renderer",
	);
	assert.ok(
		output.includes("_claudeEditEdits") &&
			output.includes("_claudeEditReplaceAll"),
		"edit-extended must still add the batch/replace_all bindings to the renderer param",
	);
});

// --- read-bat rewrites the Read tool object before limits ---
// read-bat statically replaces the Read prompt body (dropping the "reads up to"
// quasi limits keys linesCap on) and mutates the Read tool object; limits then
// rewrites numeric caps on that same object at Program.exit. limits treats
// linesCap as optional precisely because read-bat may have removed its anchor,
// but the numeric caps still depend on read-bat running first. This pins that
// registration order so a barrel reorder cannot silently invert it.
test("read-bat is registered before limits so the Read-tool rewrite order holds", () => {
	const tags = allPatches.map((patch) => patch.tag);
	const readBatIndex = tags.indexOf("read-bat");
	const limitsIndex = tags.indexOf("limits");
	assert.ok(readBatIndex >= 0, "read-bat must be in the patch roster");
	assert.ok(limitsIndex >= 0, "limits must be in the patch roster");
	assert.ok(
		readBatIndex < limitsIndex,
		`read-bat (index ${readBatIndex}) must precede limits (index ${limitsIndex}) so limits sees the post-read-bat Read tool object`,
	);
});
