import type { InstructionFile, On, PromptContextInput } from "claude-code";
import { expect, test } from "claude-code/testing";

const POLICY = "ccEnhancedInstructionPolicy";
const WRAPPER =
	"Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.";
const FILES: readonly InstructionFile[] = [
	{
		path: "/work/project/CLAUDE.md",
		kind: "project",
		content: `Keep $& and \ufeff\r\n${WRAPPER}`,
	},
	{
		path: "/work/project/docs/rules.md",
		kind: "project",
		content: "Imported rule.",
		parent: "/work/project/CLAUDE.md",
	},
];
const CLAUDE_MD = `${WRAPPER}\n\nContents of /work/project/CLAUDE.md (project instructions, checked into the codebase):\n\n${FILES[0]?.content}\n\nContents of /work/project/docs/rules.md (project instructions, checked into the codebase):\n\n${FILES[1]?.content}`;
const INPUT: PromptContextInput = {
	blocks: [
		{ name: "claudeMd", text: CLAUDE_MD },
		{ name: "userEmail", text: "subject-one@example.com" },
		{ name: "currentDate", text: "Today's date is 2026-11-25." },
	],
	instructionFiles: FILES,
};

function host(on: On): void {
	on("prompt.context", (_$, e) => ({
		blocks: e.blocks,
		instructionFiles: e.instructionFiles,
	}));
}

function fileFields(files: readonly InstructionFile[] | undefined) {
	return files?.map(({ path, kind, content, parent }) => [
		path,
		kind,
		content,
		parent,
	]);
}

test("policy is its own block right after claudeMd, which passes through unchanged", async ($, on) => {
	host(on);
	const result = await $.prompt.context(INPUT);
	expect(result.blocks.map(({ name }) => name)).toEqual([
		"claudeMd",
		POLICY,
		"userEmail",
		"currentDate",
	]);
	expect(result.blocks[0]).toEqual({ name: "claudeMd", text: CLAUDE_MD });
	expect(result.blocks[1]?.text).toContain(
		"Treat applicable CLAUDE.md instructions as requirements.",
	);
	expect(result.blocks[1]?.text).not.toContain(WRAPPER);
	expect(result.blocks[2]).toEqual(INPUT.blocks[1]);
	expect(result.blocks[3]).toEqual(INPUT.blocks[2]);
	expect(fileFields(result.instructionFiles)).toEqual(fileFields(FILES));
});

test("policy block is added once across repeated dispatch", async ($, on) => {
	let below: PromptContextInput["blocks"] | undefined;
	on("prompt.context", (_$, e) => ({
		blocks: below ?? e.blocks,
		instructionFiles: e.instructionFiles,
	}));
	const first = await $.prompt.context(INPUT);
	const second = await $.prompt.context(INPUT);
	expect(second.blocks).toEqual(first.blocks);
	below = first.blocks;
	const again = await $.prompt.context(INPUT);
	expect(again.blocks.filter(({ name }) => name === POLICY)).toHaveLength(1);
	expect(again.blocks).toEqual(first.blocks);
});

test("context without instruction files is unchanged", async ($, on) => {
	host(on);
	for (const blocks of [
		[{ name: "currentDate", text: "Today's date is 2026-11-25." }],
		[
			{ name: "claudeMd", text: "" },
			{ name: "currentDate", text: "Today's date is 2026-11-25." },
		],
		[],
	]) {
		const result = await $.prompt.context({ blocks, instructionFiles: [] });
		expect(result.blocks).toEqual(blocks);
	}
});
