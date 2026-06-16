import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { skillListingUi } from "./skill-listing-ui.js";

async function runSkillListingUiViaPasses(ast: any): Promise<void> {
	const passes = (await skillListingUi.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: skillListingUi.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

function removeFirstOccurrence(source: string, needle: string): string {
	const index = source.indexOf(needle);
	assert.notEqual(index, -1);
	return source.slice(0, index) + source.slice(index + needle.length);
}

function removeLastOccurrence(source: string, needle: string): string {
	const index = source.lastIndexOf(needle);
	assert.notEqual(index, -1);
	return source.slice(0, index) + source.slice(index + needle.length);
}

const SKILL_LISTING_FIXTURE = `
function renderAttachment(H) {
  switch (H.type) {
    case "dynamic_skill": {
      let A = H.skillNames.length;
      return Nq.default.createElement(
        xw,
        null,
        "Loaded",
        " ",
        Nq.default.createElement(v, { bold: !0 }, A, " ", Y6(A, "skill")),
        " ",
        "from ",
        Nq.default.createElement(v, { bold: !0 }, H.displayPath),
      );
    }
    case "skill_listing": {
      if (H.isInitial) return null;
      return Nq.default.createElement(
        xw,
        null,
        Nq.default.createElement(v, { bold: !0 }, H.skillCount),
        " ",
        Y6(H.skillCount, "skill"),
        " available",
      );
    }
  }
}

function buildAttachment(z, O, Y) {
  return [
    {
      type: "skill_listing",
      content: MB8(z, O, (w) => Qq$(w.name)),
      skillCount: z.length,
      isInitial: Y,
    },
  ];
}
`;

const MEMOIZED_SKILL_LISTING_FIXTURE = `
function renderAttachment(q, $) {
  switch (q.type) {
    case "dynamic_skill": {
      let z = q.skillNames.length,
        Y;
      if ($[86] !== z) (Y = R8(z, "skill")), ($[86] = z), ($[87] = Y);
      else Y = $[87];
      let O;
      if ($[88] !== z || $[89] !== Y)
        (O = yK.default.createElement(y, { bold: !0 }, z, " ", Y)),
          ($[88] = z),
          ($[89] = Y),
          ($[90] = O);
      else O = $[90];
      let w;
      if ($[91] !== q.displayPath)
        (w = yK.default.createElement(y, { bold: !0 }, q.displayPath)),
          ($[91] = q.displayPath),
          ($[92] = w);
      else w = $[92];
      let M;
      if ($[93] !== O || $[94] !== w)
        (M = yK.default.createElement(nP, null, "Loaded", " ", O, " ", "from ", w)),
          ($[93] = O),
          ($[94] = w),
          ($[95] = M);
      else M = $[95];
      return M;
    }
    case "skill_listing": {
      if (q.isInitial) return null;
      let z;
      if ($[96] !== q.skillCount)
        (z = yK.default.createElement(y, { bold: !0 }, q.skillCount)),
          ($[96] = q.skillCount),
          ($[97] = z);
      else z = $[97];
      let Y;
      if ($[98] !== q.skillCount)
        (Y = R8(q.skillCount, "skill")), ($[98] = q.skillCount), ($[99] = Y);
      else Y = $[99];
      let O;
      if ($[100] !== z || $[101] !== Y)
        (O = yK.default.createElement(nP, null, z, " ", Y, " available")),
          ($[100] = z),
          ($[101] = Y),
          ($[102] = O);
      else O = $[102];
      return O;
    }
  }
}

function buildAttachment(H) {
  let A = H.skills;
  let Y = H.model;
  let z = H.initial;
  return [
    {
      type: "skill_listing",
      content: PS6(A, Y, (w) => VbH(w.name), uW(H.options.mainLoopModel)),
      skillCount: A.length,
      isInitial: z,
      names: A.map((w) => w.name),
    },
  ];
}
`;

test("verify rejects unpatched code", () => {
	const ast = parse(SKILL_LISTING_FIXTURE);
	const code = print(ast);
	const result = skillListingUi.verify(code, ast);
	assert.notEqual(result, true, "verify should reject unpatched code");
	assert.equal(typeof result, "string");
});

test("skill-listing-ui adds skillNames metadata and a visible summary", async () => {
	const ast = parse(SKILL_LISTING_FIXTURE);
	await runSkillListingUiViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes(
			"function _claudePatchFormatSkillListingSummary(attachment)",
		),
		true,
	);
	assert.equal(
		output.includes(
			"skillNames: z.map((_claudePatchSkillItem) => _claudePatchSkillItem.name)",
		),
		true,
	);
	assert.equal(
		output.match(/_claudePatchFormatSkillListingSummary\(H\)/g)?.length,
		2,
	);
	assert.equal(
		/skillNames:[^,}]*Qq\$/.test(output),
		false,
		"skillNames must not reuse the content-call scoring formatter",
	);
	assert.equal(skillListingUi.verify(output, ast), true);
});

test("skill-listing-ui patches memoized 2.1.169 render shape", async () => {
	const ast = parse(MEMOIZED_SKILL_LISTING_FIXTURE);
	await runSkillListingUiViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes(
			"function _claudePatchFormatSkillListingSummary(attachment)",
		),
		true,
	);
	assert.equal(
		output.includes(
			"skillNames: A.map((_claudePatchSkillItem) => _claudePatchSkillItem.name)",
		),
		true,
	);
	assert.equal(
		output.match(/_claudePatchFormatSkillListingSummary\(q\)/g)?.length,
		2,
	);
	assert.equal(output.match(/if \(true\)/g)?.length, 2);
	assert.equal(skillListingUi.verify(output, ast), true);
});

test("skill-listing-ui verify rejects memoized summaries with stale cache guards", async () => {
	const ast = parse(MEMOIZED_SKILL_LISTING_FIXTURE);
	await runSkillListingUiViaPasses(ast);
	const output = print(ast);
	const mutated = output.replace(
		"if (true)",
		"if ($[93] !== O || $[94] !== w)",
	);
	assert.notEqual(mutated, output);

	const result = skillListingUi.verify(mutated);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes(
			"dynamic_skill renderer is missing the loaded-skill summary",
		),
		true,
	);
});

test("skill-listing-ui verify fails when skillNames metadata is removed", async () => {
	const ast = parse(SKILL_LISTING_FIXTURE);
	await runSkillListingUiViaPasses(ast);
	const output = print(ast);
	const mutated = output.replace(
		", skillNames: z.map((_claudePatchSkillItem) => _claudePatchSkillItem.name)",
		"",
	);
	assert.notEqual(mutated, output);

	const result = skillListingUi.verify(mutated);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes(
			"skill_listing attachment is missing skillNames metadata",
		),
		true,
	);
});

test("skill-listing-ui verify fails when the visible summary is removed", async () => {
	const ast = parse(SKILL_LISTING_FIXTURE);
	await runSkillListingUiViaPasses(ast);
	const output = print(ast);
	const mutated = removeLastOccurrence(
		output,
		", _claudePatchFormatSkillListingSummary(H)",
	);
	assert.notEqual(mutated, output);

	const result = skillListingUi.verify(mutated);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes(
			"skill_listing renderer is missing the activated-skill summary",
		),
		true,
	);
});

test("skill-listing-ui verify fails when the dynamic skill summary is removed", async () => {
	const ast = parse(SKILL_LISTING_FIXTURE);
	await runSkillListingUiViaPasses(ast);
	const output = print(ast);
	const mutated = removeFirstOccurrence(
		output,
		", _claudePatchFormatSkillListingSummary(H)",
	);
	assert.notEqual(mutated, output);

	const result = skillListingUi.verify(mutated);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes(
			"dynamic_skill renderer is missing the loaded-skill summary",
		),
		true,
	);
});

test("skill-listing-ui leaves attachment unpatched when a second skill_listing producer appears", async () => {
	const twoProducers = MEMOIZED_SKILL_LISTING_FIXTURE.replace(
		"function buildAttachment(H) {",
		`function buildDecoyAttachment(H) {
  return [
    {
      type: "skill_listing",
      content: PS6(H.skills, H.model, (w) => VbH(w.name), uW(H.options.mainLoopModel)),
      skillCount: H.skills.length,
      isInitial: H.initial,
    },
  ];
}
function buildAttachment(H) {`,
	);
	const ast = parse(twoProducers);
	await runSkillListingUiViaPasses(ast);
	const output = print(ast);
	assert.equal(
		output.includes("_claudePatchSkillItem"),
		false,
		"ambiguous attachment producers must leave skillNames unpatched",
	);
	const result = skillListingUi.verify(output, ast);
	assert.equal(typeof result, "string");
	assert.equal(
		String(result).includes(
			"skill_listing attachment is missing skillNames metadata",
		),
		true,
	);
});

test("skill-listing-ui verify accepts un-memoized render roots that have no cache guard", async () => {
	const ast = parse(SKILL_LISTING_FIXTURE);
	await runSkillListingUiViaPasses(ast);
	const output = print(ast);
	assert.equal(
		/if \(true\)/.test(output),
		false,
		"plain fixture has no cache guards to flip",
	);
	assert.equal(skillListingUi.verify(output, ast), true);
});

test("skill-listing-ui adds skillNames alongside the pre-existing upstream names field", async () => {
	const ast = parse(MEMOIZED_SKILL_LISTING_FIXTURE);
	await runSkillListingUiViaPasses(ast);
	const output = print(ast);
	assert.equal(
		output.includes("names: A.map((w) => w.name)"),
		true,
		"original upstream names field must be preserved",
	);
	assert.equal(
		output.includes(
			"skillNames: A.map((_claudePatchSkillItem) => _claudePatchSkillItem.name)",
		),
		true,
		"patch must inject its own distinct skillNames property",
	);
});

test("skill-listing-ui ignores dynamic_skill attachment objects as skill_listing producers", async () => {
	const withDynamicProducer = MEMOIZED_SKILL_LISTING_FIXTURE.replace(
		"function buildAttachment(H) {",
		`function buildDynamicProducer(K) {
  return [
    {
      type: "dynamic_skill",
      skillDir: K.dir,
      skillNames: K.files,
      displayPath: K.rel,
    },
  ];
}
function buildAttachment(H) {`,
	);
	const ast = parse(withDynamicProducer);
	await runSkillListingUiViaPasses(ast);
	const output = print(ast);
	// The single skill_listing producer is still patched (dynamic object ignored).
	assert.equal(
		output.includes(
			"skillNames: A.map((_claudePatchSkillItem) => _claudePatchSkillItem.name)",
		),
		true,
	);
	assert.equal(skillListingUi.verify(output, ast), true);
});
