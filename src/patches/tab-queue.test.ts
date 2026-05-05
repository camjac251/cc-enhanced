import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { tabQueue } from "./tab-queue.js";

async function runTabQueueViaPasses(ast: any): Promise<void> {
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

function countOccurrences(value: string, needle: RegExp): number {
	return value.match(needle)?.length ?? 0;
}

const TAB_QUEUE_FIXTURE = `
function renderInput({ input, isLoading, suggestions, helpOpen, submitPrompt }) {
  function submit(value, isSubmittingSlashCommand = false) {
    return submitPrompt(value, {
      setCursorOffset,
      clearBuffer,
      resetHistory,
    });
  }
  function change(value) {
    input = value;
  }
  function typeahead(event) {
    if (suggestions.length > 0 && event.name === "tab") {
      event.preventDefault();
    }
  }
  function beforeKey(event) {
    if (helpOpen) return;
    if ((handleFooter(event), event.defaultPrevented || event.didStopImmediatePropagation())) return;
    if ((typeahead(event), event.defaultPrevented || event.didStopImmediatePropagation())) return;
    if (event.name === "escape") cancel();
  }
  let inputProps = {
    multiline: true,
    onKeyDownBefore: beforeKey,
    onSubmit: submit,
    onChange: change,
    value: input,
    onHistoryUp: previousHistory,
    onHistoryDown: nextHistory,
    onHistoryReset: resetHistory,
    placeholder: "Try something",
    onExit: exit,
    onExitMessage: setExitMessage,
    onImagePaste: pasteImage,
    columns: 80,
    maxVisibleLines: 5,
    disableCursorMovementForUpDownKeys: suggestions.length > 0,
    disableEscapeDoublePress: suggestions.length > 0,
    cursorOffset: 0,
    onChangeCursorOffset: setCursorOffset,
    onPaste: pasteText,
    onIsPastingChange: setIsPasting,
    focus: true,
    showCursor: true,
    argumentHint: undefined,
    onUndo: undo,
    highlights: [],
    inlineGhostText: undefined,
    inputFilter: filterInput,
  };
  return React.createElement(Footer, {
    suppressHint: input.length > 0,
    isLoading,
  }, React.createElement(TextInput, inputProps));
}

function renderFooterLeft({ showHint, isInputEmpty, isLoading, leftArrowPending }) {
  let parts = [];
  let escShortcut = "esc";
  let toggleShortcut = "ctrl+t";
  let hasToggle = false;
  let mode = "none";
  let hasRunningAgent = false;
  let hintParts = showHint ? getHintParts(isLoading, escShortcut, toggleShortcut, hasToggle, mode) : [];
  if (viewingCompletedTeammate) {
    parts.push(React.createElement(
      Text,
      { dimColor: true, key: "esc-return" },
      React.createElement(KeyboardShortcutHint, {
        chord: escShortcut,
        action: "return to team lead",
        format: { keyCase: "lower" },
      }),
    ));
  } else if (!hasTeammatePills && showHint) {
    parts.push(...hintParts);
  }
  if (!isLoading && isInputEmpty && leftArrowPending) {
    parts.push(React.createElement(Text, { dimColor: true, key: "fg-agents" }, "left for agents"));
  }
  return React.createElement(Box, null, parts);
}

async function replSubmit(input, helpers, speculation, options) {
  addToHistory({ display: input, pastedContents });
  await submitPromptRuntime({
    input,
    helpers,
    queryGuard: turnGate,
    isExternalLoading: externalBusy,
    mode: inputMode,
    commands,
    onInputChange: setInputValue,
    setPastedContents,
    onQuery: runPrompt,
    setMessages,
  });
}

async function runPrompt(newMessages, abortController) {
  const generation = turnGate.tryStart();
  if (generation === null) {
    logEvent("concurrent query detected", {});
    for (const message of newMessages) {
      enqueue({ value: getContentText(message), mode: "prompt" });
      logEvent("concurrent query enqueued", {});
    }
    return;
  }
  try {
    await queryImpl();
  } finally {
    if (turnGate.end(generation)) {
      setLastQueryCompletionTime(Date.now());
      resetLoadingState();
      await onTurnComplete(messagesRef.current);
      sendBridgeResultRef.current();
      setAbortController(null);
    }
  }
}
`;

test("verify rejects unpatched code", () => {
	const ast = parse(TAB_QUEUE_FIXTURE);
	const code = print(ast);
	const result = tabQueue.verify(code, ast);
	assert.notEqual(result, true, "verify should reject unpatched code");
	assert.equal(typeof result, "string");
});

test("tab-queue adds busy-only Tab queue handler and footer hint", async () => {
	const ast = parse(TAB_QUEUE_FIXTURE);
	await runTabQueueViaPasses(ast);
	const output = print(ast);

	assert.match(output, /event\.name === "tab"/);
	assert.match(output, /!event\.shift/);
	assert.match(output, /!event\.ctrl/);
	assert.match(output, /!event\.meta/);
	assert.match(output, /&&\s+isLoading/);
	assert.match(output, /input\.trim\(\) !== ""/);
	assert.match(output, /event\.preventDefault\(\)/);
	assert.match(output, /submit\(input, "__cc_enhanced_tab_queue"\)/);
	assert.match(output, /deferUntilTurnEnd: true/);
	assert.match(output, /globalThis\.__ccEnhancedTabQueue/);
	assert.match(output, /enqueue\({ value: __ccQueuedInput, mode: "prompt" }\)/);
	assert.match(output, /key: "queue-draft"/);
	assert.match(output, /chord: "tab"/);
	assert.match(output, /action: "queue"/);
	assert.match(output, /showHint \|\| hintParts\.length > 0/);
	assert.equal(tabQueue.verify(output, ast), true);
});

test("tab-queue keeps autocomplete ahead of queue handling", async () => {
	const ast = parse(TAB_QUEUE_FIXTURE);
	await runTabQueueViaPasses(ast);
	const output = print(ast);

	const typeaheadGuardIndex = output.indexOf("typeahead(event)");
	const queueGuardIndex = output.indexOf('event.name === "tab"');
	assert.notEqual(typeaheadGuardIndex, -1);
	assert.notEqual(queueGuardIndex, -1);
	assert.equal(typeaheadGuardIndex < queueGuardIndex, true);
});

test("tab-queue is idempotent", async () => {
	const ast = parse(TAB_QUEUE_FIXTURE);
	await runTabQueueViaPasses(ast);
	const firstOutput = print(ast);

	const reparsed = parse(firstOutput);
	await runTabQueueViaPasses(reparsed);
	const secondOutput = print(reparsed);

	assert.equal(countOccurrences(firstOutput, /"__cc_enhanced_tab_queue"/g), 2);
	assert.equal(countOccurrences(secondOutput, /"__cc_enhanced_tab_queue"/g), 2);
	assert.equal(countOccurrences(firstOutput, /key: "queue-draft"/g), 1);
	assert.equal(countOccurrences(secondOutput, /key: "queue-draft"/g), 1);
	assert.equal(
		countOccurrences(firstOutput, /globalThis\.__ccEnhancedTabQueue/g),
		3,
	);
	assert.equal(
		countOccurrences(secondOutput, /globalThis\.__ccEnhancedTabQueue/g),
		3,
	);
	assert.equal(countOccurrences(firstOutput, /hintParts\.length > 0/g), 1);
	assert.equal(countOccurrences(secondOutput, /hintParts\.length > 0/g), 1);
	assert.equal(tabQueue.verify(secondOutput, reparsed), true);
});

test("tab-queue verify fails when the loading gate is removed", async () => {
	const ast = parse(TAB_QUEUE_FIXTURE);
	await runTabQueueViaPasses(ast);
	const output = print(ast);
	const mutated = output.replace(/&&\s+isLoading/, "&& true");
	assert.notEqual(mutated, output);

	const result = tabQueue.verify(mutated);
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("key handler not found"), true);
});

test("tab-queue verify fails when the non-empty draft gate is removed", async () => {
	const ast = parse(TAB_QUEUE_FIXTURE);
	await runTabQueueViaPasses(ast);
	const output = print(ast);
	const mutated = output.replace(/&&\s+input\.trim\(\) !== ""/, "&& true");
	assert.notEqual(mutated, output);

	const result = tabQueue.verify(mutated);
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("key handler not found"), true);
});

test("tab-queue fails closed when draft key targets are ambiguous", async () => {
	const input = `${TAB_QUEUE_FIXTURE}
function renderSecondInput({ input, isLoading }) {
  function submit(value) {
    return send(value);
  }
  function change(value) {
    input = value;
  }
  function beforeKey(event) {
    if ((noop(event), event.defaultPrevented || event.didStopImmediatePropagation())) return;
    if ((noop(event), event.defaultPrevented || event.didStopImmediatePropagation())) return;
  }
  let inputProps = {
    multiline: true,
    onKeyDownBefore: beforeKey,
    onSubmit: submit,
    onChange: change,
    value: input,
    disableEscapeDoublePress: false,
    inputFilter: filterInput,
  };
  return React.createElement(Footer, {
    suppressHint: input.length > 0,
    isLoading,
  }, React.createElement(TextInput, inputProps));
}
`;
	const ast = parse(input);
	await runTabQueueViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes('submit(input, "__cc_enhanced_tab_queue")'),
		false,
	);
	const result = tabQueue.verify(output, ast);
	assert.equal(typeof result, "string");
});
