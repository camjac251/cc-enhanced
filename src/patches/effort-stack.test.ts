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

function readUltracodeFlag(e) {
  let enabled = settings().ultracode === !0 || parseEffortAlias(e) === "ultracode";
  if (enabled) unpinLaunchEffort();
  return enabled;
}

function ultracodeAvailable(model) {
  return workflowsEnabled() && (model === void 0 || (supportsUltracode(model) && supportsEffort("xhigh", model)));
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

function storeEffortSetting(H, persist = true, scope) {
  let parsed = H !== void 0 ? parsePersistedEffort(H) : void 0;
  if (persist && (H === void 0 || parsed !== void 0) && !remoteActive()) {
    let result = saveSettings("userSettings", { effortLevel: parsed }, void 0, scope);
    if (result.error) return result.error;
  }
  if (persist) unpinLaunchEffort();
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

function clearEffort(cleared) {
  let envEffort = readEnvEffort();
  if (envEffort !== void 0 && envEffort !== null)
    return {
      message: \`\${cleared ? "Cleared effort from settings, but" : "Effort set to auto for this session, but"} CLAUDE_CODE_EFFORT_LEVEL=\${process.env.CLAUDE_CODE_EFFORT_LEVEL} still controls this session\`,
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

async function runEffortCommand(H, setState, done) {
  let didOptimisticUpdate = !1,
    previous = null,
    result = await pickCommand(H, (update) => {
      didOptimisticUpdate = !0;
      let nextUltracode = update.ultracode ?? !1;
      setState((current) => {
        if (
          ((previous ??= { value: current.effortValue, ultracode: current.ultracode ?? !1 }),
          current.effortValue === update.value && (current.ultracode ?? !1) === nextUltracode)
        )
          return current;
        return { ...current, effortValue: update.value, ultracode: nextUltracode };
      });
    });
  if (didOptimisticUpdate && !result.effortUpdate)
    setState((current) => {
      if (previous === null) return current;
      if (current.effortValue === previous.value && (current.ultracode ?? !1) === previous.ultracode) return current;
      return { ...current, effortValue: previous.value, ultracode: previous.ultracode };
    });
  done(result.message);
  return result;
}
`;

const SESSION_OVERRIDE_CHARACTERIZATION_FIXTURE = `
function readEnvEffort() {
  let raw = process.env.CLAUDE_CODE_EFFORT_LEVEL;
  return parseEffort(raw);
}

function storeEffortSetting(value, persist = true, scope) {
  if (persist) {
    let result = saveSettings("userSettings", { effortLevel: value });
    if (result.error) return result.error;
  }
  if (persist) unpinLaunchEffort();
  return;
}

async function runEffortCommand(input, setState) {
  let result = await pickCommand(input, (update) => setState(update));
  if (didOptimisticUpdate && !result.effortUpdate) rollbackState();
  return result;
}

function effortWouldChange(next, current, model) {
  if (resolveEffectiveEffort(model, next) === resolveEffectiveEffort(model, current)) return !1;
  return !0;
}

function nearMissEnvResolver(unused) {
  let raw = process.env.CLAUDE_CODE_EFFORT_LEVEL;
  return parseEffort(raw);
}

function nearMissSettingsWriter(value, persist, scope) {
  let result = saveSettings("userSettings", { effortLevel: value });
  if (result.error) return result.error;
}

async function nearMissResultUpdate(input) {
  let result = await pickCommand(input, (update) => update);
  return result;
}

function nearMissEffectiveNoop(next, current, model) {
  if (resolveEffectiveEffort(model, next) === otherEffectiveEffort(model, current)) return !1;
  return !0;
}
`;

const SESSION_OVERRIDE_CHARACTERIZATION_EXPECTED = `
function readEnvEffort() {if (globalThis.__claudeCodeEffortSessionOverride === true) return;
  let raw = process.env.CLAUDE_CODE_EFFORT_LEVEL;
  return parseEffort(raw);
}

function storeEffortSetting(value, persist = true, scope) {if (process.env.CLAUDE_CODE_EFFORT_LEVEL !== void 0) {




    if (persist) unpinLaunchEffort();return;}if (persist) {let result = saveSettings("userSettings", { effortLevel: value });if (result.error) return result.error;}if (persist) unpinLaunchEffort();
  return;
}

async function runEffortCommand(input, setState) {
  let result = await pickCommand(input, (update) => setState(update));if (result.effortUpdate) globalThis.__claudeCodeEffortSessionOverride = true;
  if (didOptimisticUpdate && !result.effortUpdate) rollbackState();
  return result;
}

function effortWouldChange(next, current, model) {
  if (resolveEffectiveEffort(model, next) === resolveEffectiveEffort(model, current) && !(process.env.CLAUDE_CODE_EFFORT_LEVEL !== void 0 && next !== current)) return !1;
  return !0;
}

function nearMissEnvResolver(unused) {
  let raw = process.env.CLAUDE_CODE_EFFORT_LEVEL;
  return parseEffort(raw);
}

function nearMissSettingsWriter(value, persist, scope) {
  let result = saveSettings("userSettings", { effortLevel: value });
  if (result.error) return result.error;
}

async function nearMissResultUpdate(input) {
  let result = await pickCommand(input, (update) => update);
  return result;
}

function nearMissEffectiveNoop(next, current, model) {
  if (resolveEffectiveEffort(model, next) === otherEffectiveEffort(model, current)) return !1;
  return !0;
}
`;

test("effort-stack characterizes the public session-override subsystem", async () => {
	const focusedAst = parse(SESSION_OVERRIDE_CHARACTERIZATION_FIXTURE);
	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (...args: unknown[]) =>
		warnings.push(args.map(String).join(" "));
	try {
		await runEffortStackViaPasses(focusedAst);
	} finally {
		console.warn = originalWarn;
	}
	const focusedOutput = print(focusedAst);
	assert.equal(
		focusedOutput,
		SESSION_OVERRIDE_CHARACTERIZATION_EXPECTED.trimEnd(),
	);
	assert.deepEqual(warnings, [
		"effort-stack: Could not find ultracode-forces-xhigh resolver guard",
		"effort-stack: Could not find ultrathink notification text",
		"effort-stack: Could not find ultracode-picker override message",
		"effort-stack: Could not find effort-picker override message",
		"effort-stack: Could not find current-effort display function",
		"effort-stack: Could not find ultracode description template",
		"effort-stack: Could not find ultracode active-state gate",
		"effort-stack: Could not find ultracode settings/env source",
	]);

	const repeatWarnings: string[] = [];
	console.warn = (...args: unknown[]) =>
		repeatWarnings.push(args.map(String).join(" "));
	try {
		await runEffortStackViaPasses(focusedAst);
	} finally {
		console.warn = originalWarn;
	}
	assert.equal(print(focusedAst), focusedOutput);
	assert.deepEqual(repeatWarnings, warnings);

	const fullAst = parse(EFFORT_STACK_FIXTURE);
	await runEffortStackViaPasses(fullAst);
	const fullOutput = print(fullAst);
	assert.equal(effortStack.verify(fullOutput, fullAst), true);

	const regressions = [
		{
			code: fullOutput.replace(
				"if (globalThis.__claudeCodeEffortSessionOverride === true) return;",
				"",
			),
			diagnostic: "Did not find session override guard in env effort resolver",
		},
		{
			code: fullOutput.replace(
				/if \(process\.env\.CLAUDE_CODE_EFFORT_LEVEL !== void 0\) \{\s+if \(persist\) unpinLaunchEffort\(\);\s*return;\s*\}/,
				"",
			),
			diagnostic: "Did not find env-scoped session-only effort settings guard",
		},
		{
			code: fullOutput.replace(
				"if (result.effortUpdate) globalThis.__claudeCodeEffortSessionOverride = true;",
				"",
			),
			diagnostic: "Did not find /effort session override state update",
		},
		{
			code: fullOutput.replace(
				" && !(process.env.CLAUDE_CODE_EFFORT_LEVEL !== void 0 && next !== current)",
				"",
			),
			diagnostic: "Effort picker still treats env-overridden choices as no-ops",
		},
	] as const;
	for (const { code, diagnostic } of regressions) {
		assert.notEqual(code, fullOutput);
		assert.equal(effortStack.verify(code), diagnostic);
	}

	const allRegressed = fullOutput
		.replace(
			"if (globalThis.__claudeCodeEffortSessionOverride === true) return;",
			"",
		)
		.replace(
			/if \(process\.env\.CLAUDE_CODE_EFFORT_LEVEL !== void 0\) \{\s+if \(persist\) unpinLaunchEffort\(\);\s*return;\s*\}/,
			"",
		)
		.replace(
			"if (result.effortUpdate) globalThis.__claudeCodeEffortSessionOverride = true;",
			"",
		)
		.replace(
			" && !(process.env.CLAUDE_CODE_EFFORT_LEVEL !== void 0 && next !== current)",
			"",
		);
	assert.equal(
		effortStack.verify(allRegressed),
		"Did not find session override guard in env effort resolver",
	);
});

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
			'let enabled = settings().ultracode === !0 || parseEffortAlias(e) === "ultracode" || ["1", "true", "yes", "on"].includes(String(process.env.CLAUDE_CODE_ULTRACODE).toLowerCase())',
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

test("effort-stack rewrites the ultracode command effortUpdate value to stack max", async () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	await runEffortStackViaPasses(ast);
	const output = print(ast);
	// The ultracode command's effortUpdate.value carries the env-stacking
	// conditional so selecting ultracode while CLAUDE_CODE_EFFORT_LEVEL=max
	// resolves to max.
	assert.match(
		output,
		/effortUpdate: \{ value: \w+ === "max" \? "max" : "xhigh", ultracode: !0 \}/,
	);
});

test("effort-stack verify rejects a command effortUpdate value that lost the max stacking", async () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	await runEffortStackViaPasses(ast);
	const patched = print(ast);
	// Regress only the command effortUpdate.value back to a plain literal while
	// leaving the stacked message intact, mimicking the value mutation silently
	// no-oping while the message rewrite still lands. verify() must catch it.
	const regressed = patched.replace(
		/effortUpdate: \{ value: \w+ === "max" \? "max" : "xhigh", ultracode: !0 \}/g,
		'effortUpdate: { value: "xhigh", ultracode: !0 }',
	);
	assert.notEqual(regressed, patched, "regression replacement must apply");
	const regressedAst = parse(regressed);
	const result = effortStack.verify(regressed, regressedAst);
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("effortUpdate value"), true);
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
	// The auto/unset override message (3-quasi ternary) is reframed too, not just
	// the command/session-only forms; its trailing quasi becomes the launch-default
	// wording so both ternary branches read correctly.
	assert.equal(
		output.includes(
			"CLAUDE_CODE_EFFORT_LEVEL=${process.env.CLAUDE_CODE_EFFORT_LEVEL} remains the launch default for new sessions.",
		),
		true,
		"auto/unset env override message should be rewritten to launch-default framing",
	);
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
			'String(process.env.CLAUDE_CODE_EFFORT_LEVEL).toLowerCase() === "max" ? `${ULTRACODE_ICON} ultracode \\u00b7 max effort + dynamic workflows for maximum thoroughness` : `${ULTRACODE_ICON} ultracode \\u00b7 xhigh effort + dynamic workflows for maximum thoroughness`',
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
		output.includes(
			'saveSettings("userSettings", { effortLevel: parsed }, void 0, scope)',
		),
		true,
	);
	assert.equal(output.includes("if (persist) unpinLaunchEffort();"), true);
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
		'settings().ultracode === !0 || parseEffortAlias(e) === "ultracode" || ["1", "true", "yes", "on"].includes(String(process.env.CLAUDE_CODE_ULTRACODE).toLowerCase())',
		'settings().ultracode === !0 || parseEffortAlias(e) === "ultracode"',
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

test("effort-stack marks session override after a successful effort update", async () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	await runEffortStackViaPasses(ast);
	const output = print(ast);
	assert.match(
		output,
		/if \(result\.effortUpdate\) globalThis\.__claudeCodeEffortSessionOverride = true;/,
	);
});

test("effort-stack leaves rollback state updates unmarked", async () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	await runEffortStackViaPasses(ast);
	const output = print(ast);
	assert.doesNotMatch(output, /previous\.ultracode\);\s*globalThis/);
});

test("effort-stack injects the session-override assignment at the result boundary", async () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	await runEffortStackViaPasses(ast);
	const output = print(ast);
	const occurrences =
		output.split("globalThis.__claudeCodeEffortSessionOverride = true").length -
		1;
	assert.equal(occurrences, 1);
});

test("effort-stack guards the current three-parameter settings writer", async () => {
	const ast = parse(EFFORT_STACK_FIXTURE);
	await runEffortStackViaPasses(ast);
	const output = print(ast);

	assert.match(
		output,
		/if \(process\.env\.CLAUDE_CODE_EFFORT_LEVEL !== void 0\)/,
	);
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
