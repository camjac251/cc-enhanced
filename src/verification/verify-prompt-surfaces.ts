import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface PromptSurfaceFailure {
	file: string;
	id: string;
	reason: string;
}

export interface VerifyPromptSurfacesInput {
	exportDir: string;
}

export interface VerifyPromptSurfacesResult {
	ok: boolean;
	checksRun: number;
	failures: PromptSurfaceFailure[];
}

type PromptSurfaceRule = {
	file: string;
	required?: Array<{ id: string; needle: string; reason: string }>;
	forbidden?: Array<{ id: string; needle: string; reason: string }>;
};

const PLAN_LITERAL_PLACEHOLDER = /^\$\{[A-Z][A-Z0-9_]*\}$/;

function verifyPlanSurface(content: string): PromptSurfaceFailure[] {
	const failures: PromptSurfaceFailure[] = [];
	const placeholderMatches = content.match(/\$\{[^}]+\}/g) ?? [];

	for (const placeholder of placeholderMatches) {
		if (placeholder.includes("conditional(")) {
			failures.push({
				file: "agents/plan.md",
				id: "plan-broken-helper-render",
				reason:
					"Plan surface still contains broken helper-rendered interpolation",
			});
			continue;
		}

		if (!PLAN_LITERAL_PLACEHOLDER.test(placeholder)) {
			failures.push({
				file: "agents/plan.md",
				id: "plan-unresolved-placeholder",
				reason:
					"Plan surface still contains unresolved placeholder interpolation outside explicit literal examples",
			});
		}
	}

	return failures;
}

const SURFACE_RULES: PromptSurfaceRule[] = [
	{
		file: "tools/builtin/read.md",
		required: [
			{
				id: "read-range",
				needle:
					"Range parameter (for text files only, supported bat-style forms):",
				reason: "Read surface missing bat-style range guidance",
			},
			{
				id: "read-whitespace",
				needle: "`show_whitespace: true`",
				reason: "Read surface missing show_whitespace guidance",
			},
		],
		forbidden: [
			{
				id: "read-offset-limit",
				needle: "line offset and limit",
				reason: "Read surface still references offset/limit guidance",
			},
			{
				id: "read-cat-n",
				needle: "cat -n format",
				reason: "Read surface still references cat -n output",
			},
		],
	},
	{
		file: "tools/builtin/edit.md",
		required: [
			{
				id: "edit-regex-newline-warning",
				needle:
					"In regex mode, `new_string` is literal replacement text. Do not use `\\n` expecting it to become a newline; provide actual newline characters or use diff/range mode for multiline edits",
				reason: "Edit surface missing regex newline replacement warning",
			},
		],
	},
	{
		file: "agents/explore.md",
		required: [
			{
				id: "explore-modern-bash",
				needle:
					"Use Bash ONLY for modern read-only operations (eza, git status, git log, git diff, fd, sg, rg, bat)",
				reason: "Explore surface missing modern read-only bash guidance",
			},
			{
				id: "explore-sg-policy",
				needle:
					"Prefer sg for structural code search, rg only for exact text/config/logs, fd over find, eza over ls, and bat over cat/head/tail",
				reason: "Explore surface missing sg/fd/bat policy guidance",
			},
		],
		forbidden: [
			{
				id: "explore-placeholder",
				needle: "${",
				reason:
					"Explore surface still contains unresolved placeholder interpolation",
			},
			{
				id: "explore-stray-command",
				needle: "npm view ",
				reason: "Explore surface still contains stray helper command text",
			},
			{
				id: "explore-legacy-grep-find-cat",
				needle:
					'Use Bash ONLY for read-only operations (ls, git status, git log, git diff, find${conditional(", grep" | "")}, cat, head, tail)',
				reason:
					"Explore surface still references legacy find/grep/cat guidance",
			},
			{
				id: "explore-legacy-grepping",
				needle:
					"spawn multiple parallel tool calls for grepping and reading files",
				reason: "Explore surface still uses legacy grepping wording",
			},
		],
	},
	{
		file: "agents/plan.md",
		forbidden: [
			{
				id: "plan-broken-helper-render",
				needle: "${conditional(",
				reason:
					"Plan surface still contains broken helper-rendered interpolation",
			},
		],
	},
	{
		file: "system/sections/using-your-tools.md",
		required: [
			{
				id: "using-tools-file-search",
				needle:
					"To search for files use available file-search tooling instead of find or ls",
				reason: "Using-your-tools surface missing file-search rewrite",
			},
			{
				id: "using-tools-content-search",
				needle:
					"To search the content of files use available content-search tooling instead of grep",
				reason: "Using-your-tools surface missing content-search rewrite",
			},
		],
		forbidden: [
			{
				id: "using-tools-glob",
				needle: "To search for files use Glob instead of find or ls",
				reason: "Using-your-tools surface still references Glob",
			},
			{
				id: "using-tools-grep",
				needle:
					"To search the content of files, use Grep instead of grep or rg",
				reason: "Using-your-tools surface still references Grep",
			},
		],
	},
	{
		file: "agents/claude-code-guide.md",
		required: [
			{
				id: "guide-mcp-doc-tools",
				needle:
					"Fetch the appropriate docs map URL using MCP doc tools (context7, docfork, or ref)",
				reason: "Guide surface missing MCP doc tools rewrite",
			},
			{
				id: "guide-perplexity-fallback",
				needle:
					"Use MCP search (perplexity) if official docs don't cover the topic",
				reason: "Guide surface missing MCP search fallback rewrite",
			},
		],
		forbidden: [
			{
				id: "guide-webfetch",
				needle: "Use WebFetch to fetch the appropriate docs map",
				reason: "Guide surface still references WebFetch",
			},
			{
				id: "guide-websearch",
				needle: "Use WebSearch if docs don't cover the topic",
				reason: "Guide surface still references WebSearch",
			},
		],
	},
];

async function readSurfaceFile(
	exportDir: string,
	relativePath: string,
	failures: PromptSurfaceFailure[],
): Promise<string | null> {
	const fullPath = path.join(exportDir, relativePath);
	try {
		return await fs.readFile(fullPath, "utf8");
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		failures.push({
			file: relativePath,
			id: "surface-not-readable",
			reason: `Cannot read exported prompt surface: ${reason}`,
		});
		return null;
	}
}

export async function verifyPromptSurfaces(
	input: VerifyPromptSurfacesInput,
): Promise<VerifyPromptSurfacesResult> {
	const failures: PromptSurfaceFailure[] = [];
	let checksRun = 0;

	for (const rule of SURFACE_RULES) {
		const content = await readSurfaceFile(input.exportDir, rule.file, failures);
		checksRun++;
		if (content == null) continue;

		for (const required of rule.required ?? []) {
			checksRun++;
			if (!content.includes(required.needle)) {
				failures.push({
					file: rule.file,
					id: required.id,
					reason: required.reason,
				});
			}
		}

		for (const forbidden of rule.forbidden ?? []) {
			checksRun++;
			if (content.includes(forbidden.needle)) {
				failures.push({
					file: rule.file,
					id: forbidden.id,
					reason: forbidden.reason,
				});
			}
		}

		if (rule.file === "agents/plan.md") {
			const planFailures = verifyPlanSurface(content);
			checksRun += planFailures.length > 0 ? planFailures.length : 1;
			failures.push(...planFailures);
		}
	}

	return {
		ok: failures.length === 0,
		checksRun,
		failures,
	};
}
