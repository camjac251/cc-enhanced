import assert from "node:assert/strict";
import { test } from "node:test";
import { todo } from "./todo-use.js";

const TODO_FIXTURE = `## Examples of When to Use the Todo List
- Old use example 1
- Old use example 2
## Examples of When NOT to Use the Todo List
- Old skip example 1
- Old skip example 2
## Task States and Management
- next section content`;

const TODO_FIXTURE_WITH_QUOTE_EXAMPLES = `## Examples of When to Use the Todo List
- Old use example 1
- Old use example 2
## Examples of When NOT to Use the Todo List

<example>
User: How do I print 'Hello World' in Python?
Assistant: In Python, you can print "Hello World" with this simple code:

python
print("Hello World")
</example>

<example>
User: What does the git status command do?
Assistant: The git status command shows...
</example>
## Task States and Management
- next section content`;

test("verify rejects unpatched code", () => {
	const result = todo.verify(TODO_FIXTURE);
	assert.notEqual(
		result,
		true,
		"verify should reject unpatched code but got true",
	);
	assert.equal(typeof result, "string");
});

test("todo-use rewrites NOT-to-use section terminated by next heading", () => {
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

test("todo-use rewrites NOT-to-use section when examples contain quote chars", () => {
	const input = TODO_FIXTURE_WITH_QUOTE_EXAMPLES;

	const output = todo.string?.(input) ?? input;

	// The bug: a permissive lookahead like (?=\n## |["'`]|$) terminates on the
	// first quote inside <example>, leaving stale prose behind. The fixed
	// regex anchors on the next stable heading.
	assert.equal(
		output.includes(
			"Skip it for quick, single-step tasks where tracking would add overhead.",
		),
		true,
		"condensed skip-section first bullet should be present",
	);
	assert.equal(
		output.includes("Hello World"),
		false,
		"stale upstream <example> dialogue should be fully replaced, not partial",
	);
	assert.equal(
		output.includes("<example>"),
		false,
		"stale <example> blocks should not survive the rewrite",
	);
	assert.equal(
		output.includes("git status command do?"),
		false,
		"stale second <example> dialogue should not survive",
	);
	assert.equal(todo.verify(output), true);
});

test("todo-use verify rejects partially-replaced NOT-to-use section", () => {
	// Simulates the BROKEN-pre-fix state: condensed prose injected, but stale
	// <example> blocks survive because the regex stopped at a quote char.
	const partial = `## Examples of When to Use the Todo List
- Reach for it when the user hands you multiple related tasks or explicitly asks for tracking.
- Keep items current as you work so the list reflects real progress.
## Examples of When NOT to Use the Todo List
- Skip it for quick, single-step tasks where tracking would add overhead.
- Clear stale entries so the list only mirrors the active work.

<example>
User: How do I print 'Hello World' in Python?
</example>
## Task States and Management
- content`;

	const verifyResult = todo.verify(partial);
	assert.equal(
		typeof verifyResult,
		"string",
		"verify must reject partially-replaced output where stale examples survive",
	);
	assert.equal(
		String(verifyResult).toLowerCase().includes("stale"),
		true,
		`expected stale-prose error, got: ${verifyResult}`,
	);
});

test("todo-use verify fails when NOT-to-use replacement is missing", () => {
	const broken = `## Examples of When to Use the Todo List
- Reach for it when the user hands you multiple related tasks or explicitly asks for tracking.
- Keep items current as you work so the list reflects real progress.
## Examples of When NOT to Use the Todo List
- Old skip example
## Task States and Management
- content`;

	const verifyResult = todo.verify(broken);
	assert.equal(typeof verifyResult, "string");
	assert.equal(String(verifyResult).includes("NOT-to-use"), true);
});
