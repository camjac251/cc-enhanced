import assert from "node:assert/strict";
import { test } from "node:test";
import {
	collectWorkflowSurfaces,
	type WorkflowAgentInput,
	type WorkflowSectionInput,
	type WorkflowToolInput,
} from "./workflow-surfaces.js";

function tool(
	name: string,
	overrides: Partial<WorkflowToolInput> = {},
): WorkflowToolInput {
	return {
		name,
		slug: name.toLowerCase(),
		sourceSymbol: null,
		prompt: `${name} prompt`,
		description: null,
		...overrides,
	};
}

function agent(
	agentType: string,
	overrides: Partial<WorkflowAgentInput> = {},
): WorkflowAgentInput {
	return {
		agentType,
		slug: agentType,
		sourceSymbol: null,
		prompt: `${agentType} prompt`,
		...overrides,
	};
}

function section(
	slug: string,
	overrides: Partial<WorkflowSectionInput> = {},
): WorkflowSectionInput {
	return {
		heading: `# ${slug}`,
		slug,
		sourceSymbol: null,
		snippets: ["snippet"],
		...overrides,
	};
}

test("includes only workflow-family tools, the workflow agent, and the schedule section", () => {
	const surfaces = collectWorkflowSurfaces(
		[tool("Workflow"), tool("TaskCreate"), tool("Bash"), tool("Read")],
		[agent("workflow-subagent"), agent("Explore")],
		[section("schedule-remote-agents"), section("git")],
	);
	assert.deepEqual(
		surfaces.map((surface) => `${surface.kind}:${surface.name}`),
		[
			"tool:TaskCreate",
			"tool:Workflow",
			"agent:workflow-subagent",
			"section:# schedule-remote-agents",
		],
	);
});

test("orders tools alphabetically, then the agent, then the section", () => {
	const surfaces = collectWorkflowSurfaces(
		[tool("Workflow"), tool("TeamCreate"), tool("TaskUpdate")],
		[agent("workflow-subagent")],
		[section("schedule-remote-agents")],
	);
	assert.deepEqual(
		surfaces.map((surface) => surface.kind),
		["tool", "tool", "tool", "agent", "section"],
	);
	assert.deepEqual(
		surfaces.filter((surface) => surface.kind === "tool").map((s) => s.name),
		["TaskUpdate", "TeamCreate", "Workflow"],
	);
});

test("points each surface at its canonical artifact path", () => {
	const surfaces = collectWorkflowSurfaces(
		[tool("Workflow", { slug: "workflow" })],
		[agent("workflow-subagent", { slug: "workflow-subagent" })],
		[section("schedule-remote-agents")],
	);
	assert.equal(surfaces[0].path, "tools/builtin/workflow.md");
	assert.equal(surfaces[1].path, "agents/workflow-subagent.md");
	assert.equal(surfaces[2].path, "system/sections/schedule-remote-agents.md");
});

test("falls back to the tool description and collapses preview whitespace", () => {
	const [surface] = collectWorkflowSurfaces(
		[tool("Workflow", { prompt: null, description: "line one\n\n  line two" })],
		[],
		[],
	);
	assert.equal(surface.preview, "line one line two");
});

test("truncates the preview to 200 characters", () => {
	const [surface] = collectWorkflowSurfaces(
		[tool("Workflow", { prompt: "x".repeat(500) })],
		[],
		[],
	);
	assert.equal(surface.preview.length, 200);
});

test("returns an empty list when nothing matches", () => {
	assert.deepEqual(
		collectWorkflowSurfaces(
			[tool("Bash")],
			[agent("Explore")],
			[section("git")],
		),
		[],
	);
});
