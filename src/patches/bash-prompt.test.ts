import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { bashPrompt } from "./bash-prompt.js";
import {
	BACKGROUND_TASK_POLICY,
	MODERN_CODE_SEARCH_DECISION_TREE_LINES,
	MODERN_OUTPUT_LIMIT_WARNING,
	MODERN_TOOL_PREFERENCE,
} from "./prompt-policy.js";

const STOCK_BACKGROUND_EXECUTION_GUIDANCE =
	"You can use the `run_in_background` parameter to run the command in the background. Only use this if you don't need the result immediately and are OK being notified when the command completes later. You do not need to check the output right away - you'll be notified when it finishes. You do not need to use '&' at the end of the command when using this parameter.";

const STOCK_ONE_SHOT_BACKGROUND_GUIDANCE =
	'Use the Monitor tool to stream events from a background process (each stdout line is a notification). For one-shot "wait until done," use Bash with run_in_background instead.';

async function runBashPromptViaPasses(ast: any): Promise<void> {
	const passes = (await bashPrompt.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: bashPrompt.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

test("bash-prompt rewrites stock oversized-output warnings", () => {
	const fixture = String.raw`
const posix = "Pipe output through head, tail, or grep to reduce result size. Avoid cat on large files \u2014 use Read with offset/limit instead.";
const powershell = "Pipe output through Select-Object -First/-Last or Select-String to reduce result size. Avoid Get-Content on large files \u2014 use Read with offset/limit instead.";
`;
	const output = bashPrompt.string?.(fixture) ?? fixture;

	assert.equal(
		output.includes("Pipe output through head, tail, or grep"),
		false,
	);
	assert.equal(
		output.includes("Pipe output through Select-Object -First/-Last"),
		false,
	);
	assert.equal(output.split(MODERN_OUTPUT_LIMIT_WARNING).length - 1, 2);
	assert.equal(
		MODERN_OUTPUT_LIMIT_WARNING.includes(
			"if Bash persists oversized output, inspect the saved artifact by range or semantic selection.",
		),
		true,
	);
	assert.equal(
		MODERN_OUTPUT_LIMIT_WARNING.includes("bare rg catch-all"),
		false,
	);
});

const BASH_PROMPT_FIXTURE = `
function ws_() {
  let suppressToolGuidance = toolGuidanceDisabled(), guidance = [];
  if (!suppressToolGuidance) {
    let K = TM()
      ? "\`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\`"
      : "\`find\`, \`grep\`, \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\`";
    guidance.push(\`- IMPORTANT: Avoid using this tool to run \${K} commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user.\`);
  }
  return ["Executes a bash command and returns its output.", ...guidance].join("\\n");
}

function backgroundGuidance() {
  if (backgroundTasksDisabled()) return null;
  return ${JSON.stringify(STOCK_BACKGROUND_EXECUTION_GUIDANCE)};
}

function A4D() {
  let unrelated = shouldStay(),
    H = HO(),
    background = backgroundGuidance(),
    n = [
      ...(H
        ? []
        : [
            \`File search: Use \${gd} (NOT find or ls)\`,
            \`Content search: Use \${ud} (NOT grep or rg)\`,
          ]),
      \`Read files: Use \${$i} (NOT cat/head/tail)\`,
      \`Edit files: Use \${il} (NOT sed/awk)\`,
      \`Write files: Use \${Jc} (NOT echo >/cat <<EOF)\`,
      "Communication: Output text directly (NOT echo/printf)",
    ],
    A = H
      ? "\`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\`"
      : "\`find\`, \`grep\`, \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\`";
  return [
    "Executes a given bash command and returns its output.",
    "The working directory persists between commands, but shell state does not. The shell environment is initialized from the user's profile (bash or zsh).",
    \`IMPORTANT: Avoid using this tool to run \${A} commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user:\`,
    "If your command will create new directories or files, first use this tool to run \`ls\` to verify the parent directory exists and is the correct location.",
    ${JSON.stringify(STOCK_ONE_SHOT_BACKGROUND_GUIDANCE)},
    ...(background !== null ? [background] : []),
    ...(H
      ? [
          "When running \`find\`, search from \`.\` (or a specific path), not \`/\` \u2014 scanning the full filesystem can exhaust system resources on large trees.",
          "When using \`find -regex\` with alternation, put the longest alternative first. Example: use '.*\\\\.\\\\(tsx\\\\|ts\\\\)' not '.*\\\\.\\\\(ts\\\\|tsx\\\\)' — the second form silently skips .tsx files.",
        ]
      : []),
    ...n,
  ].join("\\n");
}

function nl1() {
  let unrelated = keepMe(),
    H = HO() ? "\${z8}, \`find\`, and \`grep\`" : "\${z8}, \${hM}, and \${B_}";
  return [
    \`You are the Claude guide agent. Reference local project files when relevant using \${H}\`,
    ...(HO()
      ? []
      : [
          \`File search: Use \${AK} (NOT find or ls)\`,
          \`Content search: Use \${V_} (NOT grep or rg)\`,
        ]),
    \`Read files: Use \${wf} (NOT cat/head/tail)\`,
    \`Edit files: Use \${ef} (NOT sed/awk)\`,
    \`Write files: Use \${s9} (NOT echo >/cat <<EOF)\`,
    "Communication: Output text directly (NOT echo/printf)",
  ].join("\\n");
}

function js6(e) {
  let g = HO(),
    n = e.has(X1),
    o = n ? X1 : X2,
    i = [T1, T2, T3, ...(g && n ? [] : [G1, G2])].join(", "),
    s = [
      \`Prefer dedicated tools over \${o} when one fits (\${i}) — reserve \${o} for shell-only operations.\`,
    ];
  return ["# Using your tools", ...s].join("\\n");
}
`;

test("bash-prompt verify rejects unpatched fixture", () => {
	const ast = parse(BASH_PROMPT_FIXTURE);
	const result = bashPrompt.verify(BASH_PROMPT_FIXTURE, ast);
	assert.notEqual(result, true);
	assert.equal(typeof result, "string");
});

test("bash-prompt patches only the embedded-search gate variable", async () => {
	const ast = parse(BASH_PROMPT_FIXTURE);
	await runBashPromptViaPasses(ast);
	const output = print(ast);

	assert.equal(output.includes("let unrelated = shouldStay()"), true);
	assert.equal(output.includes("let unrelated = keepMe()"), true);
	assert.equal(output.includes("H = !0"), true);
	assert.equal(output.includes("shouldStay()"), true);
	assert.equal(output.includes("keepMe()"), true);
	assert.equal(
		output.includes(
			"IMPORTANT: Prefer dedicated symbol/semantic tools and modern CLI utilities whenever possible. Recommended defaults:",
		),
		true,
	);
	assert.equal(
		output.includes(
			"- IMPORTANT: Prefer dedicated symbol/semantic tools and modern CLI utilities whenever possible. Recommended defaults:",
		),
		true,
	);
	assert.equal(output.includes("bat"), true);
	assert.equal(
		output.includes(
			"for non-code files or known code ranges; use `bat -r START:END` for shell file slices",
		) ||
			output.includes(
				"for non-code files or known code ranges; use \\`bat -r START:END\\` for shell file slices",
			),
		true,
	);
	assert.equal(output.includes("or `bat` for shell-native viewing"), false);
	assert.equal(output.includes("or \\`bat\\` for shell-native viewing"), false);
	assert.equal(output.includes("structural code rewrites"), true);
	assert.equal(
		output.includes("use `sd` only for non-code text") ||
			output.includes("use \\`sd\\` only for non-code text"),
		true,
	);
	assert.equal(output.includes("sd"), true);
	assert.equal(output.includes("fd"), true);
	assert.equal(output.includes("eza"), true);
	assert.equal(output.includes("rg"), true);
	assert.equal(output.includes("ast-grep"), true);
	assert.equal(output.includes("Serena"), true);
	assert.equal(
		output.includes("otherwise use LSP or direct code search"),
		true,
	);
	assert.equal(output.includes("ChunkHound"), true);
	assert.equal(output.includes("Probe"), true);
	assert.equal(
		output.includes(
			"file discovery rather than crafting legacy shell search expressions",
		),
		true,
	);
	assert.equal(output.includes("run"), true);
	assert.equal(output.includes("verify the parent directory exists"), true);
	assert.equal(output.includes("Communication: Output text directly"), true);
	assert.equal(output.includes("find or ls"), false);
	assert.equal(output.includes("grep or rg"), false);
	assert.equal(output.includes("--body \"$(cat <<'EOF'"), false);
	assert.equal(output.includes("(NOT cat/head/tail)"), false);
	assert.equal(output.includes("When running `find`"), false);
	assert.equal(output.includes("find -regex"), false);
	assert.equal(bashPrompt.verify(output, ast), true);
});

test("bash-prompt replaces permissive background execution guidance with the shared intent policy", async () => {
	const ast = parse(BASH_PROMPT_FIXTURE);
	await runBashPromptViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes(BACKGROUND_TASK_POLICY) ||
			output.includes(JSON.stringify(BACKGROUND_TASK_POLICY).slice(1, -1)),
		true,
	);
	assert.equal(
		output.includes(
			"Only use this if you don't need the result immediately and are OK being notified",
		),
		false,
	);
	assert.equal(
		output.includes("use Bash with run_in_background instead"),
		false,
	);
	assert.equal(
		output.includes(
			"For a one-shot result needed now, run Bash in the foreground with an appropriate timeout.",
		),
		true,
	);
	assert.equal(bashPrompt.verify(output, ast), true);
});

test("bash-prompt verify binds background policy to the Bash prompt", async () => {
	const ast = parse(BASH_PROMPT_FIXTURE);
	await runBashPromptViaPasses(ast);
	const output = print(ast);
	const weakened = output.replace(
		"Immediate result: run Bash in the foreground with an appropriate timeout.",
		"Immediate result: choose an execution mode.",
	);
	assert.notEqual(weakened, output);
	const decoy = `${weakened}\nconst unrelatedPolicy = ${JSON.stringify(BACKGROUND_TASK_POLICY)};`;

	const result = bashPrompt.verify(decoy, parse(decoy));
	assert.equal(
		result,
		"Expected shared background execution policy missing from Bash prompt",
	);
});

test("bash-prompt escapes backticks in template literal quasis", async () => {
	// Backtick-containing text can live in a TemplateLiteral quasi.
	// rewriteLegacyText replacements that inject
	// backticks must be escaped in quasi.value.raw so Babel's generator
	// produces valid JS.
	const fixture = `
function nl1() {
  let unrelated = keepMe(),
    H = HO() ? \`\${z8}, \\\`find\\\`, and \\\`grep\\\`\` : \`\${z8}, \${hM}, and \${B_}\`;
  return [
    \`You are the Claude guide agent. Reference local project files when relevant using \${H}\`,
    ...(HO()
      ? []
      : [
          \`File search: Use \${AK} (NOT find or ls)\`,
          \`Content search: Use \${V_} (NOT grep or rg)\`,
        ]),
    \`Read files: Use \${wf} (NOT cat/head/tail)\`,
    \`Edit files: Use \${ef} (NOT sed/awk)\`,
    \`Write files: Use \${s9} (NOT echo >/cat <<EOF)\`,
    "Communication: Output text directly (NOT echo/printf)",
  ].join("\\n");
}
`;
	const ast = parse(fixture);
	await runBashPromptViaPasses(ast);
	const output = print(ast);

	// The output must be valid JS. Re-parsing must not throw
	const reparsed = parse(output);
	assert.ok(
		reparsed,
		"Output must be re-parseable (no broken template literals)",
	);

	// The replacement text should appear in the output
	assert.equal(output.includes("fd"), true);
	assert.equal(output.includes("rg"), true);
	assert.equal(output.includes("ast-grep"), true);
	assert.equal(output.includes("eza"), true);
	assert.equal(output.includes("bat"), true);
});

test("bash-prompt does not patch unrelated zero-arg helper calls", async () => {
	const fixture = `
function A4D() {
  let unrelated = shouldStay(),
    another = keepThis(),
    H = HO(),
    A = H ? "\`cat\`" : "\`find\`, \`grep\`";
  return [
    "Executes a given bash command and returns its output.",
    \`IMPORTANT: Avoid using this tool to run \${A} commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user:\`,
  ].join("\\n");
}

function nl1() {
  let H = HO() ? "\${z8}, \`find\`, and \`grep\`" : "\${z8}, \${hM}, and \${B_}";
  return \`You are the Claude guide agent. Reference local project files when relevant using \${H}\`;
}
`;
	const ast = parse(fixture);
	await runBashPromptViaPasses(ast);
	const output = print(ast);

	assert.equal(output.includes("unrelated = shouldStay()"), true);
	assert.equal(output.includes("another = keepThis()"), true);
	assert.equal(output.includes("H = !0"), true);
	assert.equal(
		output.includes(
			"IMPORTANT: Prefer dedicated symbol/semantic tools and modern CLI utilities whenever possible. Recommended defaults:",
		),
		true,
	);
	assert.equal(output.includes("appropriate dedicated tool"), false);
});

test("bash-prompt forces the gate despite a presence-only notice declarator", async () => {
	// Mirrors the latest upstream Bash prompt builder: alongside the
	// embedded-search gate, an optional notice helper (null when
	// inapplicable) is spliced in via `notice ? ["", notice] : []`. That
	// asymmetric presence shape must not make the gate ambiguous.
	const fixture = `
function A4D() {
  let H = HO(),
    A = H
      ? "\`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\`"
      : "\`find\`, \`grep\`, \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\`",
    M = [
      ...(H
        ? []
        : [
            \`File search: Use \${AK} (NOT find or ls)\`,
            \`Content search: Use \${V_} (NOT grep or rg)\`,
          ]),
    ],
    W = platformNotice();
  return [
    "Executes a given bash command and returns its output.",
    ...(W ? ["", W] : []),
    \`IMPORTANT: Avoid using this tool to run \${A} commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user:\`,
    ...M,
  ].join("\\n");
}
`;
	const ast = parse(fixture);
	await runBashPromptViaPasses(ast);
	const output = print(ast);

	assert.equal(output.includes("H = !0"), true);
	assert.equal(output.includes("W = platformNotice()"), true);
	assert.equal(output.includes("find or ls"), false);
	assert.equal(output.includes("grep or rg"), false);
	assert.equal(output.includes("appropriate dedicated tool"), false);
});

test("bash-prompt patches latest tool-guidance gate routed through an intermediate array", async () => {
	const fixture = `
function ES1(H) {
  let $ = [Vv, RE].find((A) => H.has(A));
  if (xD()) {
    let A = [
      $
        ? \`Break down and manage your work with the \${$} tool.\`
        : null,
    ].filter((f) => f !== null);
    if (A.length === 0) return "";
    return ["# Using your tools", ...aF(A)].join("\\n");
  }
  let q = kM(),
    K = [mq, DK, m7, ...(q ? [] : [N9, s_])].join(", "),
    _ = [
      \`Prefer dedicated tools over \${u6} when one fits (\${K}) — reserve \${u6} for shell-only operations.\`,
      $
        ? \`Use \${$} to plan and track work.\`
        : null,
    ].filter((A) => A !== null);
  return ["# Using your tools", ...aF(_)].join("\\n");
}
`;

	const ast = parse(fixture);
	await runBashPromptViaPasses(ast);
	const output = print(ast);

	assert.equal(output.includes("let q = !0"), true);
	assert.equal(output.includes("Prefer dedicated tools over"), true);
	assert.equal(output.includes("when one fits ("), false);
	assert.equal(output.includes("when one fits \\u2014 reserve"), true);
});

test("bash-prompt forces a logical (&&) gate test inside an array spread", async () => {
	// The live tool-guidance gate threads a logical (&&) test through an array
	// spread: `...(q && K ? [] : [a, b])`. Because the gate reference sits
	// inside the logical wrapper (not the conditional test directly), the
	// conditional test itself must be forced, leaving the `q` declarator a call.
	const fixture = `
function N3z(H) {
  let q = UW(),
    K = H.has(aq),
    _ = K ? aq : aK,
    f = [SK, p4, e1, ...(q && K ? [] : [S_, p1])].join(", "),
    z = [
      \`Prefer dedicated tools over \${_} when one fits (\${f}) — reserve \${_} for shell-only operations.\`,
    ];
  return ["# Using your tools", ...aF(z)].join("\\n");
}
`;
	const ast = parse(fixture);
	await runBashPromptViaPasses(ast);
	const output = print(ast);
	// The logical gate test is forced; the spread collapses to the empty branch.
	assert.equal(output.includes("q && K ? []"), false);
	assert.equal(output.includes("!0 ? []"), true);
	// The gated-only identifiers survive in the now-dead alternate branch.
	assert.match(output, /\[\s*S_\s*,\s*p1\s*\]/);
	// The declarator init itself stays a call (only the conditional test forced).
	assert.equal(output.includes("q = UW()"), true);
	assert.equal(output.includes("when one fits ("), false);
});

test("bash-prompt forces an asymmetric-presence gate whose guidance text is in a sibling node", async () => {
	// The gate's conditional branches contain NO search-guidance text (empty
	// array vs plain identifier array); the guidance lives only in a sibling
	// template. The gate must still qualify via asymmetric presence alone and
	// be forced. Here the gate reference is the conditional test directly, so
	// the declarator init is forced.
	const fixture = `
function N3z(H) {
  let q = UW(),
    list = [aa, bb, ...(q ? [] : [cc, dd])].join(", "),
    z = [
      \`Prefer dedicated tools over \${tool} when one fits (\${list}) — reserve \${tool} for shell-only operations.\`,
    ];
  return ["# Using your tools", ...z].join("\\n");
}
`;
	const ast = parse(fixture);
	await runBashPromptViaPasses(ast);
	const output = print(ast);
	// Gate forced even though no branch contains search-guidance fragments.
	assert.equal(output.includes("q = !0"), true);
	assert.equal(output.includes("when one fits ("), false);
});

test("bash-prompt does not force an ambiguous pair of guidance-less presence gates", async () => {
	// Two asymmetric-presence declarators with no guidance text coexist in the
	// tool-guidance function. The gate locator cannot disambiguate, so neither
	// is forced and verify must surface the un-forced gate rather than passing.
	const fixture = `
function N3z(H) {
  let q = UW(),
    r = OTHER(),
    a = [x1, ...(q ? [] : [g1])].join(", "),
    b = [y1, ...(r ? [] : [g2])].join(", "),
    z = [
      \`Prefer dedicated tools over \${tool} when one fits (\${a}\${b}) — reserve \${tool} for shell-only operations.\`,
    ];
  return ["# Using your tools", ...z].join("\\n");
}
`;
	const ast = parse(fixture);
	await runBashPromptViaPasses(ast);
	const output = print(ast);
	// Neither presence gate is forced (ambiguous: two guidance-less candidates).
	assert.equal(output.includes("!0 ? []"), false);
	// verify() must surface the un-forced gate rather than passing silently.
	assert.notEqual(bashPrompt.verify(output, ast), true);
});

test("bash-prompt empties the gated tool list in the tool-guidance surface", async () => {
	// Assert the structural outcome of the gate force directly: the gated
	// identifiers survive only in the now-dead alternate branch, never in a
	// position that renders when the test is forced true. Catches a silent gate
	// no-op even if the prompt-text rewrite still succeeds.
	const fixture = `
function N3z(H) {
  let q = UW(),
    K = H.has(aq),
    f = [SK, p4, e1, ...(q && K ? [] : [GATED_FILE, GATED_CONTENT])].join(", "),
    z = [
      \`Prefer dedicated tools over \${tool} when one fits (\${f}) — reserve \${tool} for shell-only operations.\`,
    ];
  return ["# Using your tools", ...z].join("\\n");
}
`;
	const ast = parse(fixture);
	await runBashPromptViaPasses(ast);
	const output = print(ast);
	assert.equal(output.includes("!0 ? []"), true);
	assert.match(output, /\[\s*GATED_FILE\s*,\s*GATED_CONTENT\s*\]/);
	assert.equal(output.includes("q && K"), false);
});

test("bash-prompt forces a logical-&& conditional-init guide-agent gate and verify accepts it", async () => {
	// The live guide-agent gate is a conditional-init declarator whose test is a
	// logical && of two zero-arg calls, with a `find`, and `grep` consequent.
	// Forcing the test true selects that consequent, which rewriteLegacyText then
	// modernizes to the shared finding-tools list. verify() must still accept the
	// result, which only holds because the modern list itself counts as
	// search-guidance. The fixture carries all three gate anchors so verify's
	// per-anchor forced-gate check has every surface it requires.
	const fixture = `
function backgroundGuidance() {
  if (backgroundTasksDisabled()) return null;
  return ${JSON.stringify(STOCK_BACKGROUND_EXECUTION_GUIDANCE)};
}

function A4D() {
  let H = HO(),
    background = backgroundGuidance(),
    n = [
      ...(H
        ? []
        : [
            \`File search: Use \${AK} (NOT find or ls)\`,
            \`Content search: Use \${V_} (NOT grep or rg)\`,
          ]),
      \`Read files: Use \${wf} (NOT cat/head/tail)\`,
      \`Edit files: Use \${ef} (NOT sed/awk)\`,
      \`Write files: Use \${s9} (NOT echo >/cat <<EOF)\`,
    ],
    A = H
      ? "\`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\`"
      : "\`find\`, \`grep\`, \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\`";
  return [
    "Executes a given bash command and returns its output.",
    "The working directory persists between commands, but shell state does not. The shell environment is initialized from the user's profile (bash or zsh).",
    \`IMPORTANT: Avoid using this tool to run \${A} commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user:\`,
    ${JSON.stringify(STOCK_ONE_SHOT_BACKGROUND_GUIDANCE)},
    ...(H
      ? [
          "When running \`find\`, search from \`.\` (or a specific path), not \`/\` — scanning the full filesystem can exhaust system resources on large trees.",
        ]
      : []),
    ...(background !== null ? [background] : []),
    ...n,
  ].join("\\n");
}

function nl1() {
  let unrelated = keepMe(),
    H = HO() && B7() ? \`\${z8}, \\\`find\\\`, and \\\`grep\\\`\` : \`\${z8}, \${hM}, and \${B_}\`;
  return [
    \`You are the Claude guide agent. Reference local project files when relevant using \${H}\`,
    ...(HO()
      ? []
      : [
          \`File search: Use \${AK} (NOT find or ls)\`,
          \`Content search: Use \${V_} (NOT grep or rg)\`,
        ]),
    \`Read files: Use \${wf} (NOT cat/head/tail)\`,
    \`Edit files: Use \${ef} (NOT sed/awk)\`,
    \`Write files: Use \${s9} (NOT echo >/cat <<EOF)\`,
    "Communication: Output text directly (NOT echo/printf)",
  ].join("\\n");
}

function js6(H, $) {
  let f = jO(),
    K = [
      \`Prefer dedicated tools over \${u6} when one fits (\${[mq, DK, ...(f ? [] : [N9, s_])].join(", ")}) — reserve \${u6} for shell-only operations.\`,
    ];
  return ["# Using your tools", ...K].join("\\n");
}
`;
	const ast = parse(fixture);
	await runBashPromptViaPasses(ast);
	const output = print(ast);
	// The logical && conditional-init test is forced true; the declarator keeps
	// its conditional form.
	assert.equal(output.includes("HO() && B7()"), false);
	assert.match(output, /H = !0 \?/);
	// The find/grep consequent is modernized to the shared finding-tools list.
	assert.equal(output.includes("`find`, and `grep`"), false);
	assert.equal(
		output.includes("`fd`, `rg`, `ast-grep`, `eza`, and `bat`") ||
			output.includes(
				"\\`fd\\`, \\`rg\\`, \\`ast-grep\\`, \\`eza\\`, and \\`bat\\`",
			),
		true,
	);
	// verify's forced-anchor check depends on the modern list itself counting as
	// search-guidance, so this round-trip locks that coupling end to end.
	assert.equal(bashPrompt.verify(output, ast), true);
});

test("bash-prompt leaves a gh-pr-create heredoc untouched", async () => {
	// bash-prompt does not rewrite gh pr create heredocs. Even inside an anchored
	// function, the interpolated (multi-quasi) heredoc passes through unchanged and
	// none of the mktemp/body-file rewrite artifacts appear in the output.
	const fixture = `
function A4D() {
  return [
    "Executes a given bash command and returns its output.",
    \`gh pr create --title "the pr title" --body "$(cat <<'EOF'
## Summary
\${Nir()}

## Test plan
\${Fir()}
EOF
)"\`,
  ].join("\\n");
}
`;
	const ast = parse(fixture);
	await runBashPromptViaPasses(ast);
	const output = print(ast);
	assert.equal(output.includes("--body \"$(cat <<'EOF'"), true);
	assert.equal(output.includes("pr_body=$(mktemp)"), false);
	assert.equal(output.includes("--body-file"), false);
});

test("bash-prompt does not install lean routing into an obsolete ungated builder", async () => {
	const fixture = `
function kFp(e) {
  let o = Qw()
      ? "\`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\`"
      : "\`find\`, \`grep\`, \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\`";
  return [
    "Executes a bash command and returns its output.",
    \`- IMPORTANT: Avoid using this tool to run \${o} commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user.\`,
  ].join("\\n");
}
`;
	const ast = parse(fixture);
	await runBashPromptViaPasses(ast);
	const output = print(ast);
	assert.equal(output.includes(MODERN_TOOL_PREFERENCE), false);
	assert.equal(output.includes("appropriate dedicated tool"), true);
});

test("bash-prompt replaces a reworded working-directory line with the runtime-neutral wording", async () => {
	// The working-directory replacement anchors on a durable fragment rather than
	// the exact legacy sentence, so an upstream reword is still neutralized instead
	// of silently passing through.
	const fixture = `
function A4D() {
  return [
    "Executes a given bash command and returns its output.",
    "Working directory persists between calls, but prefer absolute paths. Shell state does not persist; the shell is initialized from the user's profile.",
  ].join("\\n");
}
`;
	const ast = parse(fixture);
	await runBashPromptViaPasses(ast);
	const output = print(ast);
	assert.equal(
		output.includes(
			"Working-directory behavior is controlled by runtime policy. Do not rely on `cd`, shell variables, or other shell state carrying between calls; use explicit paths.",
		),
		true,
	);
	assert.equal(output.includes("prefer absolute paths"), false);
});

test("bash-prompt leaves the short Bash builder's working-directory guidance in place", async () => {
	// The replacement is scoped to the full builder, identified by "Executes a
	// given bash command", so the short builder's own working-directory guidance
	// is not rewritten even though it matches the same durable fragment.
	const fixture = `
function kFp(e) {
  let s = "- Working directory persists between calls. Shell state does not persist; the shell is initialized from the user's profile.";
  return ["Executes a bash command and returns its output.", s].join("\\n");
}
`;
	const ast = parse(fixture);
	await runBashPromptViaPasses(ast);
	const output = print(ast);
	assert.equal(
		output.includes("Working directory persists between calls"),
		true,
	);
	assert.equal(
		output.includes(
			"Working-directory behavior is controlled by runtime policy",
		),
		false,
	);
});

test("bash-prompt leaves the obsolete paired lean-guidance gate untouched", async () => {
	const fixture = `
function kFp(e) {
  let o = Qw(), i = Rw(), s = [];
  if (!o && !i) {
    let d = Zw() ? "\`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\`" : "\`find\`, \`grep\`, \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\`";
    s.push(\`- IMPORTANT: Avoid using this tool to run \${d} commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user.\`);
  }
  return ["Executes a bash command and returns its output.", ...s].join("\\n");
}
`;
	const ast = parse(fixture);
	await runBashPromptViaPasses(ast);
	const output = print(ast);
	assert.doesNotMatch(output, /if \(!0\) \{/);
	assert.equal(output.includes(MODERN_TOOL_PREFERENCE), false);
	assert.equal(output.includes("appropriate dedicated tool"), true);
});

test("bash-prompt forces the latest lean Bash builder's single gate", async () => {
	const fixture = `
function renderLeanBashPrompt() {
  let suppressToolGuidance = toolGuidanceDisabled(), guidance = [];
  if (!suppressToolGuidance) {
    let discouragedCommands = preferBasicUtilities() ? "\`cat\`, \`head\`, or \`tail\`" : "\`find\`, \`grep\`, or \`cat\`";
    guidance.push(\`- IMPORTANT: Avoid using this tool to run \${discouragedCommands} commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user.\`);
  }
  return ["Executes a bash command and returns its output.", ...guidance].join("\\n");
}
`;
	const ast = parse(fixture);
	await runBashPromptViaPasses(ast);
	const output = print(ast);

	assert.match(output, /if \(!0\) \{/);
	assert.equal(output.includes("if (!suppressToolGuidance)"), false);
	assert.equal(output.includes(MODERN_TOOL_PREFERENCE), true);
	for (const line of MODERN_CODE_SEARCH_DECISION_TREE_LINES) {
		assert.equal(output.includes(line), true);
	}
	assert.equal(output.includes("appropriate dedicated tool"), false);
});

test("bash-prompt rewrites the auto-mode bash-first nudge to the dedicated-tool policy", async () => {
	const fixture = `
function renderAutoMode(e) {
  let i = \`Do your work through the \${B} tool wherever it can accomplish the job: read files with cat, head, or sed -n, search with grep and find, and make file changes with sed, heredocs, or short scripts, rather than using the dedicated \${R}, \${E}, or \${W} tools. Fall back to a dedicated tool only when \${B} genuinely cannot do the job.\`,
    s = e.bypass ? \`While bypass permissions mode is active:\\n\\n\${i}\` : e.steerOnly ? \`While auto mode is active:\\n\\n\${i}\` : i;
  return s;
}
`;
	const ast = parse(fixture);
	await runBashPromptViaPasses(ast);
	const output = print(ast);
	assert.equal(output.includes("read files with cat, head, or sed -n"), false);
	assert.equal(output.includes("genuinely cannot do the job"), false);
	assert.equal(
		output.includes(
			"Work through ${B} wherever the shell has the better tool: fd for file discovery, eza for directory listings, bat -r for ranged reads, rg for exact lexical text, ast-grep run for syntax shapes and repeated rewrites (preview, then -U), comby for malformed or mixed syntax, sd for non-code text, and jq or yq for structured data. Keep ${R} for files you need whole in context, ${E} for a single known site, and ${W} for new files; route everything else through ${B}. For source code, choose by intent:",
		),
		true,
	);
});

test("bash-prompt verify rejects a bundle that still carries the bash-first nudge", async () => {
	const ast = parse(BASH_PROMPT_FIXTURE);
	await runBashPromptViaPasses(ast);
	const patched = print(ast);
	assert.equal(bashPrompt.verify(patched, ast), true);

	const legacy = `${patched}\nfunction renderAutoMode(e) { return \`While auto mode is active:\\n\\nDo your work through the \${B} tool wherever it can accomplish the job: read files with cat, head, or sed -n, search with grep and find, and make file changes with sed, heredocs, or short scripts, rather than using the dedicated \${R}, \${E}, or \${W} tools. Fall back to a dedicated tool only when \${B} genuinely cannot do the job.\`; }`;
	const legacyResult = bashPrompt.verify(legacy, parse(legacy));
	assert.equal(
		typeof legacyResult === "string" && legacyResult.includes("bash-first"),
		true,
	);

	const missing = `${patched}\nconst autoModeHeader = "While auto mode is active:";`;
	const missingResult = bashPrompt.verify(missing, parse(missing));
	assert.equal(
		typeof missingResult === "string" &&
			missingResult.includes("dedicated-tools auto-mode guidance"),
		true,
	);
});
