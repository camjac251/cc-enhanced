import assert from "node:assert/strict";
import { test } from "node:test";
import type { FsBytes, FsReadBytesOptions, FsReadOptions } from "claude-code";
import {
	decodeBatchEditOriginal,
	executeBatchEdit,
	parseBatchEditInput,
	planBatchEdits,
} from "../../plugin/hooks/batch-edit.js";

const PATH = "/work/example.txt";

function base64(text: string): string {
	return Buffer.from(text, "utf8").toString("base64");
}

test("batch input requires an absolute path, edits, and typed edit fields", () => {
	for (const input of [
		null,
		{},
		{ file_path: "relative.txt", edits: [] },
		{ file_path: "/work/bad\0path", edits: [] },
		{ file_path: PATH, edits: [] },
		{ file_path: PATH, edits: [null] },
		{ file_path: PATH, edits: [{ old_string: 1, new_string: "two" }] },
		{ file_path: PATH, edits: [{ old_string: "one", new_string: false }] },
		{
			file_path: PATH,
			edits: [{ old_string: "one", new_string: "two", replace_all: "true" }],
		},
	]) {
		assert.throws(() => parseBatchEditInput(input));
	}
	for (const file_path of [PATH, "C:\\work\\example.txt"]) {
		assert.deepEqual(
			parseBatchEditInput({
				file_path,
				edits: [{ old_string: "one", new_string: "two" }],
			}),
			{
				file_path,
				edits: [{ old_string: "one", new_string: "two", replace_all: false }],
			},
		);
	}
});

test("batch simulation lets later edits use earlier replacements", () => {
	const edits = [
		{ old_string: "alpha", new_string: "beta" },
		{ old_string: "beta tail", new_string: "gamma" },
	];
	const plan = planBatchEdits("alpha tail\n", edits);
	assert.equal(plan.content, "gamma\n");
	assert.deepEqual(plan.edits, [
		{ ...edits[0], replace_all: false, replacements: 1 },
		{ ...edits[1], replace_all: false, replacements: 1 },
	]);
	assert.deepEqual(edits, [
		{ old_string: "alpha", new_string: "beta" },
		{ old_string: "beta tail", new_string: "gamma" },
	]);
});

test("batch simulation rejects a later anchor consumed by an earlier edit", () => {
	assert.throws(
		() =>
			planBatchEdits("alpha tail\n", [
				{ old_string: "alpha", new_string: "beta" },
				{ old_string: "alpha tail", new_string: "gamma" },
			]),
		/Edit 2: old_string was not found/,
	);
});

test("each old string must be nonempty and differ after newline normalization", () => {
	for (const edit of [
		{ old_string: "", new_string: "insert" },
		{ old_string: "alpha", new_string: "alpha" },
		{ old_string: "alpha\r\n", new_string: "alpha\n" },
	]) {
		assert.throws(() => planBatchEdits("alpha\n", [edit]), /Edit 1:/);
	}
	assert.throws(
		() =>
			planBatchEdits("alpha\n", [{ old_string: "missing", new_string: "new" }]),
		/Edit 1: old_string was not found/,
	);
});

test("duplicate matches need replace_all and are counted without overlap", () => {
	assert.throws(
		() =>
			planBatchEdits("alpha alpha", [
				{ old_string: "alpha", new_string: "beta" },
			]),
		/2 matches/,
	);
	const all = planBatchEdits("alpha alpha", [
		{ old_string: "alpha", new_string: "beta", replace_all: true },
	]);
	assert.equal(all.content, "beta beta");
	assert.equal(all.edits[0]?.replacements, 2);
	assert.equal(
		planBatchEdits("aaa", [{ old_string: "aa", new_string: "b" }]).content,
		"ba",
	);
});

test("uniqueness is checked on the sequential state, not only the original", () => {
	assert.throws(
		() =>
			planBatchEdits("alpha beta", [
				{ old_string: "alpha", new_string: "beta" },
				{ old_string: "beta", new_string: "gamma" },
			]),
		/Edit 2: old_string has 2 matches/,
	);
});

test("CRLF inputs and file contents normalize while the BOM remains intact", () => {
	const original = "\uFEFFalpha\r\nbeta\r\n";
	const plan = planBatchEdits(original, [
		{ old_string: "alpha\r\nbeta", new_string: "gamma\r\ndelta" },
		{ old_string: "gamma\ndelta\r\n", new_string: "final\r\n" },
	]);
	assert.equal(plan.content, "\uFEFFfinal\n");
	assert.equal(plan.edits[0]?.old_string, "alpha\nbeta");
	assert.equal(plan.edits[0]?.new_string, "gamma\ndelta");
	assert.equal(original, "\uFEFFalpha\r\nbeta\r\n");
	assert.throws(
		() =>
			planBatchEdits(original, [
				{ old_string: "\uFEFFalpha", new_string: "gamma" },
			]),
		/not found/,
	);
});

test("empty replacements follow stock trailing-newline deletion semantics", () => {
	const plan = planBatchEdits("\uFEFFalpha\r\nbeta\r\n", [
		{ old_string: "alpha", new_string: "" },
		{ old_string: "beta\n", new_string: "gamma\n" },
	]);
	assert.equal(plan.content, "\uFEFFgamma\n");
	const all = planBatchEdits("alpha\nalpha tail", [
		{ old_string: "alpha", new_string: "", replace_all: true },
	]);
	assert.equal(all.content, "alpha tail");
	assert.equal(all.edits[0]?.replacements, 1);
});

test("replacement dollar patterns are literal and valid Unicode is retained", () => {
	assert.equal(
		planBatchEdits("alpha", [
			{ old_string: "alpha", new_string: "$& $` $' 🙂" },
		]).content,
		"$& $` $' 🙂",
	);
	for (const new_string of ["\ud800", "\udc00"]) {
		assert.throws(
			() => planBatchEdits("alpha", [{ old_string: "alpha", new_string }]),
			/valid Unicode/,
		);
	}
});

test("snapshot decoding preserves UTF-8, CRLF, and exactly the original BOM bytes", () => {
	for (const original of [
		"",
		"alpha\r\nbeta\n",
		"\uFEFFalpha\r\n🙂 café\r\n",
		"\uFEFF\uFEFFalpha\r\n",
		"literal replacement character: \uFFFD",
	]) {
		assert.equal(decodeBatchEditOriginal(base64(original)), original);
	}
});

test("snapshot decoding refuses non-UTF-8 and NUL-bearing binary files", () => {
	for (const bytes of [
		[0xff],
		[0xc0, 0xaf],
		[0xe2, 0x82],
		[0xed, 0xa0, 0x80],
		[0xff, 0xfe, 0x61, 0x00],
		[0x61, 0x00, 0x62],
	]) {
		assert.throws(
			() => decodeBatchEditOriginal(Buffer.from(bytes).toString("base64")),
			/roundtrippable UTF-8/,
		);
	}
});

for (const rollbackFails of [false, true]) {
	test(`a thrown core call reports ${rollbackFails ? "failed" : "successful"} rollback`, async () => {
		const original = "\uFEFFalpha\r\nbeta\r\n";
		let content = original;
		let writes = 0;
		function read(path: string): Promise<string>;
		function read(path: string, options: FsReadBytesOptions): Promise<FsBytes>;
		function read(
			path: string,
			options: FsReadOptions,
		): Promise<string | FsBytes>;
		async function read(
			_path: string,
			options?: FsReadOptions,
		): Promise<string | FsBytes> {
			return options?.as === "bytes" ? { base64: base64(content) } : content;
		}
		const result = await executeBatchEdit(
			{
				fs: {
					read,
					write: async (path, text) => {
						assert.equal(path, PATH);
						writes++;
						if (rollbackFails) throw new Error("write refused");
						content = text;
					},
				},
				tool: {
					check: async () => ({ decision: "allow" }),
					call: async () => {
						content = "\uFEFFchanged\r\nbeta\r\n";
						throw new Error("core call interrupted");
					},
				},
			},
			{
				file_path: PATH,
				edits: [{ old_string: "alpha", new_string: "changed" }],
			},
		);
		assert.ok(result.deny);
		assert.match(result.deny, /failed at edit 1: core call interrupted/);
		assert.match(
			result.deny,
			rollbackFails ? /Rollback failed: write refused/ : /Rollback succeeded/,
		);
		assert.equal(writes, 1);
		assert.equal(
			content,
			rollbackFails ? "\uFEFFchanged\r\nbeta\r\n" : original,
		);
	});
}
