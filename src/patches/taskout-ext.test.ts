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

async function applyTaskOutputExtPatch(source: string): Promise<string> {
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

const TASK_OUTPUT_FIXTURE = `
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
	assert.equal(output.includes("output_file path with the Read tool"), true);
	assert.equal(output.includes('Read the tail first: range "-500:"'), true);
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
function serializeTask(task) {
  return { task_id: task.taskId, status: task.status, output: task.output };
}
const TaskOutputTool = {
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
	assert.equal(output.includes('Read the tail first: range "-500:"'), true);
});

test("taskout-ext ignores a task_id+status+output_file object that lacks a bare output key", async () => {
	// emit() returns a task_id+status+output_file object with NO bare `output`
	// key (the closest false-positive shape to the serializer). Only
	// serializeTask() carries the bare `output` triad the patch targets, so the
	// injection must land on it alone and leave emit() untouched.
	const notifFixture = `
function emit(n) {
  return { type: "system", task_id: n.id, status: n.status, output_file: n.outputFile ?? "", summary: "" };
}
function serializeTask(task) {
  return { task_id: task.taskId, status: task.status, output: task.output };
}
const TaskOutputTool = {
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
