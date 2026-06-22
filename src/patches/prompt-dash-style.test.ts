import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { traverse } from "../babel.js";
import { parse, print } from "../loader.js";
import { countForbiddenPromptDashStyle } from "../prompt-dash-style.js";
import {
	normalizePromptDashText,
	promptDashStyle,
} from "./prompt-dash-style.js";

async function runPromptDashStyleViaPasses(ast: any): Promise<void> {
	const passes = (await promptDashStyle.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: promptDashStyle.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

function stringLiteralValues(code: string): string[] {
	const values: string[] = [];
	traverse(parse(code), {
		StringLiteral(path) {
			values.push(path.node.value);
		},
	});
	return values;
}

const PROMPT_DASH_FIXTURE = [
	'const longSystemSection = "# Managed Agents — Overview\\n\\nYou are helping the user schedule, update, list, or run remote Claude Code agents. These are NOT local cron jobs — each routine spawns a fully isolated remote session in Anthropic\\\'s cloud infrastructure. Read the most recent 1–3 days of sessions. You must use the remote tools directly and should not summarize this setup back to the user."; ',
	"",
	"const scheduleSkill = {",
	'  name: "schedule",',
	'  description: "Research and plan a large-scale change, then execute it in parallel across 5–30 isolated worktree agents.",',
	"  prompt: `Use ${toolName} — do not use curl. Always preserve the user's requested cadence.`,",
	"};",
	"",
	'const unrelated = "cache-key—v1";',
].join("\n");

const ESCAPED_PROMPT_DASH_FIXTURE = String.raw`
const prompt = "You are monitoring a long-running agent \u2014 do not block legitimate work. You must review the transcript across 1\u20136 turns before deciding. Always return a concise classification with evidence.";
`;

const LATEST_CLEAN_PROMPT_DASH_FIXTURE = [
	'const memoryPruning = "# Dream: Memory Pruning\\n\\nYou are performing a dream \\u2014 a pruning pass over your memory files. The job is small: delete stale or invalidated memories, and collapse duplicates."; ',
	'const monitorGuidance = "If a monitor is armed, keep `delaySeconds` at 1200\\u20131800s \\u2014 the monitor is the wake signal and this is only the fallback heartbeat."; ',
].join("\n");

const NON_PROMPT_DASH_FIXTURE = String.raw`
const dashRegex = /[\u2013\u2014]/;
const dashSet = "\u2013\u2014";
const glyphMap = { "\u2014": "em-dash" };
`;

test("normalizePromptDashText removes Unicode prose dashes", () => {
	assert.equal(
		normalizePromptDashText(
			'# Managed Agents — Overview\nUse `{action: "list"}` — list all routines.\nRead 1–3 days.',
		),
		'# Managed Agents: Overview\nUse `{action: "list"}`. List all routines.\nRead 1-3 days.',
	);
});

test("normalizePromptDashText preserves existing command punctuation", () => {
	assert.equal(
		normalizePromptDashText(
			"Use `fd -t f . logs/` to list recent activity logs — do not rewrite the command.",
		),
		"Use `fd -t f . logs/` to list recent activity logs. Do not rewrite the command.",
	);
});

test("prompt-dash-style normalizes prompt-like string and template text", async () => {
	const ast = parse(PROMPT_DASH_FIXTURE);
	await runPromptDashStyleViaPasses(ast);
	const output = print(ast);

	assert.equal(output.includes("Managed Agents — Overview"), false);
	assert.equal(output.includes("5–30 isolated"), false);
	assert.equal(output.includes("# Managed Agents: Overview"), true);
	assert.equal(output.includes("Each routine spawns"), true);
	assert.equal(output.includes("1-3 days"), true);
	assert.equal(output.includes("5-30 isolated"), true);
	assert.equal(output.includes("Do not use curl"), true);
	assert.doesNotThrow(() => parse(output));
	assert.equal(promptDashStyle.verify(output, ast), true);
});

test("prompt-dash-style normalizes escaped bundle dash sequences", async () => {
	const ast = parse(ESCAPED_PROMPT_DASH_FIXTURE);
	await runPromptDashStyleViaPasses(ast);
	const output = print(ast);

	assert.equal(output.includes("\\u2014"), false);
	assert.equal(output.includes("\\u2013"), false);
	assert.equal(output.includes("agent. Do not block legitimate work"), true);
	assert.equal(output.includes("1-6 turns"), true);
	assert.equal(promptDashStyle.verify(output, ast), true);
});

test("prompt-dash-style normalizes latest clean prompt examples", async () => {
	assert.equal(LATEST_CLEAN_PROMPT_DASH_FIXTURE.includes("\\u2014"), true);
	assert.equal(LATEST_CLEAN_PROMPT_DASH_FIXTURE.includes("\\u2013"), true);
	assert.equal(
		typeof promptDashStyle.verify(
			LATEST_CLEAN_PROMPT_DASH_FIXTURE,
			parse(LATEST_CLEAN_PROMPT_DASH_FIXTURE),
		),
		"string",
	);

	const ast = parse(LATEST_CLEAN_PROMPT_DASH_FIXTURE);
	await runPromptDashStyleViaPasses(ast);
	const output = print(ast);

	assert.deepEqual(countForbiddenPromptDashStyle(output), {
		enDash: 0,
		emDash: 0,
		total: 0,
	});
	assert.equal(output.includes("\\u2014"), false);
	assert.equal(output.includes("\\u2013"), false);
	assert.equal(output.includes("dream. A pruning pass"), true);
	assert.equal(output.includes("1200-1800s. The monitor"), true);
	assert.equal(promptDashStyle.verify(output, ast), true);
});

test("prompt-dash-style leaves non-prompt dash-bearing strings alone", async () => {
	const ast = parse(PROMPT_DASH_FIXTURE);
	await runPromptDashStyleViaPasses(ast);
	const output = print(ast);

	assert.equal(output.includes("cache-key\\u2014v1"), true);
	assert.equal(output.includes("cache-key—v1"), false);
	assert.equal(stringLiteralValues(output).includes("cache-key—v1"), true);
});

test("prompt-dash-style preserves non-prompt dash regexes and glyph maps", async () => {
	const ast = parse(NON_PROMPT_DASH_FIXTURE);
	await runPromptDashStyleViaPasses(ast);
	const output = print(ast);

	assert.equal(output.includes("/[\\u2013\\u2014]/"), true);
	assert.equal(output.includes('"\\u2013\\u2014"'), true);
	assert.equal(output.includes('"\\u2014": "em-dash"'), true);
	assert.equal(promptDashStyle.verify(output, ast), true);
});

test("prompt-dash-style is idempotent", async () => {
	const ast = parse(PROMPT_DASH_FIXTURE);
	await runPromptDashStyleViaPasses(ast);
	const once = print(ast);

	const astAgain = parse(once);
	await runPromptDashStyleViaPasses(astAgain);
	const twice = print(astAgain);

	assert.equal(twice, once);
});

test("prompt-dash-style verify rejects unpatched prompt-like dash text", () => {
	const ast = parse(PROMPT_DASH_FIXTURE);
	const result = promptDashStyle.verify(PROMPT_DASH_FIXTURE, ast);

	assert.equal(typeof result, "string");
	assert.match(String(result), /Unicode dash punctuation/);
});

test("prompt-dash-style leaves short dash-glyph constants intact", async () => {
	const fixture = `const seps = new Set(["/", "–", "—", "―"]);`;
	const ast = parse(fixture);
	await runPromptDashStyleViaPasses(ast);
	const output = print(ast);
	assert.equal(output.includes("–"), false);
	assert.equal(output.includes("—"), false);
	assert.equal(output.includes("\\u2013"), true);
	assert.equal(output.includes("\\u2014"), true);
	assert.equal(output.includes("\\u2015"), true);
	const values = stringLiteralValues(output);
	assert.equal(values.includes("–"), true);
	assert.equal(values.includes("—"), true);
	assert.equal(values.includes("―"), true);
	assert.equal(promptDashStyle.verify(output, ast), true);
});

test("prompt-dash-style verify rejects partially normalized prompt text", () => {
	const clean = 'const a = "You must always run the agent. Do not stop.";';
	const dirty = `const b = "You should always restart the tool 1–2 times before giving up on the agent.";`;
	const ast = parse(`${clean}\n${dirty}`);
	const result = promptDashStyle.verify(`${clean}\n${dirty}`, ast);
	assert.equal(typeof result, "string");
	assert.match(String(result), /Unicode dash punctuation/);
});

test("normalizePromptDashText output is always dash-free", () => {
	const inputs = [
		"Plain prose with an em dash — and more.",
		"Range 1–2 then a stray – mid-clause word.",
		"Mixed — and – in one line of guidance.",
		"trailing dash at end —",
	];
	for (const input of inputs) {
		assert.deepEqual(
			countForbiddenPromptDashStyle(normalizePromptDashText(input)),
			{
				enDash: 0,
				emDash: 0,
				total: 0,
			},
		);
	}
});

test("prompt-dash-style rewrites prose-shaped dash strings even without a prompt key", async () => {
	const fixture = `
const errLine = "Bridge keepalive timeout — connection dead and not recoverable.";
`;
	const ast = parse(fixture);
	await runPromptDashStyleViaPasses(ast);
	const output = print(ast);

	assert.equal(output.includes("\\u2014"), false);
	assert.equal(output.includes("—"), false);
	assert.equal(output.includes("timeout. Connection dead"), true);
	assert.equal(promptDashStyle.verify(output, ast), true);
});

test("prompt-dash-style does not flag a sub-threshold non-prompt-keyed dash fragment", () => {
	const fixture = `const x = { tooltip: "a – b" };`;
	const ast = parse(fixture);
	assert.equal(promptDashStyle.verify(fixture, ast), true);
});

test("prompt-dash-style normalizes dash in non-first template quasi", async () => {
	const fixture = [
		'const C3 = "x";',
		"const p = `# Loop tick\\n\\nWork the tasks. Call ${C3} again \\u2014 otherwise the loop ends and you must restart the agent.`;",
	].join("\n");
	const ast = parse(fixture);
	await runPromptDashStyleViaPasses(ast);
	const output = print(ast);
	assert.equal(output.includes("again. Otherwise the loop ends"), true);
	assert.equal(output.includes("\\u2014"), false);
	assert.equal(promptDashStyle.verify(output, ast), true);
});
