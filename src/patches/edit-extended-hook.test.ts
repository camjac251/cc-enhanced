import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const templatePath = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"../templates/edit_hook.js",
);

interface EditOutcome {
	content?: string;
	oldString?: string;
	newString?: string;
	error?: { message: string; errorCode: number };
}

type ApplyString = (
	content: string,
	edit: { oldString: string; newString: string; replaceAll?: boolean },
) => EditOutcome;

/**
 * Evaluate the injected edit helpers in isolation.
 *
 * The template is written as module-scope source for injection, so the two
 * node imports are swapped for the already-loaded modules and the helpers under
 * test are handed back through an explicit return.
 */
function loadEditHook(): { applyString: ApplyString } {
	const source = fs
		.readFileSync(templatePath, "utf-8")
		.replace(/^import \* as _claudeFs from "node:fs";$/m, "")
		.replace(/^import \* as _claudePath from "node:path";$/m, "");
	const factory = new Function(
		"_claudeFs",
		"_claudePath",
		`${source}\nreturn { applyString: _claudeEditApplyString };`,
	) as (fsModule: unknown, pathModule: unknown) => { applyString: ApplyString };
	return factory(fs, path);
}

const DOLLAR_SEQUENCES: ReadonlyArray<readonly [string, string]> = [
	["dollar-backtick", "`^\\d+(\\.\\d+)?$`"],
	["dollar-quote", "value$'tail"],
	["dollar-ampersand", "prefix$&suffix"],
	["dollar-dollar", "cost$$total"],
	["dollar-digit", "group$1here"],
];

test("single-edit replacement treats dollar sequences as literal text", () => {
	const { applyString } = loadEditHook();

	for (const [label, newString] of DOLLAR_SEQUENCES) {
		const content = "alpha\nMARKER\nomega\n";
		const outcome = applyString(content, {
			oldString: "MARKER",
			newString,
			replaceAll: false,
		});

		assert.equal(outcome.error, undefined, `${label} produced an error`);
		assert.equal(
			outcome.content,
			`alpha\n${newString}\nomega\n`,
			`${label} was expanded instead of inserted literally`,
		);
	}
});

test("replace_all replacement treats dollar sequences as literal text", () => {
	const { applyString } = loadEditHook();

	for (const [label, newString] of DOLLAR_SEQUENCES) {
		const content = "MARKER\nmiddle\nMARKER\n";
		const outcome = applyString(content, {
			oldString: "MARKER",
			newString,
			replaceAll: true,
		});

		assert.equal(outcome.error, undefined, `${label} produced an error`);
		assert.equal(
			outcome.content,
			`${newString}\nmiddle\n${newString}\n`,
			`${label} was expanded instead of inserted literally`,
		);
	}
});

test("a dollar-backtick replacement does not splice the file prefix back in", () => {
	const { applyString } = loadEditHook();

	// The reported corruption: a raw-string terminator preceded by a regex end
	// anchor reads as the "insert everything before the match" replacement token,
	// so the whole leading half of the file lands mid-line.
	const content = [
		"package action",
		"",
		"var (",
		"\tnumericLiteral = regexp.MustCompile(`OLD`)",
		")",
		"",
	].join("\n");
	const newString = "\tnumericLiteral = regexp.MustCompile(`^\\d+(\\.\\d+)?$`)";

	const outcome = applyString(content, {
		oldString: "\tnumericLiteral = regexp.MustCompile(`OLD`)",
		newString,
		replaceAll: false,
	});

	assert.equal(outcome.error, undefined);
	const updated = outcome.content ?? "";
	assert.equal(
		updated.split("package action").length - 1,
		1,
		"file prefix was duplicated into the replacement",
	);
	assert.equal(updated.includes(newString), true);
});

test("the hook keeps no string-form replacement call", () => {
	const source = fs.readFileSync(templatePath, "utf-8");
	assert.equal(
		/\.replace\(\s*searchStr\s*,\s*replacementString\s*\)/.test(source),
		false,
		"string-form replace reintroduces dollar-sequence expansion",
	);
});
