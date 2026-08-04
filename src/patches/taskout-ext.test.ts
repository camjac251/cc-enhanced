import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { traverse } from "../babel.js";
import { parse, print } from "../loader.js";
import { taskOutputExt } from "./taskout-ext.js";

async function patchTaskOutputExtWithoutVerification(
	source: string,
): Promise<{ output: string; ast: ReturnType<typeof parse> }> {
	const stringPatched = taskOutputExt.string?.(source) ?? source;
	const ast = parse(stringPatched);
	const passes = (await taskOutputExt.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: taskOutputExt.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
	const output = print(ast);
	return { output, ast };
}

async function applyTaskOutputExtPatch(source: string): Promise<string> {
	const { output, ast } = await patchTaskOutputExtWithoutVerification(source);
	assert.equal(taskOutputExt.verify(output, ast), true);
	return output;
}

async function loadPatchedTaskOutputRuntimeModule() {
	const output = await applyTaskOutputExtPatch(TASK_OUTPUT_FIXTURE);
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "taskout-ext-"));
	const modulePath = path.join(tempDir, "patched-taskout-ext-runtime.mjs");
	await fs.writeFile(
		modulePath,
		`${output}
export { serializeTask, TaskOutputTool };`,
		"utf8",
	);
	const mod = await import(pathToFileURL(modulePath).href);
	return {
		mod,
		cleanup: async () => {
			await fs.rm(tempDir, { recursive: true, force: true });
		},
	};
}

const TASK_OUTPUT_SCHEMA_FIXTURE = `
function buildTaskOutputSchema() {
  return schema.strictObject({
    task_id: schema.string().describe("The task ID to get output from"),
    block: nullable(schema.boolean().default(true)).describe("Whether to wait for completion"),
    timeout: schema.number().min(0).max(600000).default(30000).describe("Max wait time in ms"),
  });
}
`;

const TASK_OUTPUT_FIXTURE = `
${TASK_OUTPUT_SCHEMA_FIXTURE}
const TASK_PROMPT = \`- Retrieves output from a running or completed task (background shell, agent, or remote session)
- Takes a task_id parameter identifying the task
- Returns the task output along with status information
- Use block=true (default) to wait for task completion
- Use block=false for non-blocking check of current status
- Task IDs can be found using the /tasks command
- Works with all task types: background shells, async agents, and remote sessions\`;

function serializeTask(task) {
  return {
    task_id: task.taskId,
    status: task.status,
    output: task.output,
  };
}

const TaskOutputTool = {
  name: "TaskOutput",
  get inputSchema() {
    return buildTaskOutputSchema();
  },
  prompt() {
    return TASK_PROMPT;
  },
  mapToolResultToToolResultBlockParam(result) {
    let output = [];
    if (result.task) {
      output.push(\`<task_id>\${result.task.task_id}</task_id>\`);
      output.push(\`<status>\${result.task.status}</status>\`);
    }
    if (result.task.error) {
      output.push(\`<error>\${result.task.error}</error>\`);
    }
    return output;
  },
};
`;

test("taskout-ext verify rejects the unpatched fixture", () => {
	const ast = parse(TASK_OUTPUT_FIXTURE);
	const result = taskOutputExt.verify(TASK_OUTPUT_FIXTURE, ast);
	assert.notEqual(result, true);
	assert.equal(typeof result, "string");
});

test("taskout-ext patches serializer fields, XML tags, and prompt guidance", async () => {
	const output = await applyTaskOutputExtPatch(TASK_OUTPUT_FIXTURE);

	assert.equal(output.includes("output_file"), true);
	assert.equal(output.includes("output_filename"), true);
	assert.equal(output.includes("<output_file>"), true);
	assert.equal(output.includes("<output_filename>"), true);
	assert.equal(
		output.includes(
			"TaskOutput returns accumulated output, not an unread-output delta",
		),
		true,
	);
	assert.equal(
		output.includes("Do not repeatedly call TaskOutput to follow logs"),
		true,
	);
	assert.equal(output.includes('Read the tail first: range "-500:"'), false);
});

test("taskout-ext runtime derives basename fallback and emits tags before task errors", async () => {
	const { mod, cleanup } = await loadPatchedTaskOutputRuntimeModule();
	try {
		const serialized = mod.serializeTask({
			taskId: "task-1",
			status: "done",
			output: "stdout",
			outputFile: "/tmp/logs/build.txt",
		});
		assert.equal(serialized.output_file, "/tmp/logs/build.txt");
		assert.equal(serialized.output_filename, "build.txt");

		const blocks = mod.TaskOutputTool.mapToolResultToToolResultBlockParam({
			task: {
				...serialized,
				output_filename: void 0,
				error: "boom",
			},
		});

		const outputFileIndex = blocks.findIndex((value: string) =>
			value.includes("<output_file>"),
		);
		const outputFilenameIndex = blocks.findIndex((value: string) =>
			value.includes("<output_filename>build.txt</output_filename>"),
		);
		const errorIndex = blocks.findIndex((value: string) =>
			value.includes("<error>boom</error>"),
		);

		assert.equal(outputFileIndex >= 0, true);
		assert.equal(outputFilenameIndex >= 0, true);
		assert.equal(errorIndex > outputFilenameIndex, true);
	} finally {
		await cleanup();
	}
});

test("taskout-ext verify fails when prompt guidance is removed", async () => {
	const output = await applyTaskOutputExtPatch(TASK_OUTPUT_FIXTURE);
	const regressed = output.replace(
		"output_filename for display labels",
		"display labels",
	);
	assert.notEqual(regressed, output);

	const result = taskOutputExt.verify(regressed, parse(regressed));
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("output_filename guidance"),
		true,
		`Expected prompt-guidance failure, got: ${result}`,
	);
});

test("taskout-ext patches a response method that nests tag pushes inside if(result.task)", async () => {
	const nestedFixture = `
${TASK_OUTPUT_SCHEMA_FIXTURE}
function serializeTask(task) {
  return { task_id: task.taskId, status: task.status, output: task.output };
}
const TaskOutputTool = {
  name: "TaskOutput",
  prompt() {
    return \`- Retrieves output from a running or completed task (background shell, agent, or remote session)
- Takes a task_id parameter identifying the task
- Returns the task output along with status information
- Use block=true (default) to wait for task completion
- Use block=false for non-blocking check of current status
- Task IDs can be found using the /tasks command
- Works with all task types: background shells, async agents, and remote sessions\`;
  },
  mapToolResultToToolResultBlockParam(result) {
    let output = [];
    output.push(\`<retrieval_status>\${result.retrieval_status}</retrieval_status>\`);
    if (result.task) {
      output.push(\`<task_id>\${result.task.task_id}</task_id>\`);
      output.push(\`<status>\${result.task.status}</status>\`);
      if (result.task.error) output.push(\`<error>\${result.task.error}</error>\`);
    }
    return output;
  },
};
`;
	const output = await applyTaskOutputExtPatch(nestedFixture);
	assert.equal(output.includes("<output_file>"), true);
	assert.equal(output.includes("<output_filename>"), true);
	const fileIdx = output.indexOf("<output_file>");
	const errIdx = output.indexOf("<error>");
	assert.equal(fileIdx >= 0 && errIdx >= 0 && fileIdx < errIdx, true);
});

test("taskout-ext injects output_file exactly once per surface", async () => {
	const output = await applyTaskOutputExtPatch(TASK_OUTPUT_FIXTURE);
	const serializerKeyCount = output.split("output_file:").length - 1;
	assert.equal(serializerKeyCount, 1);
	const openTagCount = output.split("<output_file>").length - 1;
	assert.equal(openTagCount, 1);
	const closeTagCount = output.split("</output_file>").length - 1;
	assert.equal(closeTagCount, 1);
});

test("taskout-ext runtime basename strips backslash path separators", async () => {
	const { mod, cleanup } = await loadPatchedTaskOutputRuntimeModule();
	try {
		const serialized = mod.serializeTask({
			taskId: "task-2",
			status: "done",
			output: "out",
			outputFile: "C:\\logs\\run.txt",
		});
		assert.equal(serialized.output_filename, "run.txt");
	} finally {
		await cleanup();
	}
});

test("taskout-ext rewrites the stock TaskOutput prompt body", async () => {
	const output = await applyTaskOutputExtPatch(TASK_OUTPUT_FIXTURE);
	assert.equal(
		output.includes("Returns the task output along with status information"),
		false,
	);
	assert.equal(
		output.includes(
			"status, exit_code, error, output, output_file, output_filename",
		),
		true,
	);
	assert.equal(
		output.includes(
			"Use the output_file path from the original background-task result or completion notification",
		),
		true,
	);
	assert.equal(
		output.includes(
			"Read persisted output with explicit non-overlapping ranges",
		),
		true,
	);
	assert.equal(output.includes('Read the tail first: range "-500:"'), false);
});

test("taskout-ext routes background execution by intent without licensing an immediate blocking wait", async () => {
	const output = await applyTaskOutputExtPatch(TASK_OUTPUT_FIXTURE);

	assert.equal(
		output.includes(
			"Immediate result: run Bash in the foreground with an appropriate timeout.",
		),
		true,
	);
	assert.equal(
		output.includes("Streaming output or a condition watch: use Monitor."),
		true,
	);
	assert.equal(
		output.includes(
			"Never start Bash with run_in_background=true and immediately call TaskOutput with block=true",
		),
		true,
	);
	assert.equal(
		output.includes("Use block=true only when deliberately waiting"),
		false,
	);
});

test("taskout-ext makes an omitted TaskOutput block request non-blocking", async () => {
	const output = await applyTaskOutputExtPatch(TASK_OUTPUT_FIXTURE);

	assert.equal(output.includes("schema.boolean().default(false)"), true);
	assert.equal(output.includes("schema.boolean().default(true)"), false);
});

test("taskout-ext verify rejects a blocking TaskOutput schema default", async () => {
	const output = await applyTaskOutputExtPatch(TASK_OUTPUT_FIXTURE);
	const regressed = output.replace(
		"schema.boolean().default(false)",
		"schema.boolean().default(true)",
	);
	assert.notEqual(regressed, output);

	const result = taskOutputExt.verify(regressed, parse(regressed));
	assert.equal(result, "TaskOutput block must default to false");
});

test("taskout-ext verify binds prompt guidance to the named TaskOutput tool", async () => {
	const output = await applyTaskOutputExtPatch(TASK_OUTPUT_FIXTURE);
	const unbound = output.replace('name: "TaskOutput"', 'name: "OtherTool"');
	assert.notEqual(unbound, output);

	const result = taskOutputExt.verify(unbound, parse(unbound));
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("named TaskOutput tool"), true);
});

test("taskout-ext verify rejects a surviving stock TaskOutput prompt body", async () => {
	const duplicateStockPrompt = `
const LEGACY_TASK_PROMPT = \`- Retrieves output from a running or completed task (background shell, agent, or remote session)
- Takes a task_id parameter identifying the task
- Returns the task output along with status information
- Use block=true (default) to wait for task completion
- Use block=false for non-blocking check of current status
- Task IDs can be found using the /tasks command
- Works with all task types: background shells, async agents, and remote sessions\`;
`;
	const { output, ast } = await patchTaskOutputExtWithoutVerification(
		`${TASK_OUTPUT_FIXTURE}\n${duplicateStockPrompt}`,
	);

	const result = taskOutputExt.verify(output, ast);
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("stock TaskOutput prompt"), true);
});

test("taskout-ext verify rejects weakened background execution guidance", async () => {
	const output = await applyTaskOutputExtPatch(TASK_OUTPUT_FIXTURE);
	const weakened = output.replace(
		"Immediate result: run Bash in the foreground with an appropriate timeout.",
		"Immediate result: choose any execution mode.",
	);
	assert.notEqual(weakened, output);

	const result = taskOutputExt.verify(weakened, parse(weakened));
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("background execution policy"), true);
});

test("taskout-ext ignores a task_id+status+output_file object that lacks a bare output key", async () => {
	// emit() returns a task_id+status+output_file object with NO bare `output`
	// key (the closest false-positive shape to the serializer). Only
	// serializeTask() carries the bare `output` triad the patch targets, so the
	// injection must land on it alone and leave emit() untouched.
	const notifFixture = `
${TASK_OUTPUT_SCHEMA_FIXTURE}
function emit(n) {
  return { type: "system", task_id: n.id, status: n.status, output_file: n.outputFile ?? "", summary: "" };
}
function serializeTask(task) {
  return { task_id: task.taskId, status: task.status, output: task.output };
}
const TaskOutputTool = {
  name: "TaskOutput",
  prompt() { return \`- Retrieves output from a running or completed task (background shell, agent, or remote session)
- Takes a task_id parameter identifying the task
- Returns the task output along with status information
- Use block=true (default) to wait for task completion
- Use block=false for non-blocking check of current status
- Task IDs can be found using the /tasks command
- Works with all task types: background shells, async agents, and remote sessions\`; },
  mapToolResultToToolResultBlockParam(result) {
    let output = [];
    if (result.task) { output.push(\`<task_id>\${result.task.task_id}</task_id>\`); output.push(\`<status>\${result.task.status}</status>\`); }
    if (result.task.error) output.push(\`<error>\${result.task.error}</error>\`);
    return output;
  },
};
`;
	const output = await applyTaskOutputExtPatch(notifFixture);

	// output_filename is injected only by the patch, only into the serializer.
	// Exactly one serializer-key occurrence proves the notification object was
	// not also latched onto.
	const filenameKeyCount = output.split("output_filename:").length - 1;
	assert.equal(
		filenameKeyCount,
		1,
		"output_filename injected exactly once, into the serializer not the notification",
	);

	// The notification object keeps its original `output_file: n.outputFile`
	// initializer and gains no output_filename of its own.
	assert.equal(
		output.includes('output_file: n.outputFile ?? ""'),
		true,
		"emit() notification object left untouched",
	);
});

test("taskout-ext output_file value targets the serialized task param", async () => {
	const output = await applyTaskOutputExtPatch(TASK_OUTPUT_FIXTURE);
	const ast = parse(output);
	let sawTargetedMember = false;
	traverse(ast, {
		ObjectProperty(p) {
			const k = p.node.key;
			const isKey =
				(k.type === "Identifier" && k.name === "output_file") ||
				(k.type === "StringLiteral" && k.value === "output_file");
			if (!isKey) return;
			const v = p.node.value;
			if (
				v.type === "MemberExpression" &&
				v.property.type === "Identifier" &&
				v.property.name === "outputFile"
			)
				sawTargetedMember = true;
		},
	});
	assert.equal(
		sawTargetedMember,
		true,
		"output_file must read <param>.outputFile, matching the real task object field",
	);
});
