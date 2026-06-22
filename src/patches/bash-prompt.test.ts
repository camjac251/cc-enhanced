import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { bashPrompt } from "./bash-prompt.js";

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

const BASH_PROMPT_FIXTURE = `
function ws_() {
  let K = TM()
    ? "\`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\`"
    : "\`find\`, \`grep\`, \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\`";
  return [
    "Executes a bash command and returns its output.",
    "",
    \`- IMPORTANT: Avoid using this tool to run \${K} commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user.\`,
  ].join("\\n");
}

function A4D() {
  let unrelated = shouldStay(),
    H = HO(),
    A = H
      ? "\`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\`"
      : "\`find\`, \`grep\`, \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\`";
  let M = [
    \`To read files use \${wf} instead of cat, head, tail, or sed\`,
    \`To edit files use \${ef} instead of sed or awk\`,
    \`To create files use \${s9} instead of cat with heredoc or echo redirection\`,
    ...(H
      ? []
      : [
          \`To search for files use \${AK} instead of find or ls\`,
          \`To search the content of files, use \${V_} instead of grep or rg\`,
        ]),
  ];
  return [
    "Executes a given bash command and returns its output.",
    \`IMPORTANT: Avoid using this tool to run \${A} commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user:\`,
    "If your command will create new directories or files, first use this tool to run \`ls\` to verify the parent directory exists and is the correct location.",
    "gh pr create --title \\"the pr title\\" --body \\"$(cat <<'EOF'\\n## Summary\\n<1-3 bullet points>\\n\\n## Test plan\\n[Bulleted markdown checklist of TODOs for testing the pull request...]\\n\\n\`file viewing, editing, creation, or output formatting\`\\nEOF\\n)\\"",
    ...(H
      ? [
          "When running \`find\`, search from \`.\` (or a specific path), not \`/\` \u2014 scanning the full filesystem can exhaust system resources on large trees.",
          "When using \`find -regex\` with alternation, put the longest alternative first. Example: use '.*\\\\.\\\\(tsx\\\\|ts\\\\)' not '.*\\\\.\\\\(ts\\\\|tsx\\\\)' — the second form silently skips .tsx files.",
        ]
      : []),
    ...M,
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

function js6(H, $) {
  let f = jO(),
    _ = f ? "\`find\` or \`grep\`" : \`the \${AK} or \${V_}\`,
    M = [
      \`To read files use \${wf} instead of cat, head, tail, or sed\`,
      \`To edit files use \${ef} instead of sed or awk\`,
      \`To create files use \${s9} instead of cat with heredoc or echo redirection\`,
      ...(f
        ? []
        : [
            \`To search for files use \${AK} instead of find or ls\`,
            \`To search the content of files, use \${V_} instead of grep or rg\`,
          ]),
      \`Reserve using Bash exclusively for system commands and terminal operations.\`,
    ],
    K = [
      \`Do NOT use Bash to run commands when a relevant dedicated tool is provided. This is CRITICAL to assisting the user:\`,
      M,
    ];
  return ["# Using your tools", ...K].join("\\n");
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
	assert.equal(output.includes("code rewrites use"), true);
	assert.equal(
		output.includes("use `sd` only for non-code text") ||
			output.includes("use \\`sd\\` only for non-code text"),
		true,
	);
	assert.equal(output.includes("sd"), true);
	assert.equal(output.includes("fd"), true);
	assert.equal(output.includes("eza"), true);
	assert.equal(output.includes("rg"), true);
	assert.equal(output.includes("sg"), true);
	assert.equal(output.includes("Serena"), true);
	assert.equal(output.includes("raw LSP"), true);
	assert.equal(output.includes("ChunkHound"), true);
	assert.equal(output.includes("Probe"), true);
	assert.equal(output.includes("mcp__ast-grep__find_code"), true);
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
	assert.equal(output.includes("tee \"$pr_body\" >/dev/null <<'EOF'"), false);
	assert.equal(
		output.includes("tee \\\"$pr_body\\\" >/dev/null <<'EOF'"),
		false,
	);
	assert.equal(
		output.includes("tee \"$pr_body\" >/dev/null <<'PR_BODY'") ||
			output.includes("tee \\\"$pr_body\\\" >/dev/null <<'PR_BODY'"),
		true,
	);
	assert.equal(output.includes("pr_body=$(mktemp)"), true);
	assert.equal(
		output.includes('--body-file "$pr_body"') ||
			output.includes('--body-file \\"$pr_body\\"'),
		true,
	);
	assert.equal(output.includes("(NOT cat/head/tail)"), false);
	assert.equal(output.includes("When running `find`"), false);
	assert.equal(output.includes("find -regex"), false);
	assert.equal(bashPrompt.verify(output, ast), true);
});

test("bash-prompt escapes backticks in template literal quasis", async () => {
	// 2.1.76+ moved backtick-containing text from StringLiteral into a
	// TemplateLiteral quasi.  rewriteLegacyText replacements that inject
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
	assert.equal(output.includes("sg"), true);
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
            \`To search for files use \${AK} instead of find or ls\`,
            \`To search the content of files, use \${V_} instead of grep or rg\`,
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
function A4D() {
  let H = HO(),
    A = H
      ? "\`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\`"
      : "\`find\`, \`grep\`, \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\`",
    M = [
      \`To read files use \${wf} instead of cat, head, tail, or sed\`,
      \`To edit files use \${ef} instead of sed or awk\`,
      \`To create files use \${s9} instead of cat with heredoc or echo redirection\`,
      ...(H
        ? []
        : [
            \`To search for files use \${AK} instead of find or ls\`,
            \`To search the content of files, use \${V_} instead of grep or rg\`,
          ]),
    ];
  return [
    "Executes a given bash command and returns its output.",
    \`IMPORTANT: Avoid using this tool to run \${A} commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user:\`,
    ...M,
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
		output.includes("`fd`, `rg`, `sg`, `eza`, and `bat`") ||
			output.includes("\\`fd\\`, \\`rg\\`, \\`sg\\`, \\`eza\\`, and \\`bat\\`"),
		true,
	);
	// verify's forced-anchor check depends on the modern list itself counting as
	// search-guidance, so this round-trip locks that coupling end to end.
	assert.equal(bashPrompt.verify(output, ast), true);
});

test("bash-prompt leaves a gh-pr-create heredoc in an unanchored function, so verify still rejects it", async () => {
	// bash-prompt only rewrites functions carrying a prompt anchor. A gh-pr-create
	// heredoc lives in an unanchored helper, so bash-prompt's own pass never
	// touches it and the legacy bare-quote form survives. verify forbids that
	// form globally, so it depends on another patch's string phase to clear the
	// block before the bundle reaches verify. This pins that cross-patch
	// dependency: dropping it would force this test to be updated.
	const fixture = `
function IFp(e) {
  return [
    \`gh pr create --title "the pr title" --body "$(cat <<'EOF'
## Summary
<1-3 bullet points>

## Test plan
[Bulleted markdown checklist of TODOs for testing the pull request...]
EOF
)"\`,
  ].join("\\n");
}
`;
	const ast = parse(fixture);
	await runBashPromptViaPasses(ast);
	const output = print(ast);
	assert.equal(output.includes("--body \"$(cat <<'EOF'"), true);
	assert.notEqual(bashPrompt.verify(output, ast), true);
});

test("bash-prompt forces the short Bash builder gate even though verify does not inspect it", async () => {
	// The short Bash builder's anchor is a prompt-text anchor but not an
	// embedded-search gate anchor, so verify's forced-gate scan never inspects it.
	// Pin the mutator-level outcome (the conditional-init gate is forced and the
	// legacy guidance is gone) so a future drift that makes the force a silent
	// no-op is caught here, where verify would miss it.
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
	assert.match(output, /o = !0 \?/);
	assert.equal(output.includes("appropriate dedicated tool"), false);
});
