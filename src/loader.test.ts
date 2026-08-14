import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { detectInstalledClaudeTarget } from "./installation-detection.js";
import { formatParseDiagnostic, parse, print } from "./loader.js";
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

test("loader parse diagnostics are bounded and redact source identifiers", () => {
	const privateIdentifier = `PRIVATE_IDENTIFIER_${"x".repeat(2_000)}`;
	const source = `export const ${privateIdentifier} = 1; export { ${privateIdentifier} };`;
	let thrown: unknown;
	try {
		parse(source);
	} catch (error) {
		thrown = error;
	}

	assert.ok(thrown instanceof Error);
	assert.match(thrown.message, /Failed to parse JavaScript/);
	assert.equal(thrown.message.length <= 512, true);
	assert.doesNotMatch(thrown.message, /PRIVATE_IDENTIFIER/);
	assert.doesNotMatch(thrown.message, /x{32}/);
});

test("standalone parse diagnostic formatting does not include raw messages", () => {
	const diagnostic = formatParseDiagnostic(
		Object.assign(new Error("private source payload"), {
			reasonCode: "UnexpectedToken",
			loc: { line: 12, column: 34 },
		}),
	);

	assert.equal(diagnostic, "UnexpectedToken at 12:34");
	assert.doesNotMatch(diagnostic, /private source payload/);
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

const detectedClaudeTarget = detectInstalledClaudeTarget();

test("loader can parse a detected installed Claude bundle when available", {
	timeout: 30000,
	skip: detectedClaudeTarget ? false : "No installed Claude target detected",
}, () => {
	assert.ok(detectedClaudeTarget);
	const bundle =
		detectedClaudeTarget.kind === "cli.js"
			? fs.readFileSync(detectedClaudeTarget.targetPath, "utf8")
			: extractClaudeJsFromNativeBinary(
					detectedClaudeTarget.targetPath,
				).toString("utf8");
	assert.doesNotThrow(() => parse(bundle));
});
