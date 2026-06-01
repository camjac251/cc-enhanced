// Aggregates the multi-agent workflow / orchestration prompt surfaces from the
// already-extracted tool, agent, and system-section collections into a single
// navigable view. Each entry points at the canonical artifact path, so the
// aggregation duplicates nothing on disk.

export interface WorkflowSurface {
	kind: "tool" | "agent" | "section";
	name: string;
	slug: string;
	path: string;
	sourceSymbol: string | null;
	preview: string;
}

export interface WorkflowToolInput {
	name: string;
	slug: string;
	sourceSymbol: string | null;
	prompt: string | null;
	description: string | null;
}

export interface WorkflowAgentInput {
	agentType: string;
	slug: string;
	sourceSymbol: string | null;
	prompt: string;
}

export interface WorkflowSectionInput {
	heading: string;
	slug: string;
	sourceSymbol: string | null;
	snippets: string[];
}

// Stable, public-facing names for the workflow / orchestration surface. These
// are runtime tool, agent, and system-section identifiers, not minified
// symbols, so they remain valid across upstream releases.
const WORKFLOW_TOOL_NAMES = new Set([
	"Workflow",
	"TaskCreate",
	"TaskGet",
	"TaskList",
	"TaskOutput",
	"TaskStop",
	"TaskUpdate",
	"TeamCreate",
	"TeamDelete",
]);
const WORKFLOW_AGENT_TYPES = new Set(["workflow-subagent"]);
const WORKFLOW_SECTION_SLUGS = new Set(["schedule-remote-agents"]);

const WORKFLOW_KIND_ORDER: Record<WorkflowSurface["kind"], number> = {
	tool: 0,
	agent: 1,
	section: 2,
};

function previewText(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

export function collectWorkflowSurfaces(
	tools: WorkflowToolInput[],
	agents: WorkflowAgentInput[],
	sections: WorkflowSectionInput[],
): WorkflowSurface[] {
	const surfaces: WorkflowSurface[] = [];
	for (const tool of tools) {
		if (!WORKFLOW_TOOL_NAMES.has(tool.name)) continue;
		surfaces.push({
			kind: "tool",
			name: tool.name,
			slug: tool.slug,
			path: `tools/builtin/${tool.slug}.md`,
			sourceSymbol: tool.sourceSymbol,
			preview: previewText(tool.prompt ?? tool.description ?? ""),
		});
	}
	for (const agentEntry of agents) {
		if (!WORKFLOW_AGENT_TYPES.has(agentEntry.agentType)) continue;
		surfaces.push({
			kind: "agent",
			name: agentEntry.agentType,
			slug: agentEntry.slug,
			path: `agents/${agentEntry.slug}.md`,
			sourceSymbol: agentEntry.sourceSymbol,
			preview: previewText(agentEntry.prompt),
		});
	}
	for (const section of sections) {
		if (!WORKFLOW_SECTION_SLUGS.has(section.slug)) continue;
		surfaces.push({
			kind: "section",
			name: section.heading,
			slug: section.slug,
			path: `system/sections/${section.slug}.md`,
			sourceSymbol: section.sourceSymbol,
			preview: previewText(section.snippets.join("\n")),
		});
	}
	return surfaces.sort((left, right) => {
		const kindDelta =
			WORKFLOW_KIND_ORDER[left.kind] - WORKFLOW_KIND_ORDER[right.kind];
		if (kindDelta !== 0) return kindDelta;
		return left.name.localeCompare(right.name);
	});
}
