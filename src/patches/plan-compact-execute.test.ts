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
    if (HH !== "no" && !wH) {
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
	assert.equal(output.includes("compactContext"), true);
	assert.equal(output.includes("plan-compact-execute-failed"), true);
	assert.equal(output.includes("__ccEnhancedPlanCompactCommand"), true);
	assert.equal(output.includes("compactionResult"), true);
	assert.equal(output.includes("messagesToKeep ?? []"), true);
	assert.equal(output.includes("visibleOptionCount: N.length"), true);
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
