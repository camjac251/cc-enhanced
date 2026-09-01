import assert from "node:assert/strict";
import { test } from "node:test";
import type { File } from "@babel/types";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { tabQueue } from "./tab-queue.js";

async function runTabQueueViaPasses(ast: File): Promise<void> {
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
}

const LATEST_TAB_QUEUE_FIXTURE = `
function renderInput({ draft, turn, onSubmit, commandQueue, helpOpen = false }) {
  const {
    setValue,
    setCursorOffset,
    setMode,
    setPastedContents,
  } = draft;
  let editQueued;
  if (commandQueue) {
    editQueued = () => {
      const queued = commandQueue.popAllEditable(
        draft.value,
        draft.cursorOffset,
        draft.pastedContents,
      );
      if (!queued) return false;
      setValue(queued.text);
      setMode(queued.mode);
      setCursorOffset(queued.cursorOffset);
      setPastedContents(queued.pastedContents);
      return true;
    };
  }
  function footer(event) {
    return event;
  }
  function typeahead(event) {
    return event;
  }
  function beforeKey(event) {
    if (helpOpen) return;
    if ((footer(event), event.defaultPrevented || event.didStopImmediatePropagation())) return;
    if ((typeahead(event), event.defaultPrevented || event.didStopImmediatePropagation())) return;
    const activeLoading = turn.getSnapshot().isLoading;
    if (event.name === "escape") return;
  }
  const submitAlias = onSubmit;
  const inputProps = {
    multiline: true,
    onKeyDownBefore: beforeKey,
    onSubmit: submitAlias,
    onChange: setValue,
    value: draft.value,
    disableEscapeDoublePress: false,
    cursorOffset: draft.cursorOffset,
    onChangeCursorOffset: setCursorOffset,
    inputFilter: (value) => value,
  };
  return inputProps;
}
`;

async function patchFixture(source = LATEST_TAB_QUEUE_FIXTURE): Promise<{
	ast: File;
	output: string;
}> {
	const ast = parse(source);
	await runTabQueueViaPasses(ast);
	return { ast, output: print(ast) };
}

interface TabRuntimeInput {
	onKeyDownBefore(event: Record<string, unknown>): void;
}

interface TabRuntimeModule {
	renderInput(options: Record<string, unknown>): TabRuntimeInput;
}

function isTabRuntimeModule(value: unknown): value is TabRuntimeModule {
	return (
		typeof value === "object" &&
		value !== null &&
		"renderInput" in value &&
		typeof value.renderInput === "function"
	);
}

test("verify rejects an unpatched latest prompt input", () => {
	const ast = parse(LATEST_TAB_QUEUE_FIXTURE);
	assert.equal(typeof tabQueue.verify(print(ast), ast), "string");
});

test("tab-queue routes Tab through the native command queue", async () => {
	const { ast, output } = await patchFixture();

	assert.match(output, /event\.name === "tab"/);
	assert.match(output, /!event\.shift/);
	assert.match(output, /!event\.ctrl/);
	assert.match(output, /!event\.meta/);
	assert.match(output, /turn\.getSnapshot\(\)\.isLoading/);
	assert.match(output, /submitAlias\(draft\.value\)/);
	assert.match(output, /editQueued\(\)/);
	assert.doesNotMatch(output, /__ccEnhancedTabQueue/);
	assert.doesNotMatch(output, /deferUntilTurnEnd/);
	assert.equal(tabQueue.verify(output, ast), true);
});

test("tab-queue preserves built-in key-handler precedence", async () => {
	const { output } = await patchFixture();
	const footerIndex = output.indexOf("footer(event)");
	const typeaheadIndex = output.indexOf("typeahead(event)");
	const tabIndex = output.indexOf('event.name === "tab"');

	assert.ok(footerIndex >= 0);
	assert.ok(typeaheadIndex > footerIndex);
	assert.ok(tabIndex > typeaheadIndex);
});

test("tab-queue queues and edits through native callbacks", async () => {
	const { output } = await patchFixture();
	const evaluated: unknown = new Function(
		`${output}; return { renderInput };`,
	)();
	assert.ok(isTabRuntimeModule(evaluated));
	const runtime = evaluated;
	const submitted: string[] = [];
	const updates: Array<[string, unknown]> = [];
	const draft = {
		value: "ship it",
		cursorOffset: 7,
		pastedContents: {},
		setValue: (value: unknown) => updates.push(["value", value]),
		setCursorOffset: (value: unknown) => updates.push(["cursor", value]),
		setMode: (value: unknown) => updates.push(["mode", value]),
		setPastedContents: (value: unknown) => updates.push(["pasted", value]),
	};
	const commandQueue = {
		popAllEditable: () => ({
			text: "queued draft",
			mode: "prompt",
			cursorOffset: 12,
			pastedContents: { image: true },
		}),
	};
	const input = runtime.renderInput({
		draft,
		turn: { getSnapshot: () => ({ isLoading: true }) },
		onSubmit: (value: string) => submitted.push(value),
		commandQueue,
	});
	const busyEvent = {
		name: "tab",
		shift: false,
		ctrl: false,
		meta: false,
		defaultPrevented: false,
		didStopImmediatePropagation: () => false,
		preventDefault() {
			this.defaultPrevented = true;
		},
	};
	input.onKeyDownBefore(busyEvent);
	assert.deepEqual(submitted, ["ship it"]);
	assert.equal(busyEvent.defaultPrevented, true);

	draft.value = "";
	busyEvent.defaultPrevented = false;
	input.onKeyDownBefore(busyEvent);
	assert.deepEqual(updates, [
		["value", "queued draft"],
		["mode", "prompt"],
		["cursor", 12],
		["pasted", { image: true }],
	]);
	assert.equal(busyEvent.defaultPrevented, true);
});

test("tab-queue is idempotent", async () => {
	const ast = parse(LATEST_TAB_QUEUE_FIXTURE);
	await runTabQueueViaPasses(ast);
	const once = print(ast);
	await runTabQueueViaPasses(ast);
	const twice = print(ast);

	assert.equal(twice, once);
	assert.equal(tabQueue.verify(twice, ast), true);
});

test("tab-queue verify rejects a missing busy gate", async () => {
	const { output } = await patchFixture();
	const mutated = output.replace("turn.getSnapshot().isLoading &&", "true &&");
	assert.notEqual(mutated, output);
	assert.equal(typeof tabQueue.verify(mutated), "string");
});

test("tab-queue fails closed when prompt input targets are ambiguous", async () => {
	const second = LATEST_TAB_QUEUE_FIXTURE.replace(
		"function renderInput",
		"function renderSecondInput",
	);
	const { ast, output } = await patchFixture(
		`${LATEST_TAB_QUEUE_FIXTURE}\n${second}`,
	);

	assert.doesNotMatch(output, /submitAlias\(draft\.value\)/);
	assert.match(String(tabQueue.verify(output, ast)), /ambiguous|not found/);
});
