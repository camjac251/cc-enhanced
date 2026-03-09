import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { agentTools } from "./agents-off.js";

async function runAgentToolsViaPasses(ast: any): Promise<void> {
	const passes = (await agentTools.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: agentTools.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

const AGENT_ARRAY_FIXTURE = `
const statusAgent = {
  agentType: "statusline-setup",
  source: "built-in",
  isEnabled: true
};
const guideAgent = {
  agentType: "claude-code-guide",
  source: "built-in",
  tools: ["Write"]
};
function buildRegistry() {
  const agents = [statusAgent, guideAgent];
  return agents;
}
function buildDiagnostics() {
  const debugAgents = [statusAgent, guideAgent];
  return debugAgents.length;
}
`;

test("verify rejects unpatched code", () => {
	const ast = parse(AGENT_ARRAY_FIXTURE);
	const code = print(ast);
	const result = agentTools.verify(code, ast);
	assert.notEqual(
		result,
		true,
		"verify should reject unpatched code but got true",
	);
	assert.equal(typeof result, "string");
});

test("agents-off filters only arrays that are directly returned", async () => {
	const input = AGENT_ARRAY_FIXTURE;
	const ast = parse(input);
	await runAgentToolsViaPasses(ast);
	const output = print(ast);

	assert.equal(output.includes("const agents = [];"), true);
	assert.equal(
		output.includes("const debugAgents = [statusAgent, guideAgent];"),
		true,
	);
	assert.equal(agentTools.verify(output, ast), true);
});

test("agents-off filters arrays returned from nested branches", async () => {
	const input = `
const statusAgent = {
  agentType: "statusline-setup",
  source: "built-in",
  isEnabled: true
};
const guideAgent = {
  agentType: "claude-code-guide",
  source: "built-in",
  tools: ["Write"]
};
function maybeBuildRegistry(enabled) {
  const agents = [statusAgent, guideAgent];
  if (enabled) {
    return agents;
  }
  switch (enabled) {
    case false:
      return agents;
    default:
      return [];
  }
}
`;
	const ast = parse(input);
	await runAgentToolsViaPasses(ast);
	const output = print(ast);

	assert.equal(output.includes("const agents = [];"), true);
	assert.equal(agentTools.verify(output, ast), true);
});
