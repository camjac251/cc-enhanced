import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { workflowInlineAllow } from "./workflow-inline-allow.js";

async function patchSource(source: string): Promise<string> {
	const ast = parse(source);
	const passes = (await workflowInlineAllow.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: workflowInlineAllow.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
	return print(ast);
}

const WORKFLOW_PERMISSION_FIXTURE = `
const workflowToolName = "Workflow";
const workflowTool = {
  name: workflowToolName,
  aliases: ["RunWorkflow"],
  async validateInput(input, context) {
    return { result: true };
  },
  userFacingName() {
    return "Workflow";
  },
  async checkPermissions(input, context) {
    const lookupRule = getWorkflowRuleLookup(context, input.name);
    let resolvedInput = input;
    if (input.scriptPath) {
      resolvedInput = { ...input, script: loadWorkflowScript(input.scriptPath) };
    }
    const askRule = lookupRule("ask");
    if (askRule) {
      return {
        behavior: "ask",
        message: "Review dynamic workflow before running",
        updatedInput: resolvedInput,
        decisionReason: { type: "rule", rule: askRule },
      };
    }
    const allowRule = lookupRule("allow");
    if (allowRule) {
      return {
        behavior: "allow",
        updatedInput: resolvedInput,
        decisionReason: { type: "rule", rule: allowRule },
      };
    }
    return {
      behavior: "ask",
      message: "Review dynamic workflow before running",
      updatedInput: resolvedInput,
    };
  },
};
`;

test("workflow-inline-allow gates inline scripts behind an env flag", async () => {
	const patched = await patchSource(WORKFLOW_PERMISSION_FIXTURE);
	assert.equal(
		patched.includes(
			'process.env.CLAUDE_CODE_ALLOW_DYNAMIC_WORKFLOWS === "1" && input.script && input.name === void 0 && input.scriptPath === void 0',
		),
		true,
	);
	assert.equal(
		patched.includes(
			"(await this.validateInput(input, context)).result === true",
		),
		true,
		"the exact post-hook input must pass Workflow validation",
	);
	assert.equal(
		patched.includes('behavior: "allow"') &&
			patched.includes("updatedInput: input"),
		true,
	);
	assert.equal(
		patched.includes('message: "Review dynamic workflow before running"'),
		true,
		"the normal review path must remain for sessions without the opt-in",
	);
	const repatched = await patchSource(patched);
	assert.equal(
		repatched.split("CLAUDE_CODE_ALLOW_DYNAMIC_WORKFLOWS").length - 1,
		1,
		"inline Workflow permission opt-in must be idempotent",
	);
	assert.equal(workflowInlineAllow.verify(repatched), true);
});

for (const excludedSourceProperty of ["name", "scriptPath"]) {
	test(`verify rejects a Workflow opt-in guard without the ${excludedSourceProperty} exclusion`, async () => {
		const patched = await patchSource(WORKFLOW_PERMISSION_FIXTURE);
		const incomplete = patched.replace(
			` && input.${excludedSourceProperty} === void 0`,
			"",
		);
		assert.notEqual(incomplete, patched);
		assert.equal(
			workflowInlineAllow.verify(incomplete),
			"Inline Workflow scripts do not honor the explicit environment opt-in",
		);
	});
}

test("verify rejects a Workflow guard without post-hook validation", async () => {
	const patched = await patchSource(WORKFLOW_PERMISSION_FIXTURE);
	const incomplete = patched.replace(
		" && (await this.validateInput(input, context)).result === true",
		"",
	);
	assert.notEqual(incomplete, patched);
	assert.equal(
		workflowInlineAllow.verify(incomplete),
		"Inline Workflow scripts do not honor the explicit environment opt-in",
	);
});

test("ignores lookalike Workflow permission methods on another tool", async () => {
	const lookalike = WORKFLOW_PERMISSION_FIXTURE.replace(
		"name: workflowToolName",
		'name: "OtherTool"',
	);
	const patched = await patchSource(lookalike);
	assert.equal(patched.includes("CLAUDE_CODE_ALLOW_DYNAMIC_WORKFLOWS"), false);
});

test("verify rejects ambiguous Workflow permission sites", async () => {
	const duplicate = WORKFLOW_PERMISSION_FIXTURE.replaceAll(
		"workflowTool",
		"secondWorkflowTool",
	);
	const ast = parse(`${WORKFLOW_PERMISSION_FIXTURE}\n${duplicate}`);
	const code = await patchSource(print(ast));
	assert.equal(
		workflowInlineAllow.verify(code),
		"Inline Workflow permission site is ambiguous or missing (2 sites found)",
	);
});

test("verify rejects an unpatched Workflow permission site", () => {
	assert.equal(
		workflowInlineAllow.verify(WORKFLOW_PERMISSION_FIXTURE),
		"Inline Workflow scripts do not honor the explicit environment opt-in",
	);
});
