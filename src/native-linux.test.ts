import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { BUN_TRAILER, SIZEOF_MODULE_NEW } from "./bun-format.js";
import { Manager } from "./manager.js";
import {
	extractClaudeJsFromNativeLinux,
	unwrapBunCjsModule,
} from "./native-linux.js";
import { extractJavaScriptFromNativeBinary } from "./native-rebundle.js";

interface FixtureModule {
	name: Buffer;
	contents: Buffer;
	bytecode: Buffer;
	encoding?: number;
	loader?: number;
	moduleFormat?: number;
}

function buildNativeFixture(modules: FixtureModule[], entryPointId: number) {
	const chunks: Buffer[] = [];
	let length = 0;
	const append = (content: Buffer) => {
		const pointer = { offset: length, length: content.length };
		chunks.push(content);
		length += content.length;
		return pointer;
	};
	const modulePointers = modules.map((module) => ({
		name: append(module.name),
		contents: append(module.contents),
		bytecode: append(module.bytecode),
	}));
	const moduleTableOffset = length;
	const moduleTable = Buffer.alloc(modules.length * SIZEOF_MODULE_NEW);
	for (const [index, pointers] of modulePointers.entries()) {
		const moduleOffset = index * SIZEOF_MODULE_NEW;
		moduleTable.writeUInt32LE(pointers.name.offset, moduleOffset);
		moduleTable.writeUInt32LE(pointers.name.length, moduleOffset + 4);
		moduleTable.writeUInt32LE(pointers.contents.offset, moduleOffset + 8);
		moduleTable.writeUInt32LE(pointers.contents.length, moduleOffset + 12);
		moduleTable.writeUInt32LE(pointers.bytecode.offset, moduleOffset + 24);
		moduleTable.writeUInt32LE(pointers.bytecode.length, moduleOffset + 28);
		moduleTable.writeUInt8(modules[index].encoding ?? 1, moduleOffset + 48);
		moduleTable.writeUInt8(modules[index].loader ?? 1, moduleOffset + 49);
		moduleTable.writeUInt8(modules[index].moduleFormat ?? 2, moduleOffset + 50);
	}
	chunks.push(moduleTable);
	length += moduleTable.length;

	const offsets = Buffer.alloc(32);
	offsets.writeBigUInt64LE(BigInt(length), 0);
	offsets.writeUInt32LE(moduleTableOffset, 8);
	offsets.writeUInt32LE(moduleTable.length, 12);
	offsets.writeUInt32LE(entryPointId, 16);
	const binary = Buffer.concat([
		Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
		...chunks,
		offsets,
		BUN_TRAILER,
		Buffer.alloc(8),
	]);

	return { binary };
}

test("Bun CJS extraction unwraps the source body", () => {
	for (const header of ["// @bun @bun-cjs", "// @bun @bytecode @bun-cjs"]) {
		const body = '\nconst greeting = "こんにちは";\n';
		const source =
			`${header}\n(function(exports, require, module, __filename, __dirname){` +
			`${body}});`;
		const wrapper = unwrapBunCjsModule(source);
		assert.ok(wrapper);
		assert.equal(wrapper.body, body);
	}
});

test("native extraction uses the serialized entry-point module", (t) => {
	const targetContents = Buffer.from('console.log("entry");');
	const { binary } = buildNativeFixture(
		[
			{
				name: Buffer.from("virtual/dependency.js"),
				contents: Buffer.from("export const dependency = true;"),
				bytecode: Buffer.alloc(0),
			},
			{
				name: Buffer.from("virtual/runtime-entry.bin"),
				contents: targetContents,
				bytecode: Buffer.alloc(128, 0x5a),
			},
		],
		1,
	);
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "native-entrypoint-"),
	);
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const filePath = path.join(directory, "runtime");
	fs.writeFileSync(filePath, binary);

	const extracted = extractClaudeJsFromNativeLinux(filePath);

	assert.deepEqual(extracted.claudeJs, targetContents);
});

test("complete extraction preserves a single-module entry unchanged", async (t) => {
	const contents = Buffer.from('console.log("single source");');
	const { binary } = buildNativeFixture(
		[
			{
				name: Buffer.from("/app/entry.js"),
				contents,
				bytecode: Buffer.alloc(0),
			},
		],
		0,
	);
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-single-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const target = path.join(directory, "runtime");
	fs.writeFileSync(target, binary);

	const result = await extractJavaScriptFromNativeBinary(target);

	assert.equal(result.sourceMode, "entry");
	assert.equal(result.sourceModuleCount, 1);
	assert.deepEqual(result.code, contents);
	assert.deepEqual(fs.readFileSync(target), binary);
});

test("single-module extraction decodes UTF-16 source", async (t) => {
	const source = 'console.log("日本語");';
	const { binary } = buildNativeFixture(
		[
			{
				name: Buffer.from("/app/entry.js"),
				contents: Buffer.from(source, "utf16le"),
				bytecode: Buffer.alloc(0),
				encoding: 2,
			},
		],
		0,
	);
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-utf16-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const target = path.join(directory, "runtime");
	fs.writeFileSync(target, binary);

	assert.equal(
		extractClaudeJsFromNativeLinux(target).claudeJs.toString("utf8"),
		source,
	);
	const result = await extractJavaScriptFromNativeBinary(target);
	assert.equal(result.sourceMode, "entry");
	assert.equal(result.code.toString("utf8"), source);
});

test("native extraction rejects truncated UTF-16 source", (t) => {
	const { binary } = buildNativeFixture(
		[
			{
				name: Buffer.from("/app/entry.js"),
				contents: Buffer.from([0x61]),
				bytecode: Buffer.alloc(0),
				encoding: 2,
			},
		],
		0,
	);
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-utf16-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const target = path.join(directory, "runtime");
	fs.writeFileSync(target, binary);

	assert.throws(
		() => extractClaudeJsFromNativeLinux(target),
		/Embedded UTF-16 module has an incomplete code unit/,
	);
});

test("complete extraction includes disconnected ESM and CommonJS modules", async (t) => {
	const { binary } = buildNativeFixture(
		[
			{
				name: Buffer.from("/app/lazy.bin"),
				contents: Buffer.from(
					'export const prompt = "disconnected ESM source — 日本語";',
					"utf16le",
				),
				bytecode: Buffer.alloc(0),
				moduleFormat: 1,
				encoding: 2,
			},
			{
				name: Buffer.from("/app/entry.js"),
				contents: Buffer.from('module.exports = { value: "main source" };'),
				bytecode: Buffer.alloc(0),
			},
			{
				name: Buffer.from("/app/commonjs.js"),
				contents: Buffer.from(
					'module.exports = { prompt: "disconnected CommonJS source" };',
				),
				bytecode: Buffer.alloc(0),
			},
			{
				name: Buffer.from("/app/asset.dat"),
				contents: Buffer.from("not JavaScript"),
				bytecode: Buffer.alloc(0),
				loader: 0,
				moduleFormat: 0,
			},
		],
		1,
	);
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-complete-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const target = path.join(directory, "runtime");
	fs.writeFileSync(target, binary);

	const result = await extractJavaScriptFromNativeBinary(target);

	assert.equal(result.sourceMode, "rebundled");
	assert.equal(result.sourceModuleCount, 3);
	const source = result.code.toString("utf8");
	assert.match(source, /main source/);
	assert.match(source, /disconnected ESM source/);
	assert.match(source, /disconnected CommonJS source/);
	assert.match(source, /日本語|\\u65e5\\u672c\\u8a9e/i);
	assert.doesNotMatch(source, /not JavaScript/);
	assert.deepEqual(fs.readFileSync(target), binary);
});

test("unpacking cannot overwrite the source binary through an alias", async (t) => {
	const { binary } = buildNativeFixture(
		[
			{
				name: Buffer.from("/app/entry.js"),
				contents: Buffer.from('console.log("stock source");'),
				bytecode: Buffer.alloc(0),
			},
		],
		0,
	);
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-readonly-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const target = path.join(directory, "runtime");
	const symbolic = path.join(directory, "symbolic");
	const hard = path.join(directory, "hard");
	fs.writeFileSync(target, binary);
	fs.symlinkSync(target, symbolic);
	fs.linkSync(target, hard);
	const manager = new Manager();

	for (const output of [target, symbolic, hard]) {
		await assert.rejects(
			manager.unpackNativeTarget(target, output, { normalize: false }),
			/Extraction output must not overwrite the native binary/,
		);
		assert.deepEqual(fs.readFileSync(target), binary);
	}
});
