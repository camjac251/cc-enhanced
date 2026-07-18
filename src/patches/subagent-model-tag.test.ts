import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { subagentModelTag } from "./subagent-model-tag.js";

async function runSubagentModelTagViaPasses(ast: any): Promise<void> {
	const passes = (await subagentModelTag.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: subagentModelTag.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

async function patchSource(source: string): Promise<string> {
	const ast = parse(source);
	await runSubagentModelTagViaPasses(ast);
	return print(ast);
}

// Agent-era model row under the automatic JSX runtime: a keyed element whose
// React key ("model") is the third positional argument of the element-factory
// call, with the dimColor signal carried on a nested text element.
const AGENT_SCHEMA_FIXTURE = String.raw`
const agentInputSchema = A.object({
  description: A.string().describe("A short (3-5 word) description of the task"),
  prompt: A.string().describe("The task for the agent to perform"),
  subagent_type: A.string().optional().describe("The type of specialized agent to use for this task"),
  model: A.enum(["sonnet", "opus", "haiku", "fable"]).optional().describe('Optional model override for this agent. Takes precedence over the agent definition\'s model frontmatter. Ignored for subagent_type: "fork"; forks always inherit the parent model.'),
  run_in_background: A.boolean().optional(),
});
`;

const AGENT_LIFECYCLE_FIXTURE = `
async function* runChild({ agentDefinition, model, extraMetadata }) {
  const parentModel = getParentModel(context);
  const isFork = agentDefinition.agentType === "fork";
  const resolvedModel = resolveAgentModel(getAgentModel(agentDefinition, parentModel), parentModel, isFork ? void 0 : model, permissionMode);
  saveAgentMetadata(agentId, model !== undefined || extraMetadata !== undefined, {
    agentType: agentDefinition.agentType,
    ...(parentContext.agentId && { parentAgentId: parentContext.agentId }),
    ...(override?.agentContext !== undefined && { spawnDepth: getSpawnDepth(override.agentContext) }),
    ...(model && { model }),
    ...extraMetadata,
  });
  const launchMetadata = {
    prompt,
    resolvedAgentModel: resolvedModel,
    isBuiltInAgent,
    startTime,
    agentType: agentDefinition.agentType,
    isAsync,
    agentDepth,
    source: agentDefinition.source,
  };
}

async function resumeChild() {
  const metadata = await readAgentMetadata(agentId);
  const configuredAgent = getSelectedAgent(metadata);
  const isFork = metadata?.isFork === true;
  const selectedAgent = configuredAgent ?? (isFork ? forkAgent : defaultAgent);
  const parentModel = getParentModel(context);
  const resolvedModel = resolveAgentModel(getAgentModel(selectedAgent, parentModel), parentModel, metadata?.isObserver ? void 0 : metadata?.model, permissionMode);
  const childOptions = {
    agentDefinition: selectedAgent,
    promptMessages,
    toolUseContext,
    canUseTool,
    isAsync: true,
    querySource,
    spawnedBySkill: undefined,
    model: metadata?.isObserver ? void 0 : metadata?.model,
    override: undefined,
    availableTools,
    forkContextMessages: undefined,
    recordedUuids: new Set(messages.map((message) => message.uuid)),
    worktreePath,
    worktreeBranch: metadata?.worktreeBranch,
    cwd: metadata?.cwd,
    spawnMode: metadata?.spawnMode,
    description: metadata?.description,
    name: metadata?.name,
    toolUseId: metadata?.toolUseId,
    contentReplacementState,
  };
  registerTask({ model: resolvedModel, selectedAgent });
  const spawnMetadata = {
    prompt,
    resolvedAgentModel: resolvedModel,
    isBuiltInAgent,
    startTime,
    agentType: selectedAgent.agentType,
    isAsync: true,
    agentDepth,
    source: selectedAgent.source,
  };
  return { childOptions, spawnMetadata };
}
`;

const SUBAGENT_FIXTURE = `
function renderRows(entry, rows) {
  if (entry.model) {
    rows.push(R.jsx(Box, { flexWrap: "nowrap", marginLeft: 1, children: R.jsx(Text, { dimColor: true, children: formatModel(entry.model) }) }, "model"));
  }
}
${AGENT_SCHEMA_FIXTURE}
${AGENT_LIFECYCLE_FIXTURE}
`;

test("verify rejects unpatched code", () => {
	const ast = parse(SUBAGENT_FIXTURE);
	const code = print(ast);
	const result = subagentModelTag.verify(code, ast);
	assert.notEqual(
		result,
		true,
		"verify should reject unpatched code but got true",
	);
	assert.equal(typeof result, "string");
});

test("verify rejects an Agent model schema that still limits model aliases", () => {
	const input = SUBAGENT_FIXTURE.replace(
		"if (entry.model) {",
		"if (entry.model && !process.env.CLAUDE_CODE_SUBAGENT_MODEL) {",
	);
	const ast = parse(input);
	const result = subagentModelTag.verify(print(ast), ast);

	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("Agent model schema"),
		true,
		"verification must reject a fixed alias enum even when the UI guard is patched",
	);
});

test("subagent-model-tag patches unique Agent model branch", async () => {
	const input = SUBAGENT_FIXTURE;
	const ast = parse(input);
	await runSubagentModelTagViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes("&& !process.env.CLAUDE_CODE_SUBAGENT_MODEL"),
		true,
	);
	assert.equal(subagentModelTag.verify(output, ast), true);
});

test("subagent-model-tag accepts a nonempty full model ID in the Agent schema", async () => {
	const ast = parse(SUBAGENT_FIXTURE);
	await runSubagentModelTagViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes("model: A.string().trim().min(1).optional().describe"),
		true,
		"Agent model must trim and accept a nonempty string instead of a fixed alias enum",
	);
	assert.equal(
		output.includes("full model ID available through /model"),
		true,
		"Agent model guidance must explain how to select discovered models",
	);
});

test("subagent-model-tag keeps fork launches and resumes on the parent model", async () => {
	const output = await patchSource(SUBAGENT_FIXTURE);
	assert.equal(
		output.split("isFork ? parentModel : resolveAgentModel").length - 1,
		2,
		"both initial and resumed forks must bypass the global subagent model override",
	);
	assert.equal(subagentModelTag.verify(output, parse(output)), true);
});

test("verify rejects partial fork inheritance", async () => {
	const output = await patchSource(SUBAGENT_FIXTURE);

	const missingForkLaunch = output.replace(
		"isFork ? parentModel : resolveAgentModel",
		"resolveAgentModel",
	);
	assert.notEqual(missingForkLaunch, output);
	const forkResult = subagentModelTag.verify(
		missingForkLaunch,
		parse(missingForkLaunch),
	);
	assert.equal(typeof forkResult, "string");
	assert.equal(String(forkResult).includes("Fork launch"), true);
});

test("subagent-model-tag accepts the current child model lifecycle", async () => {
	const ast = parse(SUBAGENT_FIXTURE);
	await runSubagentModelTagViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes("...(model && { model })"),
		true,
		"child metadata must retain the current raw model persistence",
	);
	assert.equal(
		output.split("model: metadata?.isObserver ? void 0 : metadata?.model")
			.length - 1,
		1,
		"resume options must preserve the observer-aware model override exactly once",
	);
	assert.equal(
		output.includes(
			"resolveAgentModel(getAgentModel(selectedAgent, parentModel), parentModel, metadata?.isObserver ? void 0 : metadata?.model, permissionMode)",
		),
		true,
		"resume model resolution must preserve the observer-aware override",
	);
	assert.equal(subagentModelTag.verify(output, ast), true);
});

test("verify rejects partial child model resume restoration", async () => {
	const patchedAst = parse(SUBAGENT_FIXTURE);
	await runSubagentModelTagViaPasses(patchedAst);
	const patched = print(patchedAst);

	const missingOptions = patched.replace(
		"model: metadata?.isObserver ? void 0 : metadata?.model",
		"model: void 0",
	);
	assert.notEqual(missingOptions, patched);
	const missingOptionsAst = parse(missingOptions);
	const optionsResult = subagentModelTag.verify(
		print(missingOptionsAst),
		missingOptionsAst,
	);
	assert.equal(typeof optionsResult, "string");
	assert.equal(String(optionsResult).includes("resume options"), true);

	const missingResolver = patched.replace(
		"resolveAgentModel(getAgentModel(selectedAgent, parentModel), parentModel, metadata?.isObserver ? void 0 : metadata?.model, permissionMode)",
		"resolveAgentModel(getAgentModel(selectedAgent, parentModel), parentModel, void 0, permissionMode)",
	);
	assert.notEqual(missingResolver, patched);
	const missingResolverAst = parse(missingResolver);
	const resolverResult = subagentModelTag.verify(
		print(missingResolverAst),
		missingResolverAst,
	);
	assert.equal(typeof resolverResult, "string");
	assert.equal(String(resolverResult).includes("resume resolution"), true);
});

test("subagent-model-tag refuses ambiguous launch metadata writers", async () => {
	const duplicateLaunch = AGENT_LIFECYCLE_FIXTURE.slice(
		AGENT_LIFECYCLE_FIXTURE.indexOf("async function* runChild"),
		AGENT_LIFECYCLE_FIXTURE.indexOf("async function resumeChild"),
	).replace("runChild", "runChildDuplicate");
	const ast = parse(`${SUBAGENT_FIXTURE}\n${duplicateLaunch}`);
	await runSubagentModelTagViaPasses(ast);
	const output = print(ast);

	assert.equal(output.includes("model && { model }"), true);
	const verifyResult = subagentModelTag.verify(output, ast);
	assert.equal(typeof verifyResult, "string");
	assert.equal(String(verifyResult).includes("launch model metadata"), true);
});

test("subagent-model-tag ignores a schema decoy with unrelated model guidance", async () => {
	const input = `${SUBAGENT_FIXTURE}
const decoySchema = A.object({
  description: A.string().describe("A short (3-5 word) description of the task"),
  prompt: A.string().describe("The task for the agent to perform"),
  subagent_type: A.string().optional().describe("The type of specialized agent to use for this task"),
  model: A.enum(["sonnet", "opus", "haiku", "fable"]).optional().describe("Unrelated model setting"),
  run_in_background: A.boolean().optional(),
});`;
	const ast = parse(input);
	await runSubagentModelTagViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.split(".string().trim().min(1).optional().describe").length - 1,
		1,
		"only the Agent model schema should be widened",
	);
	assert.equal(output.includes("Unrelated model setting"), true);
	assert.equal(
		output.split('.enum(["sonnet", "opus", "haiku", "fable"])').length - 1,
		1,
		"the unrelated enum must remain unchanged",
	);
	assert.equal(subagentModelTag.verify(output, ast), true);
});

test("subagent-model-tag refuses ambiguous Agent input schemas", async () => {
	const duplicateSchema = AGENT_SCHEMA_FIXTURE.replace(
		"agentInputSchema",
		"duplicateAgentInputSchema",
	);
	const ast = parse(`${SUBAGENT_FIXTURE}\n${duplicateSchema}`);
	await runSubagentModelTagViaPasses(ast);
	const output = print(ast);

	assert.equal(output.includes(".string().trim().min(1)"), false);
	const verifyResult = subagentModelTag.verify(output, ast);
	assert.equal(typeof verifyResult, "string");
	assert.equal(String(verifyResult).includes("ambiguous"), true);
});

test("subagent-model-tag refuses a drifted Agent model enum", async () => {
	const input = SUBAGENT_FIXTURE.replace(
		'"haiku", "fable"]',
		'"haiku", "fable", "future"]',
	);
	const ast = parse(input);
	await runSubagentModelTagViaPasses(ast);
	const output = print(ast);

	assert.equal(output.includes(".string().trim().min(1)"), false);
	assert.equal(output.includes('"future"'), true);
	const verifyResult = subagentModelTag.verify(output, ast);
	assert.equal(typeof verifyResult, "string");
	assert.equal(String(verifyResult).includes("does not accept"), true);
});

test("verify rejects a full-ID schema without trim validation", async () => {
	const patchedAst = parse(SUBAGENT_FIXTURE);
	await runSubagentModelTagViaPasses(patchedAst);
	const weakenedAst = parse(print(patchedAst).replace(".trim()", ""));
	const verifyResult = subagentModelTag.verify(print(weakenedAst), weakenedAst);

	assert.equal(typeof verifyResult, "string");
	assert.equal(String(verifyResult).includes("does not accept"), true);
});

test("subagent-model-tag fails closed on ambiguous Agent model branches", async () => {
	const input = `
function renderRows(entry, rows) {
  if (entry.model) {
    rows.push(R.jsx(Box, { children: R.jsx(Text, { dimColor: true, children: formatModel(entry.model) }) }, "model"));
  }
  if (entry.model) {
    rows.push(R.jsx(Box, { children: R.jsx(Text, { dimColor: true, children: formatModel(entry.model) }) }, "model"));
  }
}
`;
	const ast = parse(input);
	await runSubagentModelTagViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes("&& !process.env.CLAUDE_CODE_SUBAGENT_MODEL"),
		false,
	);
	const verifyResult = subagentModelTag.verify(output, ast);
	assert.equal(typeof verifyResult, "string");
	assert.equal(String(verifyResult).includes("ambiguous"), true);
});

test("subagent-model-tag patches modern model-row branch behind a memo guard", async () => {
	const input = `
function renderRows(entry, rows) {
  if (entry.model) {
    let A = normalizeModel(entry.model), L = currentModel();
    if (A !== L) {
      rows.push(R.jsx(Box, { children: R.jsx(Text, { dimColor: true, children: formatModel(A) }) }, "model"));
    }
  }
}
${AGENT_SCHEMA_FIXTURE}
${AGENT_LIFECYCLE_FIXTURE}`;
	const ast = parse(input);
	await runSubagentModelTagViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes("entry.model && !process.env.CLAUDE_CODE_SUBAGENT_MODEL"),
		true,
	);
	assert.equal(subagentModelTag.verify(output, ast), true);
});

test("subagent-model-tag ignores a keyed model row without the dimColor signal", async () => {
	const input = `
function renderRows(entry, rows) {
  if (entry.model) {
    rows.push(R.jsx(Box, { flexWrap: "nowrap", children: R.jsx(Text, { children: formatModel(entry.model) }) }, "model"));
  }
}
`;
	const ast = parse(input);
	await runSubagentModelTagViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes("&& !process.env.CLAUDE_CODE_SUBAGENT_MODEL"),
		false,
	);
	const verifyResult = subagentModelTag.verify(output, ast);
	assert.equal(typeof verifyResult, "string");
	assert.equal(String(verifyResult).includes("not found"), true);
});

test("subagent-model-tag ignores local CLAUDE_CODE_SUBAGENT_MODEL identifiers", async () => {
	const input = `
function renderRows(entry, rows) {
  const CLAUDE_CODE_SUBAGENT_MODEL = false;
  if (entry.model && !CLAUDE_CODE_SUBAGENT_MODEL) {
    rows.push(R.jsx(Box, { children: R.jsx(Text, { dimColor: true, children: formatModel(entry.model) }) }, "model"));
  }
}
${AGENT_SCHEMA_FIXTURE}
${AGENT_LIFECYCLE_FIXTURE}`;
	const ast = parse(input);
	await runSubagentModelTagViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes("&& !process.env.CLAUDE_CODE_SUBAGENT_MODEL"),
		true,
	);
	assert.equal(subagentModelTag.verify(output, ast), true);
});

test("subagent-model-tag matches a nested dimColor written as !0 truthy form", async () => {
	const input = `
function renderRows(H) {
  let q = [];
  if (H.model && H.model !== "inherit") {
    let K = current();
    if (K) {
      q.push(C.jsx(P, { flexWrap: "nowrap", marginLeft: 1, children: C.jsx(Y, { dimColor: !0, children: label(K) }) }, "model"));
    }
  }
}
${AGENT_SCHEMA_FIXTURE}
${AGENT_LIFECYCLE_FIXTURE}`;
	const ast = parse(input);
	await runSubagentModelTagViaPasses(ast);
	const output = print(ast);
	assert.equal(
		output.includes(
			'H.model && H.model !== "inherit" && !process.env.CLAUDE_CODE_SUBAGENT_MODEL',
		),
		true,
		"guard must wrap the outer .model-bearing if even when dimColor is nested and written as !0",
	);
	assert.equal(subagentModelTag.verify(output, ast), true);
});

test("subagent-model-tag adds the env guard exactly once", async () => {
	const ast = parse(SUBAGENT_FIXTURE);
	await runSubagentModelTagViaPasses(ast);
	const output = print(ast);
	const occurrences =
		output.split("!process.env.CLAUDE_CODE_SUBAGENT_MODEL").length - 1;
	assert.equal(
		occurrences,
		1,
		`expected exactly one env guard, found ${occurrences}`,
	);
});

test("subagent-model-tag is idempotent on already-guarded code", async () => {
	const ast1 = parse(SUBAGENT_FIXTURE);
	await runSubagentModelTagViaPasses(ast1);
	const once = print(ast1);
	const ast2 = parse(once);
	await runSubagentModelTagViaPasses(ast2);
	const twice = print(ast2);
	const occurrences =
		twice.split("!process.env.CLAUDE_CODE_SUBAGENT_MODEL").length - 1;
	assert.equal(occurrences, 1, "second pass must not add a second guard");
	assert.equal(
		twice.split(".string().trim().min(1)").length - 1,
		1,
		"second pass must not add a second model validation chain",
	);
	assert.equal(subagentModelTag.verify(twice, ast2), true);
});

test("subagent-model-tag ignores a model push with no dimColor in its element tree", async () => {
	const input = `
function renderRows(H) {
  let q = [];
  if (H.model && H.model !== "inherit") {
    q.push(C.jsx(P, { flexWrap: "nowrap", children: C.jsx(Y, { children: label(H.model) }) }, "model"));
  }
}
`;
	const ast = parse(input);
	await runSubagentModelTagViaPasses(ast);
	const output = print(ast);
	assert.equal(
		output.includes("!process.env.CLAUDE_CODE_SUBAGENT_MODEL"),
		false,
	);
	const verifyResult = subagentModelTag.verify(output, ast);
	assert.equal(typeof verifyResult, "string");
	assert.equal(String(verifyResult).includes("not found"), true);
});

test("subagent-model-tag emits the guard as the rightmost top-level && operand", async () => {
	const ast = parse(SUBAGENT_FIXTURE);
	await runSubagentModelTagViaPasses(ast);
	const output = print(ast);
	// The original test is `entry.model`; the guard must be appended on the RIGHT,
	// i.e. the whole test reads `entry.model && !process.env.CLAUDE_CODE_SUBAGENT_MODEL`,
	// never `!process.env.CLAUDE_CODE_SUBAGENT_MODEL && entry.model`.
	assert.equal(
		output.includes("entry.model && !process.env.CLAUDE_CODE_SUBAGENT_MODEL"),
		true,
		"guard must be the rightmost operand of the if test",
	);
	assert.equal(
		output.includes("!process.env.CLAUDE_CODE_SUBAGENT_MODEL && entry.model"),
		false,
		"guard must not be prepended as the left operand",
	);
	assert.equal(subagentModelTag.verify(output, ast), true);
});

test("subagent-model-tag verify rejects a wrong-polarity guard with no negation", () => {
	const input = `
function renderRows(entry, rows) {
  if (entry.model && process.env.CLAUDE_CODE_SUBAGENT_MODEL) {
    rows.push(R.jsx(Box, { children: R.jsx(Text, { dimColor: true, children: formatModel(entry.model) }) }, "model"));
  }
}
`;
	const ast = parse(input);
	const code = print(ast);
	const result = subagentModelTag.verify(code, ast);
	assert.notEqual(
		result,
		true,
		"a guard without ! must not be accepted as patched",
	);
	assert.equal(typeof result, "string");
});

test("subagent-model-tag fails closed on two structurally-distinct model-tag rows", async () => {
	const input = `
function renderHeaderRow(entry, rows) {
  if (entry.model && entry.model !== "inherit") {
    rows.push(C.jsx(B, { flexWrap: "nowrap", children: C.jsx(w, { dimColor: !0, children: label(entry.model) }) }, "model"));
  }
}
function renderFooterRow(item, out) {
  if (item.model) {
    out.push(R.jsx(Box, { children: R.jsx(Text, { dimColor: true, children: fmt(item.model) }) }, "model"));
  }
}
`;
	const ast = parse(input);
	await runSubagentModelTagViaPasses(ast);
	const output = print(ast);
	assert.equal(
		output.includes("!process.env.CLAUDE_CODE_SUBAGENT_MODEL"),
		false,
		"must not guess between two distinct candidate rows",
	);
	const verifyResult = subagentModelTag.verify(output, ast);
	assert.equal(typeof verifyResult, "string");
	assert.equal(String(verifyResult).includes("ambiguous"), true);
});
