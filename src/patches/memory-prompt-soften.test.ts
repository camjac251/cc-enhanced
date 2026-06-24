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
`;

const VANILLA_FIXTURE =
	PATH_SCOPED_MEMORY_PROMPT_FIXTURE + DREAM_MEMORY_PROMPT_FIXTURE;

test("memory-prompt-soften rewrites path-scoped legacy read-only shell list", () => {
	const output =
		memoryPromptSoften.string?.(VANILLA_FIXTURE) ?? VANILLA_FIXTURE;

	assert.equal(output.includes("ls, find, grep, cat"), false);
	assert.equal(output.includes("cat/head/tail/grep"), false);
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
	assert.equal(output.includes("Use \\`eza team/\\`"), true);
	assert.equal(
		output.includes("Use \\`eza\\` to list the memory directory"),
		true,
	);
	assert.equal(
		output.includes(
			"Use \\`eza team/\\` if a \\`team/\\` subdirectory is present",
		),
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

test("memory-prompt-soften verify requires team subdirectory guidance", () => {
	const output =
		memoryPromptSoften.string?.(VANILLA_FIXTURE) ?? VANILLA_FIXTURE;
	const withoutTeamSubdir = output.replace(
		"- Use \\`eza team/\\` if a \\`team/\\` subdirectory is present, and skim it alongside your personal files",
		"",
	);

	const result = memoryPromptSoften.verify(withoutTeamSubdir);

	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("Use \\`eza team/\\` if"), true);
});

test("memory-prompt-soften rewrites the escaped-backtick template team form", () => {
	// Forward-insurance branch: if upstream flips the team block from a quoted
	// string into a template literal, the escaped-backtick form is what the
	// template-team regex targets. This is the exact shape it matches.
	const templateForm = [
		"function f(){ return `# Dream: Memory Consolidation",
		"",
		"- **Phase 1:** \\`ls team/\\` and skim it alongside your personal files. A teammate may have already captured something you'd otherwise duplicate.",
		"`; }",
	].join("\n");
	const output = memoryPromptSoften.string?.(templateForm) ?? templateForm;
	assert.equal(output.includes("\\`ls team/\\`"), false);
	assert.equal(output.includes("Use \\`eza team/\\`"), true);
});

test("memory-prompt-soften team Phase-1 matches the plain-backtick form, escaped-backtick form is a no-op", () => {
	// The real bundle stores the team Phase-1 line in a plain string literal with
	// plain backticks. This pins that the plain-backtick rewrite is the one that
	// fires on the real surface; if upstream flips to the escaped-backtick template
	// form, this fails and forces a deliberate regex update.
	const plainBundleForm =
		'"## Team memory\n\n- **Phase 1:** `ls team/` and skim it alongside your personal files. A teammate may have already captured something you\'d otherwise duplicate."';
	const out = memoryPromptSoften.string?.(plainBundleForm) ?? plainBundleForm;
	assert.equal(
		out.includes("`ls team/`"),
		false,
		"plain-backtick team line rewritten",
	);
	assert.equal(
		out.includes("Use `eza team/`"),
		true,
		"plain-backtick modern form emitted",
	);
});

test("memory-prompt-soften emits exactly one modern transcript-search command", () => {
	const output =
		memoryPromptSoften.string?.(VANILLA_FIXTURE) ?? VANILLA_FIXTURE;
	const count = (s: string, needle: string) => s.split(needle).length - 1;
	assert.equal(count(output, 'rg -m 50 "<narrow term>"'), 1);
	assert.equal(count(output, "-g '*.jsonl'"), 1);
});

test("memory-prompt-soften fixture anchors each occur exactly once", () => {
	// The team line in the fixture uses the escaped-backtick representation the
	// bundle stores, so the escaped form is the one that must appear once.
	const count = (s: string, needle: string) => s.split(needle).length - 1;
	for (const needle of [
		"ls, find, grep, cat, stat, wc, head, tail, and similar",
		"grep narrowly, don't read whole files",
		"\\`ls team/\\`",
		"\\`ls\\` the memory directory",
		"\\`ls -R logs/\\`",
		"grep the JSONL transcripts",
		"\\`grep -rn",
	]) {
		assert.equal(count(VANILLA_FIXTURE, needle), 1, needle);
	}
});

test("memory-prompt-soften string() is idempotent", () => {
	const once = memoryPromptSoften.string?.(VANILLA_FIXTURE) ?? VANILLA_FIXTURE;
	const twice = memoryPromptSoften.string?.(once) ?? once;
	assert.equal(twice, once);
	assert.equal(memoryPromptSoften.verify(twice), true);
});

test("memory-prompt-soften preserves path-scoped dynamic command and path fragments", () => {
	const output =
		memoryPromptSoften.string?.(PATH_SCOPED_MEMORY_PROMPT_FIXTURE) ??
		PATH_SCOPED_MEMORY_PROMPT_FIXTURE;
	assert.equal(output.includes('${isPosix ? "rm" : "Remove-Item"}'), true);
	assert.equal(output.includes("with all paths inside ${root}"), true);
	assert.equal(output.includes("are permitted in this context."), true);
});
