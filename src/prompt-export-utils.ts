import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const MAX_PROMPT_ARTIFACT_SLUG_LENGTH = 180;
const PROMPT_ARTIFACT_SLUG_HASH_LENGTH = 12;

export function createFilesystemSlug(value: string): string {
	const normalized = value
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-+/g, "-");
	if (normalized.length <= MAX_PROMPT_ARTIFACT_SLUG_LENGTH) {
		return normalized;
	}

	const digest = createHash("sha256")
		.update(normalized)
		.digest("hex")
		.slice(0, PROMPT_ARTIFACT_SLUG_HASH_LENGTH);
	const prefix = normalized
		.slice(
			0,
			MAX_PROMPT_ARTIFACT_SLUG_LENGTH - PROMPT_ARTIFACT_SLUG_HASH_LENGTH - 1,
		)
		.replace(/-+$/g, "");
	return `${prefix}-${digest}`;
}
export function createUniqueSlug(base: string, seen: Set<string>): string {
	const safeBase = base || "artifact";
	let candidate = safeBase;
	let suffix = 2;
	while (seen.has(candidate)) {
		candidate = `${safeBase}-${suffix}`;
		suffix += 1;
	}
	seen.add(candidate);
	return candidate;
}

export function writeArtifact(
	outputDir: string,
	written: Set<string>,
	relativePath: string,
	content: string,
): void {
	if (written.has(relativePath)) {
		throw new Error(
			`Refusing to overwrite duplicate artifact: ${relativePath}`,
		);
	}

	const targetPath = path.join(outputDir, relativePath);
	fs.mkdirSync(path.dirname(targetPath), { recursive: true });
	fs.writeFileSync(targetPath, content);
	written.add(relativePath);
}

export function extractFrontmatterName(text: string): string | null {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
	if (!match) return null;

	for (const line of match[1].split(/\r?\n/)) {
		const nameMatch = /^\s*name\s*:\s*(.+?)\s*$/.exec(line);
		if (!nameMatch) continue;
		return nameMatch[1].trim().replace(/^['"]|['"]$/g, "");
	}
	return null;
}

export function buildFrontmatterPromptMap(
	corpus: Array<{ text: string }>,
): Map<string, string> {
	const promptsByFrontmatterName = new Map<string, string>();
	for (const entry of corpus) {
		const name = extractFrontmatterName(entry.text);
		if (!name) continue;
		const existing = promptsByFrontmatterName.get(name);
		if (!existing || entry.text.length > existing.length) {
			promptsByFrontmatterName.set(name, entry.text);
		}
	}
	return promptsByFrontmatterName;
}

function unresolvedPlaceholderCount(text: string): number {
	return text.match(/\$\{[^}]+\}/g)?.length ?? 0;
}

export function selectPromptCorpusText(
	corpus: Array<{ text: string }>,
	anchors: readonly string[],
): string | null {
	const candidates = corpus
		.map((entry) => entry.text)
		.filter((text) => anchors.every((anchor) => text.includes(anchor)))
		.sort((left, right) => {
			const placeholderDelta =
				unresolvedPlaceholderCount(left) - unresolvedPlaceholderCount(right);
			if (placeholderDelta !== 0) return placeholderDelta;
			if (left.length !== right.length) return left.length - right.length;
			return left.localeCompare(right);
		});
	return candidates[0] ?? null;
}
