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

const BUILT_IN_AGENT_REGISTRY_FIXTURE = `
const generalPurposeAgent = {
  agentType: "general-purpose",
  source: "built-in",
};
const statuslineSetupAgent = {
  agentType: "statusline-setup",
  source: "built-in",
};
const claudeCodeGuideAgent = {
  agentType: "claude-code-guide",
  source: "built-in",
};
const exploreAgent = {
  agentType: "Explore",
  source: "built-in",
};
const planAgent = {
  agentType: "Plan",
  source: "built-in",
};

function getBuiltInAgents(explorePlanEnabled, isNonSdkEntrypoint) {
  const agents = [generalPurposeAgent, statuslineSetupAgent];
  if (explorePlanEnabled) {
    agents.push(exploreAgent, planAgent);
  }
  if (isNonSdkEntrypoint) {
    agents.push(claudeCodeGuideAgent);
  }
  return agents;
}

function buildDiagnostics() {
  const debugAgents = [statuslineSetupAgent, claudeCodeGuideAgent];
  return debugAgents.length;
}
`;

test("verify rejects unpatched registry fixture", () => {
	const ast = parse(BUILT_IN_AGENT_REGISTRY_FIXTURE);
	const code = print(ast);
	const result = agentTools.verify(code, ast);
	assert.notEqual(result, true);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("still present") ||
			String(result).includes("not found"),
		true,
	);
});

test("agents-off filters disabled agents from the returned built-in registry only", async () => {
	const ast = parse(BUILT_IN_AGENT_REGISTRY_FIXTURE);
	await runAgentToolsViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes(
			"const agents = [generalPurposeAgent, statuslineSetupAgent];",
		),
		false,
	);
	assert.equal(output.includes("const agents = [generalPurposeAgent];"), true);
	assert.equal(output.includes("agents.push(exploreAgent, planAgent);"), true);
	assert.equal(output.includes("agents.push(claudeCodeGuideAgent);"), false);
	assert.equal(
		output.includes(
			"const debugAgents = [statuslineSetupAgent, claudeCodeGuideAgent];",
		),
		true,
	);
	assert.equal(agentTools.verify(output, ast), true);
});

test("agents-off is idempotent against the latest registry shape", async () => {
	const ast = parse(BUILT_IN_AGENT_REGISTRY_FIXTURE);
	await runAgentToolsViaPasses(ast);
	const firstPass = print(ast);

	const ast2 = parse(firstPass);
	await runAgentToolsViaPasses(ast2);
	const secondPass = print(ast2);

	assert.equal(firstPass, secondPass);
	assert.equal(agentTools.verify(secondPass, ast2), true);
});
