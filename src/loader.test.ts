import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { detectInstalledClaudeTarget } from "./installation-detection.js";
import { parse, print } from "./loader.js";
import { extractClaudeJsFromNativeBinary } from "./native.js";

test("loader falls back from module mode to script mode when needed", () => {
	const ast = parse("with (Math) { console.log(max(1, 2)); }\n");
	assert.equal(ast.program.sourceType, "script");
});

test("loader can disable script fallback when strict module parsing is required", () => {
	assert.throws(() =>
		parse("with (Math) { console.log(max(1, 2)); }\n", {
			fallbackToScript: false,
		}),
	);
});

test("loader round-trips parsed output", () => {
	const original = [
		"const answer = 42;",
		"function read(value) {",
		"\treturn value + answer;",
		"}",
		"",
	].join("\n");
	const ast = parse(original);
	const output = print(ast);
	const reparsed = parse(output);
	assert.equal(reparsed.program.body.length, ast.program.body.length);
	assert.equal(output.includes("const answer = 42;"), true);
});

test("loader prints escaped non-ASCII bundle output", () => {
	const ast = parse(
		'const español = "français"; const labels = { 日本語: "한국어", rocket: "🚀" };',
	);
	const output = print(ast);

	assert.equal(/[^\x00-\x7f]/.test(output), false);
	assert.equal(output.includes("\\u00f1"), true);
	assert.equal(output.includes("\\u00e7"), true);
	assert.equal(output.includes("\\u65e5\\u672c\\u8a9e"), true);
	assert.equal(output.includes("\\ud83d\\ude80"), true);
	assert.doesNotThrow(() => parse(output));
});

test("loader can parse a detected installed Claude bundle when available", (t) => {
	const detected = detectInstalledClaudeTarget();
	if (!detected) {
		t.skip("No installed Claude target detected");
		return;
	}

	try {
		const bundle =
			detected.kind === "cli.js"
				? fs.readFileSync(detected.targetPath, "utf8")
				: extractClaudeJsFromNativeBinary(detected.targetPath).toString("utf8");
		assert.doesNotThrow(() => parse(bundle));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		t.skip(`Could not extract installed Claude bundle: ${reason}`);
	}
});
