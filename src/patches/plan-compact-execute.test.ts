import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { planCompactExecute } from "./plan-compact-execute.js";

const COMPACT_AUTO_VALUE_FOR_TEST = "yes-compact-auto";
const COMPACT_ACCEPT_FOR_TEST = "yes-compact-accept-edits";

async function runPlanCompactExecuteViaPasses(ast: any): Promise<void> {
	const passes = (await planCompactExecute.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: planCompactExecute.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

const PLAN_COMPACT_EXECUTE_FIXTURE = `
function mW5({
  showClearContext: H,
  showUltraplan: $,
  usedPercent: q,
  isAutoModeAvailable: K,
  isBypassPermissionsModeAvailable: _,
  onFeedbackChange: A,
}) {
  let z = [],
    Y = q !== null ? \` (\${q}% used)\` : "";
  if (H)
    if (_)
      z.push({
        label: \`Yes, clear context\${Y} and bypass permissions\`,
        value: "yes-bypass-permissions",
      });
    else if (K)
      z.push({
        label: \`Yes, clear context\${Y} and use auto mode\`,
        value: "yes-auto-clear-context",
      });
    else
      z.push({ label: \`Yes, clear context\${Y} and auto-accept edits\`, value: "yes-accept-edits" });
  if (_) z.push({ label: "Yes, and bypass permissions", value: "yes-accept-edits-keep-context" });
  else if (K) z.push({ label: "Yes, and use auto mode", value: "yes-resume-auto-mode" });
  else z.push({ label: "Yes, auto-accept edits", value: "yes-accept-edits-keep-context" });
  if ((z.push({ label: "Yes, manually approve edits", value: "yes-default-keep-context" }), $))
    z.push({ label: "No, refine with Ultraplan on Claude Code on the web", value: "ultraplan" });
  return (
    z.push({
      type: "input",
      label: "No, keep planning",
      value: "no",
      placeholder: "Tell Claude what to change",
      description: "shift+tab to approve with this feedback",
      onChange: A,
    }),
    z
  );
}

function UP4({ toolUseConfirm: H, setStickyFooter: _ }) {
  let N = [],
    D = {},
    I = () => {},
    S = () => {},
    Q = "plan body",
    O = "",
    m = [];
  async function r(HH) {
    let KH = O.trim(),
      qH = KH || void 0,
      zH = {};
    let wH =
      HH === "yes-accept-edits-keep-context" ||
      HH === "yes-default-keep-context" ||
      HH === "yes-resume-auto-mode";
    if (HH !== "no") uW5(Q, z, !wH);
    if (
      Ny &&
      (HH === "yes-bypass-permissions" ||
        HH === "yes-accept-edits" ||
        HH === "yes-auto-clear-context")
    ) {
      let GH = "default";
      if (HH === "yes-bypass-permissions") GH = "bypassPermissions";
      else if (HH === "yes-accept-edits") GH = "acceptEdits";
      else if (HH === "yes-auto-clear-context" && Th()) ((GH = "auto"), lnH?.setAutoModeActive(!0));
      (d("tengu_plan_exit", {
        planLengthChars: Q.length,
        outcome: HH,
        clearContext: !0,
        hasFeedback: !!qH,
      }),
        Fo({ from: "plan", to: GH, trigger: "exit_plan_mode" }));
      let vH = "",
        gH = "",
        FH = "",
        cH = "";
      (z((D$) => ({
        ...D$,
        initialMessage: {
          message: {
            ...$8({
              content: \`Implement the following plan:

\${Q}\${vH}\${gH}\${FH}\${cH}\`,
            }),
            planContent: Q,
          },
          clearContext: !0,
          mode: GH,
          allowedPrompts: m,
        },
      })),
        H.onReject());
      return;
    }
  }
  let o = { current: () => {} };
  _(
    P4.default.createElement(R8, {
      options: N,
      onChange: (HH) => void r(HH),
      onCancel: () => o.current?.(),
      onImagePaste: I,
      pastedContents: D,
      onRemoveImage: S,
    }),
  );
  return P4.default.createElement(R8, {
    options: N,
    onChange: r,
    onCancel: () => o.current?.(),
    onImagePaste: I,
    pastedContents: D,
    onRemoveImage: S,
  });
}

function MainRepl({ initialMessage: l }) {
  let [D4, HW] = s$.useState([]),
    A1 = s$.useRef(D4),
    Y7 = [],
    ZH = "model",
    X$ = () => {},
    qH = () => {},
    wH = { getState: () => ({}) },
    y4 = (updater) => {
      A1.current = typeof updater === "function" ? updater(A1.current) : updater;
      HW(A1.current);
    },
    CJ = (messages, allowedCommands, abortController, mainLoopModel) => ({
      abortController,
      options: { commands: Y7, mainLoopModel },
      messages,
      setMessages: y4,
      addNotification: X$,
      getAppState: () => wH.getState(),
      setAppState: qH,
    }),
    jm = () => {};
  s$.useEffect(() => {
    let _$ = l;
    if (!_$) return;
    async function i$(K8) {
      if (K8.clearContext) {
        let AK = K8.message.planContent ? HpH() : void 0,
          { clearConversation: wq } = await Promise.resolve().then(() => Gc7);
        if (
          (await wq({
            setMessages: y4,
            getAppState: () => wH.getState(),
            setAppState: qH,
          }),
          AK)
        )
          p16(E$(), AK);
      }
      let Q6 = K8.message.planContent && !1;
      qH((AK) => ({
        ...AK,
        initialMessage: null,
        ...(Q6 && { pendingPlanVerification: { plan: K8.message.planContent } }),
      }));
      await wZ();
      let Lq = K8.message.message.content;
      if (typeof Lq === "string" && !K8.message.planContent)
        GC(Lq, { setCursorOffset: () => {}, clearBuffer: () => {}, resetHistory: () => {} });
      else {
        let AK = r7();
        (v9(AK), jm([K8.message], AK, !0, [], ZH));
      }
    }
    i$(_$);
  }, [l, y4, qH, jm, ZH]);
  let GC = s$.useCallback(
    async (_$, i$, K8, Q6) => {
      await ew8({
        input: _$,
        helpers: i$,
        commands: Y7,
        getToolUseContext: CJ,
        messages: A1.current,
        mainLoopModel: Q6?.modelOverride ?? ZH,
        addNotification: X$,
        setMessages: y4,
        onQuery: jm,
      });
    },
    [Y7, CJ, ZH, X$, y4, jm],
  );
  return GC;
}
`;

test("verify rejects unpatched plan compact execute code", () => {
	const ast = parse(PLAN_COMPACT_EXECUTE_FIXTURE);
	const code = print(ast);
	const result = planCompactExecute.verify(code, ast);
	assert.notEqual(result, true);
	assert.equal(typeof result, "string");
});

test("plan-compact-execute adds non-bypass compact options and handler", async () => {
	const ast = parse(PLAN_COMPACT_EXECUTE_FIXTURE);
	await runPlanCompactExecuteViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes(`value: "${COMPACT_AUTO_VALUE_FOR_TEST}"`),
		true,
	);
	assert.equal(output.includes(`value: "${COMPACT_ACCEPT_FOR_TEST}"`), true);
	assert.equal(output.includes("yes-compact-bypass"), false);
	assert.match(output, /Yes, compact context[^"`]*and use auto mode/);
	assert.match(output, /Yes, compact context[^"`]*and auto-accept edits/);
	assert.equal(output.includes("compactContext"), true);
	assert.equal(output.includes("plan-compact-execute-failed"), true);
	assert.equal(output.includes("__ccEnhancedPlanCompactCommand"), true);
	assert.equal(output.includes("compactionResult"), true);
	assert.equal(output.includes("messagesToKeep ?? []"), true);
	assert.match(output, /visibleOptionCount:\s*\w+\.length/);
	assert.equal(output.includes("clearContext: !0"), false);

	assert.equal(planCompactExecute.verify(output), true);
});

test("plan-compact-execute is idempotent", async () => {
	const ast = parse(PLAN_COMPACT_EXECUTE_FIXTURE);
	await runPlanCompactExecuteViaPasses(ast);
	const once = print(ast);

	await runPlanCompactExecuteViaPasses(ast);
	const twice = print(ast);

	assert.equal(twice, once);
	assert.equal(planCompactExecute.verify(twice), true);
});

test("plan-compact-execute extends restrictive plan gate to accept compact values", async () => {
	const ast = parse(PLAN_COMPACT_EXECUTE_FIXTURE);
	await runPlanCompactExecuteViaPasses(ast);
	const output = print(ast);

	// The outer plan-exit handoff gate must include === comparisons against
	// both compact selection values. If upstream restricts the gate to an
	// allowlist (bypass/accept-edits/auto-clear-context) and we do not extend
	// it, the inserted compact branches are unreachable and pressing the
	// compact option silently does nothing.
	const gateMatch = output.match(
		/if\s*\(([\s\S]*?)\)\s*\{\s*let\s+\w+\s*=\s*"default"/,
	);
	assert.ok(gateMatch, "outer plan-exit gate not found in patched output");
	const gateTest = gateMatch[1];
	assert.ok(
		gateTest.includes('=== "yes-compact-auto"'),
		`gate test must include yes-compact-auto comparison, got: ${gateTest}`,
	);
	assert.ok(
		gateTest.includes('=== "yes-compact-accept-edits"'),
		`gate test must include yes-compact-accept-edits comparison, got: ${gateTest}`,
	);
});

test("plan-compact-execute verify rejects restrictive gate without compact values", async () => {
	const ast = parse(PLAN_COMPACT_EXECUTE_FIXTURE);
	await runPlanCompactExecuteViaPasses(ast);
	const output = print(ast);
	// Simulate a regression where the gate was tightened but the patch failed
	// to extend it (e.g. the OR-chain matcher missed a future upstream shape).
	const regressed = output
		.replace(' || HH === "yes-compact-auto"', "")
		.replace(' || HH === "yes-compact-accept-edits"', "");

	const result = planCompactExecute.verify(regressed);

	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("Plan execution gate restricts"), true);
});

test("plan-compact-execute verify rejects missing messagesToKeep fallback", async () => {
	const ast = parse(PLAN_COMPACT_EXECUTE_FIXTURE);
	await runPlanCompactExecuteViaPasses(ast);
	const output = print(ast);
	const regressed = output.replace(" ?? []", "");

	const result = planCompactExecute.verify(regressed);

	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("messagesToKeep"), true);
});

test("plan-compact-execute verify fails closed when plan anchors are absent", () => {
	const drifted = `
function unrelated() {
  return "Ready to code?";
}
`;
	const ast = parse(drifted);
	const result = planCompactExecute.verify(print(ast), ast);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("Compact auto-mode plan approval option not found"),
		true,
	);
});

test("plan-compact-execute verify rejects selector whose visibleOptionCount is not options.length", async () => {
	const ast = parse(PLAN_COMPACT_EXECUTE_FIXTURE);
	await runPlanCompactExecuteViaPasses(ast);
	const output = print(ast);
	// Replace the injected `visibleOptionCount: <ident>.length` with a literal,
	// simulating an upstream selector that pins a fixed count. verify() must
	// fail closed because not every matched selector tracks options.length.
	const regressed = output.replace(
		/visibleOptionCount:\s*\w+\.length/,
		"visibleOptionCount: 10",
	);
	assert.notEqual(
		regressed,
		output,
		"precondition: visibleOptionCount:X.length present to rewrite",
	);
	const result = planCompactExecute.verify(regressed);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes("visibleOptionCount does not track options.length"),
		true,
	);
});

test("plan-compact-execute compact-option split gates on auto-mode availability, not the visibility guard", async () => {
	const ast = parse(PLAN_COMPACT_EXECUTE_FIXTURE);
	await runPlanCompactExecuteViaPasses(ast);
	const output = print(ast);
	// The option builder wraps the compact split under the show-clear-context
	// guard (H). The inner split must gate on the auto-mode availability param
	// (K), not re-test H. If it re-tested H the else branch (accept-edits)
	// would be unreachable and the auto option would be offered even when auto
	// mode is unavailable.
	assert.doesNotMatch(
		output,
		/if\s*\(H\)\s*if\s*\(H\)/,
		"compact split must not duplicate the show-clear-context guard",
	);
	assert.match(
		output,
		/if\s*\(H\)\s*if\s*\(K\)/,
		"compact split must gate on the auto-mode availability param",
	);
	assert.equal(planCompactExecute.verify(output), true);
});

test("plan-compact-execute verify rejects a compact split that duplicates the visibility guard", async () => {
	const ast = parse(PLAN_COMPACT_EXECUTE_FIXTURE);
	await runPlanCompactExecuteViaPasses(ast);
	const output = print(ast);
	// Regress the split so the inner guard re-tests the show-clear-context
	// guard (H) instead of the availability param (K). That is the unreachable
	// shape the matcher must not produce: the accept-edits option can never be
	// offered because its else branch is dead.
	const regressed = output.replace(/if\s*\(H\)\s*if\s*\(K\)/, "if (H) if (H)");
	assert.notEqual(
		regressed,
		output,
		"precondition: compact split rewritten to duplicate the guard",
	);
	const result = planCompactExecute.verify(regressed);
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("unreachable"), true);
});

test("plan-compact-execute handler reads messages ref via .current", async () => {
	const ast = parse(PLAN_COMPACT_EXECUTE_FIXTURE);
	await runPlanCompactExecuteViaPasses(ast);
	const output = print(ast);
	// The injected compact command call passes `<messagesRef>.current` into the
	// tool-use-context builder. If discovery ever stops requiring the `.current`
	// member on the messages key, this dereference would be missing.
	assert.match(
		output,
		/\w+\.current,\s*\[\],\s*new AbortController\(\)/,
		"handler must dereference the messages ref via .current",
	);
	assert.equal(planCompactExecute.verify(output), true);
});

test("plan-compact-execute compact-auto branch keeps the auto-mode runtime guard", async () => {
	const ast = parse(PLAN_COMPACT_EXECUTE_FIXTURE);
	await runPlanCompactExecuteViaPasses(ast);
	const output = print(ast);
	// Fixture's upstream auto branch is `HH === "yes-auto-clear-context" && Th()`.
	// The injected compact-auto branch must be a conjunction of the compact
	// value comparison AND the same runtime guard (Th()), not a bare equality.
	assert.match(
		output,
		/===\s*"yes-compact-auto"\s*&&\s*Th\(\)/,
		"compact-auto branch must preserve the && Th() runtime guard",
	);
	assert.equal(planCompactExecute.verify(output), true);
});

test("plan-compact-execute injects visibleOptionCount into every predicate-matching selector (multi-selector all-or-nothing)", async () => {
	// The real bundle has more than one selector matching the predicate, and the
	// verifier requires EVERY match to carry visibleOptionCount: options.length.
	// A third selector in its own function exercises the all-or-nothing coupling
	// so a regression where one matched selector is not injected fails here
	// instead of only against the live bundle.
	const extra = `
function OtherSelector({ opts }) {
  let pe = opts;
  return P4.default.createElement(R8, {
    options: pe,
    onChange: () => {},
    onCancel: () => {},
    onImagePaste: () => {},
    pastedContents: {},
    onRemoveImage: () => {},
  });
}
`;
	const ast = parse(PLAN_COMPACT_EXECUTE_FIXTURE + extra);
	await runPlanCompactExecuteViaPasses(ast);
	const output = print(ast);
	const matches = output.match(/visibleOptionCount:\s*\w+\.length/g) ?? [];
	assert.ok(
		matches.length >= 2,
		`every predicate-matching selector must get visibleOptionCount:<ident>.length, found ${matches.length}`,
	);
	assert.equal(planCompactExecute.verify(output), true);
});

test("plan-compact-execute compactContext value gates on both compact selection values", async () => {
	// verify() only checks compactContext presence, so a regression emitting
	// compactContext: void 0 (compaction never triggers) would still pass. Pin
	// the injected value to reference both compact selection values.
	const ast = parse(PLAN_COMPACT_EXECUTE_FIXTURE);
	await runPlanCompactExecuteViaPasses(ast);
	const output = print(ast);
	const m = output.match(/compactContext:\s*([^,]*?(?:\|\|[^,]*?)*?)(?:,|\n)/);
	assert.ok(m, "compactContext property not found in patched output");
	assert.ok(
		m[1].includes('"yes-compact-auto"') &&
			m[1].includes('"yes-compact-accept-edits"'),
		`compactContext value must reference both compact selection values, got: ${m[1]}`,
	);
});

test("plan-compact-execute accept-edits compact branch sets mode to acceptEdits", async () => {
	// The accept-edits runtime effect is the point of the second compact option,
	// but no other test asserts the spliced branch assigns the mode variable to
	// "acceptEdits" when the selection equals yes-compact-accept-edits.
	const ast = parse(PLAN_COMPACT_EXECUTE_FIXTURE);
	await runPlanCompactExecuteViaPasses(ast);
	const output = print(ast);
	assert.match(
		output,
		/===\s*"yes-compact-accept-edits"\)\s*\w+\s*=\s*"acceptEdits"/,
		"compact-accept branch must assign the mode variable to 'acceptEdits'",
	);
	assert.equal(planCompactExecute.verify(output), true);
});

test("plan-compact-execute inserts compact handler before reading message content", async () => {
	// The compact try/catch block is spliced at the index of the message content
	// var-decl so compaction runs before the plan executes. Pin the ordering so
	// an insertion-index regression (block lands after the content read) fails.
	const ast = parse(PLAN_COMPACT_EXECUTE_FIXTURE);
	await runPlanCompactExecuteViaPasses(ast);
	const output = print(ast);
	const handlerIdx = output.indexOf("__ccEnhancedPlanCompactCommand");
	const contentReadIdx = output.search(/=\s*\w+\.message\.message\.content/);
	assert.ok(handlerIdx >= 0, "compact handler not injected");
	assert.ok(contentReadIdx >= 0, "message content read not found");
	assert.ok(
		handlerIdx < contentReadIdx,
		"compact handler must be spliced before the message content read",
	);
});
