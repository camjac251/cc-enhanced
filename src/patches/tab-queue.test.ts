import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { tabQueue } from "./tab-queue.js";

const FIXTURE =
	'function renderInput(props) {\n const { draft, onSubmit: nativeSubmit, chordGestureSpent, suggestionsStore, historySearchKeyDown } = props;\n const { turn, commandQueue, notices, ghost } = props;\n const { setValue, setCursorOffset, setMode, setPastedContents } = { setValue: draft.setValue.bind(draft), setCursorOffset: draft.setCursorOffset.bind(draft), setMode: draft.setMode.bind(draft), setPastedContents: draft.setPastedContents.bind(draft) };\n const editQueued = () => {\n  const queued = commandQueue.popAllEditable(draft.value, draft.cursorOffset, draft.pastedContents);\n  if (!queued) return false;\n  setValue(queued.text); setMode(queued.mode); setCursorOffset(queued.cursorOffset); setPastedContents(queued.pastedContents);\n  return true;\n };\n function typeahead(key) {\n  if (key.name !== "tab" || key.shift) return;\n  if (suggestionsStore.getState().suggestions.length || ghost) { key.preventDefault(); return; }\n  if (draft.value.trim() === "") { key.preventDefault(); notices.push("thinking hint"); }\n }\n function beforeKey(key) {\n  if ((historySearchKeyDown(key), key.defaultPrevented || key.didStopImmediatePropagation())) return;\n  if ((typeahead(key), key.defaultPrevented || key.didStopImmediatePropagation())) return;\n  const loading = turn.getSnapshot().isLoading;\n  if (key.name === "escape") return;\n }\n const ordinarySubmit = (value) => { if (chordGestureSpent(value)) return; nativeSubmit(value === "" ? "" : draft.value); };\n return { onKeyDownBefore: beforeKey, onSubmit: ordinarySubmit, onChange: setValue, value: "display-only placeholder", disableEscapeDoublePress: false, inputFilter: (value) => value, inlineGhostText: ghost };\n}';

async function patch(source = FIXTURE) {
	const ast = parse(source);
	const passes = (await tabQueue.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: tabQueue.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
	return { ast, output: print(ast) };
}
function event(overrides: Record<string, unknown> = {}) {
	return {
		name: "tab",
		shift: false,
		ctrl: false,
		meta: false,
		superKey: false,
		defaultPrevented: false,
		preventDefault() {
			this.defaultPrevented = true;
		},
		didStopImmediatePropagation: () => false,
		...overrides,
	};
}
async function runtime(
	options: {
		text?: string;
		busy?: boolean;
		queued?: boolean;
		suggestions?: number;
		ghost?: string;
		history?: boolean;
		spent?: boolean;
	} = {},
) {
	const { output } = await patch();
	const render = new Function(`${output}; return renderInput;`)();
	const calls: unknown[][] = [];
	const notices: string[] = [];
	const draft = {
		value: options.text ?? "draft text",
		cursorOffset: 4,
		pastedContents: { image: "kept" },
		setValue(value: string) {
			this.value = value;
		},
		setCursorOffset(value: number) {
			this.cursorOffset = value;
		},
		setMode(value: string) {
			calls.push(["mode", value]);
		},
		setPastedContents(value: unknown) {
			calls.push(["pastes", value]);
		},
	};
	let editable = options.queued ?? false;
	const input = render({
		draft,
		turn: { getSnapshot: () => ({ isLoading: options.busy ?? true }) },
		onSubmit: (...args: unknown[]) => calls.push(args),
		chordGestureSpent: () => options.spent ?? false,
		suggestionsStore: {
			getState: () => ({
				suggestions: Array(options.suggestions ?? 0).fill("completion"),
			}),
		},
		historySearchKeyDown: (key: ReturnType<typeof event>) => {
			if (options.history) key.preventDefault();
		},
		ghost: options.ghost ?? "",
		commandQueue: {
			popAllEditable: () => {
				if (!editable) return null;
				editable = false;
				return {
					text: "queued text",
					mode: "prompt",
					cursorOffset: 11,
					pastedContents: { image: "restored" },
				};
			},
		},
		notices,
	});
	return { input, calls, notices, draft, hasEditable: () => editable };
}
test("busy Tab uses native deferred submission with the real draft", async () => {
	const state = await runtime();
	const key = event();
	state.input.onKeyDownBefore(key);
	assert.deepEqual(state.calls, [["draft text", true, undefined, true]]);
	assert.equal(key.defaultPrevented, true);
});
test("empty Tab restores queued draft before the upstream hint", async () => {
	const state = await runtime({ text: "", queued: true });
	state.input.onKeyDownBefore(event());
	assert.equal(state.draft.value, "queued text");
	assert.equal(state.draft.cursorOffset, 11);
	assert.deepEqual(state.calls, [
		["mode", "prompt"],
		["pastes", { image: "restored" }],
	]);
	assert.deepEqual(state.notices, []);
	assert.equal(state.hasEditable(), false);
});
test("empty Tab without an editable item preserves the stock hint", async () => {
	const state = await runtime({ text: "" });
	state.input.onKeyDownBefore(event());
	assert.deepEqual(state.notices, ["thinking hint"]);
	assert.deepEqual(state.calls, []);
});
test("history search and completion retain priority over queue editing", async () => {
	for (const options of [
		{ history: true },
		{ suggestions: 1 },
		{ ghost: "suggested" },
	]) {
		const state = await runtime({ text: "", queued: true, ...options });
		state.input.onKeyDownBefore(event());
		assert.equal(state.hasEditable(), true);
		assert.deepEqual(state.calls, []);
	}
});
test("idle and modified Tab do not submit a draft", async () => {
	const idle = await runtime({ busy: false });
	const idleKey = event();
	idle.input.onKeyDownBefore(idleKey);
	assert.deepEqual(idle.calls, []);
	assert.equal(idleKey.defaultPrevented, false);
	for (const modifier of ["shift", "ctrl", "meta", "superKey"]) {
		const state = await runtime();
		const key = event({ [modifier]: true });
		state.input.onKeyDownBefore(key);
		assert.deepEqual(state.calls, [], modifier);
		assert.equal(key.defaultPrevented, false, modifier);
	}
});
test("a spent chord gesture cannot submit a duplicate queued draft", async () => {
	const state = await runtime({ spent: true });
	state.input.onKeyDownBefore(event());
	assert.deepEqual(state.calls, []);
});
test("verification rejects missing, inverted, and misplaced queue behavior", async () => {
	assert.equal(typeof tabQueue.verify(FIXTURE, parse(FIXTURE)), "string");
	const { output, ast } = await patch();
	assert.equal(tabQueue.verify(output, ast), true);
	const inverted = output.replace(
		/(turn\.getSnapshot\(\)\.isLoading)(?= &&)/,
		"!$1",
	);
	assert.notEqual(inverted, output);
	assert.equal(typeof tabQueue.verify(inverted, parse(inverted)), "string");
	const lostIntent = output.replace(
		/nativeSubmit\(draft\.value, true, void 0, true\)/,
		"nativeSubmit(draft.value)",
	);
	assert.notEqual(lostIntent, output);
	assert.equal(typeof tabQueue.verify(lostIntent, parse(lostIntent)), "string");
	const shifted = output.replace(/!key\.superKey/, "true");
	assert.equal(typeof tabQueue.verify(shifted, parse(shifted)), "string");
});
test("queue patch is idempotent and fails on ambiguous native owners", async () => {
	const first = await patch();
	const second = await patch(first.output);
	assert.equal(second.output, first.output);
	const ambiguous = await patch(
		FIXTURE + FIXTURE.replaceAll("renderInput", "renderOtherInput"),
	);
	assert.equal(
		typeof tabQueue.verify(ambiguous.output, ambiguous.ast),
		"string",
	);
});
