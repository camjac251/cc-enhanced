import type { On, ToolSpec } from "claude-code";
import { expect, test } from "claude-code/testing";

const TOOL = "mcp__cc-enhanced__batch_edit";
const PATH = "/work/example.txt";
const CORE = { plugin: "engine", tier: "core" } as const;

type EditInput = {
	file_path: string;
	old_string: string;
	new_string: string;
	replace_all?: boolean;
};

type FixtureOptions = {
	after?: string[];
	failAt?: number;
	failure?: "deny" | "error" | "staged";
	mutateOnFailure?: boolean;
	permission?: "allow" | "ask" | "deny";
	invalidBytes?: string;
	ignoreRestore?: boolean;
};

function base64(text: string): string {
	return btoa(
		Array.from(new TextEncoder().encode(text), (byte) =>
			String.fromCharCode(byte),
		).join(""),
	);
}

function mockFile(on: On, original: string, options: FixtureOptions = {}) {
	const fixture = {
		content: original,
		calls: [] as EditInput[],
		writes: [] as string[],
		events: [] as string[],
	};
	on("tool.check", { tool: "Read" }, (_$, e) => {
		expect(e.input).toEqual({ file_path: PATH });
		fixture.events.push("check Read");
		return {
			decision: options.permission ?? "allow",
			reason: "fixture permission",
		};
	});
	on("fs.read", (_$, e) => {
		expect(e.path).toBe(PATH);
		expect(e.as).toBe("bytes");
		fixture.events.push("read bytes");
		return {
			value: { base64: options.invalidBytes ?? base64(fixture.content) },
		};
	});
	on("fs.write", (_$, e) => {
		expect(e.path).toBe(PATH);
		fixture.events.push("restore");
		fixture.writes.push(e.text);
		if (!options.ignoreRestore) fixture.content = e.text;
		return { value: undefined };
	});
	on("tool.call", { tool: "Edit" }, (_$, e) => {
		const input = {
			file_path: e.file_path,
			old_string: e.old_string,
			new_string: e.new_string,
			replace_all: e.replace_all,
		};
		fixture.calls.push(input);
		const number = fixture.calls.length;
		fixture.events.push(`Edit ${number}`);
		const fails = options.failAt === number;
		const before = fixture.content;
		if (!fails || options.mutateOnFailure) {
			const after = options.after?.[number - 1];
			expect(typeof after).toBe("string");
			if (after !== undefined) fixture.content = after;
		}
		if (fails && options.failure === "error") {
			return { result: "core error", text: "Core Edit failed.", isError: true };
		}
		if (fails && options.failure !== "staged") {
			return { deny: "Core Edit denied." };
		}
		return {
			result: {
				filePath: e.file_path,
				oldString: e.old_string,
				newString: e.new_string,
				originalFile: before,
				structuredPatch: [],
				userModified: false,
				replaceAll: e.replace_all ?? false,
				...(fails ? { staged: true } : {}),
			},
		};
	});
	return fixture;
}

for (const [name, edits] of [
	["empty old_string", [{ old_string: "", new_string: "insert" }]],
	["identical replacement", [{ old_string: "alpha", new_string: "alpha" }]],
	[
		"missing later anchor",
		[
			{ old_string: "alpha", new_string: "beta" },
			{ old_string: "missing", new_string: "gamma" },
		],
	],
	[
		"duplicate later anchor",
		[
			{ old_string: "alpha", new_string: "tail" },
			{ old_string: "tail", new_string: "gamma" },
		],
	],
] as const) {
	test(`batch_edit performs no core Edit for ${name}`, async ($, on) => {
		const fixture = mockFile(on, "alpha tail\n");
		const result = await $.tool.call({ tool: TOOL, file_path: PATH, edits });
		expect(result.deny).toContain("Batch edit rejected:");
		expect(result.deny).toContain("No edits applied.");
		expect(fixture.content).toBe("alpha tail\n");
		expect(fixture.calls).toEqual([]);
		expect(fixture.writes).toEqual([]);
		expect(fixture.events).toEqual(["check Read", "read bytes"]);
	});
}

test("batch_edit executes core Edit sequentially with dependent anchors", async ($, on) => {
	const fixture = mockFile(on, "alpha tail\n", {
		after: ["beta tail\n", "gamma\n"],
	});
	const result = await $.tool.call({
		tool: TOOL,
		file_path: PATH,
		edits: [
			{ old_string: "alpha", new_string: "beta" },
			{ old_string: "beta tail", new_string: "gamma" },
		],
	});
	expect(fixture.calls).toEqual([
		{
			file_path: PATH,
			old_string: "alpha",
			new_string: "beta",
			replace_all: false,
		},
		{
			file_path: PATH,
			old_string: "beta tail",
			new_string: "gamma",
			replace_all: false,
		},
	]);
	expect(fixture.content).toBe("gamma\n");
	expect(fixture.writes).toEqual([]);
	expect(fixture.events).toEqual([
		"check Read",
		"read bytes",
		"Edit 1",
		"Edit 2",
	]);
	expect(result.result).toBe(
		`Updated ${PATH}:\n1. Replaced 1 occurrence.\n2. Replaced 1 occurrence.`,
	);
});

test("batch_edit forwards replace_all and reports its replacement count", async ($, on) => {
	const fixture = mockFile(on, "alpha alpha\n", {
		after: ["beta beta\n"],
	});
	const result = await $.tool.call({
		tool: TOOL,
		file_path: PATH,
		edits: [{ old_string: "alpha", new_string: "beta", replace_all: true }],
	});
	expect(fixture.calls[0]?.replace_all).toBe(true);
	expect(fixture.content).toBe("beta beta\n");
	expect(result.result).toContain("1. Replaced 2 occurrences.");
});

test("batch_edit passes LF-normalized strings to core Edit on BOM/CRLF text", async ($, on) => {
	const fixture = mockFile(on, "\uFEFFalpha\r\nbeta\r\n", {
		after: ["\uFEFFgamma\r\ndelta\r\n", "\uFEFFfinal\r\n"],
	});
	const result = await $.tool.call({
		tool: TOOL,
		file_path: PATH,
		edits: [
			{ old_string: "alpha\r\nbeta", new_string: "gamma\r\ndelta" },
			{ old_string: "gamma\ndelta\r\n", new_string: "final\r\n" },
		],
	});
	expect(fixture.calls).toEqual([
		{
			file_path: PATH,
			old_string: "alpha\nbeta",
			new_string: "gamma\ndelta",
			replace_all: false,
		},
		{
			file_path: PATH,
			old_string: "gamma\ndelta\n",
			new_string: "final\n",
			replace_all: false,
		},
	]);
	expect(fixture.content).toBe("\uFEFFfinal\r\n");
	expect(result.result).toContain("2. Replaced 1 occurrence.");
});

for (const failure of ["deny", "error", "staged"] as const) {
	test(`batch_edit restores BOM/CRLF bytes when core Edit returns ${failure} midway`, async ($, on) => {
		const original = "\uFEFFalpha\r\nbeta\r\n";
		const fixture = mockFile(on, original, {
			after: ["\uFEFFgamma\r\nbeta\r\n", "\uFEFFgamma\r\ndelta\r\n"],
			failAt: 2,
			failure,
			mutateOnFailure: failure === "error",
		});
		const result = await $.tool.call({
			tool: TOOL,
			file_path: PATH,
			edits: [
				{ old_string: "alpha", new_string: "gamma" },
				{ old_string: "beta", new_string: "delta" },
				{ old_string: "gamma", new_string: "final" },
			],
		});
		expect(fixture.calls.length).toBe(2);
		expect(fixture.writes).toEqual([original]);
		expect(base64(fixture.content)).toBe(base64(original));
		expect(fixture.events).toEqual([
			"check Read",
			"read bytes",
			"Edit 1",
			"Edit 2",
			"read bytes",
			"restore",
			"read bytes",
		]);
		expect(result.deny).toContain("Batch edit failed at edit 2:");
		expect(result.deny).toContain("2. Failed; later edits were not run.");
		expect(result.deny).toContain(
			"Rollback succeeded: original bytes restored",
		);
	});
}

test("batch_edit does not write on an unchanged first-call denial", async ($, on) => {
	const fixture = mockFile(on, "alpha\n", {
		failAt: 1,
		failure: "deny",
	});
	const result = await $.tool.call({
		tool: TOOL,
		file_path: PATH,
		edits: [{ old_string: "alpha", new_string: "beta" }],
	});
	expect(fixture.calls.length).toBe(1);
	expect(fixture.writes).toEqual([]);
	expect(fixture.content).toBe("alpha\n");
	expect(result.deny).toContain(
		"Rollback not needed: original bytes are unchanged.",
	);
});

test("batch_edit reports a rollback that did not restore the original bytes", async ($, on) => {
	const fixture = mockFile(on, "alpha beta\n", {
		after: ["gamma beta\n"],
		failAt: 2,
		ignoreRestore: true,
	});
	const result = await $.tool.call({
		tool: TOOL,
		file_path: PATH,
		edits: [
			{ old_string: "alpha", new_string: "gamma" },
			{ old_string: "beta", new_string: "delta" },
		],
	});
	expect(fixture.content).toBe("gamma beta\n");
	expect(fixture.writes).toEqual(["alpha beta\n"]);
	expect(result.deny).toContain(
		"Rollback failed: restored bytes did not match the original.",
	);
});

for (const permission of ["ask", "deny"] as const) {
	test(`batch_edit does not read bytes or edit when Read permission is ${permission}`, async ($, on) => {
		const fixture = mockFile(on, "alpha\n", { permission });
		const result = await $.tool.call({
			tool: TOOL,
			file_path: PATH,
			edits: [{ old_string: "alpha", new_string: "beta" }],
		});
		expect(fixture.events).toEqual(["check Read"]);
		expect(fixture.calls).toEqual([]);
		expect(fixture.writes).toEqual([]);
		expect(result.deny).toContain(`Read permission is ${permission}`);
	});
}

test("batch_edit rejects bytes that a text rollback could not preserve", async ($, on) => {
	const fixture = mockFile(on, "alpha\n", {
		invalidBytes: "/2FscGhhCg==",
	});
	const result = await $.tool.call({
		tool: TOOL,
		file_path: PATH,
		edits: [{ old_string: "alpha", new_string: "beta" }],
	});
	expect(fixture.calls).toEqual([]);
	expect(fixture.writes).toEqual([]);
	expect(result.deny).toContain("Only roundtrippable UTF-8 text files");
});

test("batch_edit registers nondeferred after session.start completes", async ($, on) => {
	const events: string[] = [];
	let registered: ToolSpec | undefined;
	on("session.start", (_$, e) => {
		events.push("started");
		return { cwd: e.cwd };
	});
	on("clock.now", () => ({ value: 0 }));
	on("tool.register", (_$, e) => {
		if (e.name === "batch_edit") {
			events.push("registered");
			registered = e;
		}
		return { value: { tool: `mcp__cc-enhanced__${e.name}` } };
	});
	expect(
		await $.session.start({
			cwd: "/work",
			surface: null,
			isInteractive: false,
		}),
	).toEqual({
		cwd: "/work",
	});
	expect(events).toEqual(["started", "registered"]);
	expect(registered?.isDeferred).toBe(false);
	expect(registered?.inputSchema?.required).toEqual(["file_path", "edits"]);
});

test("Edit description points to batch_edit without losing downstream fields", async ($, on) => {
	on("tool.describe", () => ({
		description: "Composed Edit description.",
		isDeferred: false,
	}));
	const result = await $.tool.describe({
		tool: "Edit",
		description: "Stale input.",
		provider: CORE,
	});
	expect(result.description).toContain("Composed Edit description.");
	expect(result.description).toContain(TOOL);
	expect(result.isDeferred).toBe(false);
});

test("Edit description append is idempotent and restricted to engine/core", async ($, on) => {
	on("tool.describe", (_$, e) => ({ description: e.description }));
	const once = await $.tool.describe({
		tool: "Edit",
		description: "Native Edit.",
		provider: CORE,
	});
	expect(
		await $.tool.describe({
			tool: "Edit",
			description: once.description,
			provider: CORE,
		}),
	).toEqual(once);
	for (const provider of [
		{ plugin: "another-plugin", tier: "user" },
		{ plugin: "engine", tier: "user" },
	] as const) {
		expect(
			await $.tool.describe({
				tool: "Edit",
				description: "Foreign Edit.",
				provider,
			}),
		).toEqual({
			description: "Foreign Edit.",
		});
	}
});
