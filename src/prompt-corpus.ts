import { createHash } from "node:crypto";

export interface PromptCorpusEntry {
	kind: "string" | "template";
	text: string;
	pieces: string[];
	placeholderExpressions: string[];
	start: number;
	end: number;
}

export interface PromptDatasetPrompt {
	name: string;
	id: string;
	description: string;
	pieces: string[];
	identifiers: number[];
	identifierMap: Record<string, string>;
	version: string;
}

export interface PromptDataset {
	version: string;
	prompts: PromptDatasetPrompt[];
}

export interface PromptHashEntry {
	id: string;
	textHash: string;
	structureHash: string;
}

export interface PromptHashIndex {
	version: string;
	algorithm: "sha256";
	datasetHash: string;
	prompts: PromptHashEntry[];
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function slugify(value: string): string {
	return value
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-+/g, "-");
}

function sanitizeIdentifierSeed(value: string): string {
	const cleaned = value
		.replace(/[^A-Za-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.toUpperCase();
	if (cleaned.length === 0) return "EXPR";
	if (/^\d/.test(cleaned)) return `EXPR_${cleaned}`;
	return cleaned.slice(0, 64);
}

function derivePromptName(text: string): string {
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	if (lines.length === 0) return "Prompt";
	const heading = lines.find((line) => line.startsWith("# "));
	if (heading) return heading.replace(/^#\s*/, "").trim().slice(0, 120);
	return lines[0].slice(0, 120);
}

function derivePromptDescription(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, 180);
}

export function isValidPromptText(text: string, minLength = 250): boolean {
	if (!text || typeof text !== "string") return false;

	if (text.startsWith("This is the git status")) return true;
	if (
		text.includes(
			"Whenever you read a file, you should consider whether it would be considered malware.",
		)
	) {
		return true;
	}
	if (text.includes("IMPORTANT: Assist with authorized security testing")) {
		return true;
	}
	if (
		text.includes(
			"When working with tool results, write down any important information",
		)
	) {
		return true;
	}

	if (text.includes('.dim("Note:')) return false;
	if (text.startsWith("Add an MCP server to Claude Code.")) return false;
	if (text.includes("Cannot install keybindings from a remote")) return false;

	if (text.length < minLength) return false;

	const first10 = text.substring(0, 10);
	if (first10.startsWith("AGFzbQ") || /^[A-Z0-9+/=]{10}$/.test(first10)) {
		return false;
	}

	const sample = text.substring(0, 500);
	const words = sample.split(/\s+/).filter((word) => word.length > 0);
	if (words.length === 0) return false;

	const uppercaseWords = words.filter(
		(word) => word === word.toUpperCase() && /[A-Z]/.test(word),
	);
	const uppercaseRatio = uppercaseWords.length / words.length;
	if (uppercaseRatio > 0.6) return false;

	const lower = text.toLowerCase();
	const hasYou = lower.includes("you");
	const hasAssistant = lower.includes("ai") || lower.includes("assistant");
	const hasInstruction =
		lower.includes("must") ||
		lower.includes("should") ||
		lower.includes("always");
	if (!hasYou && !hasAssistant && !hasInstruction) return false;

	const hasSentences = /[.!?]\s+[A-Z(]/.test(text);
	if (!hasSentences) return false;

	const avgWordLength =
		words.reduce((sum, word) => sum + word.length, 0) / words.length;
	if (avgWordLength > 15) return false;

	const spaces = (sample.match(/\s/g) || []).length;
	const spaceRatio = spaces / sample.length;
	if (spaceRatio < 0.1) return false;

	return true;
}

export function dedupeCorpusByRange(
	entries: PromptCorpusEntry[],
): PromptCorpusEntry[] {
	const sorted = [...entries].sort((left, right) => {
		if (left.start !== right.start) return left.start - right.start;
		return right.end - left.end;
	});

	const kept: PromptCorpusEntry[] = [];
	const ranges: Array<{ start: number; end: number }> = [];
	for (const entry of sorted) {
		const subset = ranges.some(
			(range) => entry.start >= range.start && entry.end <= range.end,
		);
		if (subset) continue;
		kept.push(entry);
		ranges.push({ start: entry.start, end: entry.end });
	}
	return kept;
}

export function encodePlaceholderExpressions(expressions: string[]): {
	identifiers: number[];
	identifierMap: Record<string, string>;
} {
	const expressionToLabel = new Map<string, number>();
	const identifierMap: Record<string, string> = {};
	const tokenUsage = new Map<string, number>();
	const identifiers: number[] = [];

	for (const expression of expressions) {
		const existing = expressionToLabel.get(expression);
		if (existing !== undefined) {
			identifiers.push(existing);
			continue;
		}

		const nextLabel = expressionToLabel.size;
		expressionToLabel.set(expression, nextLabel);
		identifiers.push(nextLabel);

		const baseToken = sanitizeIdentifierSeed(expression);
		const seen = tokenUsage.get(baseToken) ?? 0;
		tokenUsage.set(baseToken, seen + 1);
		const token = seen === 0 ? baseToken : `${baseToken}_${seen + 1}`;
		identifierMap[String(nextLabel)] = token;
	}

	return { identifiers, identifierMap };
}

function stablePromptId(entry: PromptCorpusEntry): string {
	const hashInput = JSON.stringify({
		kind: entry.kind,
		pieces: entry.pieces,
		placeholderExpressions: entry.placeholderExpressions,
		text: entry.text,
	});
	return `prompt-${sha256(hashInput).slice(0, 16)}`;
}

export function buildPromptDataset(
	version: string,
	entries: PromptCorpusEntry[],
): PromptDataset {
	const promptsById = new Map<string, PromptDatasetPrompt>();
	for (const entry of entries) {
		const { identifiers, identifierMap } = encodePlaceholderExpressions(
			entry.placeholderExpressions,
		);
		const name = derivePromptName(entry.text);
		const id = stablePromptId(entry);
		if (promptsById.has(id)) continue;
		promptsById.set(id, {
			name,
			id,
			description: derivePromptDescription(entry.text),
			pieces: entry.pieces,
			identifiers,
			identifierMap,
			version,
		});
	}
	const prompts = [...promptsById.values()].sort((left, right) =>
		left.id.localeCompare(right.id),
	);

	return { version, prompts };
}

export function buildPromptHashIndex(
	version: string,
	dataset: PromptDataset,
	entriesById: Map<string, PromptCorpusEntry>,
): PromptHashIndex {
	const promptsById = new Map<string, PromptHashEntry>();
	for (const prompt of dataset.prompts) {
		if (promptsById.has(prompt.id)) continue;
		const sourceEntry = entriesById.get(prompt.id);
		const textHash = sha256(sourceEntry?.text ?? "");
		const structureHash = sha256(
			JSON.stringify({
				pieces: prompt.pieces,
				identifiers: prompt.identifiers,
				identifierMap: prompt.identifierMap,
			}),
		);
		promptsById.set(prompt.id, { id: prompt.id, textHash, structureHash });
	}
	const prompts = [...promptsById.values()].sort((left, right) =>
		left.id.localeCompare(right.id),
	);

	const datasetHash = sha256(JSON.stringify(dataset));
	return {
		version,
		algorithm: "sha256",
		datasetHash,
		prompts,
	};
}

export function buildPromptCorpusIdMap(
	entries: PromptCorpusEntry[],
): Map<string, PromptCorpusEntry> {
	const byId = new Map<string, PromptCorpusEntry>();
	for (const entry of entries) {
		const id = stablePromptId(entry);
		if (byId.has(id)) continue;
		byId.set(id, entry);
	}
	return byId;
}

export function buildPromptCorpusDebug(
	dataset: PromptDataset,
	entriesById: Map<string, PromptCorpusEntry>,
): Array<{
	id: string;
	name: string;
	description: string;
	version: string;
	kind: "string" | "template";
	pieces: string[];
	identifiers: number[];
	identifierMap: Record<string, string>;
	text: string;
}> {
	return dataset.prompts.map((prompt) => {
		const entry = entriesById.get(prompt.id);
		return {
			id: prompt.id,
			name: prompt.name,
			description: prompt.description,
			version: prompt.version,
			kind: entry?.kind ?? "string",
			pieces: prompt.pieces,
			identifiers: prompt.identifiers,
			identifierMap: prompt.identifierMap,
			text: entry?.text ?? "",
		};
	});
}

export function buildPromptDatasetFilename(version: string): string {
	return `prompts-${slugify(version)}.json`;
}
