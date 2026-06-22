import assert from "node:assert/strict";
import { test } from "node:test";
import { parse, print } from "../loader.js";
import { signature } from "./signature.js";

// Mirrors the real upstream shape: the title is a composite outer template
// wrapping helper calls whose first argument is the literal "Claude Code".
// The marketplace error template merely starts its quasi with "Claude Code v..."
// (= "Claude Code version") and must NOT be decorated by the signature patch.
const SIGNATURE_FIXTURE = `
function makeTitle(e, I) {
  return \` \${Eq("claude", e)("Claude Code")} \${Eq("inactive", e)(\`v\${I}\`)} \`;
}

function marketplaceError(H) {
  return \`Claude Code version. Run 'claude plugin marketplace remove \${H}' and re-add it from the original project directory.\`;
}

function versionText(VERSION) {
  return \`\${VERSION} (Claude Code)\${suffix()}\`;
}
`;

test("signature verify rejects unpatched fixture", () => {
	const ast = parse(SIGNATURE_FIXTURE);
	const result = signature.verify(SIGNATURE_FIXTURE, ast);
	assert.notEqual(result, true);
	assert.equal(typeof result, "string");
});

test("signature decorates composite UI title and version, leaves marketplace error intact", () => {
	const ast = parse(SIGNATURE_FIXTURE);
	signature.postApply?.(ast, ["alpha", "beta"]);
	const output = print(ast);

	// Composite title's outer last quasi gets the patched marker appended.
	// The original last quasi is " " (a space), so print() emits "  \u2022 patched".
	assert.equal(
		output.includes('Eq("inactive", e)(`v${I}`)}  \\u2022 patched`'),
		true,
		`title not decorated; output:\n${output}`,
	);

	// Version-text TemplateLiteral quasi is rewritten in place.
	assert.equal(
		output.includes("(Claude Code; patched: alpha, beta)"),
		true,
		`version not signed; output:\n${output}`,
	);

	// Marketplace error template stays untouched.
	assert.equal(
		output.includes("\\u2022 patched' and re-add"),
		false,
		"marketplace error template was polluted with patched marker",
	);
	assert.equal(
		output.includes("\\u2022 patched.`"),
		false,
		"marketplace error template's trailing quasi was polluted",
	);
	assert.equal(
		output.includes(
			"Run 'claude plugin marketplace remove ${H}' and re-add it from the original project directory.",
		),
		true,
		"marketplace error text should survive verbatim",
	);

	assert.equal(signature.verify(output, ast), true);
});

test("signature verify rejects bundle where only marketplace error has patched marker", () => {
	// Simulates the BROKEN-pre-fix state: the patched suffix landed on the
	// marketplace error template instead of the real composite title.
	const polluted = `
function makeTitle(e, I) {
  return \` \${Eq("claude", e)("Claude Code")} \${Eq("inactive", e)(\`v\${I}\`)} \`;
}

function marketplaceError(H) {
  return \`Claude Code version. Run 'claude plugin marketplace remove \${H}' and re-add it from the original project directory. • patched\`;
}

function versionText(VERSION) {
  return \`\${VERSION} (Claude Code; patched: alpha)\${suffix()}\`;
}
`;
	const ast = parse(polluted);
	const result = signature.verify(polluted, ast);
	assert.notEqual(
		result,
		true,
		"verify must reject bundle where marketplace error carries the patched marker",
	);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).toLowerCase().includes("marketplace") ||
			String(result).toLowerCase().includes("not decorated"),
		true,
		`expected marketplace-pollution or not-decorated error, got: ${result}`,
	);
});

test("signature postApply is idempotent on composite title", () => {
	const ast = parse(SIGNATURE_FIXTURE);
	signature.postApply?.(ast, ["alpha"]);
	signature.postApply?.(ast, ["alpha"]);
	const output = print(ast);

	const matches = output.match(/ \\u2022 patched/g) ?? [];
	assert.equal(
		matches.length,
		1,
		`patched marker should appear exactly once, found ${matches.length}: ${output}`,
	);
});

test("signature postApply is a no-op when no tags applied", () => {
	const ast = parse(SIGNATURE_FIXTURE);
	signature.postApply?.(ast, []);
	const output = print(ast);

	assert.equal(output.includes("• patched"), false);
	assert.equal(output.includes("\\u2022 patched"), false);
	assert.equal(output.includes("patched:"), false);
});

test("signature base fixture has exactly one composite title and decorates it once", () => {
	const ast = parse(SIGNATURE_FIXTURE);
	signature.postApply?.(ast, ["alpha"]);
	const output = print(ast);

	// print() escapes the U+2022 bullet to the literal text "•".
	const markers = output.match(/\\u2022 patched/g) ?? [];
	assert.equal(
		markers.length,
		1,
		`base fixture should yield exactly one decorated composite title, got ${markers.length}: ${output}`,
	);
});

test("signature decorates every composite UI title when more than one exists", () => {
	// Two composite-title-shaped templates: both wrap a sole-arg helper call
	// on the literal "Claude Code", so both must be decorated and verify must
	// require all of them signed (patchedTitleCount === compositeTitleCount).
	const twoTitles = `
function titleA(e, I) { return \` \${Eq("claude", e)("Claude Code")} \${Eq("inactive", e)(\`v\${I}\`)} \`; }
function titleB(e, I) { return \`[\${Eq("claude", e)("Claude Code")}] v\${I} \`; }
function versionText(VERSION) { return \`\${VERSION} (Claude Code)\${suffix()}\`; }
`;
	const ast = parse(twoTitles);
	signature.postApply?.(ast, ["alpha"]);
	const output = print(ast);

	const markers = output.match(/\\u2022 patched/g) ?? [];
	assert.equal(
		markers.length,
		2,
		`expected both composite titles decorated, got ${markers.length}: ${output}`,
	);
	assert.equal(signature.verify(output, ast), true);
});

test("signature verify rejects bundle with an unsigned leftover version template", () => {
	// Two version-suffix templates where one stays unsigned: the boolean-OR
	// hasPatchedVersion is true via the signed one, but hasLegacyVersionTemplate
	// must still reject because an unsigned " (Claude Code)" template remains.
	const partial = `
function titleX(e, I) { return \` \${Eq("claude", e)("Claude Code")} \${Eq("inactive", e)(\`v\${I}\`)} • patched \`; }
function versionA(V) { return \`\${V} (Claude Code; patched: alpha)\${s()}\`; }
function versionB(V) { return \`\${V} (Claude Code)\${s()}\`; }
`;
	const ast = parse(partial);
	const result = signature.verify(partial, ast);
	assert.notEqual(
		result,
		true,
		"verify must reject when a version template is left unsigned",
	);
	assert.equal(typeof result, "string");
});
