import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { workflowSafety } from "./workflow-safety.js";

const FIXTURE = `
async function* runChild({
  agentDefinition,
  model,
  extraMetadata,
  spawnedByWorkflowRunId,
}) {
  writeTranscript(agentId).catch(reportTranscriptError),
  saveAgentMetadata(agentId, model !== undefined || extraMetadata !== undefined, {
    agentType: agentDefinition.agentType,
    ...(parentContext.agentId && { parentAgentId: parentContext.agentId }),
    ...(override?.agentContext !== undefined && { spawnDepth: getSpawnDepth(override.agentContext) }),
    ...(model && { model }),
    ...extraMetadata,
  }).catch(reportMetadataError);
}

const sendMessageTool = makeTool({
  async call(input, context, canUseTool, options) {
    if (context.agentId !== undefined && isObserver(context.agentId)) {
      return { data: { success: false, message: "Observers report via ObserverReport, not SendMessage. SendMessage is not available from an observer." } };
    }
    const resolved = await resolveTarget(input.to);
    if (resolved.kind === "agent-live" || resolved.kind === "agent-stopped" || resolved.kind === "agent-evicted") {
      let metadata;
      try {
        metadata = await readAgentMetadata(agentPath(resolved.agentId));
      } catch {
        return hiddenAgentResult;
      }
      if (metadata?.isObserver) return hiddenAgentResult;
    }
    switch (resolved.kind) {
      case "agent-live":
        queueMessage(resolved.agentId, input.message);
        return { data: { success: true, message: "Message queued for delivery to worker at its next tool round." } };
      case "agent-stopped":
        return resumeAgent(resolved.agentId, input.message);
      case "agent-evicted":
        return { data: { success: true, message: "Agent had no active task; resumed from transcript with your message." } };
    }
  },
});

function compileStructuredOutput(schema) {
  const validate = compile(schema);
  return {
    tool: {
      async call(input) {
        if (!validate(input)) {
          let errors = validate.errors?.map((error) => (error.instancePath || "root") + ": " + error.message).join(", ");
          let keywords = validate.errors?.map((error) => error.keyword).join(",");
          throw new ToolError(
            "Output does not match required schema: " + errors,
            "StructuredOutput schema mismatch: " + (keywords ?? ""),
          );
        }
        return { data: "Structured output provided successfully", structured_output: input };
      },
    },
  };
}
`;

async function patch(source: string): Promise<string> {
	const ast = parse(source);
	const passes = (await workflowSafety.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: workflowSafety.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
	return print(ast);
}

test("workflow-safety rejects an unpatched bundle", () => {
	const ast = parse(FIXTURE);
	const result = workflowSafety.verify(print(ast), ast);
	assert.equal(typeof result, "string");
});

test("workflow-safety persists ownership and rejects cross-lifecycle messages", async () => {
	const output = await patch(FIXTURE);

	assert.match(
		output,
		/\.\.\.\(spawnedByWorkflowRunId && \{\s*spawnedByWorkflowRunId: spawnedByWorkflowRunId\s*\}\)/,
	);
	assert.equal(
		output.includes(
			"Workflow-owned agents cannot receive SendMessage deliveries or resumes.",
		),
		true,
	);
	assert.match(output, /await\s+saveAgentMetadata\(/);
	assert.match(output, /reportMetadataError\(_?metadataError\)/);
	assert.match(output, /if \(spawnedByWorkflowRunId\) throw _?metadataError/);
	assert.match(output, /if \(!metadata\)\s*return hiddenAgentResult/);
	assert.equal(output.split("writeTranscript(agentId)").length - 1, 1);
	assert.equal(
		output.includes("Message queued for delivery to worker"),
		true,
		"normal live-agent delivery behavior must remain available",
	);
	assert.equal(workflowSafety.verify(output, parse(output)), true);
});

test("workflow-safety gives actionable guidance for XML-wrapped required fields", async () => {
	const output = await patch(FIXTURE);

	assert.equal(
		output.includes(
			"One or more required properties are embedded as XML-like tags inside another string.",
		),
		true,
	);
	assert.match(output, /_?schemaError\.keyword === "required"/);
	assert.match(output, /_?schemaValue\.includes/);
	assert.match(output, /"<" \+ _?schemaError\.params\.missingProperty \+ ">"/);
	assert.equal(workflowSafety.verify(output, parse(output)), true);
});

test("workflow-safety is idempotent", async () => {
	const once = await patch(FIXTURE);
	const twice = await patch(once);

	assert.equal(
		twice.split("Workflow-owned agents cannot receive SendMessage").length - 1,
		1,
	);
	assert.equal(
		twice.split("One or more required properties are embedded as XML-like tags")
			.length - 1,
		1,
	);
	assert.equal(twice.split("spawnedByWorkflowRunId &&").length - 1, 1);
	assert.equal(twice.match(/await\s+saveAgentMetadata/g)?.length, 1);
	assert.equal(twice.split("if (!metadata)").length - 1, 1);
	assert.equal(twice.split("writeTranscript(agentId)").length - 1, 1);
	assert.equal(workflowSafety.verify(twice, parse(twice)), true);
});

test("workflow-safety fails closed when the SendMessage surface is ambiguous", async () => {
	const duplicate = FIXTURE.replace(
		"const sendMessageTool =",
		"const duplicateSendMessageTool =",
	);
	const output = await patch(`${FIXTURE}\n${duplicate}`);

	assert.equal(
		output.includes("Workflow-owned agents cannot receive SendMessage"),
		false,
	);
	const result = workflowSafety.verify(output, parse(output));
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("ambiguous"), true);
});

test("workflow-safety ignores unrelated schema errors", async () => {
	const decoy = `
const unrelated = {
  async call(input) {
    if (!check(input)) {
      throw new Error("Output does not match required schema: unrelated");
    }
  },
};`;
	const output = await patch(`${FIXTURE}\n${decoy}`);

	assert.equal(
		output.split(
			"One or more required properties are embedded as XML-like tags",
		).length - 1,
		1,
	);
	assert.equal(workflowSafety.verify(output, parse(output)), true);
});
