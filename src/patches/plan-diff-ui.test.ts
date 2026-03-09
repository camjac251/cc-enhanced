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
