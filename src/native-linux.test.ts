import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { BUN_TRAILER, SIZEOF_MODULE_NEW } from "./bun-format.js";
import {
	copyBunCjsEnvelope,
	extractClaudeJsFromNativeLinux,
	repackNativeLinuxBinary,
	unwrapBunCjsModule,
	wrapBunCjsModuleBuffer,
} from "./native-linux.js";

interface FixtureModule {
	name: Buffer;
	contents: Buffer;
	bytecode: Buffer;
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
		moduleTable.writeUInt8(1, moduleOffset + 49);
		moduleTable.writeUInt8(2, moduleOffset + 50);
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

test("detached Bun CJS envelope rewraps UTF-8 body bytes exactly", () => {
	const source = [
		"// @bun @bytecode @bun-cjs",
		"(function(exports, require, module, __filename, __dirname){",
		'const greeting = "before";',
		"});",
	].join("\n");
	const wrapper = unwrapBunCjsModule(source);
	assert.ok(wrapper);

	const replacementBody = Buffer.from('\nconst greeting = "こんにちは";\n');
	const envelope = copyBunCjsEnvelope(wrapper);
	const rebuilt = wrapBunCjsModuleBuffer(envelope, replacementBody);
	const expected = Buffer.from(
		`${wrapper.prefix}${replacementBody.toString("utf-8")}${wrapper.suffix}`,
		"utf-8",
	);

	assert.deepEqual(rebuilt, expected);
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

test("native repack rewrites the serialized entry-point module", (t) => {
	const { binary } = buildNativeFixture(
		[
			{
				name: Buffer.from("virtual/dependency.js"),
				contents: Buffer.from("export const dependency = true;"),
				bytecode: Buffer.alloc(0),
			},
			{
				name: Buffer.from("virtual/runtime-entry.bin"),
				contents: Buffer.from('console.log("entry");'),
				bytecode: Buffer.alloc(128, 0x5a),
			},
		],
		1,
	);
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-repack-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const sourcePath = path.join(directory, "runtime");
	const outputPath = path.join(directory, "runtime-patched");
	fs.writeFileSync(sourcePath, binary);
	const replacementContents = Buffer.from('console.log("patched");');

	repackNativeLinuxBinary(sourcePath, replacementContents, outputPath);

	assert.equal(fs.statSync(outputPath).size, binary.length);
	assert.deepEqual(
		extractClaudeJsFromNativeLinux(outputPath).claudeJs,
		replacementContents,
	);
});
