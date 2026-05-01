import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryPromptSoften } from "./memory-prompt-soften.js";

const PATH_SCOPED_MEMORY_PROMPT_FIXTURE = `
const message = \`Only read-only shell commands and \${isPosix ? "rm" : "Remove-Item"} with all paths inside \${root} are permitted in this context (\${isPosix ? "ls, find, grep, cat, stat, wc, head, tail, and similar" : "Get-ChildItem, Get-Content, Select-Object -First/-Last, and similar"})\`;
`;

const DREAM_MEMORY_PROMPT_FIXTURE = `
function kD$(H, $, q, K = !1) {
  return \`# Dream: Memory Consolidation

Session transcripts: \\\`\${$}\\\` (large JSONL files \\u2014 grep narrowly, don't read whole files)

- **Phase 1:** \\\`ls team/\\\` and skim it alongside your personal files. A teammate may have already captured something you'd otherwise duplicate.

- \\\`ls\\\` the memory directory to see what already exists
- \\\`ls -R logs/\\\` \\u2014 recent activity logs (one file per session under \\\`YYYY/MM/DD/\\\`). If a \\\`sessions/\\\` subdirectory also exists, review recent entries there too

3. **Transcript search** \\u2014 if you need specific context (e.g., "what was the error message from yesterday's build failure?"), grep the JSONL transcripts for narrow terms:
   \\\`grep -rn "<narrow term>" \${$}/ --include="*.jsonl" | tail -50\\\`
\`;
}

function Kx7(H, $, q = !1) {
  return \`# Dream: Memory Pruning

1. \\\`find \${H} -name '*.md'\\\` to enumerate every memory file (including any \\\`team/\\\` subdirectory).
\`;
}
`;

const VANILLA_FIXTURE =
	PATH_SCOPED_MEMORY_PROMPT_FIXTURE + DREAM_MEMORY_PROMPT_FIXTURE;

test("memory-prompt-soften rewrites path-scoped legacy read-only shell list", () => {
	const output =
		memoryPromptSoften.string?.(VANILLA_FIXTURE) ?? VANILLA_FIXTURE;

	assert.equal(output.includes("ls, find, grep, cat"), false);
	assert.equal(output.includes("with all paths inside ${root}"), true);
	assert.equal(output.includes("bat ranges"), true);
	assert.equal(memoryPromptSoften.verify(output), true);
});

test("memory-prompt-soften rewrites dream memory command guidance", () => {
	const output =
		memoryPromptSoften.string?.(VANILLA_FIXTURE) ?? VANILLA_FIXTURE;

	assert.equal(output.includes("grep narrowly, don't read whole files"), false);
	assert.equal(output.includes("\\`ls team/\\`"), false);
	assert.equal(output.includes("\\`ls\\` the memory directory"), false);
	assert.equal(output.includes("\\`ls -R logs/\\`"), false);
	assert.equal(output.includes("grep the JSONL transcripts"), false);
	assert.equal(output.includes("\\`grep -rn"), false);
	assert.equal(output.includes("\\`find ${H} -name '*.md'\\`"), false);
	assert.equal(output.includes("Use \\`eza team/\\`"), true);
	assert.equal(
		output.includes("Use \\`eza\\` to list the memory directory"),
		true,
	);
	assert.equal(
		output.includes("Use \\`fd -t f . logs/\\` to list recent activity logs"),
		true,
	);
	assert.equal(
		output.includes("use \\`rg -m 50\\` on the JSONL transcripts"),
		true,
	);
	assert.equal(
		output.includes(
			"Use \\`fd -e md -t f .\\` against the memory directory shown above",
		),
		true,
	);
});

test("memory-prompt-soften verify rejects legacy list", () => {
	const result = memoryPromptSoften.verify(PATH_SCOPED_MEMORY_PROMPT_FIXTURE);
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("legacy ls/find/grep"), true);
});

test("memory-prompt-soften verify rejects missing modern guidance", () => {
	const result = memoryPromptSoften.verify("const noop = true;");
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("missing modern read-only"), true);
});
