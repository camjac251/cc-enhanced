import type { RegisteredToolSpec } from "claude-code";
import { expect, test } from "claude-code/testing";

const VIEW = "mcp__cc-enhanced__view";
const CORE = { plugin: "engine", tier: "core" } as const;
const SMALL_FILE = {
	kind: "file",
	size: 64,
	mtimeMs: 0,
	isLink: false,
} as const;
const CHUNK = 4 * 1024 * 1024;
// Fixed-width 16-byte lines: the line numbered EDGE_LINE starts 16 bytes
// before the first 4 MiB chunk boundary.
const EDGE_LINE = CHUNK / 16;

function numbered(from: number, count: number): string {
	return Array.from(
		{ length: count },
		(_, index) => `${String(from + index).padStart(15, "0")}\n`,
	).join("");
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let index = 0; index < bytes.length; index += 0x2000) {
		binary += String.fromCharCode(...bytes.subarray(index, index + 0x2000));
	}
	return btoa(binary);
}

for (const decision of ["deny", "ask"] as const) {
	test(`view refuses Read ${decision} before any filesystem access`, async ($, on) => {
		let checks = 0;
		let accesses = 0;
		on("tool.check", { tool: "Read" }, (_$, e) => {
			checks++;
			expect(e.input).toEqual({ file_path: "/work/private.txt" });
			return { decision, reason: "Read policy requires approval." };
		});
		on("fs.*", () => {
			accesses++;
			return { deny: "No file access should occur." };
		});
		const answer = await $.tool.call({
			tool: VIEW,
			file_path: "/work/private.txt",
			range: "2:3",
		});
		expect(checks).toBe(1);
		expect(accesses).toBe(0);
		expect(answer.deny).toContain("view did not access the file");
		expect(answer.deny).toContain("Read policy requires approval.");
		expect(answer.result).toBeUndefined();
		if (decision === "ask") {
			expect(answer.deny).toContain("Use Read to request it");
		}
	});
}

test("view checks the actual path, stats it, reads bytes once, and returns its requested line range", async ($, on) => {
	const calls: string[] = [];
	on("tool.check", { tool: "Read" }, (_$, e) => {
		expect(e.input).toEqual({ file_path: "/work/source.txt" });
		calls.push("Read check");
		return { decision: "allow" };
	});
	on("fs.stat", (_$, e) => {
		expect(e.path).toBe("/work/source.txt");
		calls.push("stat");
		return { value: SMALL_FILE };
	});
	on("fs.read", (_$, e) => {
		expect(e.path).toBe("/work/source.txt");
		expect(e.as).toBe("bytes");
		expect(e.offset).toBeUndefined();
		expect(e.length).toBeUndefined();
		calls.push("read bytes");
		return { value: { base64: btoa("first\nsecond\nthird\nfourth\n") } };
	});
	const answer = await $.tool.call({
		tool: VIEW,
		file_path: "/work/source.txt",
		range: "2:3",
	});
	expect(calls).toEqual(["Read check", "stat", "read bytes"]);
	expect(answer.deny).toBeUndefined();
	expect(answer.result).toBe("2 │ second\n3 │ third");
});

test("view renders whitespace and CRLF through the mod engine", async ($, on) => {
	on("tool.check", { tool: "Read" }, () => ({ decision: "allow" }));
	on("fs.stat", () => ({ value: SMALL_FILE }));
	on("fs.read", () => ({ value: { base64: btoa(" a\t\r\nlast\n") } }));
	const answer = await $.tool.call({
		tool: VIEW,
		file_path: "/work/whitespace.txt",
		show_whitespace: true,
	});
	expect(answer.result).toBe("1 │ ·a→␍␊\n2 │ last␊");
});

test("view preserves UTF-8 and BOM with the engine's decoder", async ($, on) => {
	const text = "\uFEFFcafé 音 𐐀\r\nsecond\n";
	const base64 = btoa(String.fromCharCode(...new TextEncoder().encode(text)));
	on("tool.check", { tool: "Read" }, () => ({ decision: "allow" }));
	on("fs.stat", () => ({ value: SMALL_FILE }));
	on("fs.read", () => ({ value: { base64 } }));
	const answer = await $.tool.call({
		tool: VIEW,
		file_path: "/work/unicode.txt",
		range: "1:1",
	});
	expect(answer.result).toBe("1 │ \uFEFFcafé 音 𐐀");
});

test("view defaults .output to the last 500 lines in real dispatch", async ($, on) => {
	const text = Array.from(
		{ length: 502 },
		(_, index) => `line ${index + 1}`,
	).join("\n");
	on("tool.check", { tool: "Read" }, () => ({ decision: "allow" }));
	on("fs.stat", () => ({ value: SMALL_FILE }));
	on("fs.read", () => ({ value: { base64: btoa(text) } }));
	const answer = await $.tool.call({
		tool: VIEW,
		file_path: "/work/task.output",
	});
	const expected = Array.from({ length: 500 }, (_, index) => {
		const line = index + 3;
		return `${String(line).padStart(3)} │ line ${line}`;
	}).join("\n");
	expect(answer.result).toBe(expected);
});

test(
	"view reads a file over 4 MiB by byte ranges: its tail, and a range across a chunk edge that splits a character",
	{
		timeoutMs: 30_000,
	},
	async ($, on) => {
		// U+97F3 occupies the last byte of the first chunk and two of the second.
		const file = new TextEncoder().encode(
			`${numbered(1, EDGE_LINE - 1)}${"a".repeat(15)}音 edge\n${numbered(EDGE_LINE + 1, 1_000)}`,
		);
		expect(file[CHUNK - 1]).toBe(0xe9);
		const reads: Array<{ offset?: number; length?: number }> = [];
		on("tool.check", { tool: "Read" }, () => ({ decision: "allow" }));
		on("fs.stat", (_$, e) => {
			expect(e.path).toBe("/work/large.output");
			return {
				value: { kind: "file", size: file.length, mtimeMs: 0, isLink: false },
			};
		});
		on("fs.read", (_$, e) => {
			expect(e.path).toBe("/work/large.output");
			expect(e.as).toBe("bytes");
			reads.push({ offset: e.offset, length: e.length });
			// Answering in the host's place, the hook cuts its answer to the range.
			const offset = e.offset ?? 0;
			const end = e.length === undefined ? file.length : offset + e.length;
			return { value: { base64: toBase64(file.subarray(offset, end)) } };
		});
		const row = (line: number) => `${line} │ ${String(line).padStart(15, "0")}`;
		const tail = await $.tool.call({
			tool: VIEW,
			file_path: "/work/large.output",
			range: "-2:",
		});
		expect(tail.deny).toBeUndefined();
		expect(tail.result).toBe(
			`${row(EDGE_LINE + 999)}\n${row(EDGE_LINE + 1_000)}`,
		);
		const edge = await $.tool.call({
			tool: VIEW,
			file_path: "/work/large.output",
			range: `${EDGE_LINE - 1}:+3`,
		});
		expect(edge.deny).toBeUndefined();
		expect(edge.result).toBe(
			`${row(EDGE_LINE - 1)}\n${EDGE_LINE} │ ${"a".repeat(15)}音 edge\n${row(EDGE_LINE + 1)}`,
		);
		expect(reads.length).toBeGreaterThan(0);
		for (const { offset, length } of reads) {
			expect(offset).toBeDefined();
			expect(length).toBeDefined();
			expect(length ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(CHUNK);
		}
	},
);

for (const [kind, described] of [
	["dir", "a directory"],
	["other", "not a regular file"],
] as const) {
	test(`view refuses a path whose stat kind is ${kind} without reading it`, async ($, on) => {
		let reads = 0;
		on("tool.check", { tool: "Read" }, () => ({ decision: "allow" }));
		on("fs.stat", () => ({
			value: { kind, size: 0, mtimeMs: 0, isLink: false },
		}));
		on("fs.read", () => {
			reads++;
			return { deny: "A non-file must not be read." };
		});
		const answer = await $.tool.call({
			tool: VIEW,
			file_path: "/work/fifo.output",
		});
		expect(reads).toBe(0);
		expect(answer.deny).toContain("regular files only");
		expect(answer.deny).toContain(`/work/fifo.output is ${described}`);
		expect(answer.deny).toContain("view did not read it");
		expect(answer.result).toBeUndefined();
	});
}

test("view reports a stat failure as a read failure without reading", async ($, on) => {
	let reads = 0;
	on("tool.check", { tool: "Read" }, () => ({ decision: "allow" }));
	on("fs.stat", () => ({ deny: "No such file." }));
	on("fs.read", () => {
		reads++;
		return { deny: "A missing file must not be read." };
	});
	const answer = await $.tool.call({
		tool: VIEW,
		file_path: "/work/missing.txt",
	});
	expect(reads).toBe(0);
	expect(answer.deny).toContain("view could not read the file");
	expect(answer.result).toBeUndefined();
});

test("view directs images, PDFs, and notebooks to Read without reading their bytes", async ($, on) => {
	let accesses = 0;
	on("tool.check", { tool: "Read" }, () => ({ decision: "allow" }));
	on("fs.*", () => {
		accesses++;
		return { deny: "Media bytes should not be read by view." };
	});
	for (const file_path of [
		"/work/image.PNG",
		"/work/paper.pdf",
		"/work/analysis.ipynb",
	]) {
		const answer = await $.tool.call({ tool: VIEW, file_path });
		expect(answer.deny).toContain("Use Read for images, PDFs, notebooks");
		expect(answer.result).toBeUndefined();
	}
	expect(accesses).toBe(0);
});

test("view detects nontext bytes even for a text filename", async ($, on) => {
	on("tool.check", { tool: "Read" }, () => ({ decision: "allow" }));
	on("fs.stat", () => ({ value: SMALL_FILE }));
	on("fs.read", () => ({ value: { base64: btoa("text\0binary") } }));
	const answer = await $.tool.call({
		tool: VIEW,
		file_path: "/work/not-text.txt",
	});
	expect(answer.deny).toContain("UTF-8 text only");
	expect(answer.deny).toContain("Use Read");
	expect(answer.result).toBeUndefined();
});

test("view rejects invalid range input before permission queries or reads", async ($, on) => {
	let checks = 0;
	let reads = 0;
	on("tool.check", () => {
		checks++;
		return { decision: "allow" };
	});
	on("fs.read", () => {
		reads++;
		return { value: { base64: btoa("unreachable") } };
	});
	for (const range of ["30:20", "-0:", "1:+0", "100::-1", 12]) {
		const answer = await $.tool.call({
			tool: VIEW,
			file_path: "/work/file.txt",
			range,
		});
		expect(answer.deny).toContain("Invalid range");
	}
	expect(checks).toBe(0);
	expect(reads).toBe(0);
});

test("view is registered nondeferred only after downstream session startup", async ($, on) => {
	let started = false;
	let registered: RegisteredToolSpec | undefined;
	on("session.start", (_$, e) => {
		started = true;
		return { cwd: e.cwd };
	});
	on("tool.register", (_$, e) => {
		expect(started).toBe(true);
		if (e.name === "view") registered = e;
		return { value: { tool: `mcp__cc-enhanced__${e.name}` } };
	});
	// Existing prompt hooks also refresh cached tool descriptions at startup.
	on("ui.invalidate", () => ({ value: undefined }));
	on("clock.now", () => ({ value: 0 }));
	expect(
		await $.session.start({
			cwd: "/work",
			surface: null,
			isInteractive: false,
		}),
	).toEqual({ cwd: "/work" });
	expect(registered).toMatchObject({
		name: "view",
		isDeferred: false,
		inputSchema: {
			type: "object",
			required: ["file_path"],
			additionalProperties: false,
			properties: {
				file_path: { type: "string" },
				range: { type: "string" },
				show_whitespace: { type: "boolean" },
			},
		},
	});
	expect(registered?.description).toContain("byte ranges of at most 4 MiB");
	expect(registered?.description).toContain("regular files only");
	expect(registered?.description).not.toContain("cannot stream");
});

test("core Read description appends view guidance to the downstream result and keeps placement", async ($, on) => {
	on("tool.describe", () => ({
		description: "Downstream Read instructions remain intact.",
		isDeferred: false,
	}));
	const answer = await $.tool.describe({
		tool: "Read",
		description: "Superseded incoming description.",
		provider: CORE,
		isDeferred: true,
	});
	expect(answer.description).toMatch(
		/^Downstream Read instructions remain intact\.\n\n/,
	);
	expect(answer.description).toContain(VIEW);
	expect(answer.description).toContain("last 500 lines");
	expect(answer.description).toContain("regular UTF-8 text files of any size");
	expect(answer.description).not.toContain("no larger than 4 MiB");
	expect(answer.description).not.toContain("Superseded");
	expect(answer.isDeferred).toBe(false);
});

test("core Read view guidance is idempotent", async ($, on) => {
	on("tool.describe", (_$, e) => ({ description: e.description }));
	const first = await $.tool.describe({
		tool: "Read",
		description: "Read a file.",
		provider: CORE,
	});
	const second = await $.tool.describe({
		tool: "Read",
		description: first.description,
		provider: CORE,
	});
	expect(first.description).toContain(VIEW);
	expect(second).toEqual(first);
});

test("view guidance is limited to engine/core Read descriptions", async ($, on) => {
	on("tool.describe", (_$, e) => ({
		description: e.description,
		isDeferred: false,
	}));
	for (const provider of [
		{ plugin: "another-plugin", tier: "user" },
		{ plugin: "engine", tier: "user" },
		{ plugin: "another-plugin", tier: "core" },
	] as const) {
		expect(
			await $.tool.describe({
				tool: "Read",
				description: "Other provider.",
				provider,
			}),
		).toEqual({ description: "Other provider.", isDeferred: false });
	}
	expect(
		await $.tool.describe({
			tool: "Unrelated",
			description: "Not Read.",
			provider: CORE,
		}),
	).toEqual({ description: "Not Read.", isDeferred: false });
});
