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

test("session-guidance produces exactly one modern surface of each kind", () => {
	const output = sessionGuidance.string?.(VANILLA_FIXTURE) ?? VANILLA_FIXTURE;
	const broadCount =
		output.split("Otherwise choose by intent: Serena for known symbols")
			.length - 1;
	const helperCount =
		output.split(
			"code-search routing (Serena, ChunkHound, Probe, ast-grep MCP/sg)",
		).length - 1;
	assert.equal(broadCount, 1);
	assert.equal(helperCount, 1);
});

test("session-guidance converts every legacy occurrence, not just the first", () => {
	const doubled = `${VANILLA_FIXTURE}\n${VANILLA_FIXTURE}`;
	const output = sessionGuidance.string?.(doubled) ?? doubled;
	assert.equal(output.includes("Otherwise use ${z} directly."), false);
	assert.equal(
		output.includes("\\`find\\` or \\`grep\\` via the ${Wq} tool"),
		false,
	);
	const broadCount =
		output.split("Otherwise choose by intent: Serena for known symbols")
			.length - 1;
	assert.equal(broadCount, 2);
});

test("session-guidance modern find/grep helper preserves the captured tool placeholder", () => {
	const output = sessionGuidance.string?.(VANILLA_FIXTURE) ?? VANILLA_FIXTURE;
	assert.equal(
		output.includes(
			"code-search routing (Serena, ChunkHound, Probe, ast-grep MCP/sg) or \\`rg\\` for non-code text via the ${Wq} tool",
		),
		true,
	);
});

test("session-guidance verify flags legacy find/grep helper when broad sentence already modern", () => {
	const patched = sessionGuidance.string?.(VANILLA_FIXTURE) ?? VANILLA_FIXTURE;
	const halfReverted = patched.replace(
		"code-search routing (Serena, ChunkHound, Probe, ast-grep MCP/sg) or \\`rg\\` for non-code text via the ${Wq} tool",
		"\\`find\\` or \\`grep\\` via the ${Wq} tool",
	);
	const result = sessionGuidance.verify(halfReverted);
	assert.equal(
		result,
		"Session guidance still routes fallback exploration through find/grep",
	);
});

test("session-guidance fails verify when broad-exploration sentence drifts but helper is rewritten", () => {
	const driftedBroad = VANILLA_FIXTURE.replace(
		"For broad codebase exploration or research that'll take more than ${nQK} queries",
		"For wide codebase exploration that needs more than ${nQK} queries",
	);
	const output = sessionGuidance.string?.(driftedBroad) ?? driftedBroad;
	// helper still rewritten
	assert.equal(
		output.includes(
			"code-search routing (Serena, ChunkHound, Probe, ast-grep MCP/sg)",
		),
		true,
	);
	// but the broad sentence was not in the expected legacy shape, so it stays
	// legacy and verify rejects
	const result = sessionGuidance.verify(output);
	assert.notEqual(result, true);
});

test("session-guidance verify accepts a fully-patched doubled surface", () => {
	const doubled = `${VANILLA_FIXTURE}\n${VANILLA_FIXTURE}`;
	const output = sessionGuidance.string?.(doubled) ?? doubled;
	assert.equal(sessionGuidance.verify(output), true);
	assert.equal(output.includes("Otherwise use ${z} directly."), false);
});
