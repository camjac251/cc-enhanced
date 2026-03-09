import assert from "node:assert/strict";
import { test } from "node:test";
import { promptRewrite } from "./prompt-rewrite.js";

test("prompt-rewrite rewrites agent search guidance and verifies", () => {
	const input = `
- Use \${qV} for broad file pattern matching
- Use \${OX} for searching file contents with regex
    `;
	const output = promptRewrite.string?.(input) ?? input;
	assert.equal(
		output.includes("available code/file search tooling for focused discovery"),
		true,
	);
	assert.equal(
		output.includes("available content-search tooling for targeted discovery"),
		true,
	);
	assert.equal(promptRewrite.verify(output), true);
});

test("prompt-rewrite verify tolerates missing agent section when upstream removed it", () => {
	const input = "const noop = true;";
	assert.equal(promptRewrite.verify(input), true);
});

test("prompt-rewrite verify fails when agent section exists but replacements are missing", () => {
	const unpatched = `
- Use \${qV} for broad file pattern matching
- Use \${OX} for searching file contents with regex
`;
	const result = promptRewrite.verify(unpatched);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes(
			"Missing neutral replacements for agent search prompts",
		),
		true,
	);
});

test("prompt-rewrite updates legacy Task-tool subagent description", () => {
	const unpatched =
		'describe("Information about an available subagent that can be invoked via the Task tool.")';
	const output = promptRewrite.string?.(unpatched) ?? unpatched;
	assert.equal(output.includes("invoked via the Task tool"), false);
	assert.equal(output.includes("invoked via the Agent tool"), true);
	assert.equal(promptRewrite.verify(output), true);
});
