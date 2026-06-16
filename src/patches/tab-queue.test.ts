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
function renderInput({ input, isLoading, suggestions, helpOpen, submitPrompt, setPastedContents }) {
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
    if (event.name === "tab" && !event.shift) {
      if (suggestions.length > 0) return;
      if (input.trim() === "") {
        event.preventDefault();
        addNotification({
          key: "thinking-toggle-hint",
          jsx: React.createElement(Text, { dimColor: true }, "Use ctrl+t to toggle thinking"),
          priority: "immediate",
          timeoutMs: 3000,
        });
      }
      return;
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
  if (isExternalEditorActive) {
    return React.createElement(Box, { flexDirection: "row", borderStyle: "round" },
      React.createElement(Text, { dimColor: true, italic: true }, "Save and close editor to continue...")
    );
  }
  let textInputElement = isVimModeEnabled()
    ? React.createElement(VimTextInput, { ...inputProps, initialMode: vimMode, onModeChange: setVimMode })
    : React.createElement(TextInput, { ...inputProps });
  return React.createElement(Box, { flexDirection: "column" },
    React.createElement(Box, { borderColor: "promptBorder", borderStyle: "round", width: "100%" },
      React.createElement(ModeIndicator, { mode: "prompt", isLoading }),
      React.createElement(Box, { flexGrow: 1, flexShrink: 1, onClick: handleInputClick }, textInputElement)
    ),
    React.createElement(Footer, {
      suppressHint: input.length > 0,
      isLoading,
    })
  );
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
  } else if (showHint) {
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
      const turnDurationMs = Date.now() - loadingStartTimeRef.current;
      if (turnDurationMs > 30000 && !abortController.signal.aborted) {
        setMessages(prev => [...prev, createTurnDurationMessage(turnDurationMs)]);
      }
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

test("tab-queue adds busy-only Tab queue handler, preview, edit, and footer hint", async () => {
	const ast = parse(TAB_QUEUE_FIXTURE);
	await runTabQueueViaPasses(ast);
	const output = print(ast);

	assert.match(output, /event\.name === "tab"/);
	assert.match(output, /!event\.shift/);
	assert.match(output, /!event\.ctrl/);
	assert.match(output, /!event\.meta/);
	assert.match(output, /&&\s+isLoading/);
	assert.match(output, /input\.trim\(\) === ""/);
	assert.match(output, /input\.trim\(\) !== ""/);
	assert.match(output, /event\.preventDefault\(\)/);
	assert.match(output, /globalThis\.__ccEnhancedTabQueue\.pop\(\)/);
	assert.match(output, /typeof __ccQueuedDraft === "string"/);
	assert.match(output, /change\(__ccQueuedDraft\)/);
	assert.match(output, /setCursorOffset\(__ccQueuedDraft\.length\)/);
	assert.match(output, /setPastedContents/);
	assert.match(output, /setPastedContents\({}\)/);
	assert.match(output, /submit\(input, "__cc_enhanced_tab_queue"\)/);
	assert.match(output, /deferUntilTurnEnd: true/);
	assert.match(output, /globalThis\.__ccEnhancedTabQueue/);
	assert.match(output, /!abortController\.signal\.aborted/);
	assert.match(
		output,
		/enqueue\({ value: __ccQueuedInput, mode: "prompt", priority: "later" }\)/,
	);
	assert.match(output, /key: "tab-queue-status"/);
	assert.match(output, /Queued follow-up/);
	assert.match(output, /Tab to edit/);
	assert.match(output, /key: "tab-queue-draft"/);
	assert.match(output, /> /);
	assert.match(output, /let textInputElement = __ccTabQueuedPreview \?/);
	assert.match(output, /key: "thinking-toggle-hint"/);
	assert.match(
		output,
		/input\.trim\(\) === "" && !\(Array\.isArray\(globalThis\.__ccEnhancedTabQueue\) && globalThis\.__ccEnhancedTabQueue\.length > 0\)/,
	);
	assert.doesNotMatch(
		output,
		/__ccTabQueuedDraft = isLoading && Array\.isArray\(__ccTabQueuedDrafts\)/,
	);
	assert.match(output, /key: "queue-draft"/);
	assert.match(output, /chord: "tab"/);
	assert.match(output, /action: "queue"/);
	assert.match(output, /key: "edit-queued-draft"/);
	assert.match(output, /action: "edit queued"/);
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

test("tab-queue lets queued draft edit bypass the thinking hint", async () => {
	const ast = parse(TAB_QUEUE_FIXTURE);
	await runTabQueueViaPasses(ast);
	const output = print(ast);

	const thinkingHintIndex = output.indexOf('key: "thinking-toggle-hint"');
	const queueBypassIndex = output.indexOf(
		"Array.isArray(globalThis.__ccEnhancedTabQueue)",
		thinkingHintIndex - 240,
	);
	const editGuardIndex = output.indexOf(
		"globalThis.__ccEnhancedTabQueue.pop()",
	);
	assert.notEqual(thinkingHintIndex, -1);
	assert.notEqual(queueBypassIndex, -1);
	assert.notEqual(editGuardIndex, -1);
	assert.equal(queueBypassIndex < thinkingHintIndex, true);
	assert.equal(thinkingHintIndex < editGuardIndex, true);
	assert.equal(tabQueue.verify(output, ast), true);
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
	assert.equal(countOccurrences(firstOutput, /key: "edit-queued-draft"/g), 1);
	assert.equal(countOccurrences(secondOutput, /key: "edit-queued-draft"/g), 1);
	assert.equal(countOccurrences(firstOutput, /key: "tab-queue-status"/g), 1);
	assert.equal(countOccurrences(secondOutput, /key: "tab-queue-status"/g), 1);
	assert.equal(countOccurrences(firstOutput, /key: "tab-queue-draft"/g), 1);
	assert.equal(countOccurrences(secondOutput, /key: "tab-queue-draft"/g), 1);
	assert.equal(
		countOccurrences(firstOutput, /globalThis\.__ccEnhancedTabQueue/g),
		countOccurrences(secondOutput, /globalThis\.__ccEnhancedTabQueue/g),
	);
	assert.equal(countOccurrences(firstOutput, /hintParts\.length > 0/g), 1);
	assert.equal(countOccurrences(secondOutput, /hintParts\.length > 0/g), 1);
	assert.equal(tabQueue.verify(secondOutput, reparsed), true);
});

test("tab-queue verify fails when the loading gate is removed", async () => {
	const ast = parse(TAB_QUEUE_FIXTURE);
	await runTabQueueViaPasses(ast);
	const output = print(ast);
	const mutated = output.replace(/&&\s+isLoading/g, "&& true");
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

test("tab-queue verify fails when the edit path is removed", async () => {
	const ast = parse(TAB_QUEUE_FIXTURE);
	await runTabQueueViaPasses(ast);
	const output = print(ast);
	const mutated = output.replace(/change\(__ccQueuedDraft\);/, "");
	assert.notEqual(mutated, output);

	const result = tabQueue.verify(mutated);
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("edit handler not found"), true);
});

test("tab-queue verify fails when the edit queue-length gate is removed", async () => {
	const ast = parse(TAB_QUEUE_FIXTURE);
	await runTabQueueViaPasses(ast);
	const output = print(ast);
	const mutated = output.replace(
		/&&\s+Array\.isArray\(globalThis\.__ccEnhancedTabQueue\) &&\s+globalThis\.__ccEnhancedTabQueue\.length > 0/,
		"",
	);
	assert.notEqual(mutated, output);

	const result = tabQueue.verify(mutated);
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("edit handler not found"), true);
});

test("tab-queue verify fails when the prompt bar preview is removed", async () => {
	const ast = parse(TAB_QUEUE_FIXTURE);
	await runTabQueueViaPasses(ast);
	const output = print(ast);
	const mutated = output.replace(
		/key: "tab-queue-status"/,
		'key: "tab-queue-missing"',
	);
	assert.notEqual(mutated, output);

	const result = tabQueue.verify(mutated);
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("prompt bar preview not found"), true);
});

test("tab-queue verify fails when the typeahead bypass is removed", async () => {
	const ast = parse(TAB_QUEUE_FIXTURE);
	await runTabQueueViaPasses(ast);
	const output = print(ast);
	const mutated = output.replace(
		/ && !\(Array\.isArray\(globalThis\.__ccEnhancedTabQueue\) && globalThis\.__ccEnhancedTabQueue\.length > 0\)/,
		"",
	);
	assert.notEqual(mutated, output);

	const result = tabQueue.verify(mutated);
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("typeahead bypass not found"), true);
});

test("tab-queue verify fails when the typeahead bypass polarity is flipped", async () => {
	const ast = parse(TAB_QUEUE_FIXTURE);
	await runTabQueueViaPasses(ast);
	const output = print(ast);
	// Drop only the negation so the queue member still appears in the test but
	// the bypass no longer suppresses on a non-empty queue. A presence-only
	// check would accept this; the polarity-aware check must reject it.
	const mutated = output.replace(
		" && !(Array.isArray(globalThis.__ccEnhancedTabQueue) && globalThis.__ccEnhancedTabQueue.length > 0)",
		" && (Array.isArray(globalThis.__ccEnhancedTabQueue) && globalThis.__ccEnhancedTabQueue.length > 0)",
	);
	assert.notEqual(mutated, output);

	const result = tabQueue.verify(mutated);
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("typeahead bypass not found"), true);
});

test("tab-queue verify fails when the end-turn abort guard is removed", async () => {
	const ast = parse(TAB_QUEUE_FIXTURE);
	await runTabQueueViaPasses(ast);
	const output = print(ast);
	const mutated = output.replace(
		/if \(!abortController\.signal\.aborted && Array\.isArray\(__ccTabQueue\)/,
		"if (Array.isArray(__ccTabQueue)",
	);
	assert.notEqual(mutated, output);

	const result = tabQueue.verify(mutated);
	assert.equal(typeof result, "string");
	assert.equal(String(result).includes("end-turn drain not found"), true);
});

test("tab-queue fails closed when draft key targets are ambiguous", async () => {
	const input = `${TAB_QUEUE_FIXTURE}
function renderSecondInput({ input, isLoading, setPastedContents }) {
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
    onChangeCursorOffset: setCursorOffset,
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
