import assert from "node:assert/strict";
import { test } from "node:test";
import * as t from "@babel/types";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { traverse } from "../babel.js";
import { parse, print } from "../loader.js";
import { bashOutputTail } from "./bash-tail.js";
import { skillActivationNotice } from "./skill-activation-notice.js";
import { skillGlobalPaths } from "./skill-global-paths.js";
import { skillPathsInvoke } from "./skill-paths-invoke.js";
import { taskOutputExt } from "./taskout-ext.js";

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

// --- bash-tail x taskout-ext: shared mapToolResultToToolResultBlockParam ---
// bash-tail keys on an ObjectPattern first param with `stdout`; taskout-ext on
// an Identifier first param with a `<task_id>`/`<status>` body. Each must mutate
// only its own tool's method.

function findMapToolResultMethod(
	ast: t.File,
	firstParamKind: "ObjectPattern" | "Identifier",
): t.ObjectMethod | null {
	let found: t.ObjectMethod | null = null;
	traverse(ast, {
		ObjectMethod(path) {
			if (found) return;
			if (
				!t.isIdentifier(path.node.key, {
					name: "mapToolResultToToolResultBlockParam",
				})
			) {
				return;
			}
			const first = path.node.params[0];
			if (firstParamKind === "ObjectPattern" && t.isObjectPattern(first)) {
				found = path.node;
			}
			if (firstParamKind === "Identifier" && t.isIdentifier(first)) {
				found = path.node;
			}
		},
	});
	return found;
}

const BASH_AND_TASKOUTPUT_FIXTURE = `
const BashTool = {
  name: "Bash",
  mapToolResultToToolResultBlockParam({ stdout, stderr, interrupted, isImage }, toolUseId) {
    let parts = [];
    if (stdout) parts.push(stdout);
    if (stderr) parts.push(stderr);
    return { tool_use_id: toolUseId, type: "tool_result", content: parts.join("\\n") };
  },
};

const TaskOutputTool = {
  name: "TaskOutput",
  mapToolResultToToolResultBlockParam(result, toolUseId) {
    let blocks = [];
    if (result.task) {
      blocks.push(\`<task_id>\${result.task.id}</task_id>\`);
      blocks.push(\`<status>\${result.task.status}</status>\`);
      if (result.task.error) blocks.push(\`<error>\${result.task.error}</error>\`);
      blocks.push(\`<output>\${result.task.output}</output>\`);
    }
    return { tool_use_id: toolUseId, type: "tool_result", content: blocks };
  },
};
`;

test("bash-tail and taskout-ext do not cross-mutate the shared mapToolResult method", async () => {
	const ast = parse(BASH_AND_TASKOUTPUT_FIXTURE);
	await runMutateTogether(ast, [bashOutputTail, taskOutputExt]);

	const bashMethod = findMapToolResultMethod(ast, "ObjectPattern");
	const taskMethod = findMapToolResultMethod(ast, "Identifier");
	assert.ok(
		bashMethod,
		"Bash mapToolResult method (ObjectPattern param) missing",
	);
	assert.ok(
		taskMethod,
		"TaskOutput mapToolResult method (Identifier param) missing",
	);

	const bashBody = JSON.stringify(bashMethod.body);
	const taskBody = JSON.stringify(taskMethod.body);

	// taskout-ext must not touch the Bash method; bash-tail adds outputTail to
	// the Bash destructuring only.
	assert.equal(
		bashBody.includes("output_file"),
		false,
		"taskout-ext must not inject <output_file> into the Bash method",
	);
	const bashParam = bashMethod.params[0];
	assert.ok(t.isObjectPattern(bashParam));
	const bashParamKeys = bashParam.properties
		.filter((p): p is t.ObjectProperty => t.isObjectProperty(p))
		.map((p) => (t.isIdentifier(p.key) ? p.key.name : null));
	assert.equal(
		bashParamKeys.includes("outputTail"),
		true,
		"bash-tail must add outputTail to the Bash method destructuring",
	);

	// bash-tail must not touch the TaskOutput method; taskout-ext adds the tags
	// there and leaves its Identifier param intact.
	assert.equal(
		taskBody.includes("<output_file>"),
		true,
		"taskout-ext must inject <output_file> into the TaskOutput method",
	);
	assert.equal(
		taskBody.includes("<output_filename>"),
		true,
		"taskout-ext must inject <output_filename> into the TaskOutput method",
	);
	assert.equal(
		t.isIdentifier(taskMethod.params[0]),
		true,
		"TaskOutput method first param must remain an Identifier (bash-tail must not destructure it)",
	);
});

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
    let A = ig.default().add(_.paths);
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
