import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { agentListingUi } from "./agent-listing-ui.js";

async function runAgentListingUiViaPasses(ast: any): Promise<void> {
	const passes = (await agentListingUi.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: agentListingUi.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

const AGENT_LISTING_FIXTURE = `
function renderAttachment(H) {
  switch (H.type) {
    case "agent_listing_delta": {
      if (H.isInitial || H.addedTypes.length === 0) return null;
      let A = H.addedTypes.length;
      return Nq.default.createElement(
        xw,
        null,
        Nq.default.createElement(v, { bold: !0 }, A),
        " agent ",
        Y6(A, "type"),
        " available",
      );
    }
  }
}
`;

const MEMOIZED_AGENT_LISTING_FIXTURE = `
function renderAttachment(q, $) {
  switch (q.type) {
    case "agent_listing_delta": {
      if (q.isInitial || q.addedTypes.length === 0) return null;
      let z = q.addedTypes.length,
        Y;
      if ($[103] !== z)
        (Y = yK.default.createElement(y, { bold: !0 }, z)), ($[103] = z), ($[104] = Y);
      else Y = $[104];
      let O;
      if ($[105] !== z) (O = R8(z, "type")), ($[105] = z), ($[106] = O);
      else O = $[106];
      let w;
      if ($[107] !== Y || $[108] !== O)
        (w = yK.default.createElement(nP, null, Y, " agent ", O, " available")),
          ($[107] = Y),
          ($[108] = O),
          ($[109] = w);
      else w = $[109];
      return w;
    }
  }
}
`;

test("verify rejects unpatched code", () => {
	const ast = parse(AGENT_LISTING_FIXTURE);
	const code = print(ast);
	const result = agentListingUi.verify(code, ast);
	assert.notEqual(result, true, "verify should reject unpatched code");
	assert.equal(typeof result, "string");
});

test("agent-listing-ui adds a visible agent type summary", async () => {
	const ast = parse(AGENT_LISTING_FIXTURE);
	await runAgentListingUiViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes(
			"function _claudePatchFormatAgentListingSummary(attachment)",
		),
		true,
	);
	assert.equal(output.includes("Array.isArray(attachment.addedTypes)"), true);
	assert.equal(
		output.includes("_claudePatchFormatAgentListingSummary(H)"),
		true,
	);
	assert.equal(agentListingUi.verify(output, ast), true);
});

test("agent-listing-ui patches memoized 2.1.169 render shape", async () => {
	const ast = parse(MEMOIZED_AGENT_LISTING_FIXTURE);
	await runAgentListingUiViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes(
			"function _claudePatchFormatAgentListingSummary(attachment)",
		),
		true,
	);
	assert.equal(
		output.includes("_claudePatchFormatAgentListingSummary(q)"),
		true,
	);
	assert.equal(output.includes("if (true)"), true);
	assert.equal(agentListingUi.verify(output, ast), true);
});

test("agent-listing-ui verify rejects memoized summary with stale cache guard", async () => {
	const ast = parse(MEMOIZED_AGENT_LISTING_FIXTURE);
	await runAgentListingUiViaPasses(ast);
	const output = print(ast);
	const mutated = output.replace(
		"if (true)",
		"if ($[107] !== Y || $[108] !== O)",
	);
	assert.notEqual(mutated, output);

	const result = agentListingUi.verify(mutated);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes(
			"agent_listing_delta renderer is missing the agent-type summary",
		),
		true,
	);
});

test("agent-listing-ui verify fails when the visible summary is removed", async () => {
	const ast = parse(AGENT_LISTING_FIXTURE);
	await runAgentListingUiViaPasses(ast);
	const output = print(ast);
	const mutated = output.replace(
		", _claudePatchFormatAgentListingSummary(H)",
		"",
	);
	assert.notEqual(mutated, output);

	const result = agentListingUi.verify(mutated);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes(
			"agent_listing_delta renderer is missing the agent-type summary",
		),
		true,
	);
});
