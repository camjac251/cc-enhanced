import {
	MODERN_BASH_SEARCH_GUIDANCE,
	MODERN_CODE_SEARCH_POLICY,
	MODERN_DEDICATED_TOOLS_NUDGE_PARTS,
	MODERN_TOOL_PREFERENCE,
} from "./policy.js";

const SESSION_FALLBACK =
	"Otherwise choose by intent: Serena for known symbols when available, ChunkHound for unfamiliar concepts when available, Probe for known terms, `rg` for exact lexical text, and the ast-grep CLI for syntax shapes and structural rewrites.";

const TODO_USE = `## Examples of When to Use the Todo List
- Reach for it when the user hands you multiple related tasks or explicitly asks for tracking.
- Keep items current as you work so the list reflects real progress.`;

const TODO_SKIP = `## Examples of When NOT to Use the Todo List
- Skip it for quick, single-step tasks where tracking would add overhead.
- Clear stale entries so the list only mirrors the active work.`;

const BASH_IMPORTANT =
	"IMPORTANT: Prefer dedicated symbol/semantic tools and modern CLI utilities whenever possible. Recommended defaults:";

const LEAN_BASH_GUIDANCE = [
	`- ${BASH_IMPORTANT}`,
	`- ${MODERN_TOOL_PREFERENCE}`,
	"- For changes: Edit for one known site; ast-grep run -r for a repeated shape (preview, then -U); comby for malformed or mixed syntax; sd only for non-code text",
	`- ${MODERN_CODE_SEARCH_POLICY}`,
].join("\n");

function sessionGuidance(text: string): string {
	return text
		.replace(
			/(^|\n)([ \t]*(?:- )?For broad codebase exploration or research that'll take more than [^\r\n]+? queries, spawn [^\r\n]+? with subagent_type=[^\r\n]+?\. )Otherwise use [^\r\n]+? directly\.(?=\r?$)/gm,
			(_match, boundary: string, prefix: string) =>
				`${boundary}${prefix}${SESSION_FALLBACK}`,
		)
		.replace(
			/(^|\n)([ \t]*(?:- )?)`find` or `grep` via the ([^\r\n]+?) tool(?=\r?$)/gm,
			(_match, boundary: string, prefix: string, tool: string) =>
				`${boundary}${prefix}code-search routing (Serena, ChunkHound, Probe, rg, ast-grep CLI) via the ${tool} tool`,
		);
}

function todoDescription(text: string): string {
	if (!text.includes("## Examples of When to Use the Todo List")) return text;
	return text
		.replace(
			/(## Examples of When to Use the Todo List\n)[\s\S]*?(?=\n## Examples of When NOT to Use the Todo List)/,
			() => TODO_USE,
		)
		.replace(
			/(## Examples of When NOT to Use the Todo List\n)[\s\S]*?(?=\n## Task States and Management)/,
			() => TODO_SKIP,
		);
}

function bashDescription(text: string): string {
	if (text.startsWith("Executes a bash command and returns its output.")) {
		return text.replace(
			/(^|\n)- IMPORTANT: Avoid using this tool to run [^\r\n]+? commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task\. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user\.(?=\r?$)/gm,
			(_match, boundary: string) => `${boundary}${LEAN_BASH_GUIDANCE}`,
		);
	}
	if (!text.startsWith("Executes a given bash command")) return text;

	return text
		.replace(
			/(^|\n)([ \t]*(?:- )?)Communication: Output text directly \(NOT echo\/printf\)(?=\r?$)/gm,
			"$1$2Communication: Output text directly",
		)
		.replace(
			/(^|\n)IMPORTANT: Avoid using this tool to run [^\r\n]+? commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task\. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user:(?=\r?$)/gm,
			(_match, boundary: string) => `${boundary}${BASH_IMPORTANT}`,
		)
		.replace(
			/(^|\n)([ \t]*(?:- )?)Read files: Use ([^\r\n]+?) \(NOT cat\/head\/tail\)(?=\r?$)/gm,
			(_match, boundary: string, prefix: string, tool: string) =>
				`${boundary}${prefix}Read files: Use ${tool} for non-code files or known code ranges; use \`bat -r START:END\` for shell file slices`,
		)
		.replace(
			/(^|\n)([ \t]*(?:- )?)Edit files: Use ([^\r\n]+?) \(NOT sed\/awk\)(?=\r?$)/gm,
			(_match, boundary: string, prefix: string, tool: string) =>
				`${boundary}${prefix}Edit files: Use ${tool} or \`ast-grep run\` for repeated structural code rewrites; use \`sd\` only for non-code text`,
		)
		.replace(
			/(^|\n)([ \t]*(?:- )?)Write files: Use ([^\r\n]+?) \(NOT echo >\/cat <<EOF\)(?=\r?$)/gm,
			(_match, boundary: string, prefix: string, tool: string) =>
				`${boundary}${prefix}Write files: Use ${tool} for file creation or major rewrites`,
		)
		.replace(
			/(^|\n)([ \t]*(?:- )?)File search: Use [^\r\n]+? \(NOT find or ls\)(?=\r?$)/gm,
			(_match, boundary: string, prefix: string) =>
				`${boundary}${prefix}For shell-native file discovery use \`fd\` and \`eza\`.`,
		)
		.replace(
			/(^|\n)([ \t]*(?:- )?)Content search: Use [^\r\n]+? \(NOT grep or rg\)(?=\r?$)/gm,
			(_match, boundary: string, prefix: string) =>
				`${boundary}${prefix}${MODERN_BASH_SEARCH_GUIDANCE}`,
		);
}

function agentDescription(text: string): string {
	return text
		.replace(
			/(^|\n)(If the target is already known, use the direct tool: [^\r\n]+? for a known path, )`grep` via the Bash tool( for a specific symbol or string\. Reserve this tool for open-ended questions that span the codebase, or tasks that match an available agent type\.)(?=\r?$)/gm,
			(_match, boundary: string, prefix: string, suffix: string) =>
				`${boundary}${prefix}Serena or Probe search_code (exact: true)${suffix}`,
		)
		.replace(
			/(^|\n)When using the ([^\r\n]+?) tool, specify a subagent_type to select an agent: `"fork"` forks yourself \(the fork inherits your full conversation context and always runs on your model(?: \u2014 a|\. A) `model` override is ignored\); (any other type(?: \u2014 or omitting it \u2014 starts|\. Or omitting it\. Starts) a fresh agent \(general-purpose by default\)\.|any other type starts a fresh agent\.)/gm,
			(_match, boundary: string, tool: string, availability: string) => {
				const fresh = availability.endsWith("(general-purpose by default).")
					? "Pass any other subagent_type, or omit subagent_type, to start a fresh agent (general-purpose by default)."
					: "Pass any other subagent_type to start a fresh agent.";
				return `${boundary}When using the ${tool} tool, pass \`subagent_type: "fork"\` to fork yourself. A fork inherits your full conversation context, always runs on your model, and ignores any \`model\` override. ${fresh}`;
			},
		)
		.replace(
			/(^|\n)When using the ([^\r\n]+?) tool, specify a subagent_type to choose which type of agent you want to launch\. A type of "fork" forks yourself, allowing the fork to inherit your full conversation and context, and ensuring that it runs on the same model that you are running on \(a \x60model\x60 override is ignored for forks\)\. For other types of subagents, they start fresh without your context window\.( If omitted, the general-purpose agent is used\.)?/gm,
			(
				_match,
				boundary: string,
				tool: string,
				defaultClause: string | undefined,
			) => {
				const fresh = defaultClause
					? "Pass any other subagent_type, or omit subagent_type, to start a fresh agent (general-purpose by default)."
					: "Pass any other subagent_type to start a fresh agent.";
				return `${boundary}When using the ${tool} tool, pass \`subagent_type: "fork"\` to fork yourself. A fork inherits your full conversation context, always runs on your model, and ignores any \`model\` override. ${fresh}`;
			},
		);
}

function autoModeAttachment(text: string): string {
	const replace = (
		_match: string,
		boundary: string,
		bash: string,
		read: string,
		edit: string,
		write: string,
	): string => {
		const labels = [bash, read, edit, write, bash];
		return (
			boundary +
			MODERN_DEDICATED_TOOLS_NUDGE_PARTS.map(
				(part, index) => part + (labels[index] ?? ""),
			).join("")
		);
	};
	return text
		.replace(
			/(^|\n)Do your work through the ([^\r\n]+?) tool wherever it can accomplish the job: read files with cat, head, or sed -n, search with grep and find, and make file changes with sed, heredocs, or short scripts, rather than using the dedicated ([^\r\n]+?), ([^\r\n]+?), or ([^\r\n]+?) tools\. Fall back to a dedicated tool only when \2 genuinely cannot do the job\.(?=\r?$)/gm,
			replace,
		)
		.replace(
			/(^|\n)You can do much of your work through the ([^\r\n]+?) tool when it is the simpler route: read files with cat, head, or sed -n, search with grep and find, and make small, mechanical file changes with sed, heredocs, or short scripts instead of the dedicated ([^\r\n]+?), ([^\r\n]+?), or ([^\r\n]+?) tools\. The choice is yours: prefer \4 or \5 when a shell edit would be fragile, such as exact or multi-line replacements, or sed\/awk flags that differ between GNU and BSD\/macOS\.(?=\r?$)/gm,
			replace,
		);
}

/** The caller must restrict this rendered-text transform to engine attachments. */
export function transformPromptAttachment(type: string, text: string): string {
	return type === "auto_mode" ? autoModeAttachment(text) : text;
}

/** Only the named, engine-authored session guidance surface is mod-owned. */
export function transformPromptSection(name: string, text: string): string {
	return name === "session_guidance" ? sessionGuidance(text) : text;
}

/** Native builders still own gates, shared helpers and custom agent prompts. */
export function transformToolDescription(tool: string, text: string): string {
	switch (tool) {
		case "TodoWrite":
			return todoDescription(text);
		case "Bash":
			return bashDescription(text);
		case "Agent":
			return agentDescription(text);
		default:
			return text;
	}
}
