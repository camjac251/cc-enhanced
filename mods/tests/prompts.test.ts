import type { On } from "claude-code";
import { expect, test } from "claude-code/testing";

const CORE = { plugin: "engine", tier: "core" } as const;

const SESSION_SOURCE =
	"For broad codebase exploration or research that'll take more than 7 queries, spawn Agent with subagent_type=Explore. Otherwise use `find` or `grep` via the Bash tool directly.";
const SESSION_EXPECTED =
	"For broad codebase exploration or research that'll take more than 7 queries, spawn Agent with subagent_type=Explore. Otherwise choose by intent: Serena for known symbols when available, ChunkHound for unfamiliar concepts when available, Probe for known terms, `rg` for exact lexical text, and the ast-grep CLI for syntax shapes and structural rewrites.";

const TODO_SOURCE = `Track the active work. Keep the user's path /work/notes—draft intact.

## Examples of When to Use the Todo List
A multi-step example with "quoted dialogue" and \`commands\`.

## Examples of When NOT to Use the Todo List
How do I print 'Hello World' in Python?
What does the git status command do?
Run npm install for me and tell me what happens

## Task States and Management
Preserve every state rule, the literal $& token, and 2–4 items.
`;
const TODO_EXPECTED = `Track the active work. Keep the user's path /work/notes—draft intact.

## Examples of When to Use the Todo List
- Reach for it when the user hands you multiple related tasks or explicitly asks for tracking.
- Keep items current as you work so the list reflects real progress.
## Examples of When NOT to Use the Todo List
- Skip it for quick, single-step tasks where tracking would add overhead.
- Clear stale entries so the list only mirrors the active work.
## Task States and Management
Preserve every state rule, the literal $& token, and 2–4 items.
`;

const BASH_IMPORTANT_SOURCE =
	"IMPORTANT: Avoid using this tool to run `file viewing, editing, creation, or output formatting` commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user";

const AGENT_LOOKUP_SOURCE =
	"If the target is already known, use the direct tool: Read for a known path, `grep` via the Bash tool for a specific symbol or string. Reserve this tool for open-ended questions that span the codebase, or tasks that match an available agent type.";
const AGENT_LOOKUP_EXPECTED =
	"If the target is already known, use the direct tool: Read for a known path, Serena or Probe search_code (exact: true) for a specific symbol or string. Reserve this tool for open-ended questions that span the codebase, or tasks that match an available agent type.";
const AGENT_FORK_SOURCE =
	'When using the Agent tool, specify a subagent_type to select an agent: `"fork"` forks yourself (the fork inherits your full conversation context and always runs on your model — a `model` override is ignored); ';
const AGENT_FORK_EXPECTED =
	'When using the Agent tool, pass `subagent_type: "fork"` to fork yourself. A fork inherits your full conversation context, always runs on your model, and ignores any `model` override. ';

function stubPromptEvents(on: On): void {
	on("prompt.section", (_$, e) => ({ text: e.text }));
	on("prompt.attachment", (_$, e) => ({ text: e.text }));
	on("tool.describe", (_$, e) => ({ description: e.description }));
}

for (const fallback of [
	"`find` or `grep` via the Bash tool",
	"the Glob or Grep",
]) {
	test(`session guidance preserves delegation while replacing ${fallback}`, async ($, on) => {
		stubPromptEvents(on);
		const original = SESSION_SOURCE.replace(
			"`find` or `grep` via the Bash tool",
			fallback,
		);
		const prefix = "# Session-specific guidance\n- ";
		const suffix = "\n- User text: /work/report—draft, 2–4, $&.";
		const first = await $.prompt.section({
			name: "session_guidance",
			text: `${prefix}${original}${suffix}`,
		});
		expect(first.text).toBe(`${prefix}${SESSION_EXPECTED}${suffix}`);
		expect(
			await $.prompt.section({ name: "session_guidance", text: first.text }),
		).toEqual(first);
		expect(
			await $.prompt.section({
				name: "session_guidance",
				text: `${prefix}${original}${suffix}`,
			}),
		).toEqual(first);
	});
}

test("session guidance preserves rendered thresholds and selected agent labels", async ($, on) => {
	stubPromptEvents(on);
	const description = SESSION_SOURCE.replace("7 queries", "19 queries").replace(
		"subagent_type=Explore",
		() => "subagent_type=Research—local 2–4 $&",
	);
	const expected = SESSION_EXPECTED.replace("7 queries", "19 queries").replace(
		"subagent_type=Explore",
		() => "subagent_type=Research—local 2–4 $&",
	);
	expect(
		await $.prompt.section({ name: "session_guidance", text: description }),
	).toEqual({ text: expected });
});

test("session guidance is restricted to its actual named section", async ($, on) => {
	stubPromptEvents(on);
	for (const name of ["tools", "memory", "system", "custom"]) {
		expect(await $.prompt.section({ name, text: SESSION_SOURCE })).toEqual({
			text: SESSION_SOURCE,
		});
	}
	expect(
		await $.prompt.section({ name: "session_guidance", text: null }),
	).toEqual({ text: null });
});

test("session guidance leaves unknown wording and quoted user prose intact", async ($, on) => {
	stubPromptEvents(on);
	const text = `# Session-specific guidance\nA user quoted: ${SESSION_SOURCE}\nFor broad codebase exploration, prefer your usual tools.`;
	expect(await $.prompt.section({ name: "session_guidance", text })).toEqual({
		text,
	});
});

test("session guidance transforms the composed answer instead of stale input", async ($, on) => {
	on("prompt.section", () => ({
		text: "Another mod omitted the stock clause.",
	}));
	expect(
		await $.prompt.section({ name: "session_guidance", text: SESSION_SOURCE }),
	).toEqual({ text: "Another mod omitted the stock clause." });
});

test("TodoWrite condenses both examples without changing surrounding guidance", async ($, on) => {
	stubPromptEvents(on);
	const first = await $.tool.describe({
		tool: "TodoWrite",
		description: TODO_SOURCE,
		provider: CORE,
	});
	expect(first.description).toBe(TODO_EXPECTED);
	expect(
		await $.tool.describe({
			tool: "TodoWrite",
			description: first.description,
			provider: CORE,
		}),
	).toEqual(first);
});

test("TodoWrite keeps a downstream explicit tool placement", async ($, on) => {
	on("tool.describe", () => ({
		description: TODO_SOURCE,
		isDeferred: false,
	}));
	expect(
		await $.tool.describe({
			tool: "TodoWrite",
			description: "The incoming description was superseded.",
			isDeferred: true,
			provider: CORE,
		}),
	).toEqual({ description: TODO_EXPECTED, isDeferred: false });
});

test("TodoWrite never appends policy when section boundaries are absent", async ($, on) => {
	stubPromptEvents(on);
	for (const description of [
		"A new TodoWrite description with no known headings.",
		"## Examples of When to Use the Todo List\nA sample with no closing heading.",
		"## Examples of When NOT to Use the Todo List\nAn isolated sample.\n## Task States and Management\nKeep these states.",
	]) {
		expect(
			await $.tool.describe({ tool: "TodoWrite", description, provider: CORE }),
		).toEqual({ description });
	}
});

test("TodoWrite handles only the bounded section when the later boundary is absent", async ($, on) => {
	stubPromptEvents(on);
	const description =
		"## Examples of When to Use the Todo List\nOld use example.\n## Examples of When NOT to Use the Todo List\nPreserve this unbounded section.";
	const answer = await $.tool.describe({
		tool: "TodoWrite",
		description,
		provider: CORE,
	});
	expect(answer.description).toBe(
		"## Examples of When to Use the Todo List\n- Reach for it when the user hands you multiple related tasks or explicitly asks for tracking.\n- Keep items current as you work so the list reflects real progress.\n## Examples of When NOT to Use the Todo List\nPreserve this unbounded section.",
	);
});

const WORKING_DIRECTORY_SOURCE =
	"Every call starts in the start folder: a `cd` does not carry over. Shell state does not persist. The shell environment is initialized from the user's profile (bash or zsh).";

test("full Bash descriptors receive only the transferred native text changes", async ($, on) => {
	stubPromptEvents(on);
	const nativeRemainder =
		'# Instructions\nNative policy remains here. User path: /work/alpha—beta. Deadline: 5–9.\nUse the Monitor tool to stream events from a background process (each stdout line is a notification). For one-shot "wait until done," use Bash with run_in_background instead.';
	const description = [
		"Executes a given bash command and returns its output.",
		"",
		WORKING_DIRECTORY_SOURCE,
		`${BASH_IMPORTANT_SOURCE}:`,
		"- File search: Use Glob (NOT find or ls)",
		"- Content search: Use Grep (NOT grep or rg)",
		"- Read files: Use Read (NOT cat/head/tail)",
		"- Edit files: Use Edit (NOT sed/awk)",
		"- Write files: Use Write (NOT echo >/cat <<EOF)",
		"- Communication: Output text directly (NOT echo/printf)",
		nativeRemainder,
	].join("\n");
	const answer = await $.tool.describe({
		tool: "Bash",
		description,
		provider: CORE,
	});
	// Stock now states the exact `cd` rule; the mod leaves it as written.
	expect(answer.description).toContain(WORKING_DIRECTORY_SOURCE);
	expect(answer.description).toContain(
		"IMPORTANT: Prefer dedicated symbol/semantic tools and modern CLI utilities whenever possible. Recommended defaults:",
	);
	expect(answer.description).toContain(
		"- For shell-native file discovery use `fd` and `eza`.",
	);
	expect(answer.description).toContain(
		"- For source code discovery, choose by intent:\n- Known symbol, definition, references, or symbol-safe edit: use Serena when available; otherwise use LSP or direct code search.",
	);
	expect(answer.description).toContain(
		"- Syntax shape or structural rewrite: use the ast-grep CLI. Preview rewrites before applying.",
	);
	expect(answer.description).toContain(
		"- Read files: Use Read for non-code files or known code ranges; use `bat -r START:END` for shell file slices",
	);
	expect(answer.description).toContain(
		"- Edit files: Use Edit or `ast-grep run` for repeated structural code rewrites; use `sd` only for non-code text",
	);
	expect(answer.description).toContain(
		"- Write files: Use Write for file creation or major rewrites",
	);
	expect(answer.description).toContain(
		"- Communication: Output text directly\n",
	);
	expect(answer.description).not.toContain("NOT echo/printf");
	expect(answer.description).toContain(nativeRemainder);
	expect(answer.description).not.toContain("(NOT ");
	expect(
		await $.tool.describe({
			tool: "Bash",
			description: answer.description,
			provider: CORE,
		}),
	).toEqual(answer);
});

test("Bash keeps interpolation-derived tool names byte-for-byte", async ($, on) => {
	stubPromptEvents(on);
	const description =
		"Executes a given bash command and returns its output.\nRead files: Use Read (local — exact) $& (NOT cat/head/tail)\nEdit files: Use Edit 2–4 (NOT sed/awk)\nWrite files: Use Write $` (NOT echo >/cat <<EOF)";
	const answer = await $.tool.describe({
		tool: "Bash",
		description,
		provider: CORE,
	});
	expect(answer.description).toContain(
		"Read files: Use Read (local — exact) $& for non-code files",
	);
	expect(answer.description).toContain(
		"Edit files: Use Edit 2–4 or `ast-grep run`",
	);
	expect(answer.description).toContain(
		"Write files: Use Write $` for file creation",
	);
});

test("lean Bash changes its guidance but preserves working-directory and timeout text", async ($, on) => {
	stubPromptEvents(on);
	const untouched =
		"- Working directory persists between calls, but prefer absolute paths — `cd` in a compound command can trigger a permission prompt. Shell state (env vars, functions) does not persist; the shell is initialized from the user's profile.";
	const timing =
		"- `timeout` is in milliseconds: default 75000, max 450000 for a foreground command.";
	const description = `Executes a bash command and returns its output.\n\n${untouched}\n- ${BASH_IMPORTANT_SOURCE}.\n${timing}`;
	const answer = await $.tool.describe({
		tool: "Bash",
		description,
		provider: CORE,
	});
	expect(answer.description).toContain(untouched);
	expect(answer.description).toContain(timing);
	expect(answer.description).toContain(
		"- Use fd for file discovery, eza for directory listings, Read for known files or ranges, bat -r for shell file ranges, rg for exact lexical text, and ast-grep run for structural code patterns and rewrites",
	);
	expect(answer.description).toContain(
		"- For changes: Edit for one known site; ast-grep run -r for a repeated shape (preview, then -U); comby for malformed or mixed syntax; sd only for non-code text",
	);
	expect(answer.description).toContain(
		"- For source code discovery, choose by intent:",
	);
	expect(answer.description).not.toContain("Avoid using this tool");
	expect(
		await $.tool.describe({
			tool: "Bash",
			description: answer.description,
			provider: CORE,
		}),
	).toEqual(answer);
});

test("Bash does not fabricate absent gated guidance or match a custom description", async ($, on) => {
	stubPromptEvents(on);
	for (const description of [
		"Executes a bash command and returns its output.\n- Policy supplied by another mod — preserve it.",
		"Executes a given bash command and returns its output.\nIMPORTANT: The upstream routing paragraph was reworded.",
		`Custom runner\n${BASH_IMPORTANT_SOURCE}:\nRead files: Use Read (NOT cat/head/tail)`,
	]) {
		expect(
			await $.tool.describe({ tool: "Bash", description, provider: CORE }),
		).toEqual({ description });
	}
});

test("Agent lookup changes only the stock routing paragraph", async ($, on) => {
	stubPromptEvents(on);
	const prefix =
		"Available agent: Review—local. Its author says `grep` via the Bash tool.\n\n## When not to use\n\n";
	const suffix =
		"\nCustom description retains 2–4 examples and the literal $&.";
	const answer = await $.tool.describe({
		tool: "Agent",
		description: `${prefix}${AGENT_LOOKUP_SOURCE}${suffix}`,
		provider: CORE,
	});
	expect(answer.description).toBe(`${prefix}${AGENT_LOOKUP_EXPECTED}${suffix}`);
	expect(
		await $.tool.describe({
			tool: "Agent",
			description: answer.description,
			provider: CORE,
		}),
	).toEqual(answer);
});

for (const normalized of [false, true]) {
	for (const hasDefault of [false, true]) {
		test(`Agent fork guidance preserves availability (normalized=${normalized}, default=${hasDefault})`, async ($, on) => {
			stubPromptEvents(on);
			const userTypes =
				"Choose a listed type: Review—local, Audit 2–4; keep $&.";
			const sourceAvailability = hasDefault
				? "any other type — or omitting it — starts a fresh agent (general-purpose by default)."
				: `any other type starts a fresh agent. ${userTypes}`;
			const stock = normalized
				? AGENT_FORK_SOURCE.replace(" — a ", ". A ") +
					sourceAvailability.replace(
						" — or omitting it — starts",
						". Or omitting it. Starts",
					)
				: AGENT_FORK_SOURCE + sourceAvailability;
			const expectedAvailability = hasDefault
				? "Pass any other subagent_type, or omit subagent_type, to start a fresh agent (general-purpose by default)."
				: `Pass any other subagent_type to start a fresh agent. ${userTypes}`;
			const answer = await $.tool.describe({
				tool: "Agent",
				description: stock,
				provider: CORE,
			});
			expect(answer.description).toBe(
				AGENT_FORK_EXPECTED + expectedAvailability,
			);
			expect(
				await $.tool.describe({
					tool: "Agent",
					description: answer.description,
					provider: CORE,
				}),
			).toEqual(answer);
		});
	}
}

for (const hasDefault of [false, true]) {
	test(`Agent current long-form fork wording preserves default availability (${hasDefault})`, async ($, on) => {
		stubPromptEvents(on);
		const suffix = hasDefault
			? " If omitted, the general-purpose agent is used."
			: " Choose a listed agent: Review-local.";
		const description = `When using the Agent tool, specify a subagent_type to choose which type of agent you want to launch. A type of "fork" forks yourself, allowing the fork to inherit your full conversation and context, and ensuring that it runs on the same model that you are running on (a \`model\` override is ignored for forks). For other types of subagents, they start fresh without your context window.${suffix}`;
		const expected =
			AGENT_FORK_EXPECTED +
			(hasDefault
				? "Pass any other subagent_type, or omit subagent_type, to start a fresh agent (general-purpose by default)."
				: "Pass any other subagent_type to start a fresh agent. Choose a listed agent: Review-local.");
		expect(
			await $.tool.describe({ tool: "Agent", provider: CORE, description }),
		).toEqual({ description: expected });
	});
}

test("Agent leaves non-fork routing and changed upstream wording alone", async ($, on) => {
	stubPromptEvents(on);
	for (const description of [
		"When using the Agent tool, specify a subagent_type parameter to select which agent type to use. If omitted, the general-purpose agent is used.",
		"When using the Agent tool, specify a subagent_type to choose which type of agent you want to launch. Subagents start fresh without your context window. If omitted, the general-purpose agent is used.",
		"When using the Agent tool, specify a subagent_type to select an agent: forking follows a new contract.",
		"A user quoted `grep` via the Bash tool, and the task must preserve it.",
	]) {
		expect(
			await $.tool.describe({ tool: "Agent", description, provider: CORE }),
		).toEqual({ description });
	}
});

test("description rewrites neither target aliases nor tools supplied by plugins", async ($, on) => {
	stubPromptEvents(on);
	for (const tool of ["Todo", "Write", "mcp__tasks__TodoWrite"]) {
		expect(
			await $.tool.describe({ tool, description: TODO_SOURCE, provider: CORE }),
		).toEqual({ description: TODO_SOURCE });
	}
	const read = await $.tool.describe({
		tool: "Read",
		description: TODO_SOURCE,
		provider: CORE,
	});
	expect(read.description.startsWith(TODO_SOURCE)).toBe(true);
	expect(read.description).toContain("mcp__cc-enhanced__view");
	for (const [tool, description] of [
		["TodoWrite", TODO_SOURCE],
		["Agent", AGENT_LOOKUP_SOURCE],
		[
			"Bash",
			`Executes a bash command and returns its output.\n- ${BASH_IMPORTANT_SOURCE}.`,
		],
	]) {
		expect(
			await $.tool.describe({
				tool,
				description,
				provider: { plugin: "custom-tools", tier: "user" },
			}),
		).toEqual({ description });
	}
});

const STRICT_ATTACHMENT =
	"Do your work through the Shell $& — local tool wherever it can accomplish the job: read files with cat, head, or sed -n, search with grep and find, and make file changes with sed, heredocs, or short scripts, rather than using the dedicated Read $` (whole), Edit 2–4, or Write $' local tools. Fall back to a dedicated tool only when Shell $& — local genuinely cannot do the job.";
const RELAXED_ATTACHMENT =
	"You can do much of your work through the Shell $& — local tool when it is the simpler route: read files with cat, head, or sed -n, search with grep and find, and make small, mechanical file changes with sed, heredocs, or short scripts instead of the dedicated Read $` (whole), Edit 2–4, or Write $' local tools. The choice is yours: prefer Edit 2–4 or Write $' local when a shell edit would be fragile, such as exact or multi-line replacements, or sed/awk flags that differ between GNU and BSD/macOS.";

const ATTACHMENT_EXPECTED =
	"Work through Shell $& — local wherever the shell has the better tool: fd for file discovery, eza for directory listings, bat -r for ranged reads, rg for exact lexical text, ast-grep run for syntax shapes and repeated rewrites (preview, then -U), comby for malformed or mixed syntax, sd for non-code text, and jq or yq for structured data. Keep Read $` (whole) for files you need whole in context, Edit 2–4 for a single known site, and Write $' local for new files; route everything else through Shell $& — local. For source code, choose by intent: Serena or LSP for symbols when available, ChunkHound for unfamiliar concepts when available, Probe for known terms, rg for exact lexical text, and the ast-grep CLI for syntax shapes.";
const ENGINE = { kind: "engine" } as const;

for (const [variant, paragraph] of [
	["strict", STRICT_ATTACHMENT],
	["relaxed", RELAXED_ATTACHMENT],
]) {
	for (const [mode, prefix] of [
		["bypass", "While bypass permissions mode is active:\n\n"],
		["steer-only", "While auto mode is active:\n\n"],
		[
			"full-auto",
			"## Auto mode\n\nKeep working; ask when blocked.\n\nBefore destructive commands, preserve uncommitted work.\n\nBatch consent requests; never silently drop one.\n\n",
		],
	]) {
		test(`auto-mode ${variant} paragraph preserves ${mode} framing and consent`, async ($, on) => {
			stubPromptEvents(on);
			const before = `<system-reminder>\n${prefix}`;
			const after =
				"\n\nKeep the user's consent instructions — and $& — unchanged.\n</system-reminder>";
			const text = before + paragraph + after;
			const expected = before + ATTACHMENT_EXPECTED + after;
			const result = await $.prompt.attachment({
				type: "auto_mode",
				origin: ENGINE,
				text,
			});
			expect(result).toEqual({ text: expected });
			expect(
				await $.prompt.attachment({
					type: "auto_mode",
					origin: ENGINE,
					text: expected,
				}),
			).toEqual(result);
		});
	}
}

test("auto-mode attachment preserves absent, unknown, quoted and inconsistent guidance", async ($, on) => {
	stubPromptEvents(on);
	for (const text of [
		"## Auto mode\n\nConsent guidance only; shell steering is disabled.",
		`A user quoted: ${STRICT_ATTACHMENT}`,
		STRICT_ATTACHMENT.replace(
			"wherever it can accomplish the job",
			"under a new upstream policy",
		),
		STRICT_ATTACHMENT.replace(
			"when Shell $& — local genuinely",
			"when Another shell genuinely",
		),
		RELAXED_ATTACHMENT.replace("prefer Edit 2–4", "prefer Another editor"),
	]) {
		expect(
			await $.prompt.attachment({ type: "auto_mode", origin: ENGINE, text }),
		).toEqual({ text });
	}
});

test("auto-mode attachment transforms the downstream result, including suppression", async ($, on) => {
	let downstream: string | null = null;
	on("prompt.attachment", () => ({ text: downstream }));
	const input = { type: "auto_mode", origin: ENGINE, text: STRICT_ATTACHMENT };
	expect(await $.prompt.attachment(input)).toEqual({ text: null });
	downstream = "A downstream mod replaced the guidance.";
	expect(await $.prompt.attachment(input)).toEqual({ text: downstream });
	downstream = `Downstream prefix.\n\n${RELAXED_ATTACHMENT}\n\nDownstream suffix.`;
	expect(
		await $.prompt.attachment({ ...input, text: "Superseded input." }),
	).toEqual({
		text: `Downstream prefix.\n\n${ATTACHMENT_EXPECTED}\n\nDownstream suffix.`,
	});
});

test("auto-mode attachment leaves other origins and types untouched", async ($, on) => {
	stubPromptEvents(on);
	for (const origin of [
		{ kind: "hook", event: "SessionStart" },
		{ kind: "plugin", event: "prompt.submit" },
	] as const) {
		expect(
			await $.prompt.attachment({
				type: "auto_mode",
				origin,
				text: STRICT_ATTACHMENT,
			}),
		).toEqual({ text: STRICT_ATTACHMENT });
	}
	for (const type of ["custom_context", "plan_mode", "bypass"]) {
		expect(
			await $.prompt.attachment({
				type,
				origin: ENGINE,
				text: RELAXED_ATTACHMENT,
			}),
		).toEqual({ text: RELAXED_ATTACHMENT });
	}
});
