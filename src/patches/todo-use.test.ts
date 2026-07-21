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

test("todo-use no-ops and verify fails if the use-section heading is renamed", () => {
	const renamed = TODO_FIXTURE.replace(
		"## Examples of When to Use the Todo List",
		"## Examples Of Using The Todo List",
	);
	const output = todo.string?.(renamed) ?? renamed;
	// string() guards on the exact TRIGGER, so a renamed heading is a no-op
	assert.equal(
		output,
		renamed,
		"string() must not partially rewrite a renamed heading",
	);
	assert.equal(
		output.includes("Reach for it when the user hands you multiple"),
		false,
		"condensed bullets must not appear when the trigger heading drifted",
	);
});

test("todo-use leaves stale skip examples and verify fails if the next-section heading is renamed", () => {
	const renamed = TODO_FIXTURE_WITH_QUOTE_EXAMPLES.replace(
		"## Task States and Management",
		"## Task State Management",
	);
	const output = todo.string?.(renamed) ?? renamed;
	// skipRegex lookahead no longer matches, so the example block survives
	assert.equal(
		output.includes("<example>"),
		true,
		"renamed next-section heading should leave the skip examples uncaptured",
	);
	assert.notEqual(
		todo.verify(output),
		true,
		"verify must reject when stale skip examples survive due to drifted terminator",
	);
});

test("todo-use replaces the whole skip block including template exprs and nested reasoning", () => {
	const upstreamShape = `## Examples of When to Use the Todo List
- Old use example 1
## Examples of When NOT to Use the Todo List

<example>
User: How do I print 'Hello World' in Python?
Assistant: * Uses the ${"${p4}"} tool *

<reasoning>
The assistant did not use the todo list because it is trivial.
</reasoning>
</example>
## Task States and Management
- next section content`;
	const output = todo.string?.(upstreamShape) ?? upstreamShape;
	assert.equal(
		output.includes("${p4}"),
		false,
		"embedded template expr must be dropped by whole-block replacement",
	);
	assert.equal(
		output.includes("<reasoning>"),
		false,
		"nested reasoning block must be dropped",
	);
	assert.equal(
		output.includes("<example>"),
		false,
		"example block must be dropped",
	);
	assert.equal(
		output.includes(
			"Skip it for quick, single-step tasks where tracking would add overhead.",
		),
		true,
		"condensed skip bullet must be present",
	);
	assert.equal(todo.verify(output), true);
});

test("todo-use fixture headings are unique (drift guard)", () => {
	const count = (s: string, sub: string) => s.split(sub).length - 1;
	assert.equal(
		count(TODO_FIXTURE, "## Examples of When to Use the Todo List"),
		1,
	);
	assert.equal(
		count(TODO_FIXTURE, "## Examples of When NOT to Use the Todo List"),
		1,
	);
	assert.equal(count(TODO_FIXTURE, "## Task States and Management"), 1);
});

test("todo-use verify flags neighbor-present-but-headings-missing as drift", () => {
	// The durable neighbor heading survives, but both example headings were
	// reworded away, so every heading-gated check would be skipped.
	const noSection = `## Task Rules
Some prose.
## Task States and Management
More prose.`;
	const result = todo.verify(noSection);
	assert.notEqual(
		result,
		true,
		"verify must flag bundle drift when the example headings vanished",
	);
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("example headings are missing"), true);
});

test("todo-use stale-prose guard matches the upstream npm-install line despite trailing period", () => {
	const withRealLine = `## Examples of When to Use the Todo List
- Reach for it when the user hands you multiple related tasks or explicitly asks for tracking.
- Keep items current as you work so the list reflects real progress.
## Examples of When NOT to Use the Todo List
- Skip it for quick, single-step tasks where tracking would add overhead.
- Clear stale entries so the list only mirrors the active work.

<example>
User: Run npm install for me and tell me what happens.
</example>
## Task States and Management
- content`;
	const result = todo.verify(withRealLine);
	assert.equal(
		typeof result,
		"string",
		"verify must reject when the period-terminated npm-install example survives",
	);
	assert.equal(String(result).toLowerCase().includes("stale"), true);
});
