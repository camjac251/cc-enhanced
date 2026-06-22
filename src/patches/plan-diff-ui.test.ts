import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { planDiffUi } from "./plan-diff-ui.js";

async function runPlanDiffUiViaPasses(ast: any): Promise<void> {
	const passes = (await planDiffUi.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: planDiffUi.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

const PLAN_DIFF_FIXTURE = `
function v6() {
  return "/tmp/.claude/plans";
}

function ES$(H) {
  if (!H) return "Update";
  if (H.file_path?.startsWith(v6())) return "Updated plan";
  if (H.old_string === "") return "Create";
  return "Update";
}

function SyD(H) {
  if (H?.file_path?.startsWith(v6())) return "Updated plan";
  return "Write";
}

function f$D(H) {
  if (H?.file_path?.startsWith(v6())) return "Reading Plan";
  return "Read";
}

function PyD({ file_path: H }, { verbose: $ }) {
  if (!H) return null;
  if (H.startsWith(v6())) return "";
  return dM.createElement(oZ, { filePath: H }, $ ? H : I1(H));
}

function jyD(H, { verbose: $ }) {
  if (!H.file_path) return null;
  if (H.file_path.startsWith(v6())) return "";
  return a0.createElement(oZ, { filePath: H.file_path }, $ ? H.file_path : I1(H.file_path));
}

function YyD({ filePath: H, structuredPatch: $, originalFile: A }, L, { style: I, verbose: D }) {
  let B = H.startsWith(v6());
  return dM.createElement(BS$, {
    filePath: H,
    structuredPatch: $,
    firstLine: A.split("\\n")[0] ?? null,
    fileContent: A,
    style: I,
    verbose: D,
    previewHint: B ? "/plan to preview" : void 0,
  });
}

function hyD(
  { filePath: H, content: $, structuredPatch: A, type: L, originalFile: I },
  D,
  { style: B, verbose: f },
) {
  switch (L) {
    case "create": {
      if (H.startsWith(v6()) && !f) {
        if (B !== "condensed")
          return a0.createElement(
            QA,
            null,
            a0.createElement(V, { dimColor: !0 }, "/plan to preview"),
          );
      } else if (B === "condensed" && !f) {
        return a0.createElement(V, null, "condensed write summary");
      }
      return a0.createElement(S69, { filePath: H, content: $, verbose: f });
    }
    case "update": {
      let E = H.startsWith(v6());
      return a0.createElement(BS$, {
        filePath: H,
        structuredPatch: A,
        firstLine: $.split("\\n")[0] ?? null,
        fileContent: I ?? void 0,
        style: B,
        verbose: f,
        previewHint: E ? "/plan to preview" : void 0,
      });
    }
  }
}
`;

test("verify rejects unpatched plan UI code", () => {
	const ast = parse(PLAN_DIFF_FIXTURE);
	const code = print(ast);
	const result = planDiffUi.verify(code, ast);
	assert.notEqual(result, true);
	assert.equal(typeof result, "string");
});

test("plan-diff-ui removes plan-specific label and preview suppression", async () => {
	const ast = parse(PLAN_DIFF_FIXTURE);
	await runPlanDiffUiViaPasses(ast);
	const output = print(ast);

	assert.equal(output.includes('return "Updated plan"'), false);
	assert.equal(
		output.includes('if (H.file_path?.startsWith(v6())) return "Update";'),
		true,
	);
	assert.equal(
		output.includes('if (H?.file_path?.startsWith(v6())) return "Write";'),
		true,
	);
	assert.equal(output.includes('return "Reading Plan"'), false);
	assert.equal(
		output.includes('if (H?.file_path?.startsWith(v6())) return "Read";'),
		true,
	);
	assert.equal(
		output.includes('previewHint: B ? "/plan to preview" : void 0'),
		false,
	);
	assert.equal(
		output.includes('previewHint: E ? "/plan to preview" : void 0'),
		false,
	);
	assert.equal(output.includes("previewHint: void 0"), true);
	assert.equal(output.includes("if (H.startsWith(v6()) && !f)"), false);
	assert.equal(output.includes('if (H.startsWith(v6())) return "";'), false);
	assert.equal(
		output.includes('if (H.file_path.startsWith(v6())) return "";'),
		false,
	);
	assert.equal(output.includes('if (false) return "";'), true);

	assert.equal(planDiffUi.verify(output), true);
});

test("plan-diff-ui verify fails closed when plan anchors are absent", () => {
	const drifted = `
function unrelated() {
  return "Write";
}
`;
	const ast = parse(drifted);
	const result = planDiffUi.verify(print(ast), ast);
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("Plan diff anchors not found"), true);
});

test("plan-diff-ui rewrites both Updated-plan label fns with the correct per-function fallback", async () => {
	const ast = parse(PLAN_DIFF_FIXTURE);
	await runPlanDiffUiViaPasses(ast);
	const output = print(ast);
	// SyD has a "Write" fallback -> plan branch must become "Write"
	assert.equal(
		output.includes('if (H?.file_path?.startsWith(v6())) return "Write";'),
		true,
	);
	// ES$ has only an "Update" fallback -> plan branch must become "Update"
	assert.equal(
		output.includes('if (H.file_path?.startsWith(v6())) return "Update";'),
		true,
	);
	// no "Updated plan" literal survives anywhere
	assert.equal(output.includes("Updated plan"), false);
});

test("plan-diff-ui neutralizes every previewHint plan ternary", async () => {
	const ast = parse(PLAN_DIFF_FIXTURE);
	await runPlanDiffUiViaPasses(ast);
	const output = print(ast);
	// fixture has exactly two previewHint plan ternaries (YyD + hyD update branch)
	const remainingTernaries =
		output.split('? "/plan to preview" : void 0').length - 1;
	assert.equal(remainingTernaries, 0);
	const neutralized = output.split("previewHint: void 0").length - 1;
	assert.equal(neutralized, 2);
});

test("plan-diff-ui flips both tool-use-hide guards to a false test", async () => {
	const ast = parse(PLAN_DIFF_FIXTURE);
	await runPlanDiffUiViaPasses(ast);
	const output = print(ast);
	// fixture has exactly two `startsWith(...) return ""` guards (PyD + jyD)
	const falseEmptyReturns = output.split('if (false) return "";').length - 1;
	assert.equal(falseEmptyReturns, 2);
	assert.equal(output.includes('startsWith(v6())) return "";'), false);
});

test("plan-diff-ui flips the create-preview guard test to false", async () => {
	const ast = parse(PLAN_DIFF_FIXTURE);
	await runPlanDiffUiViaPasses(ast);
	const output = print(ast);
	// The create-branch guard `if (H.startsWith(v6()) && !f)` is a LogicalExpression
	// test (the && form, unique to the create guard). The mutator replaces the
	// whole test with the boolean literal `false`, so the original && guard is
	// gone and the create branch (a block body, not a `return ""` guard) now
	// opens with `if (false) {`, distinct from the flipped tool-use-hide guards.
	assert.equal(output.includes("if (H.startsWith(v6()) && !f)"), false);
	assert.equal(output.includes("if (false) {"), true);
});

test("plan-diff-ui rewrites Reading-Plan branch without disturbing a sibling Read-variant branch", async () => {
	const src = `
function v6() { return "/tmp/.claude/plans"; }
function readLabel(H) {
  if (H?.file_path?.startsWith(v6())) return "Reading Plan";
  if (H?.file_path && agentOut(H.file_path)) return "Read agent output";
  return "Read";
}
`;
	const ast = parse(src);
	await runPlanDiffUiViaPasses(ast);
	const output = print(ast);
	// plan branch becomes "Read"
	assert.equal(
		output.includes('if (H?.file_path?.startsWith(v6())) return "Read";'),
		true,
	);
	// the competing sibling branch is untouched
	assert.equal(output.includes('return "Read agent output";'), true);
	assert.equal(output.includes("Reading Plan"), false);
});

test("plan-diff-ui resolves the Update fallback even when extra non-fallback branches are present", async () => {
	const src = `
function v6() { return "/tmp/.claude/plans"; }
function updLabel(H) {
  if (!H) return "Update";
  if (H.file_path?.startsWith(v6())) return "Updated plan";
  if (H.edits != null) return "Update";
  if (H.old_string === "") return "Create";
  return "Update";
}
`;
	const ast = parse(src);
	await runPlanDiffUiViaPasses(ast);
	const output = print(ast);
	// no Write fallback in scope -> plan branch must resolve to "Update", not "Create"
	assert.equal(
		output.includes('if (H.file_path?.startsWith(v6())) return "Update";'),
		true,
	);
	assert.equal(output.includes("Updated plan"), false);
	// the unrelated edits/old_string branches are preserved verbatim
	assert.equal(output.includes('if (H.edits != null) return "Update";'), true);
	assert.equal(
		output.includes('if (H.old_string === "") return "Create";'),
		true,
	);
});

test("verify fails when an Updated-plan branch is left as the raw literal even if a Read return exists elsewhere", () => {
	// Simulates a partial/incorrect mutation: the previewHint, guards, and one
	// label group are patched, but an "Updated plan" literal survives. verify()
	// must catch the surviving unpatched label rather than passing on the
	// strength of other patched groups.
	const partiallyPatched = `
function v6() { return "/tmp/.claude/plans"; }
function a(H) {
  if (H?.file_path?.startsWith(v6())) return "Updated plan";
  return "Write";
}
function b({ file_path: H }, { verbose: $ }) {
  if (!H) return null;
  if (false) return "";
  return mk(H);
}
function c(H) {
  return mk2({ filePath: H, previewHint: void 0 });
}
`;
	const ast = parse(partiallyPatched);
	const result = planDiffUi.verify(print(ast), ast);
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("Updated plan"), true);
});

test("plan-diff-ui fixture models the same anchor multiplicity as the live bundle", () => {
	// Tripwire: if upstream adds/removes a plan-dir surface, this count drifts
	// and forces a fixture review. Pins the per-surface multiplicity the
	// mutator's count-based test assertions depend on.
	const plannedPreviewHints =
		PLAN_DIFF_FIXTURE.split('? "/plan to preview" : void 0').length - 1;
	const toolUseHideGuards =
		PLAN_DIFF_FIXTURE.split('startsWith(v6())) return "";').length - 1;
	const updatedPlanLiterals =
		PLAN_DIFF_FIXTURE.split('"Updated plan"').length - 1;
	const readingPlanLiterals =
		PLAN_DIFF_FIXTURE.split('"Reading Plan"').length - 1;
	assert.equal(plannedPreviewHints, 2);
	assert.equal(toolUseHideGuards, 2);
	assert.equal(updatedPlanLiterals, 2);
	assert.equal(readingPlanLiterals, 1);
});
