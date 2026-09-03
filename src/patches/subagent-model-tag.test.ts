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
const AGENT_DESCRIPTION_TEXT = "A short (3-5 word) description of the task";
const AGENT_PROMPT_TEXT = "The task for the agent to perform";
const agentInputSchema = A.object({
  description: A.string().describe(AGENT_DESCRIPTION_TEXT),
  prompt: A.string().describe(AGENT_PROMPT_TEXT),
  subagent_type: A.string().optional().describe("The type of specialized agent to use for this task"),
  model: A.enum(["sonnet", "opus", "haiku", "fable"]).optional().describe('Optional model override for this agent. Takes precedence over the agent definition\'s model frontmatter. Ignored for subagent_type: "fork"; forks always inherit the parent model.'),
  run_in_background: A.boolean().optional(),
});
`;

const DIRECT_AGENT_SCHEMA_FIXTURE = String.raw`
const objectSchema = (shape) => shape;
const stringSchema = () => ({ trim() { return this; }, min() { return this; }, optional() { return this; }, describe() { return this; } });
const enumSchema = (values) => ({ optional() { return this; }, describe() { return this; } });
const booleanSchema = () => ({ optional() { return this; }, describe() { return this; } });
const agentInputSchema = objectSchema({
  description: stringSchema().describe("A short (3-5 word) description of the task"),
  prompt: stringSchema().describe("The task for the agent to perform"),
  subagent_type: stringSchema().optional().describe("The type of specialized agent to use for this task"),
  model: enumSchema(["sonnet", "opus", "haiku", "fable"]).optional().describe('Optional model override for this agent. Takes precedence over the agent definition\'s model frontmatter. Ignored for subagent_type: "fork"; forks always inherit the parent model.'),
  run_in_background: booleanSchema().optional(),
});
`;

const AGENT_LIFECYCLE_FIXTURE = `
const agentTool = {
  async call(
    {
      prompt,
      subagent_type,
      description,
      model,
      run_in_background,
      name,
      isolation,
      cwd,
    },
    context,
  ) {
    const parentModel = getParentModel(context);
    const isFork = subagent_type === "fork";
    if (name) {
      return spawnTeammate({
        name,
        prompt,
        description,
        use_splitpane: true,
        plan_mode_required: false,
        model,
        agent_type: configuredAgent?.agentType ?? subagent_type,
        invokingRequestId,
      }, context);
    }
    let selectedAgent;
    if (isFork) selectedAgent = forkAgent;
    else selectedAgent = configuredAgent;
    const selectedModel = isFork ? "inherit" : model;
    const resolvedModel = resolveAgentModel(
      getAgentModel(selectedAgent, parentModel),
      parentModel,
      selectedModel,
      permissionMode,
    );
    if (isRemote) {
      await createRemoteSession({
        initialMessage: prompt,
        source: "remote_agent",
        model: resolvedModel,
        ...withProactivity(permissionMode, state.proactivityLevel),
        branchName,
        signal,
        storageV5,
        credentials,
      });
    }
    const launchOptions = {
      agentDefinition: selectedAgent,
      promptMessages,
      toolUseContext: context,
      canUseTool,
      isAsync: run_in_background,
      querySource,
      spawnedBySkill,
      model: selectedModel,
      override,
      availableTools,
      description,
    };
    const launchMetadata = {
      prompt,
      resolvedAgentModel: resolvedModel,
      isBuiltInAgent,
      startTime,
      agentType: selectedAgent.agentType,
      isAsync: run_in_background,
      agentDepth,
      source: selectedAgent.source,
    };
    registerTask({ model: resolvedModel, selectedAgent });
    return runChild(launchOptions, launchMetadata);
  },
};

function spawnTeammateBackendA(input, context) {
  const state = context.getAppState();
  return reserveTeammate(async ({ teammateId }) => {
    return buildTeammateArguments({
      planModeRequired: input.plan_mode_required,
      permissionMode: state.toolPermissionContext.mode,
      proactivityLevel: state.proactivityLevel,
      sessionEffort: state.sessionEffort,
      skipModel: !!input.model,
    });
  });
}

function spawnTeammateBackendB(input, context) {
  const state = context.getAppState();
  return reserveTeammate(async ({ teammateId }) => {
    return buildTeammateArguments({
      planModeRequired: input.plan_mode_required,
      permissionMode: state.toolPermissionContext.mode,
      proactivityLevel: state.proactivityLevel,
      sessionEffort: state.sessionEffort,
      skipModel: !!input.model,
    });
  });
}

async function* runChild({ agentDefinition, model, extraMetadata }) {
  saveAgentMetadata(agentId, model !== undefined || extraMetadata !== undefined, {
    agentType: agentDefinition.agentType,
    ...(parentContext.agentId && { parentAgentId: parentContext.agentId }),
    ...(override?.agentContext !== undefined && { spawnDepth: getSpawnDepth(override.agentContext) }),
    ...(model && { model }),
    ...extraMetadata,
  });
}

function mirrorAgentMetadata(metadata) {
  return {
    type: "agent_metadata",
    agentType: metadata.agentType,
    ...(metadata.model && { model: metadata.model }),
    ...(metadata.permissionMode && { permissionMode: metadata.permissionMode }),
  };
}

async function resumeChild() {
  const metadata = await readAgentMetadata(agentId);
  const configuredAgent = getSelectedAgent(metadata);
  const isFork = metadata?.isFork === true;
  let selectedAgent =
    metadata?.agentType === defaultAgent.agentType && metadata?.isBuiltIn !== true
      ? configuredAgent
      : metadata?.isBuiltIn === true
        ? defaultAgent
        : configuredAgent ?? (isFork ? forkAgent : defaultAgent);
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

const CURRENT_SUBAGENT_FIXTURE = SUBAGENT_FIXTURE.replace(
	/function spawnTeammateBackendA[\s\S]+?(?=async function\* runChild)/,
	"",
);

// A resume-time wrapper re-exposes the selected agent through
// `cond ? { ...selectedAgent, effort } : selectedAgent` before the model
// resolver reads it, so the fork flag sits one binding level behind the model
// call. The matcher must see through this alias to keep the fork resume on the
// parent model. The added `effort` field is incidental: the matcher anchors on
// the spread-of-the-alias identity, not on the property name.
const SUBAGENT_FIXTURE_EFFORT_WRAPPED = SUBAGENT_FIXTURE.replace(
	"        : configuredAgent ?? (isFork ? forkAgent : defaultAgent);",
	"        : configuredAgent ?? (isFork ? forkAgent : defaultAgent);\n  const effortAgent = resumeOptions?.effort !== undefined ? { ...selectedAgent, effort: resumeOptions.effort } : selectedAgent;",
).replace(
	"const resolvedModel = resolveAgentModel(getAgentModel(selectedAgent, parentModel), parentModel, metadata?.isObserver ? void 0 : metadata?.model, permissionMode);",
	"const resolvedModel = resolveAgentModel(getAgentModel(effortAgent, parentModel), parentModel, metadata?.isObserver ? void 0 : metadata?.model, permissionMode);",
);

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

test("subagent-model-tag adds per-call effort without replacing the selected agent", async () => {
	const output = await patchSource(SUBAGENT_FIXTURE);

	assert.equal(
		output.includes(
			'effort: A.enum(["low", "medium", "high", "xhigh", "max"]).optional().describe',
		),
		true,
		"the Agent tool must accept every named Claude Code effort level",
	);
	assert.equal(
		output.includes("effort: __claudeCodeAgentEffortOverride"),
		true,
		"the Agent call must bind the per-call effort input",
	);
	assert.equal(
		output.includes("!isFork && __claudeCodeAgentEffortOverride !== void 0"),
		true,
		"forks must ignore a per-call effort override",
	);
	assert.equal(
		output.includes(
			"selectedAgent = { ...selectedAgent, effort: __claudeCodeAgentEffortOverride }",
		),
		true,
		"the effort override must clone the selected definition instead of changing its type",
	);
	assert.equal(output.includes("subagent_type"), true);
});

test("subagent-model-tag persists and restores per-call effort", async () => {
	const output = await patchSource(SUBAGENT_FIXTURE);

	assert.equal(
		output.includes(
			"extraMetadata: !isFork && __claudeCodeAgentEffortOverride !== void 0",
		),
		true,
		"launch metadata must carry the explicit effort for cold resume",
	);
	assert.equal(
		output.includes("metadata?.isFork !== true && metadata?.effort !== void 0"),
		true,
		"resume must restore effort only for a non-fork agent",
	);
	assert.equal(
		output.includes(
			"...(metadata.effort !== void 0 && { effort: metadata.effort })",
		),
		true,
		"the transcript metadata mirror must retain effort",
	);
	assert.equal(
		output.includes("effort: selectedAgent.effort"),
		true,
		"remote-agent creation must receive the resolved selected-agent effort",
	);
});

test("subagent-model-tag routes named teammates without replacing agent_type", async () => {
	const output = await patchSource(SUBAGENT_FIXTURE);

	assert.equal(
		output.includes("agent_type: configuredAgent?.agentType ?? subagent_type"),
		true,
		"the selected teammate agent type must remain unchanged",
	);
	assert.equal(
		output.includes("effort: __claudeCodeAgentEffortOverride"),
		true,
		"the Agent call must forward its effort override to teammate launch",
	);
	assert.equal(
		output.split('kind: "level", value: input.effort').length - 1,
		2,
		"both teammate backends must turn the named level into session effort",
	);
});

test("subagent-model-tag routes effort through the unified teammate launch", async () => {
	const output = await patchSource(CURRENT_SUBAGENT_FIXTURE);

	assert.equal(
		output.includes("agent_type: configuredAgent?.agentType ?? subagent_type"),
		true,
	);
	assert.equal(
		output.includes("effort: __claudeCodeAgentEffortOverride"),
		true,
	);
	assert.equal(subagentModelTag.verify(output, parse(output)), true);
});

test("subagent-model-tag verification rejects coordinated effort drift", async () => {
	const output = await patchSource(SUBAGENT_FIXTURE);
	const mutations = [
		[
			'["low", "medium", "high", "xhigh", "max"]',
			'["low", "medium", "high", "xhigh"]',
		],
		[
			"selectedAgent = { ...selectedAgent, effort: __claudeCodeAgentEffortOverride }",
			"selectedAgent = { effort: __claudeCodeAgentEffortOverride }",
		],
		["effort: selectedAgent.effort", 'effort: "high"'],
		[
			"...(metadata.effort !== void 0 && { effort: metadata.effort })",
			"...(metadata.model !== void 0 && { effort: metadata.model })",
		],
		[
			'kind: "level", value: input.effort',
			'kind: "inherit", value: input.effort',
		],
	] as const;

	for (const [expected, replacement] of mutations) {
		const mutated = output.replace(expected, replacement);
		assert.notEqual(mutated, output, `fixture output was missing: ${expected}`);
		assert.notEqual(
			subagentModelTag.verify(mutated, parse(mutated)),
			true,
			`verification accepted drift at: ${expected}`,
		);
	}
});

test("subagent-model-tag widens the latest direct-factory Agent schema", async () => {
	const input = SUBAGENT_FIXTURE.replace(
		AGENT_SCHEMA_FIXTURE,
		DIRECT_AGENT_SCHEMA_FIXTURE,
	);
	const ast = parse(input);
	await runSubagentModelTagViaPasses(ast);
	const output = print(ast);

	assert.match(
		output,
		/model: stringSchema\(\)\.trim\(\)\.min\(1\)\.optional\(\)\.describe/,
	);
	assert.equal(subagentModelTag.verify(output, parse(output)), true);
});

test("subagent-model-tag recognizes a compound Agent model description", async () => {
	const compoundSchema = AGENT_SCHEMA_FIXTURE.replace(
		`model: A.enum(["sonnet", "opus", "haiku", "fable"]).optional().describe('Optional model override for this agent. Takes precedence over the agent definition\\'s model frontmatter. Ignored for subagent_type: "fork"; forks always inherit the parent model.'),`,
		`model: A.enum(["sonnet", "opus", "haiku", "fable"]).optional().describe(
    \`Optional model override for this agent. Takes precedence over the agent definition's model frontmatter. Ignored for subagent_type: "fork"; forks always inherit the parent model.\` +
      (isCoordinator ? " Set only when explicitly requested." : "")
  ),`,
	);
	assert.notEqual(compoundSchema, AGENT_SCHEMA_FIXTURE);
	const input = SUBAGENT_FIXTURE.replace(AGENT_SCHEMA_FIXTURE, compoundSchema);
	const output = await patchSource(input);

	assert.match(output, /model: A\.string\(\)\.trim\(\)\.min\(1\)/);
	assert.match(
		output,
		/effort: A\.enum\(\["low", "medium", "high", "xhigh", "max"\]\)/,
	);
	assert.equal(subagentModelTag.verify(output, parse(output)), true);
});

test("subagent-model-tag keeps fork launches and resumes on the parent model", async () => {
	const output = await patchSource(SUBAGENT_FIXTURE);
	assert.equal(
		output.includes('isFork ? "inherit" : model'),
		true,
		"initial forks must use the upstream inherit model token",
	);
	assert.equal(
		output.split("isFork ? parentModel : resolveAgentModel").length - 1,
		1,
		"resumed forks must bypass the global subagent model override",
	);
	assert.equal(subagentModelTag.verify(output, parse(output)), true);
});

test("verify rejects partial fork inheritance", async () => {
	const output = await patchSource(SUBAGENT_FIXTURE);

	const missingForkLaunch = output.replace(
		'isFork ? "inherit" : model',
		"model",
	);
	assert.notEqual(missingForkLaunch, output);
	const forkResult = subagentModelTag.verify(
		missingForkLaunch,
		parse(missingForkLaunch),
	);
	assert.equal(typeof forkResult, "string");
	assert.equal(String(forkResult).includes("Fork launch"), true);
});

test("subagent-model-tag resolves fork resume through an effort-wrapper alias", async () => {
	assert.notEqual(
		SUBAGENT_FIXTURE_EFFORT_WRAPPED,
		SUBAGENT_FIXTURE,
		"the effort-wrapper fixture must actually differ from the base fixture",
	);
	const output = await patchSource(SUBAGENT_FIXTURE_EFFORT_WRAPPED);

	assert.equal(
		output.includes('isFork ? "inherit" : model'),
		true,
		"initial forks must use the upstream inherit model token",
	);
	assert.equal(
		output.split("isFork ? parentModel : resolveAgentModel").length - 1,
		1,
		"wrapper-fed resume forks must bypass the global subagent model override",
	);
	assert.equal(
		output.includes(
			"isFork ? parentModel : resolveAgentModel(getAgentModel(effortAgent, parentModel)",
		),
		true,
		"the resume fork bypass must wrap the resolver that reads the effort-wrapped agent",
	);
	assert.equal(
		subagentModelTag.verify(output, parse(output)),
		true,
		"verify must accept a fork resume resolved through the effort-wrapper alias",
	);
});

test("subagent-model-tag preserves the native child model persistence", async () => {
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

test("subagent-model-tag verify ignores the resume options model expression", async () => {
	const patchedAst = parse(SUBAGENT_FIXTURE);
	await runSubagentModelTagViaPasses(patchedAst);
	const patched = print(patchedAst);

	const driftedOptions = patched.replace(
		"model: metadata?.isObserver ? void 0 : metadata?.model",
		"model: void 0",
	);
	assert.notEqual(driftedOptions, patched);
	const driftedAst = parse(driftedOptions);
	assert.equal(
		subagentModelTag.verify(print(driftedAst), driftedAst),
		true,
		"the effort resume contract does not depend on the resume model expression",
	);
});

test("subagent-model-tag fails fork resume when the resolver override drifts", async () => {
	const patchedAst = parse(SUBAGENT_FIXTURE);
	await runSubagentModelTagViaPasses(patchedAst);
	const patched = print(patchedAst);

	const driftedResolver = patched.replace(
		"resolveAgentModel(getAgentModel(selectedAgent, parentModel), parentModel, metadata?.isObserver ? void 0 : metadata?.model, permissionMode)",
		"resolveAgentModel(getAgentModel(selectedAgent, parentModel), parentModel, void 0, permissionMode)",
	);
	assert.notEqual(driftedResolver, patched);
	const driftedAst = parse(driftedResolver);
	const result = subagentModelTag.verify(print(driftedAst), driftedAst);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("Fork resume"),
		true,
		"the fork-resume mutation locates its target through the resolver override shape",
	);
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
	)
		.replaceAll("AGENT_DESCRIPTION_TEXT", "DUPLICATE_AGENT_DESCRIPTION_TEXT")
		.replaceAll("AGENT_PROMPT_TEXT", "DUPLICATE_AGENT_PROMPT_TEXT");
	const ast = parse(`${SUBAGENT_FIXTURE}\n${duplicateSchema}`);
	await runSubagentModelTagViaPasses(ast);
	const output = print(ast);

	assert.equal(output.includes(".string().trim().min(1)"), false);
	const verifyResult = subagentModelTag.verify(output, ast);
	assert.equal(typeof verifyResult, "string");
	assert.equal(String(verifyResult).includes("ambiguous"), true);
});

test("subagent-model-tag widens an Agent model enum that adds an alias", async () => {
	const input = SUBAGENT_FIXTURE.replace(
		'"haiku", "fable"]',
		'"haiku", "fable", "future"]',
	);
	const ast = parse(input);
	await runSubagentModelTagViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes("model: A.string().trim().min(1).optional().describe"),
		true,
		"an enum that still lists every known alias is widened even with an added alias",
	);
	assert.equal(
		output.includes('"future"'),
		false,
		"widening discards the enum, including the added alias",
	);
	assert.equal(output.includes("full model ID available through /model"), true);
	assert.equal(subagentModelTag.verify(output, ast), true);
});

test("subagent-model-tag refuses an Agent model enum missing a known alias", async () => {
	const input = SUBAGENT_FIXTURE.replace(
		'A.enum(["sonnet", "opus", "haiku", "fable"])',
		'A.enum(["opus", "haiku", "fable"])',
	);
	const ast = parse(input);
	await runSubagentModelTagViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes(".string().trim().min(1)"),
		false,
		"an enum that drops a known alias is not recognized and stays unwidened",
	);
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
