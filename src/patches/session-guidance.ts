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

const MODERN_BROAD_EXPLORATION_SIGNAL =
	"Otherwise choose by intent: Serena for known symbols, ChunkHound for conceptual search, Probe for known terms, ast-grep MCP/sg for structural patterns and code rewrites, and \\`rg\\` only for non-code text directly.";
const MODERN_FIND_GREP_TOOL_SIGNAL =
	"code-search routing (Serena, ChunkHound, Probe, ast-grep MCP/sg)";

export const sessionGuidance: Patch = {
	tag: "session-guidance",

	string: (code) =>
		code
			.replace(LEGACY_FIND_GREP_TOOL_RE, MODERN_FIND_GREP_TOOL)
			.replace(LEGACY_BROAD_EXPLORATION_RE, MODERN_BROAD_EXPLORATION),

	verify: (code) => {
		const hasLegacySentenceStart = code.includes(
			LEGACY_BROAD_EXPLORATION_SIGNAL,
		);
		const hasLegacyOtherwiseTail = LEGACY_OTHERWISE_TAIL_RE.test(code);
		const hasLegacyFindGrepTool = LEGACY_FIND_GREP_TOOL_SIGNAL_RE.test(code);
		const hasModernSignal = code.includes(MODERN_BROAD_EXPLORATION_SIGNAL);
		const hasModernFindGrepTool = code.includes(MODERN_FIND_GREP_TOOL_SIGNAL);

		if (!hasLegacySentenceStart && !hasModernSignal && !hasModernFindGrepTool) {
			return true;
		}

		if (hasLegacyFindGrepTool) {
			return "Session guidance still routes fallback exploration through find/grep";
		}

		if (!hasModernFindGrepTool) {
			return "Session guidance missing modern code-search routing helper text";
		}

		if (!hasModernSignal) {
			return "Session guidance still uses legacy 'Otherwise use ${z} directly' phrasing without modern code-search routing";
		}

		if (hasLegacyOtherwiseTail) {
			return "Session guidance still contains an 'Otherwise use ${...} directly' fallback referencing a placeholder";
		}

		return true;
	},
};
