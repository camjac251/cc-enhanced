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
