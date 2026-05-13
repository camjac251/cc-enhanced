import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionGuidance } from "./session-guidance.js";

const VANILLA_FIXTURE = `
function Fj5(H, $) {
  let A = H.has(IK),
    z = gX() && H.has(Wq) ? \`\\\`find\\\` or \\\`grep\\\` via the \${Wq} tool\` : \`the \${c1} or \${W9}\`,
    Y = [
      A ? pj5() : null,
      ...(A && t5$() && !Lv()
        ? [
            \`For broad codebase exploration or research that'll take more than \${nQK} queries, spawn \${IK} with subagent_type=\${Aa.agentType}. Otherwise use \${z} directly.\`,
          ]
        : []),
    ];
  return Y;
}
`;

test("session-guidance rewrites helper and Otherwise-clause to modern search routing", () => {
	const output = sessionGuidance.string?.(VANILLA_FIXTURE) ?? VANILLA_FIXTURE;
	assert.equal(output.includes("Otherwise use ${z} directly."), false);
	assert.equal(
		output.includes("\\`find\\` or \\`grep\\` via the ${Wq} tool"),
		false,
	);
	assert.equal(
		output.includes(
			"code-search routing (Serena, ChunkHound, Probe, ast-grep MCP/sg)",
		),
		true,
	);
	assert.equal(
		output.includes(
			"Otherwise choose by intent: Serena for known symbols, ChunkHound for conceptual search, Probe for known terms, ast-grep MCP/sg for structural patterns and code rewrites, and \\`rg\\` only for non-code text directly.",
		),
		true,
	);
});

test("session-guidance preserves placeholder-style identifiers when rewriting", () => {
	const output = sessionGuidance.string?.(VANILLA_FIXTURE) ?? VANILLA_FIXTURE;
	assert.equal(output.includes("${nQK}"), true);
	assert.equal(output.includes("${IK}"), true);
	assert.equal(output.includes("${Aa.agentType}"), true);
});

test("session-guidance verify accepts patched code", () => {
	const patched = sessionGuidance.string?.(VANILLA_FIXTURE) ?? VANILLA_FIXTURE;
	assert.equal(sessionGuidance.verify(patched), true);
});

test("session-guidance verify rejects unpatched fixture with legacy phrasing", () => {
	const result = sessionGuidance.verify(VANILLA_FIXTURE);
	assert.notEqual(result, true);
});

test("session-guidance verify accepts unrelated code with no exploration sentence", () => {
	const unrelated = `function unrelated() { return "no exploration sentence here"; }`;
	assert.equal(sessionGuidance.verify(unrelated), true);
});

test("session-guidance is idempotent across runs", () => {
	const first = sessionGuidance.string?.(VANILLA_FIXTURE) ?? VANILLA_FIXTURE;
	const second = sessionGuidance.string?.(first) ?? first;
	assert.equal(first, second);
});
