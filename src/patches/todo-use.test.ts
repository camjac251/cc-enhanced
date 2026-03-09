import assert from "node:assert/strict";
import { test } from "node:test";
import { todo } from "./todo-use.js";

const TODO_FIXTURE = `## Examples of When to Use the Todo List
- Old use example 1
- Old use example 2
## Examples of When NOT to Use the Todo List
- Old skip example 1
- Old skip example 2`;

test("verify rejects unpatched code", () => {
	const result = todo.verify(TODO_FIXTURE);
	assert.notEqual(
		result,
		true,
		"verify should reject unpatched code but got true",
	);
	assert.equal(typeof result, "string");
});

test("todo-use rewrites NOT-to-use section when it is terminal", () => {
	const input = TODO_FIXTURE;

	const output = todo.string?.(input) ?? input;

	assert.equal(
		output.includes(
			"Reach for it when the user hands you multiple related tasks",
		),
		true,
	);
	assert.equal(
		output.includes(
			"Skip it for quick, single-step tasks where tracking would add overhead.",
		),
		true,
	);
	assert.equal(output.includes("- Old use example 1"), false);
	assert.equal(output.includes("- Old skip example 1"), false);
	assert.equal(todo.verify(output), true);
});

test("todo-use verify fails when NOT-to-use replacement is missing", () => {
	const broken = `## Examples of When to Use the Todo List
- Reach for it when the user hands you multiple related tasks or explicitly asks for tracking.
## Examples of When NOT to Use the Todo List
- Old skip example`;

	const verifyResult = todo.verify(broken);
	assert.equal(typeof verifyResult, "string");
	assert.equal(String(verifyResult).includes("NOT-to-use"), true);
});
