import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	countForbiddenPromptDashStyle,
	type PromptDashStyleCounts,
} from "../prompt-dash-style.js";

export interface PromptExportCompareInput {
	baselineExportDir: string;
	candidateExportDir: string;
	etcClaudeDir: string;
	/** Defaults to the union of Markdown paths discovered in both stock exports. */
	watchPaths?: readonly string[];
	minOverlapLineLength?: number;
}

export interface PromptExportCompareResult {
	baselineExportDir: string;
	candidateExportDir: string;
	etcClaudeDir: string;
	files: FileInventoryComparison;
	manifest: ManifestComparison;
	unicodeDashStyle: UnicodeDashStyleComparison;
	watchedSurfaces: WatchedSurfaceComparison;
	etcLayer: EtcLayerComparison;
	policyTerms: PolicyTermComparison[];
}

export interface FileInventoryComparison {
	baselineFiles: number;
	candidateFiles: number;
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
	baselineManifestPath: string;
	candidateManifestPath: string;
	baselinePresent: boolean;
	candidatePresent: boolean;
	countDeltas: ManifestCountDelta[];
}

export interface ManifestCountDelta {
	key: string;
	baseline: number | null;
	candidate: number | null;
	delta: number | null;
}

export interface UnicodeDashStyleComparison {
	baseline: UnicodeDashCorpusStats;
	candidate: UnicodeDashCorpusStats;
	delta: PromptDashStyleCounts;
	changedFiles: UnicodeDashFileComparison[];
}

export interface UnicodeDashCorpusStats extends PromptDashStyleCounts {
	markdownFiles: number;
	filesWithDashes: number;
}

export interface UnicodeDashFileComparison {
	file: string;
	baseline: PromptDashStyleCounts;
	candidate: PromptDashStyleCounts;
	delta: PromptDashStyleCounts;
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
	totalExactLinesInCandidateExport: number;
	candidateMarkdownFiles: number;
	candidateComparableLines: number;
}

export interface EtcPromptFileComparison {
	file: string;
	candidateLines: number;
	exactLinesInCandidateExport: number;
	exactPct: number;
}

export interface PolicyTermComparison {
	id: string;
	label: string;
	candidateExportFiles: number;
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
		label: "ast-grep structural search",
		pattern: /\bast-grep\b|\bmcp__ast[-_]grep__/i,
	},
	{
		id: "rg-lexical",
		label: "rg exact lexical search",
		pattern: /\brg\b|\bripgrep\b/i,
	},
	{
		id: "bat-ranges",
		label: "bat range-based reading",
		pattern: /\bbat\b|bat -r/i,
	},
	{
		id: "output-limits",
		label: "producer-native output bounds",
		pattern:
			/\bproducer's native\b|\bproducer-native\b|\bnative limit\b|\brange or semantic selection\b/i,
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
	baselineFiles: Map<string, CollectedFile>,
	candidateFiles: Map<string, CollectedFile>,
): FileInventoryComparison {
	const baselinePaths = new Set(baselineFiles.keys());
	const candidatePaths = new Set(candidateFiles.keys());
	const changedFiles: string[] = [];
	const addedFiles: string[] = [];
	const removedFiles: string[] = [];
	let unchanged = 0;

	for (const relativePath of [...candidatePaths].sort()) {
		if (!baselinePaths.has(relativePath)) {
			addedFiles.push(relativePath);
			continue;
		}
		const baseline = baselineFiles.get(relativePath);
		const candidate = candidateFiles.get(relativePath);
		if (!baseline || !candidate) continue;
		if (baseline.hash === candidate.hash) {
			unchanged++;
		} else {
			changedFiles.push(relativePath);
		}
	}

	for (const relativePath of [...baselinePaths].sort()) {
		if (!candidatePaths.has(relativePath)) removedFiles.push(relativePath);
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
		baselineFiles: baselinePaths.size,
		candidateFiles: candidatePaths.size,
		common: [...baselinePaths].filter((relativePath) =>
			candidatePaths.has(relativePath),
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
	baselineExportDir: string,
	candidateExportDir: string,
): Promise<ManifestComparison> {
	const baseline = await readManifest(baselineExportDir);
	const candidate = await readManifest(candidateExportDir);
	const keys = new Set([
		...Object.keys(baseline.counts),
		...Object.keys(candidate.counts),
	]);
	const countDeltas: ManifestCountDelta[] = [];

	for (const key of [...keys].sort()) {
		const baselineValue = baseline.counts[key] ?? null;
		const candidateValue = candidate.counts[key] ?? null;
		if (baselineValue === candidateValue) continue;
		countDeltas.push({
			key: key.replace(/^manifest\./, ""),
			baseline: baselineValue,
			candidate: candidateValue,
			delta:
				baselineValue === null || candidateValue === null
					? null
					: candidateValue - baselineValue,
		});
	}

	return {
		baselineManifestPath: baseline.path,
		candidateManifestPath: candidate.path,
		baselinePresent: baseline.present,
		candidatePresent: candidate.present,
		countDeltas,
	};
}

function compareWatchedSurfaces(
	baselineFiles: Map<string, CollectedFile>,
	candidateFiles: Map<string, CollectedFile>,
	watchPaths: readonly string[],
): WatchedSurfaceComparison {
	const surfaces = watchPaths.map((file): WatchedSurfaceStatus => {
		const baseline = baselineFiles.get(file);
		const candidate = candidateFiles.get(file);
		if (!baseline && !candidate) return { file, status: "missing" };
		if (!baseline && candidate) return { file, status: "added" };
		if (baseline && !candidate) return { file, status: "removed" };
		return {
			file,
			status: baseline?.hash === candidate?.hash ? "unchanged" : "changed",
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
	candidateMarkdownFiles: Map<string, CollectedFile>,
	minOverlapLineLength: number,
): Promise<EtcLayerComparison> {
	const etcMarkdownFiles = await collectFiles(etcClaudeDir, {
		includeContent: true,
		onlyMarkdown: true,
	});
	const candidateExportLines = collectMarkdownComparableLines(
		candidateMarkdownFiles,
		minOverlapLineLength,
	);
	const files: EtcPromptFileComparison[] = [];
	let totalCandidateLines = 0;
	let totalExactLinesInCandidateExport = 0;

	for (const file of etcMarkdownFiles.values()) {
		const candidateLines = extractComparableLines(
			file.content ?? "",
			minOverlapLineLength,
		);
		const exactLines = [...candidateLines].filter((line) =>
			candidateExportLines.has(line),
		);
		const exactPct =
			candidateLines.size === 0
				? 0
				: Number(((exactLines.length / candidateLines.size) * 100).toFixed(1));
		files.push({
			file: file.relativePath,
			candidateLines: candidateLines.size,
			exactLinesInCandidateExport: exactLines.length,
			exactPct,
		});
		totalCandidateLines += candidateLines.size;
		totalExactLinesInCandidateExport += exactLines.length;
	}

	files.sort((left, right) => left.file.localeCompare(right.file));

	return {
		files,
		totalCandidateLines,
		totalExactLinesInCandidateExport,
		candidateMarkdownFiles: candidateMarkdownFiles.size,
		candidateComparableLines: candidateExportLines.size,
	};
}

function comparePolicyTerms(
	candidateMarkdownFiles: Map<string, CollectedFile>,
	etcMarkdownFiles: Map<string, CollectedFile>,
): PolicyTermComparison[] {
	return POLICY_TERMS.map((term) => ({
		id: term.id,
		label: term.label,
		candidateExportFiles: countPolicyFiles(
			candidateMarkdownFiles,
			term.pattern,
		),
		etcFiles: countPolicyFiles(etcMarkdownFiles, term.pattern),
	}));
}

function emptyDashCounts(): PromptDashStyleCounts {
	return {
		enDash: 0,
		emDash: 0,
		total: 0,
	};
}

function addDashCounts(
	left: PromptDashStyleCounts,
	right: PromptDashStyleCounts,
): PromptDashStyleCounts {
	return {
		enDash: left.enDash + right.enDash,
		emDash: left.emDash + right.emDash,
		total: left.total + right.total,
	};
}

function subtractDashCounts(
	left: PromptDashStyleCounts,
	right: PromptDashStyleCounts,
): PromptDashStyleCounts {
	return {
		enDash: left.enDash - right.enDash,
		emDash: left.emDash - right.emDash,
		total: left.total - right.total,
	};
}

function countMarkdownDashStyle(
	files: Map<string, CollectedFile>,
): UnicodeDashCorpusStats {
	let total = emptyDashCounts();
	let filesWithDashes = 0;
	for (const file of files.values()) {
		const counts = countForbiddenPromptDashStyle(file.content ?? "");
		total = addDashCounts(total, counts);
		if (counts.total > 0) filesWithDashes++;
	}
	return {
		...total,
		markdownFiles: files.size,
		filesWithDashes,
	};
}

function compareUnicodeDashStyle(
	baselineMarkdownFiles: Map<string, CollectedFile>,
	candidateMarkdownFiles: Map<string, CollectedFile>,
): UnicodeDashStyleComparison {
	const allPaths = new Set([
		...baselineMarkdownFiles.keys(),
		...candidateMarkdownFiles.keys(),
	]);
	const changedFiles: UnicodeDashFileComparison[] = [];

	for (const file of [...allPaths].sort()) {
		const baseline = countForbiddenPromptDashStyle(
			baselineMarkdownFiles.get(file)?.content ?? "",
		);
		const candidate = countForbiddenPromptDashStyle(
			candidateMarkdownFiles.get(file)?.content ?? "",
		);
		const delta = subtractDashCounts(candidate, baseline);
		if (delta.total === 0 && delta.enDash === 0 && delta.emDash === 0) {
			continue;
		}
		changedFiles.push({ file, baseline, candidate, delta });
	}

	changedFiles.sort(
		(left, right) =>
			Math.abs(right.delta.total) - Math.abs(left.delta.total) ||
			left.file.localeCompare(right.file),
	);

	const baseline = countMarkdownDashStyle(baselineMarkdownFiles);
	const candidate = countMarkdownDashStyle(candidateMarkdownFiles);
	return {
		baseline,
		candidate,
		delta: subtractDashCounts(candidate, baseline),
		changedFiles,
	};
}

export async function comparePromptExports({
	baselineExportDir,
	candidateExportDir,
	etcClaudeDir,
	watchPaths,
	minOverlapLineLength = DEFAULT_MIN_OVERLAP_LINE_LENGTH,
}: PromptExportCompareInput): Promise<PromptExportCompareResult> {
	const baselineFiles = await collectFiles(baselineExportDir);
	const candidateFiles = await collectFiles(candidateExportDir);
	const baselineMarkdownFiles = await collectFiles(baselineExportDir, {
		includeContent: true,
		onlyMarkdown: true,
	});
	const candidateMarkdownFiles = await collectFiles(candidateExportDir, {
		includeContent: true,
		onlyMarkdown: true,
	});
	const etcMarkdownFiles = await collectFiles(etcClaudeDir, {
		includeContent: true,
		onlyMarkdown: true,
	});
	const stockWatchPaths =
		watchPaths ??
		[
			...new Set([
				...baselineMarkdownFiles.keys(),
				...candidateMarkdownFiles.keys(),
			]),
		].sort();

	return {
		baselineExportDir,
		candidateExportDir,
		etcClaudeDir,
		files: compareFileInventory(baselineFiles, candidateFiles),
		manifest: await compareManifests(baselineExportDir, candidateExportDir),
		unicodeDashStyle: compareUnicodeDashStyle(
			baselineMarkdownFiles,
			candidateMarkdownFiles,
		),
		watchedSurfaces: compareWatchedSurfaces(
			baselineFiles,
			candidateFiles,
			stockWatchPaths,
		),
		etcLayer: await compareEtcLayer(
			etcClaudeDir,
			candidateMarkdownFiles,
			minOverlapLineLength,
		),
		policyTerms: comparePolicyTerms(candidateMarkdownFiles, etcMarkdownFiles),
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
		`Baseline export: \`${result.baselineExportDir}\``,
		`Candidate export: \`${result.candidateExportDir}\``,
		`Runtime policy dir: \`${result.etcClaudeDir}\``,
		"",
		"## File Inventory",
		"",
		"| Metric | Count |",
		"|---|---:|",
		`| Baseline files | ${result.files.baselineFiles} |`,
		`| Candidate files | ${result.files.candidateFiles} |`,
		`| Common files | ${result.files.common} |`,
		`| Unchanged common files | ${result.files.unchanged} |`,
		`| Changed common files | ${result.files.changed} |`,
		`| Added candidate-only files | ${result.files.added} |`,
		`| Removed baseline-only files | ${result.files.removed} |`,
		"",
	];

	if (result.manifest.countDeltas.length > 0) {
		lines.push(
			"## Manifest Count Deltas",
			"",
			"| Count | Baseline | Candidate | Delta |",
			"|---|---:|---:|---:|",
			...result.manifest.countDeltas.map(
				(delta) =>
					`| \`${delta.key}\` | ${formatNumber(delta.baseline)} | ${formatNumber(
						delta.candidate,
					)} | ${formatDelta(delta.delta)} |`,
			),
			"",
		);
	}

	lines.push(
		"## Unicode Dash Style",
		"",
		"| Metric | Baseline | Candidate | Delta |",
		"|---|---:|---:|---:|",
		`| Markdown files | ${result.unicodeDashStyle.baseline.markdownFiles} | ${result.unicodeDashStyle.candidate.markdownFiles} | ${formatDelta(
			result.unicodeDashStyle.candidate.markdownFiles -
				result.unicodeDashStyle.baseline.markdownFiles,
		)} |`,
		`| Files with Unicode dash punctuation | ${result.unicodeDashStyle.baseline.filesWithDashes} | ${result.unicodeDashStyle.candidate.filesWithDashes} | ${formatDelta(
			result.unicodeDashStyle.candidate.filesWithDashes -
				result.unicodeDashStyle.baseline.filesWithDashes,
		)} |`,
		`| En dash characters | ${result.unicodeDashStyle.baseline.enDash} | ${result.unicodeDashStyle.candidate.enDash} | ${formatDelta(
			result.unicodeDashStyle.delta.enDash,
		)} |`,
		`| Em dash characters | ${result.unicodeDashStyle.baseline.emDash} | ${result.unicodeDashStyle.candidate.emDash} | ${formatDelta(
			result.unicodeDashStyle.delta.emDash,
		)} |`,
		`| Total Unicode dash punctuation | ${result.unicodeDashStyle.baseline.total} | ${result.unicodeDashStyle.candidate.total} | ${formatDelta(
			result.unicodeDashStyle.delta.total,
		)} |`,
		"",
	);

	const dashRows = result.unicodeDashStyle.changedFiles
		.slice(0, sampleLimit)
		.map(
			(file) =>
				`| \`${file.file}\` | ${file.baseline.total} | ${file.candidate.total} | ${formatDelta(
					file.delta.total,
				)} |`,
		);
	if (dashRows.length > 0) {
		lines.push(
			"### Unicode Dash File Deltas",
			"",
			"| File | Baseline | Candidate | Delta |",
			"|---|---:|---:|---:|",
			...dashRows,
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
		`Candidate Markdown corpus: ${result.etcLayer.candidateMarkdownFiles} files, ${result.etcLayer.candidateComparableLines} comparable lines.`,
		`Runtime /etc policy corpus: ${result.etcLayer.files.length} Markdown files, ${result.etcLayer.totalCandidateLines} comparable lines.`,
		`Exact /etc lines found in candidate export: ${result.etcLayer.totalExactLinesInCandidateExport}.`,
		"",
		"| /etc file | Comparable lines | Exact lines in candidate export | Exact % |",
		"|---|---:|---:|---:|",
		...result.etcLayer.files.map(
			(file) =>
				`| \`${file.file}\` | ${file.candidateLines} | ${file.exactLinesInCandidateExport} | ${file.exactPct}% |`,
		),
		"",
		"Interpretation: `/etc/claude-code/system-prompt.md`, `CLAUDE.md`, and `.claude/rules/*.md` are runtime policy/context layers. They should not normally appear verbatim in the exported bundle prompts.",
		"",
		"## Policy Term Presence",
		"",
		"| Term | Candidate export Markdown files | /etc Markdown files |",
		"|---|---:|---:|",
		...result.policyTerms.map(
			(term) =>
				`| ${term.label} | ${term.candidateExportFiles} | ${term.etcFiles} |`,
		),
		"",
	);

	return `${lines.join("\n").trimEnd()}\n`;
}
