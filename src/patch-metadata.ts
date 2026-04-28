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
	"bash-tail": {
		tag: "bash-tail",
		label: "Bash output tail",
		group: "Tooling",
	},
	"bash-prompt": {
		tag: "bash-prompt",
		label: "Bash prompt",
		group: "Prompt",
	},
	"built-in-agent-prompt": {
		tag: "built-in-agent-prompt",
		label: "Built-in agent prompts",
		group: "Prompt",
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
	"todo-use": {
		tag: "todo-use",
		label: "Todo prompt",
		group: "Prompt",
	},
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
	"image-limits": {
		tag: "image-limits",
		label: "Opus 4.7 image limits",
		group: "System",
	},
	"plan-diff-ui": {
		tag: "plan-diff-ui",
		label: "Plan diff UI",
		group: "UX",
	},
	"tools-off": {
		tag: "tools-off",
		label: "Disable tools",
		group: "Tooling",
	},
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
	"agents-off": {
		tag: "agents-off",
		label: "Disable agent tools",
		group: "Agent",
	},
	"commands-off": {
		tag: "commands-off",
		label: "Disable built-in commands",
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
	"skill-listing-ui": {
		tag: "skill-listing-ui",
		label: "Skill listing UI",
		group: "UX",
	},
	"session-mem": {
		tag: "session-mem",
		label: "Session memory",
		group: "System",
	},
	"shell-quote-fix": {
		tag: "shell-quote-fix",
		label: "Shell quote fix",
		group: "Tooling",
	},
	"sys-prompt-file": {
		tag: "sys-prompt-file",
		label: "System prompt file",
		group: "System",
	},
	"taskout-ext": {
		tag: "taskout-ext",
		label: "Task output metadata",
		group: "Tooling",
	},
	"lsp-multi-server": {
		tag: "lsp-multi-server",
		label: "LSP multi-server",
		group: "Tooling",
	},
	"lsp-workspace-symbol": {
		tag: "lsp-workspace-symbol",
		label: "LSP workspaceSymbol query",
		group: "Tooling",
	},
	limits: {
		tag: "limits",
		label: "Limits",
		group: "System",
	},
	"worktree-perms": {
		tag: "worktree-perms",
		label: "Worktree permissions",
		group: "System",
	},
	signature: {
		tag: "signature",
		label: "Signature",
		group: "Metadata",
	},
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
