import type { Patch } from "../types.js";

const LEGACY_PATH_SCOPED_MEMORY_READONLY_RE =
	/Only read-only shell commands and (\$\{[^}]+\}) with all paths inside (\$\{[^}]+\}) are permitted in this context \(\$\{[^?]+ \? "ls, find, grep, cat, stat, wc, head, tail, and similar" : "Get-ChildItem, Get-Content, Select-Object -First\/-Last, and similar"\}\)/g;

const LEGACY_DREAM_TRANSCRIPTS_RE =
	/Session transcripts: (\\`\$\{[^}]+\}\\`) \(large JSONL files \\u2014 grep narrowly, don't read whole files\)/g;
const LEGACY_DREAM_TEAM_LIST_TEMPLATE_RE =
	/- \*\*Phase 1:\*\* \\`ls team\/\\` and skim it alongside your personal files\. A teammate may have already captured something you'd otherwise duplicate\./g;
const LEGACY_DREAM_TEAM_LIST_TEXT_RE =
	/- \*\*Phase 1:\*\* `ls team\/` and skim it alongside your personal files\. A teammate may have already captured something you'd otherwise duplicate\./g;
const LEGACY_DREAM_LIST_MEMORY_RE =
	/- \\`ls\\` the memory directory to see what already exists/g;
const LEGACY_DREAM_LIST_LOGS_RE =
	/- \\`ls -R logs\/\\` \\u2014 recent activity logs \(one file per session under \\`YYYY\/MM\/DD\/\\`\)\. If a \\`sessions\/\\` subdirectory also exists, review recent entries there too/g;
const LEGACY_DREAM_TRANSCRIPT_SEARCH_LABEL_RE =
	/\*\*Transcript search\*\* \\u2014 if you need specific context \(e\.g\., "what was the error message from yesterday's build failure\?"\), grep the JSONL transcripts for narrow terms:/g;
const LEGACY_DREAM_TRANSCRIPT_SEARCH_COMMAND_RE =
	/\\`grep -rn "<narrow term>" (\$\{[^}]+\})\/ --include="\*\.jsonl" \| tail -50\\`/g;
const LEGACY_DREAM_FIND_MEMORY_FILES_RE =
	/1\. \\`find (\$\{[^}]+\}) -name '\*\.md'\\` to enumerate every memory file \(including any \\`team\/\\` subdirectory\)\./g;

const MODERN_PATH_SCOPED_MEMORY_READONLY =
	"Only read-only shell commands and $1 with all paths inside $2 are permitted in this context. Prefer modern read-only inspection commands such as fd, eza, sg, rg for non-code text, bat ranges, git status/log/diff, stat, and wc when needed. Do not use legacy Unix viewing or truncation utilities as generic inspection tools.";
const MODERN_DREAM_TRANSCRIPTS =
	"Session transcripts: $1 (large JSONL files. Use \\`rg -m 50\\` narrowly; don't read whole files)";
const MODERN_DREAM_TEAM_LIST_TEMPLATE =
	"- **Phase 1:** Use \\`eza team/\\` and skim it alongside your personal files. A teammate may have already captured something you'd otherwise duplicate.";
const MODERN_DREAM_TEAM_LIST_TEXT =
	"- **Phase 1:** Use `eza team/` and skim it alongside your personal files. A teammate may have already captured something you'd otherwise duplicate.";
const MODERN_DREAM_LIST_MEMORY =
	"- Use \\`eza\\` to list the memory directory and see what already exists\n- Use \\`eza team/\\` if a \\`team/\\` subdirectory is present, and skim it alongside your personal files";
const MODERN_DREAM_LIST_LOGS =
	"- Use \\`fd -t f . logs/\\` to list recent activity logs (one file per session under \\`YYYY/MM/DD/\\`). If a \\`sessions/\\` subdirectory also exists, review recent entries there too";
const MODERN_DREAM_TRANSCRIPT_SEARCH_LABEL =
	'**Transcript search**: if you need specific context (e.g., "what was the error message from yesterday\'s build failure?"), use \\`rg -m 50\\` on the JSONL transcripts for narrow terms:';
const MODERN_DREAM_TRANSCRIPT_SEARCH_COMMAND =
	"\\`rg -m 50 \"<narrow term>\" $1/ -g '*.jsonl'\\`";
const MODERN_DREAM_FIND_MEMORY_FILES =
	"1. Use \\`fd -e md -t f .\\` against the memory directory shown above to enumerate every memory file (including any \\`team/\\` subdirectory).";

const LEGACY_MEMORY_READONLY_TEXT =
	"ls, find, grep, cat, stat, wc, head, tail, and similar";
const MODERN_MEMORY_READONLY_TEXT =
	"Prefer modern read-only inspection commands such as fd, eza, sg, rg for non-code text, bat ranges, git status/log/diff, stat, and wc when needed.";
const LEGACY_DREAM_TEXTS = [
	"grep narrowly, don't read whole files",
	"`ls team/`",
	"\\`ls team/\\`",
	"\\`ls\\` the memory directory",
	"\\`ls -R logs/\\`",
	"grep the JSONL transcripts",
	'\\`grep -rn "<narrow term>"',
] as const;
const MODERN_DREAM_TEXTS = [
	"Use \\`eza\\` to list the memory directory",
	"Use \\`eza team/\\` if a \\`team/\\` subdirectory is present",
	"Use \\`fd -t f . logs/\\` to list recent activity logs",
	"use \\`rg -m 50\\` on the JSONL transcripts",
	"Use \\`fd -e md -t f .\\` against the memory directory shown above",
] as const;

export const memoryPromptSoften: Patch = {
	tag: "memory-prompt-soften",

	string: (code) =>
		code
			.replace(
				LEGACY_PATH_SCOPED_MEMORY_READONLY_RE,
				MODERN_PATH_SCOPED_MEMORY_READONLY,
			)
			.replace(LEGACY_DREAM_TRANSCRIPTS_RE, MODERN_DREAM_TRANSCRIPTS)
			.replace(
				LEGACY_DREAM_TEAM_LIST_TEMPLATE_RE,
				MODERN_DREAM_TEAM_LIST_TEMPLATE,
			)
			.replace(LEGACY_DREAM_TEAM_LIST_TEXT_RE, MODERN_DREAM_TEAM_LIST_TEXT)
			.replace(LEGACY_DREAM_LIST_MEMORY_RE, MODERN_DREAM_LIST_MEMORY)
			.replace(LEGACY_DREAM_LIST_LOGS_RE, MODERN_DREAM_LIST_LOGS)
			.replace(
				LEGACY_DREAM_TRANSCRIPT_SEARCH_LABEL_RE,
				MODERN_DREAM_TRANSCRIPT_SEARCH_LABEL,
			)
			.replace(
				LEGACY_DREAM_TRANSCRIPT_SEARCH_COMMAND_RE,
				MODERN_DREAM_TRANSCRIPT_SEARCH_COMMAND,
			)
			.replace(
				LEGACY_DREAM_FIND_MEMORY_FILES_RE,
				MODERN_DREAM_FIND_MEMORY_FILES,
			),

	verify: (code) => {
		if (code.includes(LEGACY_MEMORY_READONLY_TEXT)) {
			return "Memory/read-only prompt still contains legacy ls/find/grep/cat/head/tail list";
		}
		for (const legacyText of LEGACY_DREAM_TEXTS) {
			if (code.includes(legacyText)) {
				return `Dream memory prompt still contains legacy guidance: ${legacyText}`;
			}
		}
		// The /g flag on LEGACY_DREAM_FIND_MEMORY_FILES_RE makes
		// RegExp.prototype.test stateful via lastIndex; calling .test() on
		// the global regex would yield nondeterministic results across
		// invocations. Use a fresh non-global copy for the verify probe.
		const legacyFindRE = new RegExp(
			LEGACY_DREAM_FIND_MEMORY_FILES_RE.source,
			LEGACY_DREAM_FIND_MEMORY_FILES_RE.flags.replace("g", ""),
		);
		if (legacyFindRE.test(code)) {
			return "Dream memory pruning prompt still enumerates memory files with find";
		}
		if (!code.includes(MODERN_MEMORY_READONLY_TEXT)) {
			return "Memory/read-only prompt missing modern read-only inspection guidance";
		}
		if (
			!code.includes("Use \\`eza team/\\`") &&
			!code.includes("Use `eza team/`")
		) {
			return "Dream memory prompt missing modern guidance: Use `eza team/`";
		}
		for (const modernText of MODERN_DREAM_TEXTS) {
			if (!code.includes(modernText)) {
				return `Dream memory prompt missing modern guidance: ${modernText}`;
			}
		}
		return true;
	},
};
