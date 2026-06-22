import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
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

	// Module-level pending list + seen-set injected.
	assert.ok(output.includes("var __ccPathActivations = []"));
	assert.ok(output.includes("var __ccPathActivationsSeen = new Set()"));
	// Matcher records the activated names + first touched file, deduplicated
	// per (file, sorted skill names).
	assert.ok(output.includes("__ccPathActivations.push("));
	assert.ok(output.includes("names: q.slice()"));
	assert.ok(output.includes("file: H[0]"));
	assert.ok(output.includes("__ccPathActivationsSeen.has("));
	assert.ok(output.includes("__ccPathActivationsSeen.add("));
	assert.ok(output.includes("q.slice().sort().join("));
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
	assert.equal(output.split("var __ccPathActivations = ").length - 1, 1);
	assert.equal(output.split("var __ccPathActivationsSeen = ").length - 1, 1);
});

// Executable variant of the fixture: same structural anchors, with working
// stub collaborators so the patched output can be imported as a module and
// the dedup semantics exercised for real.
const RUNTIME_FIXTURE = `
const _state = {
  conditionalSkills: new Map(),
  dynamicSkills: new Map(),
  activatedConditionalSkillNames: new Set(),
};
function state() { return _state; }
const ig = {
  default() {
    return {
      _globs: [],
      add(globs) { this._globs = globs; return this; },
      ignores(file) {
        return this._globs.some((glob) => file.endsWith(glob.slice(glob.lastIndexOf("."))));
      },
    };
  },
};
const pathmod = {
  isAbsolute(p) { return p.startsWith("/"); },
  relative(base, p) {
    return p.startsWith(base + "/") ? p.slice(base.length + 1) : ".." + p;
  },
};
function track() {}
const emitter = { emit() {} };

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

export { state, activate, produce };
`;

test("runtime dedup: repeat activations of the same file and skill set drain once", async () => {
	const ast = parse(RUNTIME_FIXTURE);
	await runViaPasses(ast);
	const output = print(ast);

	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "skill-activation-runtime-"),
	);
	const modulePath = path.join(tempDir, "patched-activation.mjs");
	try {
		await fs.writeFile(modulePath, output, "utf8");
		const mod = await import(pathToFileURL(modulePath).href);
		const seed = (names: string[]) => {
			for (const name of names) {
				mod.state().conditionalSkills.set(name, {
					name,
					type: "prompt",
					paths: ["**/*.md"],
				});
			}
		};

		// First activation drains one record with both names.
		seed(["beta", "alpha"]);
		assert.deepEqual(mod.activate(["/proj/doc.md"], "/proj"), [
			"beta",
			"alpha",
		]);
		const first = await mod.produce({});
		assert.equal(first.length, 1);
		assert.deepEqual(first[0].skillNames, ["beta", "alpha"]);
		assert.equal(first[0].skillDir, "/proj/doc.md");

		// Re-activation of the same (file, skill set) in a different order is
		// suppressed: the key sorts names before comparing.
		seed(["alpha", "beta"]);
		assert.deepEqual(mod.activate(["/proj/doc.md"], "/proj"), [
			"alpha",
			"beta",
		]);
		assert.equal((await mod.produce({})).length, 0);

		// A distinct skill set from the same file still drains a record.
		seed(["gamma"]);
		assert.deepEqual(mod.activate(["/proj/doc.md"], "/proj"), ["gamma"]);
		assert.equal((await mod.produce({})).length, 1);

		// The same skill set from a different file still drains a record.
		seed(["alpha"]);
		assert.deepEqual(mod.activate(["/proj/other.md"], "/proj"), ["alpha"]);
		assert.equal((await mod.produce({})).length, 1);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("verify fails when the seen-set dedup is removed", async () => {
	const ast = parse(FIXTURE);
	await runViaPasses(ast);
	const output = print(ast);
	const mutated = output
		.replace(/__ccPathActivationsSeen\.has\(/g, "alwaysFalse(")
		.replace(/__ccPathActivationsSeen\.add\(/g, "noop(");
	const result = skillActivationNotice.verify(mutated);
	assert.equal(
		result,
		"activation notices are not deduplicated per file and skill set",
	);
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

test("matcher record is injected inside the conditionalSkills function body", async () => {
	const ast = parse(FIXTURE);
	await runViaPasses(ast);
	const output = print(ast);
	// Isolate the `activate` function body and assert the dedup push lives there,
	// not in some unrelated function the global verify() check would also accept.
	const start = output.indexOf("function activate(");
	assert.notEqual(start, -1);
	const next = output.indexOf("async function produce(", start);
	const activateBody = output.slice(start, next === -1 ? undefined : next);
	assert.ok(activateBody.includes("conditionalSkills"));
	assert.ok(activateBody.includes("__ccPathActivations.push("));
	assert.ok(activateBody.includes("__ccPathActivationsSeen.has("));
});

test("dedup record sits alongside the activation emit in the same branch", async () => {
	const ast = parse(FIXTURE);
	await runViaPasses(ast);
	const output = print(ast);
	// The record-and-emit must be co-located: between the emit() call and the
	// record push there should be no intervening function boundary.
	const emitIdx = output.indexOf("emitter.emit()");
	const pushIdx = output.indexOf("__ccPathActivations.push(");
	assert.notEqual(emitIdx, -1);
	assert.notEqual(pushIdx, -1);
	const between = output.slice(
		Math.min(emitIdx, pushIdx),
		Math.max(emitIdx, pushIdx),
	);
	assert.equal(between.includes("function "), false);
});

test("drained dynamic_skill attachment carries renderer-consumed fields", async () => {
	const ast = parse(FIXTURE);
	await runViaPasses(ast);
	const output = print(ast);
	// Locate the injected drain loop and assert its pushed object uses the field
	// names the upstream renderer reads, so a renderer rename is caught here.
	const drainIdx = output.indexOf("__ccPathActivations.splice(0)");
	assert.notEqual(drainIdx, -1);
	const drainTail = output.slice(drainIdx, drainIdx + 400);
	assert.ok(drainTail.includes('type: "dynamic_skill"'));
	assert.ok(drainTail.includes("skillNames:"));
	assert.ok(drainTail.includes("displayPath:"));
	assert.ok(drainTail.includes(".names"));
	assert.ok(drainTail.includes(".file"));
});

test("matcher wrap targets only the conditionalSkills function among decoys", async () => {
	const ast = parse(
		`
function decoy(H) {
  let q = [];
  for (let z of H) if (z) q.push(z);
  if (q.length > 0) emitter.emit();
  return q;
}
${FIXTURE}`,
	);
	await runViaPasses(ast);
	const output = print(ast);
	// Exactly one record injection, and it is in the real matcher, not the decoy.
	assert.equal(output.split("__ccPathActivations.push(").length - 1, 1);
	const decoyStart = output.indexOf("function decoy(");
	const decoyEnd = output.indexOf("function activate(");
	const decoyBody = output.slice(decoyStart, decoyEnd);
	assert.equal(decoyBody.includes("__ccPathActivations.push("), false);
});

test("dedup key uses NUL separators for injectivity", async () => {
	const ast = parse(FIXTURE);
	await runViaPasses(ast);
	const output = print(ast);
	// The key must separate file/name and join names with a NUL escape, never a
	// comma, so a name containing a comma cannot forge a multi-name key. The
	// generator emits the separator as the escaped text "\\u0000".
	const keyIdx = output.indexOf("q.slice().sort().join(");
	assert.notEqual(keyIdx, -1);
	const keyExpr = output.slice(keyIdx - 80, keyIdx + 40);
	assert.ok(keyExpr.includes("\\u0000"));
});

test("drain targets the dynamic_skill return even with an earlier early-return", async () => {
	const ast = parse(`
async function produce(H) {
  let early = [];
  if (H.bail) return early;
  let attachments = [];
  let triggers = H.dynamicSkillDirTriggers;
  if (triggers && triggers.length > 0) {
    for (let dir of triggers) {
      attachments.push({ type: "dynamic_skill", skillDir: dir, skillNames: ["x"], displayPath: dir });
    }
  }
  return attachments;
}
${FIXTURE.slice(FIXTURE.indexOf("function activate"))}`);
	await runViaPasses(ast);
	const output = print(ast);
	const earlyIdx = output.indexOf("return early");
	const spliceIdx = output.indexOf("__ccPathActivations.splice(0)");
	const attachReturnIdx = output.indexOf("return attachments");
	assert.notEqual(spliceIdx, -1, "drain must be injected");
	assert.ok(spliceIdx > earlyIdx, "drain must not precede the early return");
	assert.ok(
		spliceIdx < attachReturnIdx,
		"drain must precede the attachments return",
	);
});

test("recorded file index targets the matcher first parameter", async () => {
	const ast = parse(FIXTURE);
	await runViaPasses(ast);
	const output = print(ast);
	// activate(H, $) -> first param is H; record must read H[0], not $ or another id.
	assert.ok(
		output.includes("file: H[0]"),
		"record file must be H[0] (first param)",
	);
	assert.equal(
		output.includes("file: $[0]"),
		false,
		"record must not read the cwd param",
	);
});
