import { traverse } from "../babel.js";
import type { Patch } from "../types.js";
import { getVerifyAst } from "./ast-helpers.js";

const STOCK_TRIGGER_NEEDLES = [
	"TRIGGER",
	"the prompt names Claude/Anthropic in any form",
	"the task is LLM-shaped with provider unstated",
] as const;
const STOCK_SKIP_NEEDLES = [
	"SKIP only when another provider is being worked on",
	"run this grep FIRST",
] as const;

const SCOPED_TRIGGER =
	"TRIGGER - read before opening the target file whenever the task is to build, debug, configure, or answer current reference questions about an application that directly calls the Claude API or uses an Anthropic SDK. This includes API request parameters, model IDs, pricing, limits, streaming, tool use, prompt caching, token counting, API-hosted agents, and SDK migration.";
const SCOPED_EXCLUSION =
	"DO NOT TRIGGER merely because a task mentions Claude Code, the Claude CLI, cli.js, local session JSONL/transcripts, statuslines, hooks, skills, subagents, workflows, MCP configuration, model routing, proxies, or a repository that happens to contain Claude-related names. Those are client and runtime tasks unless the work also requires writing or debugging API or SDK calls.";
const SCOPED_SKIP =
	"SKIP when another provider is being worked on, or when the task is solely about client or runtime behavior described above. When a task mixes surfaces, use this skill only for the API or SDK portion.";

function containsEvery(value: string, needles: readonly string[]): boolean {
	return needles.every((needle) => value.includes(needle));
}

export const claudeApiScope: Patch = {
	tag: "claude-api-scope",
	astPasses: () => [
		{
			pass: "mutate" as const,
			visitor: {
				StringLiteral(path) {
					if (containsEvery(path.node.value, STOCK_TRIGGER_NEEDLES)) {
						path.node.value = `${SCOPED_TRIGGER}\n${SCOPED_EXCLUSION}`;
						return;
					}
					if (containsEvery(path.node.value, STOCK_SKIP_NEEDLES)) {
						path.node.value = SCOPED_SKIP;
					}
				},
			},
		},
	],
	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) {
			return "Unable to parse AST during claude-api-scope verification";
		}
		let stockRules = 0;
		let scopedTriggers = 0;
		let scopedExclusions = 0;
		let scopedSkips = 0;
		traverse(verifyAst, {
			StringLiteral(path) {
				const { value } = path.node;
				if (
					containsEvery(value, STOCK_TRIGGER_NEEDLES) ||
					containsEvery(value, STOCK_SKIP_NEEDLES)
				) {
					stockRules += 1;
				}
				if (value.includes(SCOPED_TRIGGER)) scopedTriggers += 1;
				if (value.includes(SCOPED_EXCLUSION)) scopedExclusions += 1;
				if (value === SCOPED_SKIP) scopedSkips += 1;
			},
		});
		if (stockRules > 0) {
			return "Claude API skill scope still contains broad stock activation rules";
		}
		if (scopedTriggers !== 1 || scopedExclusions !== 1 || scopedSkips !== 1) {
			return `Claude API skill scope is missing or ambiguous (trigger: ${scopedTriggers}, exclusion: ${scopedExclusions}, skip: ${scopedSkips})`;
		}
		return true;
	},
};
