import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { modelPickerSessionOnly } from "./model-picker-session-only.js";

async function runSessionOnlyPickerViaPasses(ast: any): Promise<void> {
	const passes = (await modelPickerSessionOnly.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: modelPickerSessionOnly.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

const PICKER_FIXTURE = `
const childEnvOne = ["CLAUDE_CODE_SUBAGENT_MODEL"];
const childEnvTwo = new Set(["CLAUDE_CODE_SUBAGENT_MODEL"]);
const childEnvThree = ["CLAUDE_CODE_SUBAGENT_MODEL"];
function renderModelPicker(props) {
  let {
    initial,
    sessionModel,
    onSelect,
    onSetDefault,
    onCancel,
    isStandaloneCommand,
    showFastModeNotice,
    headerText,
    options,
    skipSettingsWrite,
  } = props,
    state = initial;
  function select(value) {
    if (onSetDefault) onSetDefault(value);
    onSelect(value);
    state = value;
  }
  const header = headerText ?? "Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names, specify with --model.";
  return {
    select,
    header,
    canSetDefault: Boolean(onSetDefault),
    state,
    sessionModel,
    onCancel,
    isStandaloneCommand,
    showFastModeNotice,
    options,
    skipSettingsWrite,
  };
}
`;

function evaluatePatched(code: string) {
	const processValue: { env: Record<string, string | undefined> } = { env: {} };
	const runtime = Function(
		"process",
		`${code}
return {
  setSessionOnly(enabled) {
    if (enabled) process.env.CLAUDE_CODE_MODEL_PICKER_SESSION_ONLY = "1";
    else delete process.env.CLAUDE_CODE_MODEL_PICKER_SESSION_ONLY;
  },
  renderModelPicker,
  childEnvs: [childEnvOne, [...childEnvTwo], childEnvThree],
};`,
	)(processValue);
	return runtime as {
		setSessionOnly: (enabled: boolean) => void;
		renderModelPicker: (props: Record<string, unknown>) => {
			select: (value: string) => void;
			header: string;
			canSetDefault: boolean;
		};
		childEnvs: string[][];
	};
}

function pickerProps(
	onSelect: (value: string) => void,
	onSetDefault: (value: string) => void,
): Record<string, unknown> {
	return {
		initial: "fable",
		sessionModel: null,
		onSelect,
		onSetDefault,
		onCancel: () => {},
		isStandaloneCommand: true,
		showFastModeNotice: false,
		headerText: undefined,
		options: [],
		skipSettingsWrite: false,
	};
}

test("verify rejects a picker that can still persist defaults", () => {
	const ast = parse(PICKER_FIXTURE);
	assert.equal(typeof modelPickerSessionOnly.verify(print(ast), ast), "string");
});

test("preserves stock default-setting behavior while the mode is absent", async () => {
	const ast = parse(PICKER_FIXTURE);
	await runSessionOnlyPickerViaPasses(ast);
	const runtime = evaluatePatched(print(ast));
	const selected: string[] = [];
	const defaults: string[] = [];
	const picker = runtime.renderModelPicker(
		pickerProps(
			(value) => selected.push(value),
			(value) => defaults.push(value),
		),
	);
	picker.select("opus");

	assert.deepEqual(selected, ["opus"]);
	assert.deepEqual(defaults, ["opus"]);
	assert.equal(picker.canSetDefault, true);
	assert.equal(
		picker.header,
		"Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names, specify with --model.",
	);
});

test("selects for the session without invoking the settings writer", async () => {
	const ast = parse(PICKER_FIXTURE);
	await runSessionOnlyPickerViaPasses(ast);
	const output = print(ast);
	const runtime = evaluatePatched(output);
	runtime.setSessionOnly(true);
	const selected: string[] = [];
	const defaults: string[] = [];
	const picker = runtime.renderModelPicker(
		pickerProps(
			(value) => selected.push(value),
			(value) => defaults.push(value),
		),
	);
	picker.select("clodex:openai-oauth:gpt-5.6-sol");

	assert.deepEqual(selected, ["clodex:openai-oauth:gpt-5.6-sol"]);
	assert.deepEqual(defaults, []);
	assert.equal(picker.canSetDefault, false);
	assert.equal(
		picker.header,
		"Switch between models for this session. Your selection is not saved as the default for new sessions.",
	);
	for (const childEnv of runtime.childEnvs) {
		assert.equal(
			childEnv.filter(
				(value) => value === "CLAUDE_CODE_MODEL_PICKER_SESSION_ONLY",
			).length,
			1,
		);
	}
	assert.equal(modelPickerSessionOnly.verify(output, ast), true);
});

test("model-picker-session-only forwards session-only mode to two arrays", async () => {
	const twoArrayFixture = PICKER_FIXTURE.replace(
		'const childEnvThree = ["CLAUDE_CODE_SUBAGENT_MODEL"];\n',
		"",
	);
	assert.notEqual(twoArrayFixture, PICKER_FIXTURE);
	const ast = parse(twoArrayFixture);
	await runSessionOnlyPickerViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.split('"CLAUDE_CODE_MODEL_PICKER_SESSION_ONLY"').length - 1,
		2,
		"every remaining forwarding array must receive the session-only env",
	);
	assert.equal(modelPickerSessionOnly.verify(output, ast), true);
});

test("model-picker-session-only forwards session-only mode to four arrays", async () => {
	const fourArrayFixture = PICKER_FIXTURE.replace(
		'const childEnvThree = ["CLAUDE_CODE_SUBAGENT_MODEL"];',
		'const childEnvThree = ["CLAUDE_CODE_SUBAGENT_MODEL"];\nconst childEnvFour = ["CLAUDE_CODE_SUBAGENT_MODEL"];',
	);
	assert.notEqual(fourArrayFixture, PICKER_FIXTURE);
	const ast = parse(fourArrayFixture);
	await runSessionOnlyPickerViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.split('"CLAUDE_CODE_MODEL_PICKER_SESSION_ONLY"').length - 1,
		4,
		"a fourth forwarding array must also receive the session-only env",
	);
	assert.equal(modelPickerSessionOnly.verify(output, ast), true);
});

test("model-picker-session-only is idempotent", async () => {
	const ast = parse(PICKER_FIXTURE);
	await runSessionOnlyPickerViaPasses(ast);
	const once = print(ast);
	await runSessionOnlyPickerViaPasses(ast);
	const twice = print(ast);

	assert.equal(twice, once);
	assert.equal(modelPickerSessionOnly.verify(twice, ast), true);
});
