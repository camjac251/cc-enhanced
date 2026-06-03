import * as fs from "node:fs";
import * as path from "node:path";

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
