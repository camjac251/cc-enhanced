import assert from "node:assert/strict";
import { test } from "node:test";
import {
	decodeViewText,
	parseViewRange,
	renderViewRanges,
	renderViewText,
	requiresCoreRead,
	resolveViewRange,
	VIEW_MAX_CHARS,
	VIEW_MAX_LINES,
	VIEW_READ_CHUNK_BYTES,
	type ViewByteReader,
	type ViewRange,
} from "../../plugin/hooks/view.js";

const RANGE_CASES: ReadonlyArray<{
	input: string;
	parsed: ViewRange;
	start: number;
	end: number;
}> = [
	{
		input: "30:40",
		parsed: { kind: "bounds", start: 30, end: 40 },
		start: 30,
		end: 40,
	},
	{
		input: "30:",
		parsed: { kind: "bounds", start: 30 },
		start: 30,
		end: 120,
	},
	{
		input: ":40",
		parsed: { kind: "bounds", start: 1, end: 40 },
		start: 1,
		end: 40,
	},
	{
		input: "-30:",
		parsed: { kind: "tail", count: 30 },
		start: 91,
		end: 120,
	},
	{
		input: "50:+20",
		parsed: { kind: "count", start: 50, count: 20 },
		start: 50,
		end: 69,
	},
	{
		input: "100::10",
		parsed: { kind: "context", line: 100, context: 10 },
		start: 90,
		end: 110,
	},
];

for (const { input, parsed, start, end } of RANGE_CASES) {
	test(`view parses and renders ${input} with inclusive numbered lines`, () => {
		assert.deepEqual(parseViewRange(input, "source.txt"), parsed);
		assert.deepEqual(resolveViewRange(parsed, 120), { start, end });
		const text = Array.from({ length: 120 }, (_, index) => `line ${index + 1}`)
			.join("\n")
			.concat("\n");
		const width = String(end).length;
		const expected = Array.from({ length: end - start + 1 }, (_, index) => {
			const line = start + index;
			return `${String(line).padStart(width)} │ line ${line}`;
		}).join("\n");
		assert.equal(renderViewText(text, parsed), expected);
	});
}

for (const input of [
	"",
	":",
	"30",
	"30:40:50",
	"30-40",
	"30:20",
	"0:40",
	":0",
	"-0:",
	"-30:40",
	"30:-1",
	"50:+0",
	"0:+20",
	"0::10",
	"100::-1",
	"100::",
	"::10",
	"1.5:20",
	"1e2:200",
	"+30:40",
	" 30:40",
	"30:40 ",
	"30:40\n",
	"30:\r\n",
	"-30:\n",
	"50:+20\n",
	"100::10\n",
	"NaN:40",
	"1:Infinity",
	"9007199254740992:",
	"1:9007199254740992",
	"-9007199254740992:",
	"1:+9007199254740992",
	"1::9007199254740992",
]) {
	test(`view refuses invalid range ${JSON.stringify(input)}`, () => {
		assert.throws(() => parseViewRange(input, "source.txt"), /Invalid range/);
	});
}

test("view clamps selections at file boundaries without remapping past-EOF starts", () => {
	for (const [input, expected] of [
		["1:100", { start: 1, end: 5 }],
		["-30:", { start: 1, end: 5 }],
		["3:+20", { start: 3, end: 5 }],
		["2::10", { start: 1, end: 5 }],
		["3::0", { start: 3, end: 3 }],
		["6:", { start: 6, end: 5 }],
		["6:+1", { start: 6, end: 5 }],
		["9007199254740991:+9007199254740991", { start: 9007199254740991, end: 5 }],
		["1::9007199254740991", { start: 1, end: 5 }],
	] as const) {
		assert.deepEqual(
			resolveViewRange(parseViewRange(input, "file.txt"), 5),
			expected,
		);
	}
	assert.equal(
		renderViewText("one\ntwo\n", parseViewRange("3:", "file.txt")),
		"[no lines in the requested range; file has 2 lines]",
	);
});

test("view uses bat-like glyphs for spaces, tabs, CR, and LF without adding an EOF line", () => {
	const text = " a\t\r\n\tb  \nc\rd";
	const range = parseViewRange(undefined, "file.txt");
	assert.equal(
		renderViewText(text, range, true),
		"1 │ ·a→␍␊\n2 │ →b··␊\n3 │ c␍d",
	);
	assert.equal(renderViewText(text, range), "1 │  a\t\n2 │ \tb  \n3 │ c␍d");
	assert.equal(renderViewText("\r\n\n", range, true), "1 │ ␍␊\n2 │ ␊");
	assert.equal(renderViewText("\r\n\n", range), "1 │ \n2 │ ");
	assert.equal(renderViewText("last\n", range, true), "1 │ last␊");
	assert.equal(renderViewText("last", range, true), "1 │ last");
});

test("view handles empty files and whitespace-only final lines", () => {
	const range = parseViewRange(undefined, "file.txt");
	assert.equal(renderViewText("", range), "[empty file]");
	assert.equal(renderViewText("\n", range), "1 │ ");
	assert.equal(renderViewText("\n ", range, true), "1 │ ␊\n2 │ ·");
	assert.deepEqual(resolveViewRange(parseViewRange("-30:", "file.txt"), 0), {
		start: 1,
		end: 0,
	});
});

test("view defaults .output files to the last 500 lines, only when range is omitted", () => {
	const text = Array.from({ length: 600 }, (_, index) => `line ${index + 1}`)
		.join("\n")
		.concat("\n");
	const range = parseViewRange(undefined, "/work/task.output");
	assert.deepEqual(range, { kind: "tail", count: 500 });
	assert.deepEqual(parseViewRange(undefined, "TASK.OUTPUT"), range);
	const rendered = renderViewText(text, range);
	assert.equal(rendered.split("\n").length, 500);
	assert(rendered.startsWith("101 │ line 101\n"));
	assert(rendered.endsWith("600 │ line 600"));
	assert(!rendered.includes("truncated"));
	assert.equal(
		renderViewText(text, parseViewRange("1:2", "task.output")),
		"1 │ line 1\n2 │ line 2",
	);
	assert.deepEqual(parseViewRange(undefined, "task.output.txt"), {
		kind: "bounds",
		start: 1,
	});
	assert.equal(
		renderViewText("one\ntwo\n", parseViewRange(undefined, "short.output")),
		"1 │ one\n2 │ two",
	);
});

test("view caps content lines and reports omitted output explicitly", () => {
	const range = parseViewRange(undefined, "file.txt");
	const exact = renderViewText("line\n".repeat(VIEW_MAX_LINES), range);
	assert.equal(exact.split("\n").length, VIEW_MAX_LINES);
	assert(!exact.includes("truncated"));
	const truncated = renderViewText("line\n".repeat(VIEW_MAX_LINES + 1), range);
	const rows = truncated.split("\n");
	assert.equal(rows.length, VIEW_MAX_LINES + 1);
	assert.equal(rows[VIEW_MAX_LINES - 1], `${VIEW_MAX_LINES} │ line`);
	assert.match(
		rows[VIEW_MAX_LINES] ?? "",
		/view truncated.*content lines.*narrower range/,
	);
	assert(truncated.length <= VIEW_MAX_CHARS);
});

test("view caps characters including numbering and its truncation notice", () => {
	const range = parseViewRange(undefined, "file.txt");
	const exact = renderViewText("x".repeat(VIEW_MAX_CHARS - 4), range);
	assert.equal(exact.length, VIEW_MAX_CHARS);
	assert(!exact.includes("truncated"));
	const truncated = renderViewText("x".repeat(VIEW_MAX_CHARS - 3), range);
	assert(truncated.length <= VIEW_MAX_CHARS);
	assert(truncated.startsWith("1 │ x"));
	assert.match(
		truncated,
		/\n\[view truncated:.*characters, including this note/,
	);
	assert.equal(truncated.split("\n").length, 2);
});

test("view budgets visible LF and never truncates through a Unicode surrogate pair", () => {
	const range = parseViewRange(undefined, "file.txt");
	const withLf = renderViewText(
		`${" ".repeat(VIEW_MAX_CHARS - 4)}\n`,
		range,
		true,
	);
	assert(withLf.length <= VIEW_MAX_CHARS);
	assert(withLf.startsWith("1 │ ·"));
	assert.match(withLf, /view truncated/);
	const unicode = renderViewText("𐐀".repeat(VIEW_MAX_CHARS), range, true);
	assert(unicode.length <= VIEW_MAX_CHARS);
	assert.match(unicode, /view truncated/);
	assert.equal(Buffer.from(unicode).toString("utf8"), unicode);
});

test("view accepts exact UTF-8 text bytes, including BOM, CRLF, and literal replacement characters", () => {
	for (const text of [
		"",
		"plain\r\n",
		"café 音 𐐀\n",
		"\uFEFFtext",
		"\uFEFF\uFEFFtext",
		"literal �",
	]) {
		assert.equal(decodeViewText(Buffer.from(text).toString("base64")), text);
	}
});

test("view rejects non-UTF-8, binary controls, terminal escapes, and PDF content", () => {
	for (const bytes of [
		Buffer.from([0xff]),
		Buffer.from([0xc3, 0x28]),
		Buffer.from([0xef, 0xbb, 0xbf, 0xff]),
		Buffer.from([0xff, 0xfe, 0x61, 0x00]),
		Buffer.from("text\0binary"),
		Buffer.from("text\x01binary"),
		Buffer.from("\x1b[31mred\x1b[0m"),
		Buffer.from("%PDF-1.7\n"),
		Buffer.from("\uFEFF%PDF-1.7\n"),
	]) {
		assert.throws(
			() => decodeViewText(bytes.toString("base64")),
			/UTF-8 text only.*Read/,
		);
	}
});

// Fixed-width 16-byte lines: line n ends at byte 16 * n, so the line numbered
// EDGE_LINE starts 16 bytes before the first chunk boundary.
const EDGE_LINE = VIEW_READ_CHUNK_BYTES / 16;

function filler(from: number, count: number): string {
	return Array.from(
		{ length: count },
		(_, index) => `${String(from + index).padStart(15, "0")}\n`,
	).join("");
}

function largeFile(edge: Buffer | string, after = 2_000): Buffer {
	return Buffer.concat([
		Buffer.from(filler(1, EDGE_LINE - 1)),
		Buffer.from(edge),
		Buffer.from(filler(EDGE_LINE + 1, after)),
	]);
}

function rangeReader(
	file: Buffer,
	reads: Array<[number, number]> = [],
): ViewByteReader {
	return async (offset, length) => {
		reads.push([offset, length]);
		return new Uint8Array(file.subarray(offset, offset + length));
	};
}

test("view reads files over one chunk by ranges and matches whole-text rendering", async () => {
	// U+97F3 occupies the last byte of the first chunk and two of the second.
	const multibyte = largeFile(`${"a".repeat(15)}音 edge\n`);
	assert.equal(multibyte[VIEW_READ_CHUNK_BYTES - 1], 0xe9);
	// CR ends the first chunk and its LF begins the second.
	const crlf = largeFile(`${"b".repeat(15)}\r\n`);
	assert.equal(crlf[VIEW_READ_CHUNK_BYTES - 1], 0x0d);
	assert.equal(crlf[VIEW_READ_CHUNK_BYTES], 0x0a);
	for (const file of [multibyte, crlf]) {
		const text = file.toString("utf8");
		for (const [input, path] of [
			["-3:", "big.txt"],
			[undefined, "big.output"],
			["-1500:", "big.txt"],
			[`${EDGE_LINE - 1}:${EDGE_LINE + 2}`, "big.txt"],
			[`${EDGE_LINE}::1`, "big.txt"],
			[`${EDGE_LINE + 1}:+2`, "big.txt"],
			[`${EDGE_LINE}:${EDGE_LINE}`, "big.txt"],
			["2:3", "big.txt"],
			["1:", "big.txt"],
			["300000:", "big.txt"],
		] as const) {
			for (const showWhitespace of [false, true]) {
				const range = parseViewRange(input, path);
				const reads: Array<[number, number]> = [];
				assert.equal(
					await renderViewRanges(
						rangeReader(file, reads),
						range,
						showWhitespace,
					),
					renderViewText(text, range, showWhitespace),
					`${input} ${showWhitespace}`,
				);
				for (const [, length] of reads) {
					assert(length <= VIEW_READ_CHUNK_BYTES);
				}
			}
		}
	}
	assert.equal(
		await renderViewRanges(
			rangeReader(multibyte),
			parseViewRange(`${EDGE_LINE - 1}:${EDGE_LINE + 1}`, "big.txt"),
		),
		[
			`${EDGE_LINE - 1} │ ${String(EDGE_LINE - 1).padStart(15, "0")}`,
			`${EDGE_LINE} │ aaaaaaaaaaaaaaa音 edge`,
			`${EDGE_LINE + 1} │ ${String(EDGE_LINE + 1).padStart(15, "0")}`,
		].join("\n"),
	);
	assert.equal(
		await renderViewRanges(
			rangeReader(crlf),
			parseViewRange(`${EDGE_LINE}:+2`, "big.txt"),
			true,
		),
		`${EDGE_LINE} │ ${"b".repeat(15)}␍␊\n${EDGE_LINE + 1} │ ${String(EDGE_LINE + 1).padStart(15, "0")}␊`,
	);
	assert.equal(
		await renderViewRanges(
			rangeReader(multibyte),
			parseViewRange("-2:", "big.txt"),
		),
		[EDGE_LINE + 1999, EDGE_LINE + 2000]
			.map((line) => `${line} │ ${String(line).padStart(15, "0")}`)
			.join("\n"),
	);
});

test("view stops its line scan at the last requested line of a large file", async () => {
	const reads: Array<[number, number]> = [];
	assert.equal(
		await renderViewRanges(
			rangeReader(largeFile(`${"c".repeat(15)}\n`), reads),
			parseViewRange("2:3", "big.txt"),
		),
		"2 │ 000000000000002\n3 │ 000000000000003",
	);
	assert(reads.length > 0);
	for (const [offset] of reads) assert(offset < VIEW_READ_CHUNK_BYTES);
});

test("view refuses nontext or malformed UTF-8 found beyond the first chunk", async () => {
	const range = parseViewRange("-1:", "big.txt");
	for (const file of [
		largeFile(`${"d".repeat(16)}\0\n`),
		largeFile(
			Buffer.concat([
				Buffer.from("e".repeat(15)),
				Buffer.from([0xe9]),
				Buffer.from("x\n"),
			]),
		),
	]) {
		await assert.rejects(
			renderViewRanges(rangeReader(file), range),
			/UTF-8 text only/,
		);
	}
});

test("view routes image, PDF, and notebook filenames to core Read", () => {
	for (const path of [
		"image.png",
		"IMAGE.JPEG",
		"scan.tiff",
		"icon.svg",
		"photo.webp",
		"paper.PDF",
		"analysis.ipynb",
	]) {
		assert.equal(requiresCoreRead(path), true, path);
	}
	for (const path of [
		"image.png.ts",
		"README",
		"script.py",
		"task.output",
		"notebook.json",
	]) {
		assert.equal(requiresCoreRead(path), false, path);
	}
});
