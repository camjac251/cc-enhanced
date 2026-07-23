import * as fs from "node:fs/promises";
import * as path from "node:path";
import { findForbiddenPromptDashStyle } from "../prompt-dash-style.js";
import {
	PROMPT_SURFACE_RULES,
	type PromptSurfaceRule,
} from "./prompt-surface-rules.js";

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

const PLAN_LITERAL_PLACEHOLDER = /^\$\{[A-Z][A-Z0-9_]*\}$/;
const AGENT_REFERENCE_PLACEHOLDER = /^\$\{agent\.[A-Za-z0-9_.]+\}$/;
const DYNAMIC_PROMPT_MARKER =
	"(Dynamic prompt: not statically resolved from cli.js AST.)";
const GENERATED_MARKDOWN_FILENAMES = new Set(["INDEX.md", "README.md"]);

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

function verifyResolvedSurface(
	rule: PromptSurfaceRule,
	content: string,
): PromptSurfaceFailure[] {
	const failures: PromptSurfaceFailure[] = [];
	const file = rule.file;
	const pushOnce = (id: string, reason: string): void => {
		if (failures.some((failure) => failure.id === id)) return;
		failures.push({ file, id, reason });
	};

	if (!rule.allowDynamicPrompt && content.includes(DYNAMIC_PROMPT_MARKER)) {
		pushOnce(
			"surface-dynamic-prompt",
			"Surface still contains a dynamic prompt marker instead of resolved prompt text",
		);
	}

	for (const placeholder of content.match(/\$\{[^}]+\}/g) ?? []) {
		if (PLAN_LITERAL_PLACEHOLDER.test(placeholder)) continue;
		if (rule.allowLiteralTemplatePlaceholders) continue;
		if (placeholder.startsWith("${...")) {
			pushOnce(
				"surface-unresolved-spread",
				"Surface still contains an unresolved spread placeholder",
			);
			continue;
		}
		if (placeholder.startsWith("${value_")) {
			if (rule.allowSyntheticPlaceholders) continue;
			pushOnce(
				"surface-unresolved-value",
				"Surface still contains an unresolved synthetic value placeholder",
			);
			continue;
		}
		if (
			rule.allowSyntheticPlaceholders &&
			AGENT_REFERENCE_PLACEHOLDER.test(placeholder)
		) {
			continue;
		}
		if (placeholder.includes("conditional(")) {
			pushOnce(
				"surface-unresolved-conditional",
				"Surface still contains an unresolved conditional placeholder",
			);
			continue;
		}
		pushOnce(
			"surface-unresolved-placeholder",
			"Surface still contains an unresolved placeholder interpolation",
		);
	}

	return failures;
}

async function readSurfaceFile(
	exportDir: string,
	rule: PromptSurfaceRule,
	failures: PromptSurfaceFailure[],
): Promise<string | null> {
	const relativePath = rule.file;
	const fullPath = path.join(exportDir, relativePath);
	try {
		return await fs.readFile(fullPath, "utf8");
	} catch (error) {
		if (
			rule.presence === "optional" &&
			(error as NodeJS.ErrnoException).code === "ENOENT"
		) {
			return null;
		}
		const reason = error instanceof Error ? error.message : String(error);
		failures.push({
			file: relativePath,
			id: "surface-not-readable",
			reason: `Cannot read exported prompt surface: ${reason}`,
		});
		return null;
	}
}

async function collectPromptMarkdownFiles(
	dir: string,
	root = dir,
): Promise<string[]> {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectPromptMarkdownFiles(fullPath, root)));
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		if (GENERATED_MARKDOWN_FILENAMES.has(entry.name)) continue;
		files.push(path.relative(root, fullPath));
	}
	return files.sort();
}

async function verifyNoUnicodeDashPromptMarkdown(
	exportDir: string,
): Promise<PromptSurfaceFailure[]> {
	const failures: PromptSurfaceFailure[] = [];
	const files = await collectPromptMarkdownFiles(exportDir);
	for (const file of files) {
		const content = await fs.readFile(path.join(exportDir, file), "utf8");
		const match = findForbiddenPromptDashStyle(content);
		if (!match) continue;
		failures.push({
			file,
			id: "surface-unicode-dash-style",
			reason: `Prompt Markdown still contains ${match.label} punctuation`,
		});
	}
	return failures;
}

export async function verifyPromptSurfaces(
	input: VerifyPromptSurfacesInput,
): Promise<VerifyPromptSurfacesResult> {
	const failures: PromptSurfaceFailure[] = [];
	let checksRun = 0;

	for (const rule of PROMPT_SURFACE_RULES) {
		const content = await readSurfaceFile(input.exportDir, rule, failures);
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

		const resolvedSurfaceFailures = verifyResolvedSurface(rule, content);
		checksRun +=
			resolvedSurfaceFailures.length > 0 ? resolvedSurfaceFailures.length : 1;
		failures.push(...resolvedSurfaceFailures);

		if (rule.file === "agents/plan.md") {
			const planFailures = verifyPlanSurface(content);
			checksRun += planFailures.length > 0 ? planFailures.length : 1;
			failures.push(...planFailures);
		}
	}

	const dashFailures = await verifyNoUnicodeDashPromptMarkdown(input.exportDir);
	checksRun += dashFailures.length > 0 ? dashFailures.length : 1;
	failures.push(...dashFailures);

	return {
		ok: failures.length === 0,
		checksRun,
		failures,
	};
}
