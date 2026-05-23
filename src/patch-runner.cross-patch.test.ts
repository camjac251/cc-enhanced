import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "./ast-pass-engine.js";
import { parse, print } from "./loader.js";
import { planDiffUi } from "./patches/plan-diff-ui.js";

// Synthetic cross-patch fixture verifying inter-patch interactions in the
// merged combined-pass engine. CLAUDE.md's Pipeline Ordering section lists
// the known interactions; this test locks in the resilience by reproducing
// the shared-visitor scenario in a controlled fixture rather than relying on
// the full real-bundle dry-run to catch a regression.

const EDIT_RENDERER_FIXTURE = `
const planPrefix = () => "PLAN:";

const EditTool = {
  name: "Edit",
  renderToolUseMessage({ file_path }, { verbose }) {
    if (!file_path) return null;
    if (file_path.startsWith(planPrefix())) return "";
    return file_path;
  },
};
`;

async function runPlanDiffUi(ast: any) {
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

test("plan-diff-ui rewrites Edit renderer's startsWith plan-preview guard to `if (false)`", async () => {
	// This is the well-known interaction documented in CLAUDE.md's Pipeline
	// Ordering section: plan-diff-ui's IfStatement mutator rewrites the test
	// of any plan-preview guard to `false`. Any later patch that anchors on
	// the `.startsWith(...)` shape would silently fail; the resilient
	// approach (per the doc) is to anchor on the surrounding
	// `if (!file_path) return null;` plus the SHAPE of a second empty-string
	// return, both of which survive this rewrite.
	const ast = parse(EDIT_RENDERER_FIXTURE);
	await runPlanDiffUi(ast);
	const output = print(ast);

	// 1. The startsWith call should no longer appear in test position; it
	//    was replaced by the BooleanLiteral `false`.
	assert.equal(
		output.includes("if (false)"),
		true,
		`expected if(false) rewrite in output:\n${output}`,
	);
	assert.equal(
		output.includes("file_path.startsWith(planPrefix())"),
		false,
		"startsWith call should no longer be in the test position",
	);

	// 2. The early null-guard SHOULD survive intact. Any later patch that
	//    anchors here will still work after plan-diff-ui has rewritten the
	//    plan-preview guard.
	assert.equal(
		output.includes("if (!file_path) return null;"),
		true,
		"early null-guard must survive plan-diff-ui's rewrite",
	);

	// 3. The empty-string return inside the (now `false`-tested) guard SHOULD
	//    survive too. Patches that anchor on the SHAPE of a second
	//    `if (...) return "";` (ignoring the test) will still match.
	assert.equal(
		output.includes('return "";') || output.includes("return ``;"),
		true,
		"empty-string return inside plan-preview guard must survive",
	);
});
