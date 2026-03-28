import assert from "node:assert/strict";
import { test } from "node:test";
import { parse, print } from "../loader.js";
import { signature } from "./signature.js";

const SIGNATURE_FIXTURE = `
function makeCli() {
  return {
    title: \`Claude Code v\${VERSION}\`,
    unchanged: "Claude Code version. Run 'claude marketplace remove test' and re-add it.",
  };
}

function versionText() {
  return \`\${VERSION} (Claude Code)\`;
}

function directVersionText() {
  return "2.1.72 (Claude Code)";
}
`;

test("signature verify rejects unpatched fixture", () => {
	const ast = parse(SIGNATURE_FIXTURE);
	const result = signature.verify(SIGNATURE_FIXTURE, ast);
	assert.notEqual(result, true);
	assert.equal(typeof result, "string");
});

test("signature patches only version outputs and UI title", () => {
	const ast = parse(SIGNATURE_FIXTURE);
	signature.postApply?.(ast, ["alpha", "beta"]);
	const output = print(ast);

	assert.equal(output.includes("Claude Code v${VERSION} • patched"), true);
	assert.equal(
		output.includes("${VERSION} (Claude Code; patched: alpha, beta)"),
		true,
	);
	assert.equal(
		output.includes('"2.1.72 (Claude Code; patched: alpha, beta)"'),
		true,
	);
	assert.equal(
		output.includes(
			`"Claude Code version. Run 'claude marketplace remove test' and re-add it."`,
		),
		true,
	);
	assert.equal(signature.verify(output, ast), true);
});
