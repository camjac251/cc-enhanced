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

test("agents-off resolves assignment-defined agents, identifier-valued agentType, and unbraced-if pushes", async () => {
	const fixture = `
var generalPurposeAgent;
var statuslineSetupAgent;
var claudeCodeGuideAgent;
var exploreAgent;
const claudeCodeGuideType = "claude-code-guide";
function init() {
  generalPurposeAgent = { agentType: "general-purpose", source: "built-in" };
  statuslineSetupAgent = { agentType: "statusline-setup", source: "built-in" };
  claudeCodeGuideAgent = { agentType: claudeCodeGuideType, source: "built-in" };
  exploreAgent = { agentType: "Explore", source: "built-in" };
}
function getBuiltInAgents(isNonSdk) {
  const agents = [generalPurposeAgent];
  if (!isNonSdk) agents.push(statuslineSetupAgent);
  agents.push(exploreAgent);
  if (isNonSdk) agents.push(claudeCodeGuideAgent);
  return agents;
}
`;
	const ast = parse(fixture);
	await runAgentToolsViaPasses(ast);
	const output = print(ast);
	assert.equal(output.includes("agents.push(statuslineSetupAgent)"), false);
	assert.equal(output.includes("agents.push(claudeCodeGuideAgent)"), false);
	assert.equal(output.includes("agents.push(exploreAgent)"), true);
	assert.equal(output.includes("const agents = [generalPurposeAgent]"), true);
	assert.equal(agentTools.verify(output, ast), true);
});

test("agents-off trims a disabled arg from a multi-arg push and keeps the rest", async () => {
	const fixture = `
const generalPurposeAgent = { agentType: "general-purpose", source: "built-in" };
const statuslineSetupAgent = { agentType: "statusline-setup", source: "built-in" };
const claudeCodeGuideAgent = { agentType: "claude-code-guide", source: "built-in" };
const exploreAgent = { agentType: "Explore", source: "built-in" };
function getBuiltInAgents() {
  const agents = [generalPurposeAgent];
  agents.push(statuslineSetupAgent, exploreAgent);
  return agents;
}
`;
	const ast = parse(fixture);
	await runAgentToolsViaPasses(ast);
	const output = print(ast);
	assert.equal(output.includes("agents.push(exploreAgent)"), true);
	assert.equal(output.includes("agents.push(statuslineSetupAgent"), false);
	assert.equal(agentTools.verify(output, ast), true);
});

test("verify fails when registry survives but keeps no expected agents", () => {
	const fixture = `
const statuslineSetupAgent = { agentType: "statusline-setup", source: "built-in" };
const claudeCodeGuideAgent = { agentType: "claude-code-guide", source: "built-in" };
const otherAgent = { agentType: "some-other", source: "built-in" };
function getBuiltInAgents() {
  const agents = [otherAgent];
  return agents;
}
`;
	const ast = parse(fixture);
	const result = agentTools.verify(print(ast), ast);
	assert.notEqual(result, true);
	assert.equal(String(result).includes("expected kept agents"), true);
});

test("verify rejects a registry that only exposes agents via a directly-returned array literal", async () => {
	// A registry function that returns an array literal directly (rather than a
	// returned variable) is not recognized as a registry, so a disabled agent in
	// it is never filtered. verify must not pass this shape: with no detectable
	// registry it reports failure, which correctly fails the patch run instead of
	// silently shipping a leaked agent.
	const fixture = `
const generalPurposeAgent = { agentType: "general-purpose", source: "built-in" };
const statuslineSetupAgent = { agentType: "statusline-setup", source: "built-in" };
const claudeCodeGuideAgent = { agentType: "claude-code-guide", source: "built-in" };
function getBuiltInAgents() {
  return [generalPurposeAgent, statuslineSetupAgent];
}
`;
	const ast = parse(fixture);
	await runAgentToolsViaPasses(ast);
	const output = print(ast);
	const result = agentTools.verify(output, ast);
	assert.notEqual(result, true);
});

test("verify fails and names the single disabled agent still present in the registry", () => {
	const fixture = `
const generalPurposeAgent = { agentType: "general-purpose", source: "built-in" };
const statuslineSetupAgent = { agentType: "statusline-setup", source: "built-in" };
const claudeCodeGuideAgent = { agentType: "claude-code-guide", source: "built-in" };
function getBuiltInAgents() {
  const agents = [generalPurposeAgent];
  agents.push(statuslineSetupAgent);
  return agents;
}
`;
	const ast = parse(fixture);
	const result = agentTools.verify(print(ast), ast);
	assert.notEqual(result, true);
	assert.equal(String(result).includes("still present"), true);
	assert.equal(String(result).includes("statusline-setup"), true);
});

test("agents-off filters the main registry and leaves a coexisting coordinator registry intact", async () => {
	const fixture = `
const generalPurposeAgent = { agentType: "general-purpose", source: "built-in" };
const statuslineSetupAgent = { agentType: "statusline-setup", source: "built-in" };
const claudeCodeGuideAgent = { agentType: "claude-code-guide", source: "built-in" };
const workerAgent = { agentType: "worker", source: "built-in" };
function getBuiltInAgents() {
  const agents = [generalPurposeAgent];
  agents.push(statuslineSetupAgent);
  return agents;
}
function getCoordinatorAgents() {
  const team = [workerAgent];
  return team;
}
`;
	const ast = parse(fixture);
	await runAgentToolsViaPasses(ast);
	const output = print(ast);
	assert.equal(output.includes("agents.push(statuslineSetupAgent)"), false);
	assert.equal(output.includes("const team = [workerAgent]"), true);
	assert.equal(agentTools.verify(output, ast), true);
});
