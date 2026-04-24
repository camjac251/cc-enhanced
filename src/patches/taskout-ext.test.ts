import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
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
