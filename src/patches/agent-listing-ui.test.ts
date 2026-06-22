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

test("agent-listing-ui ignores the non-render agent_listing_delta text case", async () => {
	const TWO_CASE_FIXTURE = `
function renderAttachment(q, $) {
  switch (q.type) {
    case "agent_listing_delta": {
      if (q.isInitial || q.addedTypes.length === 0) return null;
      let A = q.addedTypes.length,
        Y;
      if ($[104] !== A)
        (Y = mK.default.createElement(y, { bold: !0 }, A)), ($[104] = A), ($[105] = Y);
      else Y = $[105];
      let O;
      if ($[106] !== A) (O = C8(A, "type")), ($[106] = A), ($[107] = O);
      else O = $[107];
      let w;
      if ($[108] !== Y || $[109] !== O)
        (w = mK.default.createElement(dW, null, Y, " agent ", O, " available")),
          ($[108] = Y),
          ($[109] = O),
          ($[110] = w);
      else w = $[110];
      return w;
    }
  }
}
function renderTranscript(H) {
  switch (H.type) {
    case "agent_listing_delta": {
      let q = [];
      if (H.addedLines.length > 0) {
        let K = H.isInitial
          ? "Available agent types for the Agent tool:"
          : "New agent types are now available for the Agent tool:";
        q.push(K + H.addedLines.join("\\n"));
      }
      if (H.removedTypes.length > 0)
        q.push("The following agent types are no longer available:");
      return df([F8({ content: q.join("\\n\\n"), isMeta: !0 })]);
    }
  }
}
`;
	const ast = parse(TWO_CASE_FIXTURE);
	await runAgentListingUiViaPasses(ast);
	const output = print(ast);

	// Exactly one helper injected, and the render case got the summary arg.
	const helperCount =
		output.split("function _claudePatchFormatAgentListingSummary(attachment)")
			.length - 1;
	assert.equal(helperCount, 1, "helper should be injected exactly once");
	assert.equal(
		output.includes("_claudePatchFormatAgentListingSummary(q)"),
		true,
		"render case should receive the summary call",
	);
	// The text case is untouched: no summary call near addedLines.
	assert.equal(
		output.includes("_claudePatchFormatAgentListingSummary(H)"),
		false,
		"text-twin case must not be patched",
	);
	assert.equal(agentListingUi.verify(output, ast), true);
});

test("agent-listing-ui is idempotent across a second pass run", async () => {
	const ast = parse(MEMOIZED_AGENT_LISTING_FIXTURE);
	await runAgentListingUiViaPasses(ast);
	await runAgentListingUiViaPasses(ast);
	const output = print(ast);

	const helperCount =
		output.split("function _claudePatchFormatAgentListingSummary(attachment)")
			.length - 1;
	assert.equal(helperCount, 1, "helper must not be injected twice");

	const summaryArgCount =
		output.split("_claudePatchFormatAgentListingSummary(q)").length - 1;
	assert.equal(summaryArgCount, 1, "summary arg must not be appended twice");
	assert.equal(agentListingUi.verify(output, ast), true);
});

test("agent-listing-ui verify rejects a summary call with the wrong attachment identifier", async () => {
	const ast = parse(MEMOIZED_AGENT_LISTING_FIXTURE);
	await runAgentListingUiViaPasses(ast);
	const output = print(ast);
	// q is the case attachment identifier; swap the summary arg to a foreign name.
	const mutated = output.replace(
		"_claudePatchFormatAgentListingSummary(q)",
		"_claudePatchFormatAgentListingSummary(NOT_THE_ATTACHMENT)",
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

test("agent-listing-ui appends the summary call as the last createElement argument", async () => {
	const ast = parse(MEMOIZED_AGENT_LISTING_FIXTURE);
	await runAgentListingUiViaPasses(ast);
	const output = print(ast);

	// The summary call must sit at the tail of the render-root createElement
	// argument list, so its closing paren is immediately followed by the
	// createElement closing paren. A non-terminal insertion would be followed
	// by a comma instead, which this assertion rejects.
	assert.match(
		output,
		/_claudePatchFormatAgentListingSummary\(q\)\s*\)/,
		"summary call must be the final createElement argument",
	);
});

test("agent-listing-ui verify reports ambiguity when two render-shaped cases exist", async () => {
	// Patch a single render case first to obtain a well-formed helper plus one
	// patched render function, then duplicate the patched render function so
	// verify sees two render-shaped agent_listing_delta cases with the helper
	// already present. This drives verify past the helper gate into the
	// renderCaseCount > 1 fail-closed branch.
	const single = parse(MEMOIZED_AGENT_LISTING_FIXTURE);
	await runAgentListingUiViaPasses(single);
	const patched = print(single);

	const fnStart = patched.indexOf("function renderAttachment");
	const helperPart = patched.slice(0, fnStart);
	const renderFn = patched.slice(fnStart);
	const renderFnTwin = renderFn.replace(
		"renderAttachment",
		"renderAttachmentTwin",
	);
	const combined = `${helperPart}${renderFn}\n${renderFnTwin}`;
	assert.notEqual(combined, patched);

	const result = agentListingUi.verify(combined);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("ambiguous"),
		true,
		"two render-shaped cases must fail verify with the ambiguity message",
	);
});
