import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { effortStack } from "./effort-stack.js";

async function runEffortStackViaPasses(ast: any): Promise<void> {
	const passes = (await effortStack.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: effortStack.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

const EFFORT_STACK_FIXTURE = `
function resolveEffortLevel(H) {
  if (H.settings.ultracode === !0) return "xhigh";
  return H.settings.effortLevel ?? "high";
}

function readUltracodeFlag(state) {
  let enabled = settings().ultracode === !0 || !1;
  if (enabled) unpinLaunchEffort();
  return enabled;
}

function ultracodeAvailable(model) {
  return workflowsEnabled() && (model === void 0 || supportsXhigh(model));
}

function isUltracodeActive(model, effort, ultracode) {
  return ultracode === !0 && workflowsEnabled() && resolveEffort(model, effort) === "xhigh";
}

function readEnvEffort() {
  let raw = process.env.CLAUDE_CODE_EFFORT_LEVEL;
  return raw?.toLowerCase() === "unset" || raw?.toLowerCase() === "auto" ? null : parseEffort(raw);
}

function resolveEffectiveEffort(model, effort) {
  if (!effortSupported(model)) return;
  let launchDefault = pinnedLaunchEffort(model);
  let envEffort = readEnvEffort();
  if (envEffort === null) return launchDefault ? defaultEffort(model) : void 0;
  let resolved = envEffort ?? (launchDefault ? defaultEffort(model) : void 0) ?? effort ?? defaultEffort(model);
  if (resolved === "max" && !supportsMax(model)) return "high";
  if (resolved === "xhigh" && !supportsXhigh(model)) return "high";
  return resolved;
}

function effortWouldChange(next, current, model, cacheToken, hasConversationMessages) {
  if (!hasConversationMessages) return !1;
  let marker = changedMessageCount();
  if (marker === 0 || marker === cacheToken) return !1;
  if (!effortSupported(model)) return !1;
  if (launchPinned(model)) {
    if (next === void 0 || next === defaultEffort(model)) return !1;
  } else if (resolveEffectiveEffort(model, next) === resolveEffectiveEffort(model, current)) return !1;
  return !0;
}

function storeEffortSetting(H) {
  let parsed = H !== void 0 ? parsePersistedEffort(H) : void 0;
  if (H === void 0 || parsed !== void 0) {
    let result = saveSettings("userSettings", { effortLevel: parsed });
    if (result.error) return result.error;
  }
  unpinLaunchEffort();
  return;
}

function notify(EL) {
  EL({
    key: "ultrathink-active",
    text: "Deeper reasoning requested for this turn",
    priority: "immediate",
    timeoutMs: 5000,
  });
}

function pickUltracode() {
  let envEffort = readEnvEffort();
  if (envEffort !== void 0 && envEffort !== "xhigh")
    return {
      message: \`CLAUDE_CODE_EFFORT_LEVEL=\${process.env.CLAUDE_CODE_EFFORT_LEVEL} overrides effort this session — clear it and ultracode takes over\`,
      effortUpdate: { value: "xhigh", ultracode: !0 },
    };
  return {
    message: "Set effort level to ultracode (this session only): xhigh + dynamic workflow orchestration",
    effortUpdate: { value: "xhigh", ultracode: !0 },
  };
}

function pickEffort(H) {
  let Y = process.env.CLAUDE_CODE_EFFORT_LEVEL;
  return {
    message: \`CLAUDE_CODE_EFFORT_LEVEL=\${Y} overrides this session — clear it and \${labelFor(H)} takes over\`,
    effortUpdate: { value: H, ultracode: !1 },
  };
}

function pickMaxEffort(H) {
  let Y = process.env.CLAUDE_CODE_EFFORT_LEVEL;
  return {
    message: \`Not applied: CLAUDE_CODE_EFFORT_LEVEL=\${Y} overrides effort this session, and \${labelFor(H)} is session-only (nothing saved)\`,
    effortUpdate: { value: H, ultracode: !1 },
  };
}

function clearEffort() {
  let envEffort = readEnvEffort();
  if (envEffort !== void 0 && envEffort !== null)
    return {
      message: \`Cleared effort from settings, but CLAUDE_CODE_EFFORT_LEVEL=\${process.env.CLAUDE_CODE_EFFORT_LEVEL} still controls this session\`,
      effortUpdate: { value: void 0, ultracode: !1 },
    };
  return {
    message: "Effort level set to auto",
    effortUpdate: { value: void 0, ultracode: !1 },
  };
}

function currentEffort(H, $, q) {
  if (isUltracodeActive($, H, q))
    return {
      message: "Current effort level: ultracode (xhigh + dynamic workflow orchestration; this session only)",
    };
  return { message: "Effort level: auto" };
}

function describeOption(H, $ = !1) {
  if (!H) return;
  if ($) return \`\${ULTRACODE_ICON} ultracode · xhigh effort + dynamic workflows for maximum thoroughness\`;
  return \`option: \${H}\`;
}

function runEffortCommand(H, setState, done) {
  let K = pickCommand(H);
  if (K.effortUpdate) {
    let { value: _, ultracode: z = !1 } = K.effortUpdate;
    setState((A) => {
      if (A.effortValue === _ && (A.ultracode ?? !1) === z) return A;
      return { ...A, effortValue: _, ultracode: z };
    });
  }
  done(K.message);
}

function callEffortCommand(H, api) {
  let K = pickCommand(H);
  if (K.effortUpdate) {
    let _ = K.effortUpdate.value;
    let z = K.effortUpdate.ultracode ?? !1;
    api.setAppState((A) =>
      A.effortValue === _ && (A.ultracode ?? !1) === z ? A : { ...A, effortValue: _, ultracode: z },
    );
  }
  return { type: "text", value: K.message };
}
`;

test("verify rejects unpatched fixture", () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	const code = print(ast);
	const result = effortStack.verify(code, ast);
	assert.notEqual(result, true);
	assert.equal(typeof result, "string");
});

test("effort-stack patches resolver to honor CLAUDE_CODE_EFFORT_LEVEL=max", async () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	await runEffortStackViaPasses(ast);
	const output = print(ast);

	assert.match(
		output,
		/\(H\.settings\.ultracode === !0 \|\| \["1", "true", "yes", "on"\]\.includes\(String\(process\.env\.CLAUDE_CODE_ULTRACODE\)\.toLowerCase\(\)\)\) && String\(process\.env\.CLAUDE_CODE_EFFORT_LEVEL\)\.toLowerCase\(\) !== "max"/,
	);
});

test("effort-stack lets CLAUDE_CODE_ULTRACODE enable workflow mode", async () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	await runEffortStackViaPasses(ast);
	const output = print(ast);
	assert.equal(
		output.includes(
			'let enabled = settings().ultracode === !0 || !1 || ["1", "true", "yes", "on"].includes(String(process.env.CLAUDE_CODE_ULTRACODE).toLowerCase())',
		),
		true,
	);
});

test("effort-stack patches ultracode active gate to treat max as active", async () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	await runEffortStackViaPasses(ast);
	const output = print(ast);
	assert.equal(
		output.includes(
			'ultracode === !0 && ultracodeAvailable(model) && (resolveEffort(model, effort) === "xhigh" || resolveEffort(model, effort) === "max")',
		),
		true,
	);
});

test("effort-stack rewrites the ultrathink notification text", async () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	await runEffortStackViaPasses(ast);
	const output = print(ast);
	assert.equal(
		output.includes('text: "Effort set to max for this turn"'),
		true,
	);
});

test("effort-stack makes the ultracode env override message state-aware", async () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	await runEffortStackViaPasses(ast);
	const output = print(ast);
	assert.equal(
		output.includes("Ultracode workflows active for this session"),
		true,
	);
	assert.equal(
		output.includes("Set effort level to ultracode for this session"),
		true,
	);
	assert.equal(
		output.includes('value: envEffort === "max" ? "max" : "xhigh"'),
		true,
	);
	assert.equal(
		output.includes("overrides effort this session"),
		false,
		"legacy BYz warning text should be gone",
	);
});

test("effort-stack rewrites effort env override warnings into session overrides", async () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	await runEffortStackViaPasses(ast);
	const output = print(ast);
	assert.equal(
		output.includes(
			"CLAUDE_CODE_EFFORT_LEVEL=${Y} remains the launch default for new sessions. Set effort level to ${labelFor(H)} for this session.",
		),
		true,
	);
	assert.equal(
		output.includes("Not applied: CLAUDE_CODE_EFFORT_LEVEL="),
		false,
	);
	assert.equal(output.includes("still controls this session"), false);
	assert.equal(
		output.includes(" overrides this session "),
		false,
		"legacy uYz warning text should be gone",
	);
});

test("effort-stack prepends env-stacking branch to current-effort display", async () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	await runEffortStackViaPasses(ast);
	const output = print(ast);
	assert.match(
		output,
		/if\s*\(\s*isUltracodeActive\(\$, H, q\) && String\(process\.env\.CLAUDE_CODE_EFFORT_LEVEL\)\.toLowerCase\(\) === "max"\)\s+return \{\s+message: "Current effort level: max effort \+ ultracode workflows \(env-stacked\)"/,
	);
});

test("effort-stack wraps ultracode description in env-aware conditional", async () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	await runEffortStackViaPasses(ast);
	const output = print(ast);
	assert.equal(
		output.includes(
			'String(process.env.CLAUDE_CODE_EFFORT_LEVEL).toLowerCase() === "max" ? `${ULTRACODE_ICON} ultracode · max effort + dynamic workflows for maximum thoroughness` : `${ULTRACODE_ICON} ultracode · xhigh effort + dynamic workflows for maximum thoroughness`',
		),
		true,
	);
});

test("effort-stack lets /effort override env for the current session", async () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	await runEffortStackViaPasses(ast);
	const output = print(ast);
	assert.equal(
		output.includes("globalThis.__claudeCodeEffortSessionOverride === true"),
		true,
	);
	assert.equal(
		output.includes("globalThis.__claudeCodeEffortSessionOverride = true"),
		true,
	);
	assert.equal(
		output.includes(
			"process.env.CLAUDE_CODE_EFFORT_LEVEL !== void 0 && next !== current",
		),
		true,
	);
});

test("effort-stack keeps env-backed effort changes session-only", async () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	await runEffortStackViaPasses(ast);
	const output = print(ast);
	assert.equal(
		output.includes("process.env.CLAUDE_CODE_EFFORT_LEVEL !== void 0"),
		true,
	);
	assert.equal(
		output.includes('saveSettings("userSettings", { effortLevel: parsed })'),
		true,
	);
});

test("effort-stack full pipeline verifies clean", async () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	await runEffortStackViaPasses(ast);
	const output = print(ast);
	assert.equal(effortStack.verify(output, ast), true);
});

test("effort-stack is idempotent across all mutations", async () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	await runEffortStackViaPasses(ast);
	const once = print(ast);
	await runEffortStackViaPasses(ast);
	const twice = print(ast);
	assert.equal(twice, once);
	assert.equal(effortStack.verify(twice), true);
});

test("effort-stack verify rejects regression where env guard is dropped", async () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	await runEffortStackViaPasses(ast);
	const output = print(ast);
	const regressed = output.replace(
		' && String(process.env.CLAUDE_CODE_EFFORT_LEVEL).toLowerCase() !== "max"',
		"",
	);

	const result = effortStack.verify(regressed);
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("patched ultracode resolver"), true);
});

test("effort-stack verify fails hard on ultracode command UI drift", async () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	await runEffortStackViaPasses(ast);
	const output = print(ast);
	const regressed = output.replace(
		"Ultracode workflows active for this session",
		"`CLAUDE_CODE_EFFORT_LEVEL=${process.env.CLAUDE_CODE_EFFORT_LEVEL} overrides effort this session — clear it and ultracode takes over`",
	);
	const result = effortStack.verify(regressed);
	assert.equal(typeof result, "string");
});

test("effort-stack verify fails hard when env ultracode source is missing", async () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	await runEffortStackViaPasses(ast);
	const output = print(ast);
	const regressed = output.replace(
		'settings().ultracode === !0 || !1 || ["1", "true", "yes", "on"].includes(String(process.env.CLAUDE_CODE_ULTRACODE).toLowerCase())',
		"settings().ultracode === !0",
	);
	const result = effortStack.verify(regressed);
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("CLAUDE_CODE_ULTRACODE"), true);
});

test("effort-stack verify still fails hard when resolver guard is dropped", async () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	await runEffortStackViaPasses(ast);
	const output = print(ast);
	const regressed = output.replace(
		' && String(process.env.CLAUDE_CODE_EFFORT_LEVEL).toLowerCase() !== "max"',
		"",
	);
	const result = effortStack.verify(regressed);
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("patched ultracode resolver"), true);
});

test("effort-stack verify fails hard when active gate rejects max", async () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	await runEffortStackViaPasses(ast);
	const output = print(ast);
	const regressed = output.replace(
		' && ultracodeAvailable(model) && (resolveEffort(model, effort) === "xhigh" || resolveEffort(model, effort) === "max")',
		' && workflowsEnabled() && resolveEffort(model, effort) === "xhigh"',
	);
	const result = effortStack.verify(regressed);
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("active-state gate"), true);
});

test("effort-stack verify fails hard when session override resolver guard is missing", async () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	await runEffortStackViaPasses(ast);
	const output = print(ast);
	const regressed = output.replace(
		"if (globalThis.__claudeCodeEffortSessionOverride === true) return;",
		"",
	);
	const result = effortStack.verify(regressed);
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("session override guard"), true);
});

test("effort-stack verify fails hard when /effort updates do not mark session override", async () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	await runEffortStackViaPasses(ast);
	const output = print(ast);
	const regressed = output.replaceAll(
		"globalThis.__claudeCodeEffortSessionOverride = true",
		"void 0",
	);
	const result = effortStack.verify(regressed);
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("session override state update"), true);
});

test("effort-stack verify fails hard when the picker still treats env choices as no-ops", async () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	await runEffortStackViaPasses(ast);
	const output = print(ast);
	const regressed = output.replace(
		" && !(process.env.CLAUDE_CODE_EFFORT_LEVEL !== void 0 && next !== current)",
		"",
	);
	const result = effortStack.verify(regressed);
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("no-ops"), true);
});

test("effort-stack verify fails closed when anchors are absent", () => {
	const drifted = `
function unrelated() {
  return "no ultracode here";
}
`;
	const ast = parse(drifted);
	const result = effortStack.verify(print(ast), ast);
	assert.equal(typeof result, "string");
});

test("effort-stack marks session override on the expression-body effortUpdate arrow", async () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	await runEffortStackViaPasses(ast);
	const output = print(ast);
	assert.match(
		output,
		/api\.setAppState\(\(A\) =>\s*\(globalThis\.__claudeCodeEffortSessionOverride = true,\s*A\.effortValue === _ && \(A\.ultracode \?\? !1\) === z \? A : \{ \.\.\.A, effortValue: _, ultracode: z \}\)/,
	);
});

test("effort-stack marks session override as first statement of the block-body effortUpdate arrow", async () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	await runEffortStackViaPasses(ast);
	const output = print(ast);
	assert.match(
		output,
		/setState\(\(A\) => \{\s*globalThis\.__claudeCodeEffortSessionOverride = true;\s*if \(A\.effortValue === _ && \(A\.ultracode \?\? !1\) === z\) return A;/,
	);
});

test("effort-stack injects the session-override assignment at exactly both effortUpdate sites", async () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	await runEffortStackViaPasses(ast);
	const output = print(ast);
	const occurrences =
		output.split("globalThis.__claudeCodeEffortSessionOverride = true").length -
		1;
	assert.equal(occurrences, 2);
});

test("effort-stack does not inject the session-only guard into a writer without a top-level unpin call", async () => {
	const NESTED_WRITER_FIXTURE = `
function nestedWriter(H) {
  if (H !== void 0) {
    let q = saveSettings("userSettings", { effortLevel: H });
    if (q.error) return q.error;
  }
  return;
}
`;
	const ast = parse(NESTED_WRITER_FIXTURE);
	await runEffortStackViaPasses(ast);
	const output = print(ast);
	assert.equal(
		output.includes("process.env.CLAUDE_CODE_EFFORT_LEVEL !== void 0"),
		false,
		"writer without a top-level unpin call must not receive the env-scoped session-only guard",
	);
});
