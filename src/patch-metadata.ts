import type { PatchGroupResult, PatchVerification } from "./types.js";

export interface PatchMetadata {
	tag: string;
	label: string;
	group: string;
}

const GROUP_ORDER = [
	"Prompt",
	"Tooling",
	"Agent",
	"System",
	"UX",
	"Metadata",
] as const;

const BY_TAG: Record<string, PatchMetadata> = {
	"bash-prompt": { tag: "bash-prompt", label: "Bash prompt", group: "Prompt" },
	"built-in-agent-prompt": {
		tag: "built-in-agent-prompt",
		label: "Built-in agent prompts",
		group: "Prompt",
	},
	"bash-tail": {
		tag: "bash-tail",
		label: "Bash output tail",
		group: "Tooling",
	},
	"prompt-rewrite": {
		tag: "prompt-rewrite",
		label: "Prompt rewrite",
		group: "Prompt",
	},
	"taskout-ext": {
		tag: "taskout-ext",
		label: "Task output tool",
		group: "Tooling",
	},
	"claudemd-strong": {
		tag: "claudemd-strong",
		label: "CLAUDE.md system prompt",
		group: "Prompt",
	},
	"mcp-server-name": {
		tag: "mcp-server-name",
		label: "MCP server name validation",
		group: "Tooling",
	},
	"skill-tools": {
		tag: "skill-tools",
		label: "Skill allowed tools",
		group: "Prompt",
	},
	"todo-use": { tag: "todo-use", label: "Todo prompt", group: "Prompt" },

	"cache-tail-policy": {
		tag: "cache-tail-policy",
		label: "Cache tail policy",
		group: "System",
	},
	"edit-extended": {
		tag: "edit-extended",
		label: "Edit tool",
		group: "Tooling",
	},
	"effort-max": {
		tag: "effort-max",
		label: "Interactive max effort",
		group: "System",
	},
	"plan-diff-ui": {
		tag: "plan-diff-ui",
		label: "Plan diff UI",
		group: "UX",
	},
	"tools-off": { tag: "tools-off", label: "Disable tools", group: "Tooling" },
	"no-autoupdate": {
		tag: "no-autoupdate",
		label: "Disable autoupdater",
		group: "System",
	},
	"read-bat": {
		tag: "read-bat",
		label: "Read with bat",
		group: "Tooling",
	},
	"write-result-trim": {
		tag: "write-result-trim",
		label: "Shrink write result",
		group: "Tooling",
	},
	"memory-write-ui": {
		tag: "memory-write-ui",
		label: "Memory write UI",
		group: "UX",
	},
	"agents-off": {
		tag: "agents-off",
		label: "Disable agent tools",
		group: "Agent",
	},
	"no-collapse": {
		tag: "no-collapse",
		label: "Disable collapse",
		group: "UX",
	},
	"subagent-model-tag": {
		tag: "subagent-model-tag",
		label: "Subagent model tag",
		group: "UX",
	},
	"session-mem": {
		tag: "session-mem",
		label: "Session memory",
		group: "System",
	},
	"sys-prompt-file": {
		tag: "sys-prompt-file",
		label: "System prompt file",
		group: "System",
	},
	"flag-bypass": {
		tag: "flag-bypass",
		label: "Feature flag bypass",
		group: "System",
	},
	limits: { tag: "limits", label: "Limits", group: "System" },
	signature: { tag: "signature", label: "Signature", group: "Metadata" },
};

export function getPatchMetadata(tag: string): PatchMetadata {
	return (
		BY_TAG[tag] ?? {
			tag,
			label: tag,
			group: "Ungrouped",
		}
	);
}

export function buildGroupResults(
	verifications: PatchVerification[],
): PatchGroupResult[] {
	const byGroup = new Map<string, PatchGroupResult>();
	for (const v of verifications) {
		const meta = getPatchMetadata(v.tag);
		const groupName = v.group ?? meta.group;
		const existing = byGroup.get(groupName);
		if (existing) {
			existing.total += 1;
			if (v.passed) {
				existing.passed += 1;
				existing.appliedTags.push(v.tag);
			} else {
				existing.failed += 1;
				existing.failedTags.push(v.tag);
			}
			continue;
		}

		byGroup.set(groupName, {
			group: groupName,
			total: 1,
			passed: v.passed ? 1 : 0,
			failed: v.passed ? 0 : 1,
			appliedTags: v.passed ? [v.tag] : [],
			failedTags: v.passed ? [] : [v.tag],
		});
	}

	return [...byGroup.values()].sort((a, b) => {
		const ai = GROUP_ORDER.indexOf(a.group as (typeof GROUP_ORDER)[number]);
		const bi = GROUP_ORDER.indexOf(b.group as (typeof GROUP_ORDER)[number]);
		if (ai === -1 && bi === -1) return a.group.localeCompare(b.group);
		if (ai === -1) return 1;
		if (bi === -1) return -1;
		return ai - bi;
	});
}
