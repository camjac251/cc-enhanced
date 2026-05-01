import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PROMPT_SURFACE_DRIFT_PATHS } from "./prompt-surface-rules.js";

export interface PromptSurfaceDriftBaseline {
	version: string | null;
	algorithm: "sha256";
	normalization: "prompt-surface-v1";
	surfaces: Record<string, string>;
}

export interface PromptSurfaceDriftFailure {
	file: string;
	id: string;
	reason: string;
}

export interface PromptSurfaceDriftResult {
	ok: boolean;
	checksRun: number;
	failures: PromptSurfaceDriftFailure[];
}

export interface CreatePromptSurfaceDriftBaselineInput {
	exportDir: string;
	version?: string | null;
	watchPaths?: readonly string[];
}

export interface VerifyPromptSurfaceDriftInput {
	exportDir: string;
	baseline?: PromptSurfaceDriftBaseline;
	baselinePath?: string;
	watchPaths?: readonly string[];
}

const PLACEHOLDER_TOKEN_RE = /\b(?:value|expr)_[0-9]+\b/g;

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalizePlaceholderTokens(content: string): string {
	const tokenMap = new Map<string, string>();
	let nextToken = 1;
	return content.replace(PLACEHOLDER_TOKEN_RE, (token) => {
		const existing = tokenMap.get(token);
		if (existing) return existing;
		const prefix = token.startsWith("expr_") ? "expr" : "value";
		const canonical = `${prefix}_${nextToken++}`;
		tokenMap.set(token, canonical);
		return canonical;
	});
}

export function normalizePromptSurfaceContent(content: string): string {
	const normalized = content
		.replace(/\r\n?/g, "\n")
		.replace(/^-\s+source_symbol:\s+.*$/gm, "- source_symbol: <normalized>")
		.replace(/[ \t]+$/gm, "")
		.trimEnd();
	return `${canonicalizePlaceholderTokens(normalized)}\n`;
}

export function hashPromptSurfaceContent(content: string): string {
	return sha256(normalizePromptSurfaceContent(content));
}

async function readSurface(
	exportDir: string,
	relativePath: string,
): Promise<string> {
	return fs.readFile(path.join(exportDir, relativePath), "utf8");
}

async function readBaseline(
	baselinePath: string,
): Promise<PromptSurfaceDriftBaseline> {
	const raw = await fs.readFile(baselinePath, "utf8");
	const parsed = JSON.parse(raw) as PromptSurfaceDriftBaseline;
	if (parsed.algorithm !== "sha256") {
		throw new Error(
			`Unsupported prompt drift baseline algorithm: ${parsed.algorithm}`,
		);
	}
	if (parsed.normalization !== "prompt-surface-v1") {
		throw new Error(
			`Unsupported prompt drift baseline normalization: ${parsed.normalization}`,
		);
	}
	if (!parsed.surfaces || typeof parsed.surfaces !== "object") {
		throw new Error("Prompt drift baseline is missing surfaces");
	}
	return parsed;
}

export async function createPromptSurfaceDriftBaseline({
	exportDir,
	version = null,
	watchPaths = PROMPT_SURFACE_DRIFT_PATHS,
}: CreatePromptSurfaceDriftBaselineInput): Promise<PromptSurfaceDriftBaseline> {
	const surfaces: Record<string, string> = {};
	for (const relativePath of watchPaths) {
		const content = await readSurface(exportDir, relativePath);
		surfaces[relativePath] = hashPromptSurfaceContent(content);
	}
	return {
		version,
		algorithm: "sha256",
		normalization: "prompt-surface-v1",
		surfaces: Object.fromEntries(
			Object.entries(surfaces).sort(([left], [right]) =>
				left.localeCompare(right),
			),
		),
	};
}

export async function writePromptSurfaceDriftBaseline(
	baselinePath: string,
	baseline: PromptSurfaceDriftBaseline,
): Promise<void> {
	await fs.mkdir(path.dirname(baselinePath), { recursive: true });
	await fs.writeFile(
		baselinePath,
		`${JSON.stringify(baseline, null, 2)}\n`,
		"utf8",
	);
}

export async function verifyPromptSurfaceDrift({
	exportDir,
	baseline,
	baselinePath,
	watchPaths,
}: VerifyPromptSurfaceDriftInput): Promise<PromptSurfaceDriftResult> {
	if (!baseline && !baselinePath) {
		throw new Error(
			"verifyPromptSurfaceDrift requires a baseline or baselinePath",
		);
	}

	const expected = baseline ?? (await readBaseline(baselinePath as string));
	const watched = [...(watchPaths ?? PROMPT_SURFACE_DRIFT_PATHS)].sort();
	const failures: PromptSurfaceDriftFailure[] = [];
	let checksRun = 0;

	for (const relativePath of watched) {
		checksRun++;
		const expectedHash = expected.surfaces[relativePath];
		if (!expectedHash) {
			failures.push({
				file: relativePath,
				id: "baseline-missing-surface",
				reason: "Baseline does not contain this watched prompt surface",
			});
			continue;
		}

		let content: string;
		try {
			content = await readSurface(exportDir, relativePath);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			failures.push({
				file: relativePath,
				id: "surface-not-readable",
				reason: `Cannot read watched prompt surface: ${reason}`,
			});
			continue;
		}

		const actualHash = hashPromptSurfaceContent(content);
		if (actualHash !== expectedHash) {
			failures.push({
				file: relativePath,
				id: "surface-drift",
				reason: `Normalized prompt surface hash changed (${expectedHash} -> ${actualHash})`,
			});
		}
	}

	return {
		ok: failures.length === 0,
		checksRun,
		failures,
	};
}
