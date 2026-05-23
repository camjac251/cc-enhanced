import type { Patch } from "../types.js";

const LEGACY_BROAD_EXPLORATION_RE =
	/For broad codebase exploration or research that'll take more than (\$\{[^}]+\}) queries, spawn (\$\{[^}]+\}) with subagent_type=(\$\{[^}]+\})\. Otherwise use \$\{[^}]+\} directly\./g;

const LEGACY_FIND_GREP_TOOL_RE =
	/`\\`find\\` or \\`grep\\` via the (\$\{[^}]+\}) tool`/g;

const MODERN_FIND_GREP_TOOL =
	"`code-search routing (Serena, ChunkHound, Probe, ast-grep MCP/sg) or \\`rg\\` for non-code text via the $1 tool`";

const MODERN_BROAD_EXPLORATION =
	"For broad codebase exploration or research that'll take more than $1 queries, spawn $2 with subagent_type=$3. Otherwise choose by intent: Serena for known symbols, ChunkHound for conceptual search, Probe for known terms, ast-grep MCP/sg for structural patterns and code rewrites, and \\`rg\\` only for non-code text directly.";

const LEGACY_BROAD_EXPLORATION_SIGNAL =
	"For broad codebase exploration or research that'll take more than";
const LEGACY_OTHERWISE_TAIL_RE = /Otherwise use \$\{[^}]+\} directly\./;
const LEGACY_FIND_GREP_TOOL_SIGNAL_RE =
	/\\`find\\` or \\`grep\\` via the \$\{[^}]+\} tool/;

export const sessionGuidance: Patch = {
	tag: "session-guidance",

	string: (code) =>
		code
			.replace(LEGACY_FIND_GREP_TOOL_RE, MODERN_FIND_GREP_TOOL)
			.replace(LEGACY_BROAD_EXPLORATION_RE, MODERN_BROAD_EXPLORATION),

	verify: (code) => {
		// Anchored full-template regexes covering the entire patched surfaces.
		// The audit flagged the previous probe-based check as fragile (each
		// substring could be satisfied incidentally elsewhere in the bundle);
		// anchoring on the structural sentence body and the helper-text
		// envelope leaves much less room for accidental matches.
		const MODERN_BROAD_EXPLORATION_FULL =
			/For broad codebase exploration or research that'll take more than \$\{[^}]+\} queries, spawn \$\{[^}]+\} with subagent_type=\$\{[^}]+\}\. Otherwise choose by intent: Serena for known symbols, ChunkHound for conceptual search, Probe for known terms, ast-grep MCP\/sg for structural patterns and code rewrites, and \\`rg\\` only for non-code text directly\./;
		const MODERN_FIND_GREP_TOOL_FULL =
			/`code-search routing \(Serena, ChunkHound, Probe, ast-grep MCP\/sg\) or \\`rg\\` for non-code text via the \$\{[^}]+\} tool`/;

		const hasLegacySentenceStart = code.includes(
			LEGACY_BROAD_EXPLORATION_SIGNAL,
		);
		const hasLegacyOtherwiseTail = LEGACY_OTHERWISE_TAIL_RE.test(code);
		const hasLegacyFindGrepTool = LEGACY_FIND_GREP_TOOL_SIGNAL_RE.test(code);
		const hasModernFull = MODERN_BROAD_EXPLORATION_FULL.test(code);
		const hasModernFindGrepFull = MODERN_FIND_GREP_TOOL_FULL.test(code);

		if (!hasLegacySentenceStart && !hasModernFull && !hasModernFindGrepFull) {
			return true;
		}

		if (hasLegacyFindGrepTool) {
			return "Session guidance still routes fallback exploration through find/grep";
		}

		if (!hasModernFindGrepFull) {
			return "Session guidance missing modern code-search routing helper text in expected template shape";
		}

		if (!hasModernFull) {
			return "Session guidance broad-exploration sentence is not in the patched full-template shape";
		}

		// Mutual-exclusion: if the modern full sentence matches, the legacy
		// "Otherwise use ${...} directly." fallback must NOT also be present
		// (only one surface should exist after a clean patch).
		if (hasLegacyOtherwiseTail) {
			return "Session guidance has both modern code-search routing AND legacy 'Otherwise use ${...} directly' fallback";
		}

		return true;
	},
};
