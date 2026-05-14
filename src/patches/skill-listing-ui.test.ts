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
