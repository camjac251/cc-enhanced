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
    ...(H
      ? [
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
			"IMPORTANT: Prefer dedicated tools and modern CLI utilities whenever possible. Recommended defaults:",
		),
		true,
	);
	assert.equal(output.includes("shell-native viewing use"), true);
	assert.equal(output.includes("bat"), true);
	assert.equal(output.includes("shell-native replacement use"), true);
	assert.equal(output.includes("sd"), true);
	assert.equal(output.includes("fd"), true);
	assert.equal(output.includes("eza"), true);
	assert.equal(output.includes("rg"), true);
	assert.equal(output.includes("sg"), true);
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
	assert.equal(output.includes("(NOT cat/head/tail)"), false);
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
			"IMPORTANT: Prefer dedicated tools and modern CLI utilities whenever possible. Recommended defaults:",
		),
		true,
	);
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
});
