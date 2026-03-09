import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { taskOutputTool } from "./taskout-ext.js";

async function runTaskOutputViaPasses(ast: any): Promise<void> {
	const passes = (await taskOutputTool.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: taskOutputTool.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

function applyStringPatch(input: string): string {
	assert.equal(typeof taskOutputTool.string, "function");
	return taskOutputTool.string?.(input) ?? input;
}

// Minimal fixture covering the structures the patch mutates:
// 1. var X = "TaskOutput" (rename to TaskStatus)
// 2. aliases: ["AgentOutputTool", "BashOutputTool"] (empty it)
// 3. Task serializer object with task_id, status, output (add output_file, output_filename)
// 4. mapToolResultToToolResultBlockParam method with <task_id>/<status> tags (add output_file/filename tags)
// 5. if (A.task.output?.trim()) B.push(`<output>...`) (replace with summary + tools)
// 6. String patches for prompt text
const TASKOUT_FIXTURE = `
var taskToolName = "TaskOutput";

var taskToolDef = {
  aliases: ["AgentOutputTool", "BashOutputTool"],
  name: taskToolName
};

function serializeTask(H) {
  let result = {
    task_id: H.id,
    task_type: H.type,
    status: H.status,
    output: H.output
  };
  return result;
}

var taskTool = {
  mapToolResultToToolResultBlockParam(A) {
    let B = [];
    if (A.task) {
      B.push(\`<task_id>\${A.task.task_id}</task_id>\`);
      B.push(\`<status>\${A.task.status}</status>\`);
      if (A.task.error) {
        B.push(\`<error>\${A.task.error}</error>\`);
      }
    }
    if (A.task.output?.trim()) B.push(\`<output>\${A.task.output}</output>\`);
    return [{ type: "text", text: B.join("\\n") }];
  }
};

function getUserFacingName() {
  return "Task Output";
}

function getDescription() {
  return "Retrieves output from a running or completed task";
}

function getPrompt() {
  return \`- Retrieves output from a running or completed task (background shell, agent, or remote session)
- Takes a task_id parameter identifying the task
- Returns the task output along with status information
- Use block=true (default) to wait for task completion
- Use block=false for non-blocking check of current status
- Task IDs can be found using the /tasks command
- Works with all task types: background shells, async agents, and remote sessions\`;
}

var guidance1 = "Use TaskOutput to read the output later";
var guidance2 = "You can check its output using the TaskOutput tool";
`;

test("taskout-ext renames TaskOutput to TaskStatus and adds output_file/output_filename", async () => {
	// String patch runs first in real pipeline; simulate it here
	const stringPatched = applyStringPatch(TASKOUT_FIXTURE);
	const ast = parse(stringPatched);
	await runTaskOutputViaPasses(ast);
	const output = print(ast);

	// 1. TaskOutput renamed to TaskStatus
	assert.equal(
		output.includes('"TaskStatus"'),
		true,
		"TaskOutput should be renamed to TaskStatus",
	);
	assert.equal(
		output.includes('"TaskOutput"'),
		false,
		"TaskOutput literal should be gone",
	);

	// 2. Aliases array should be empty
	assert.equal(
		output.includes('"AgentOutputTool"'),
		false,
		"AgentOutputTool alias should be removed",
	);
	assert.equal(
		output.includes('"BashOutputTool"'),
		false,
		"BashOutputTool alias should be removed",
	);

	// 3. Task serializer should have output_file and output_filename
	assert.equal(
		output.includes("output_file:"),
		true,
		"output_file property should be added",
	);
	assert.equal(
		output.includes("output_filename:"),
		true,
		"output_filename property should be added",
	);
	// output_file should reference H.outputFile (the enclosing function's first param)
	assert.equal(
		output.includes("H.outputFile"),
		true,
		"output_file should reference H.outputFile",
	);
});

test("taskout-ext adds <output_file> and <output_filename> tags to response payload", async () => {
	const stringPatched = applyStringPatch(TASKOUT_FIXTURE);
	const ast = parse(stringPatched);
	await runTaskOutputViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes("<output_file>"),
		true,
		"<output_file> tag should be added",
	);
	assert.equal(
		output.includes("</output_file>"),
		true,
		"</output_file> closing tag",
	);
	assert.equal(
		output.includes("<output_filename>"),
		true,
		"<output_filename> tag should be added",
	);
	assert.equal(
		output.includes("</output_filename>"),
		true,
		"</output_filename> closing tag",
	);
});

test("taskout-ext replaces inline <output> push with summary+tools payload", async () => {
	const stringPatched = applyStringPatch(TASKOUT_FIXTURE);
	const ast = parse(stringPatched);
	await runTaskOutputViaPasses(ast);
	const output = print(ast);

	// The old inline <output> push should be gone
	assert.equal(
		output.includes("<output>${A.task.output}</output>"),
		false,
		"inline <output> template should be replaced",
	);

	// New summary/tools structure should be present
	assert.equal(
		output.includes("<summary>"),
		true,
		"<summary> tag should be present",
	);
	assert.equal(
		output.includes("<summary_chars>"),
		true,
		"<summary_chars> tag should be present",
	);
	assert.equal(
		output.includes("<summary_truncated>"),
		true,
		"<summary_truncated> tag should be present",
	);
	assert.equal(
		output.includes("<tools>"),
		true,
		"<tools> tag should be present",
	);
	assert.equal(
		output.includes("[middle truncated]"),
		true,
		"truncation marker should be present",
	);
});

test("taskout-ext string patch updates prompt text", () => {
	const result = applyStringPatch(TASKOUT_FIXTURE);

	// userFacingName updated
	assert.equal(
		result.includes('return "Task Status"'),
		true,
		"userFacingName should be updated",
	);
	assert.equal(
		result.includes('return "Task Output"'),
		false,
		"old userFacingName should be gone",
	);

	// description updated
	assert.equal(
		result.includes('return "Check status of a background task"'),
		true,
		"description should be updated",
	);
	assert.equal(
		result.includes(
			'return "Retrieves output from a running or completed task"',
		),
		false,
		"old description should be gone",
	);

	// prompt updated
	assert.equal(
		result.includes("summary is preview-only, not full raw output"),
		true,
		"new prompt guidance should be present",
	);
	assert.equal(
		result.includes("Use output_filename for display/log labels"),
		true,
		"output_filename guidance should be present",
	);

	// Legacy references cleaned up
	assert.equal(
		result.includes("Use TaskOutput to read the output later"),
		false,
		"legacy TaskOutput guidance should be replaced",
	);
	assert.equal(
		result.includes("Use TaskStatus to check status, Read tool for output"),
		true,
		"replacement TaskStatus guidance should be present",
	);
	assert.equal(
		result.includes("You can check its output using the TaskOutput tool"),
		false,
		"legacy TaskOutput tool reference should be replaced",
	);
	assert.equal(
		result.includes("Check status with TaskStatus, read output with Read tool"),
		true,
		"replacement TaskStatus tool reference should be present",
	);
});

test("taskout-ext verify returns true on fully patched AST", async () => {
	const stringPatched = applyStringPatch(TASKOUT_FIXTURE);
	const ast = parse(stringPatched);
	await runTaskOutputViaPasses(ast);
	const output = print(ast);

	const result = taskOutputTool.verify(output, ast);
	assert.equal(result, true);
});

test("taskout-ext verify detects unpatched fixture (TaskOutput not renamed)", () => {
	const ast = parse(TASKOUT_FIXTURE);
	const result = taskOutputTool.verify(print(ast), ast);
	assert.equal(
		typeof result,
		"string",
		"verify should fail on unpatched fixture",
	);
	assert.equal(
		String(result).includes("TaskOutput not renamed to TaskStatus"),
		true,
		"failure should mention rename",
	);
});

test("taskout-ext verify detects missing output_file in serializer", async () => {
	// Only run string patch (renames TaskOutput), skip AST patches
	const stringPatched = applyStringPatch(TASKOUT_FIXTURE);
	const ast = parse(stringPatched);
	// Do NOT run AST passes -- serializer won't get output_file
	const output = print(ast);

	// Manually inject TaskStatus string to pass the first check
	const withRename = output.replace('"TaskOutput"', '"TaskStatus"');
	const renamedAst = parse(withRename);
	const result = taskOutputTool.verify(withRename, renamedAst);
	assert.equal(
		typeof result,
		"string",
		"verify should fail without output_file",
	);
	assert.equal(
		String(result).includes("output_file"),
		true,
		"failure should mention output_file",
	);
});

test("taskout-ext verify detects legacy alias array", async () => {
	// Fully patch, then re-inject legacy aliases
	const stringPatched = applyStringPatch(TASKOUT_FIXTURE);
	const ast = parse(stringPatched);
	await runTaskOutputViaPasses(ast);
	const output = print(ast);

	const tampered = output.replace(
		"aliases: []",
		'aliases: ["AgentOutputTool", "BashOutputTool"]',
	);
	const tamperedAst = parse(tampered);
	const result = taskOutputTool.verify(tampered, tamperedAst);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("AgentOutputTool/BashOutputTool"),
		true,
		"should flag legacy alias pair",
	);
});

test("taskout-ext verify detects legacy output push template", async () => {
	// Fully patch, then re-inject an <output> push
	const stringPatched = applyStringPatch(TASKOUT_FIXTURE);
	const ast = parse(stringPatched);
	await runTaskOutputViaPasses(ast);
	const output = print(ast);

	// Insert it as a proper push call so the verifier's push-template check finds it
	const withPush = `${output}
B.push(\`<output>\${A.task.output}</output>\`);
`;
	const pushAst = parse(withPush);
	const result = taskOutputTool.verify(withPush, pushAst);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("inline <output>"),
		true,
		"should flag remaining <output> push template",
	);
});

test("taskout-ext verify returns failure string when AST is missing", () => {
	const result = taskOutputTool.verify("some code");
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("Missing AST"), true);
});

test("taskout-ext patch is idempotent (double-run does not duplicate properties)", async () => {
	const stringPatched = applyStringPatch(TASKOUT_FIXTURE);
	const ast1 = parse(stringPatched);
	await runTaskOutputViaPasses(ast1);
	const output1 = print(ast1);

	// Parse the patched output and run AST passes again
	const ast2 = parse(output1);
	await runTaskOutputViaPasses(ast2);
	const output2 = print(ast2);

	// Count occurrences of output_file: to ensure no duplication
	const outputFileCount = (output2.match(/output_file:/g) || []).length;
	const outputFilenameCount = (output2.match(/output_filename:/g) || []).length;

	// There should be exactly one of each in the serializer (plus possibly in the map method tags)
	// The serializer object should not have duplicates
	assert.equal(
		outputFileCount >= 1 && outputFileCount <= 3,
		true,
		`output_file should appear 1-3 times (serializer + tags), got ${outputFileCount}`,
	);
	assert.equal(
		outputFilenameCount >= 1 && outputFilenameCount <= 3,
		true,
		`output_filename should appear 1-3 times (serializer + tags), got ${outputFilenameCount}`,
	);

	// Verify still passes after double application
	const result = taskOutputTool.verify(output2, ast2);
	assert.equal(result, true);
});
