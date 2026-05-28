import { execFileSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

interface NormalizeOptions {
	filepath?: string;
}

const BIOME_BIN = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"node_modules/.bin/biome",
);

// Bundle is far over biome's default 1MB ceiling; raise the cap.
const BIOME_MAX_FILE_SIZE = 64 * 1024 * 1024;
// Formatted output is much larger than execFileSync's 1MB default; raise the buffer.
const BIOME_MAX_BUFFER = 512 * 1024 * 1024;

/**
 * Format JavaScript with biome.
 *
 * biome is ~2.6x faster and ~4x lighter than prettier on the bundle and
 * produces output that every patch applies to identically. Formatter settings
 * are passed as flags (mirroring the former prettier config). biome runs from a
 * neutral working directory and reads via stdin so the repo's own biome config,
 * which scopes to src/, does not treat the bundle as an ignored file.
 */
export async function normalize(
	code: string,
	opts: NormalizeOptions = {},
): Promise<string> {
	const stdinPath = path.basename(opts.filepath ?? "file.js");
	return execFileSync(
		BIOME_BIN,
		[
			"format",
			`--stdin-file-path=${stdinPath}`,
			`--files-max-size=${BIOME_MAX_FILE_SIZE}`,
			"--line-width=100",
			"--indent-style=space",
			"--indent-width=2",
			"--javascript-formatter-quote-style=double",
			"--semicolons=always",
			"--trailing-commas=all",
			"--arrow-parentheses=always",
		],
		{
			input: code,
			cwd: os.tmpdir(),
			encoding: "utf-8",
			maxBuffer: BIOME_MAX_BUFFER,
		},
	);
}
