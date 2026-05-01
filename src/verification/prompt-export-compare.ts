import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PROMPT_SURFACE_REVIEW_PATHS } from "./prompt-surface-rules.js";

export interface PromptExportCompareInput {
	baseExportDir: string;
	patchedExportDir: string;
	etcClaudeDir: string;
	watchPaths?: readonly string[];
	minOverlapLineLength?: number;
}

export interface PromptExportCompareResult {
	baseExportDir: string;
	patchedExportDir: string;
	etcClaudeDir: string;
	files: FileInventoryComparison;
	manifest: ManifestComparison;
	watchedSurfaces: WatchedSurfaceComparison;
	etcLayer: EtcLayerComparison;
	policyTerms: PolicyTermComparison[];
}

export interface FileInventoryComparison {
	baseFiles: number;
	patchedFiles: number;
	common: number;
	unchanged: number;
	changed: number;
	added: number;
	removed: number;
	changedByTopLevel: Record<string, number>;
	addedByTopLevel: Record<string, number>;
	removedByTopLevel: Record<string, number>;
	changedByExtension: Record<string, number>;
	addedFiles: string[];
	removedFiles: string[];
	changedFiles: string[];
}

export interface ManifestComparison {
	baseManifestPath: string;
	patchedManifestPath: string;
	basePresent: boolean;
	patchedPresent: boolean;
	countDeltas: ManifestCountDelta[];
}

export interface ManifestCountDelta {
	key: string;
	base: number | null;
	patched: number | null;
	delta: number | null;
}

export interface WatchedSurfaceComparison {
	total: number;
	unchanged: number;
	changed: number;
	added: number;
	removed: number;
	missing: number;
	surfaces: WatchedSurfaceStatus[];
}

export interface WatchedSurfaceStatus {
	file: string;
	status: "unchanged" | "changed" | "added" | "removed" | "missing";
}

export interface EtcLayerComparison {
	files: EtcPromptFileComparison[];
	totalCandidateLines: number;
	totalExactLinesInPatchedExport: number;
	patchedMarkdownFiles: number;
	patchedComparableLines: number;
}

export interface EtcPromptFileComparison {
	file: string;
	candidateLines: number;
	exactLinesInPatchedExport: number;
	exactPct: number;
}

export interface PolicyTermComparison {
	id: string;
	label: string;
	patchedExportFiles: number;
	etcFiles: number;
}

interface CollectedFile {
	relativePath: string;
	hash: string;
	content?: string;
}

interface ManifestData {
	path: string;
	present: boolean;
	counts: Record<string, number>;
}

interface PolicyTerm {
	id: string;
	label: string;
	pattern: RegExp;
}

const DEFAULT_MIN_OVERLAP_LINE_LENGTH = 20;

const POLICY_TERMS: readonly PolicyTerm[] = [
	{
		id: "serena",
		label: "Serena / symbol navigation",
		pattern: /\bSerena\b|\bLSP\b/i,
	},
	{
		id: "chunkhound",
		label: "ChunkHound semantic search",
		pattern: /\bChunkHound\b/i,
	},
	{
		id: "probe",
		label: "Probe boolean/code search",
		pattern: /\bProbe\b|\bmcp__probe__/i,
	},
	{
		id: "ast-grep",
		label: "ast-grep / sg structural search",
		pattern: /\bast-grep\b|\bsg\b|\bmcp__ast[-_]grep__/i,
	},
	{
		id: "rg-non-code",
		label: "rg reserved for non-code text",
		pattern: /\brg\b|\bripgrep\b/i,
	},
	{
		id: "bat-ranges",
		label: "bat range-based reading",
		pattern: /\bbat\b|bat -r/i,
	},
	{
		id: "output-limits",
		label: "native output limits / tailing",
		pattern: /\bmax_output\b|\boutput_tail\b|\bhead\/tail\b/i,
	},
	{
		id: "mcp",
		label: "MCP tool routing",
		pattern: /\bMCP\b|\bmcp__/i,
	},
];

function sha256(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

function toPosixPath(value: string): string {
	return value.split(path.sep).join("/");
}

function sortedEntries<T>(record: Record<string, T>): [string, T][] {
	return Object.entries(record).sort(([left], [right]) =>
		left.localeCompare(right),
	);
}

function bump(record: Record<string, number>, key: string): void {
	record[key] = (record[key] ?? 0) + 1;
}

function topLevel(relativePath: string): string {
	return relativePath.split("/")[0] || relativePath;
}

function extensionOf(relativePath: string): string {
	return path.extname(relativePath) || "<none>";
}

function isMarkdown(relativePath: string): boolean {
	return path.extname(relativePath).toLowerCase() === ".md";
}

function normalizeText(content: string): string {
	return content.replace(/\r\n?/g, "\n");
}

function extractComparableLines(
	content: string,
	minLength: number,
): Set<string> {
	const lines = new Set<string>();
	for (const rawLine of normalizeText(content).split("\n")) {
		const line = rawLine.trim();
		if (line.length < minLength) continue;
		if (line.startsWith("```")) continue;
		if (/^[-*_]{3,}$/.test(line)) continue;
		lines.add(line);
	}
	return lines;
}

async function listFiles(rootDir: string): Promise<string[]> {
	const files: string[] = [];

	async function walk(currentDir: string): Promise<void> {
		const entries = await fs.readdir(currentDir, { withFileTypes: true });
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			const fullPath = path.join(currentDir, entry.name);
			if (entry.isDirectory()) {
				await walk(fullPath);
				continue;
			}
			if (!entry.isFile()) continue;
			files.push(toPosixPath(path.relative(rootDir, fullPath)));
		}
	}

	await walk(rootDir);
	return files.sort((left, right) => left.localeCompare(right));
}

async function collectFiles(
	rootDir: string,
	options: { includeContent?: boolean; onlyMarkdown?: boolean } = {},
): Promise<Map<string, CollectedFile>> {
	const files = await listFiles(rootDir);
	const collected = new Map<string, CollectedFile>();
	for (const relativePath of files) {
		if (options.onlyMarkdown && !isMarkdown(relativePath)) continue;
		const fullPath = path.join(rootDir, relativePath);
		const buffer = await fs.readFile(fullPath);
		const content = options.includeContent
			? buffer.toString("utf8")
			: undefined;
		collected.set(relativePath, {
			relativePath,
			hash: sha256(buffer),
			content,
		});
	}
	return collected;
}

function compareFileInventory(
	baseFiles: Map<string, CollectedFile>,
	patchedFiles: Map<string, CollectedFile>,
): FileInventoryComparison {
	const basePaths = new Set(baseFiles.keys());
	const patchedPaths = new Set(patchedFiles.keys());
	const changedFiles: string[] = [];
	const addedFiles: string[] = [];
	const removedFiles: string[] = [];
	let unchanged = 0;

	for (const relativePath of [...patchedPaths].sort()) {
		if (!basePaths.has(relativePath)) {
			addedFiles.push(relativePath);
			continue;
		}
		const base = baseFiles.get(relativePath);
		const patched = patchedFiles.get(relativePath);
		if (!base || !patched) continue;
		if (base.hash === patched.hash) {
			unchanged++;
		} else {
			changedFiles.push(relativePath);
		}
	}

	for (const relativePath of [...basePaths].sort()) {
		if (!patchedPaths.has(relativePath)) removedFiles.push(relativePath);
	}

	const changedByTopLevel: Record<string, number> = {};
	const addedByTopLevel: Record<string, number> = {};
	const removedByTopLevel: Record<string, number> = {};
	const changedByExtension: Record<string, number> = {};

	for (const relativePath of changedFiles) {
		bump(changedByTopLevel, topLevel(relativePath));
		bump(changedByExtension, extensionOf(relativePath));
	}
	for (const relativePath of addedFiles) {
		bump(addedByTopLevel, topLevel(relativePath));
	}
	for (const relativePath of removedFiles) {
		bump(removedByTopLevel, topLevel(relativePath));
	}

	return {
		baseFiles: basePaths.size,
		patchedFiles: patchedPaths.size,
		common: [...basePaths].filter((relativePath) =>
			patchedPaths.has(relativePath),
		).length,
		unchanged,
		changed: changedFiles.length,
		added: addedFiles.length,
		removed: removedFiles.length,
		changedByTopLevel,
		addedByTopLevel,
		removedByTopLevel,
		changedByExtension,
		addedFiles,
		removedFiles,
		changedFiles,
	};
}

async function readManifest(exportDir: string): Promise<ManifestData> {
	const manifestPath = path.join(exportDir, "manifest.json");
	try {
		const raw = await fs.readFile(manifestPath, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		return {
			path: manifestPath,
			present: true,
			counts: collectNumberLeaves(parsed, "manifest"),
		};
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") throw error;
		return {
			path: manifestPath,
			present: false,
			counts: {},
		};
	}
}

function collectNumberLeaves(
	value: unknown,
	prefix: string,
): Record<string, number> {
	if (typeof value === "number" && Number.isFinite(value)) {
		return { [prefix]: value };
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}

	const output: Record<string, number> = {};
	for (const [key, child] of Object.entries(value)) {
		Object.assign(output, collectNumberLeaves(child, `${prefix}.${key}`));
	}
	return output;
}

async function compareManifests(
	baseExportDir: string,
	patchedExportDir: string,
): Promise<ManifestComparison> {
	const base = await readManifest(baseExportDir);
	const patched = await readManifest(patchedExportDir);
	const keys = new Set([
		...Object.keys(base.counts),
		...Object.keys(patched.counts),
	]);
	const countDeltas: ManifestCountDelta[] = [];

	for (const key of [...keys].sort()) {
		const baseValue = base.counts[key] ?? null;
		const patchedValue = patched.counts[key] ?? null;
		if (baseValue === patchedValue) continue;
		countDeltas.push({
			key: key.replace(/^manifest\./, ""),
			base: baseValue,
			patched: patchedValue,
			delta:
				baseValue === null || patchedValue === null
					? null
					: patchedValue - baseValue,
		});
	}

	return {
		baseManifestPath: base.path,
		patchedManifestPath: patched.path,
		basePresent: base.present,
		patchedPresent: patched.present,
		countDeltas,
	};
}

function compareWatchedSurfaces(
	baseFiles: Map<string, CollectedFile>,
	patchedFiles: Map<string, CollectedFile>,
	watchPaths: readonly string[],
): WatchedSurfaceComparison {
	const surfaces = watchPaths.map((file): WatchedSurfaceStatus => {
		const base = baseFiles.get(file);
		const patched = patchedFiles.get(file);
		if (!base && !patched) return { file, status: "missing" };
		if (!base && patched) return { file, status: "added" };
		if (base && !patched) return { file, status: "removed" };
		return {
			file,
			status: base?.hash === patched?.hash ? "unchanged" : "changed",
		};
	});

	return {
		total: surfaces.length,
		unchanged: surfaces.filter((surface) => surface.status === "unchanged")
			.length,
		changed: surfaces.filter((surface) => surface.status === "changed").length,
		added: surfaces.filter((surface) => surface.status === "added").length,
		removed: surfaces.filter((surface) => surface.status === "removed").length,
		missing: surfaces.filter((surface) => surface.status === "missing").length,
		surfaces,
	};
}

function collectMarkdownComparableLines(
	files: Map<string, CollectedFile>,
	minLength: number,
): Set<string> {
	const lines = new Set<string>();
	for (const file of files.values()) {
		if (!file.content) continue;
		for (const line of extractComparableLines(file.content, minLength)) {
			lines.add(line);
		}
	}
	return lines;
}

function countPolicyFiles(
	files: Map<string, CollectedFile>,
	pattern: RegExp,
): number {
	let count = 0;
	for (const file of files.values()) {
		if (!file.content) continue;
		if (pattern.test(file.content)) count++;
	}
	return count;
}

async function compareEtcLayer(
	etcClaudeDir: string,
	patchedMarkdownFiles: Map<string, CollectedFile>,
	minOverlapLineLength: number,
): Promise<EtcLayerComparison> {
	const etcMarkdownFiles = await collectFiles(etcClaudeDir, {
		includeContent: true,
		onlyMarkdown: true,
	});
	const patchedLines = collectMarkdownComparableLines(
		patchedMarkdownFiles,
		minOverlapLineLength,
	);
	const files: EtcPromptFileComparison[] = [];
	let totalCandidateLines = 0;
	let totalExactLinesInPatchedExport = 0;

	for (const file of etcMarkdownFiles.values()) {
		const candidateLines = extractComparableLines(
			file.content ?? "",
			minOverlapLineLength,
		);
		const exactLines = [...candidateLines].filter((line) =>
			patchedLines.has(line),
		);
		const exactPct =
			candidateLines.size === 0
				? 0
				: Number(((exactLines.length / candidateLines.size) * 100).toFixed(1));
		files.push({
			file: file.relativePath,
			candidateLines: candidateLines.size,
			exactLinesInPatchedExport: exactLines.length,
			exactPct,
		});
		totalCandidateLines += candidateLines.size;
		totalExactLinesInPatchedExport += exactLines.length;
	}

	files.sort((left, right) => left.file.localeCompare(right.file));

	return {
		files,
		totalCandidateLines,
		totalExactLinesInPatchedExport,
		patchedMarkdownFiles: patchedMarkdownFiles.size,
		patchedComparableLines: patchedLines.size,
	};
}

function comparePolicyTerms(
	patchedMarkdownFiles: Map<string, CollectedFile>,
	etcMarkdownFiles: Map<string, CollectedFile>,
): PolicyTermComparison[] {
	return POLICY_TERMS.map((term) => ({
		id: term.id,
		label: term.label,
		patchedExportFiles: countPolicyFiles(patchedMarkdownFiles, term.pattern),
		etcFiles: countPolicyFiles(etcMarkdownFiles, term.pattern),
	}));
}

export async function comparePromptExports({
	baseExportDir,
	patchedExportDir,
	etcClaudeDir,
	watchPaths = PROMPT_SURFACE_REVIEW_PATHS,
	minOverlapLineLength = DEFAULT_MIN_OVERLAP_LINE_LENGTH,
}: PromptExportCompareInput): Promise<PromptExportCompareResult> {
	const baseFiles = await collectFiles(baseExportDir);
	const patchedFiles = await collectFiles(patchedExportDir);
	const patchedMarkdownFiles = await collectFiles(patchedExportDir, {
		includeContent: true,
		onlyMarkdown: true,
	});
	const etcMarkdownFiles = await collectFiles(etcClaudeDir, {
		includeContent: true,
		onlyMarkdown: true,
	});

	return {
		baseExportDir,
		patchedExportDir,
		etcClaudeDir,
		files: compareFileInventory(baseFiles, patchedFiles),
		manifest: await compareManifests(baseExportDir, patchedExportDir),
		watchedSurfaces: compareWatchedSurfaces(
			baseFiles,
			patchedFiles,
			watchPaths,
		),
		etcLayer: await compareEtcLayer(
			etcClaudeDir,
			patchedMarkdownFiles,
			minOverlapLineLength,
		),
		policyTerms: comparePolicyTerms(patchedMarkdownFiles, etcMarkdownFiles),
	};
}

function formatNumber(value: number | null): string {
	return value === null ? "missing" : String(value);
}

function formatDelta(value: number | null): string {
	if (value === null) return "n/a";
	if (value > 0) return `+${value}`;
	return String(value);
}

function topRows(record: Record<string, number>, limit: number): string[] {
	return sortedEntries(record)
		.sort(
			(left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
		)
		.slice(0, limit)
		.map(([key, value]) => `| \`${key}\` | ${value} |`);
}

function sampleRows(files: readonly string[], limit: number): string[] {
	return files.slice(0, limit).map((file) => `| \`${file}\` |`);
}

function statusRows(
	surfaces: readonly WatchedSurfaceStatus[],
	limit: number,
): string[] {
	return surfaces
		.filter((surface) => surface.status !== "unchanged")
		.slice(0, limit)
		.map((surface) => `| \`${surface.file}\` | ${surface.status} |`);
}

export function formatPromptExportComparisonMarkdown(
	result: PromptExportCompareResult,
	options: { sampleLimit?: number } = {},
): string {
	const sampleLimit = options.sampleLimit ?? 20;
	const lines: string[] = [
		"# Prompt Export Comparison",
		"",
		`Base export: \`${result.baseExportDir}\``,
		`Patched export: \`${result.patchedExportDir}\``,
		`Runtime policy dir: \`${result.etcClaudeDir}\``,
		"",
		"## File Inventory",
		"",
		"| Metric | Count |",
		"|---|---:|",
		`| Base files | ${result.files.baseFiles} |`,
		`| Patched files | ${result.files.patchedFiles} |`,
		`| Common files | ${result.files.common} |`,
		`| Unchanged common files | ${result.files.unchanged} |`,
		`| Changed common files | ${result.files.changed} |`,
		`| Added patched-only files | ${result.files.added} |`,
		`| Removed base-only files | ${result.files.removed} |`,
		"",
	];

	if (result.manifest.countDeltas.length > 0) {
		lines.push(
			"## Manifest Count Deltas",
			"",
			"| Count | Base | Patched | Delta |",
			"|---|---:|---:|---:|",
			...result.manifest.countDeltas.map(
				(delta) =>
					`| \`${delta.key}\` | ${formatNumber(delta.base)} | ${formatNumber(
						delta.patched,
					)} | ${formatDelta(delta.delta)} |`,
			),
			"",
		);
	}

	lines.push("## Changed Files By Area", "");
	for (const [title, record] of [
		["Changed", result.files.changedByTopLevel],
		["Added", result.files.addedByTopLevel],
		["Removed", result.files.removedByTopLevel],
	] as const) {
		const rows = topRows(record, sampleLimit);
		if (rows.length === 0) continue;
		lines.push(
			`### ${title}`,
			"",
			"| Top-level path | Files |",
			"|---|---:|",
			...rows,
			"",
		);
	}

	const extensionRows = topRows(result.files.changedByExtension, sampleLimit);
	if (extensionRows.length > 0) {
		lines.push(
			"### Changed By Extension",
			"",
			"| Extension | Files |",
			"|---|---:|",
			...extensionRows,
			"",
		);
	}

	for (const [title, files] of [
		["Changed File Samples", result.files.changedFiles],
		["Added File Samples", result.files.addedFiles],
		["Removed File Samples", result.files.removedFiles],
	] as const) {
		const rows = sampleRows(files, sampleLimit);
		if (rows.length === 0) continue;
		lines.push(`## ${title}`, "", "| File |", "|---|", ...rows, "");
	}

	lines.push(
		"## Watched Prompt Surfaces",
		"",
		"| Status | Count |",
		"|---|---:|",
		`| Total watched | ${result.watchedSurfaces.total} |`,
		`| Unchanged | ${result.watchedSurfaces.unchanged} |`,
		`| Changed | ${result.watchedSurfaces.changed} |`,
		`| Added | ${result.watchedSurfaces.added} |`,
		`| Removed | ${result.watchedSurfaces.removed} |`,
		`| Missing from both exports | ${result.watchedSurfaces.missing} |`,
		"",
	);

	const watchedRows = statusRows(result.watchedSurfaces.surfaces, sampleLimit);
	if (watchedRows.length > 0) {
		lines.push("| File | Status |", "|---|---|", ...watchedRows, "");
	}

	lines.push(
		"## /etc Claude Code Layer",
		"",
		`Patched Markdown corpus: ${result.etcLayer.patchedMarkdownFiles} files, ${result.etcLayer.patchedComparableLines} comparable lines.`,
		`Runtime /etc policy corpus: ${result.etcLayer.files.length} Markdown files, ${result.etcLayer.totalCandidateLines} comparable lines.`,
		`Exact /etc lines found in patched export: ${result.etcLayer.totalExactLinesInPatchedExport}.`,
		"",
		"| /etc file | Candidate lines | Exact lines in patched export | Exact % |",
		"|---|---:|---:|---:|",
		...result.etcLayer.files.map(
			(file) =>
				`| \`${file.file}\` | ${file.candidateLines} | ${file.exactLinesInPatchedExport} | ${file.exactPct}% |`,
		),
		"",
		"Interpretation: `/etc/claude-code/system-prompt.md`, `CLAUDE.md`, and `.claude/rules/*.md` are runtime policy/context layers. They should not normally appear verbatim in the exported bundle prompts.",
		"",
		"## Policy Term Presence",
		"",
		"| Term | Patched export Markdown files | /etc Markdown files |",
		"|---|---:|---:|",
		...result.policyTerms.map(
			(term) =>
				`| ${term.label} | ${term.patchedExportFiles} | ${term.etcFiles} |`,
		),
		"",
	);

	return `${lines.join("\n").trimEnd()}\n`;
}
