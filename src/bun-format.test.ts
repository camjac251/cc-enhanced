import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type BunOffsets,
	getPointerContent,
	parseModule,
	replaceEntryPointModuleInPlace,
	SIZEOF_MODULE_NEW,
} from "./bun-format.js";

interface FixtureModule {
	name: Buffer;
	contents: Buffer;
	bytecode: Buffer;
	moduleInfo?: Buffer;
	moduleFormat?: number;
}

function buildBunBlob(
	modules: FixtureModule[],
	entryPointId: number,
): {
	bunBlob: Buffer;
	bunOffsets: BunOffsets;
} {
	const chunks: Buffer[] = [];
	let length = 0;
	const append = (content: Buffer) => {
		const pointer = { offset: length, length: content.length };
		chunks.push(content);
		length += content.length;
		return pointer;
	};
	const pointers = modules.map((module) => ({
		name: append(module.name),
		contents: append(module.contents),
		bytecode: append(module.bytecode),
		moduleInfo: append(module.moduleInfo ?? Buffer.alloc(0)),
	}));
	const moduleTableOffset = length;
	const moduleTable = Buffer.alloc(modules.length * SIZEOF_MODULE_NEW);
	for (const [index, modulePointers] of pointers.entries()) {
		const moduleOffset = index * SIZEOF_MODULE_NEW;
		moduleTable.writeUInt32LE(modulePointers.name.offset, moduleOffset);
		moduleTable.writeUInt32LE(modulePointers.name.length, moduleOffset + 4);
		moduleTable.writeUInt32LE(modulePointers.contents.offset, moduleOffset + 8);
		moduleTable.writeUInt32LE(
			modulePointers.contents.length,
			moduleOffset + 12,
		);
		moduleTable.writeUInt32LE(
			modulePointers.bytecode.offset,
			moduleOffset + 24,
		);
		moduleTable.writeUInt32LE(
			modulePointers.bytecode.length,
			moduleOffset + 28,
		);
		moduleTable.writeUInt32LE(
			modulePointers.moduleInfo.offset,
			moduleOffset + 32,
		);
		moduleTable.writeUInt32LE(
			modulePointers.moduleInfo.length,
			moduleOffset + 36,
		);
		moduleTable.writeUInt8(modules[index].moduleFormat ?? 1, moduleOffset + 50);
	}
	chunks.push(moduleTable);
	length += moduleTable.length;

	return {
		bunBlob: Buffer.concat(chunks, length),
		bunOffsets: {
			byteCount: BigInt(length),
			modulesPtr: {
				offset: moduleTableOffset,
				length: moduleTable.length,
			},
			entryPointId,
			compileExecArgvPtr: { offset: 0, length: 0 },
			flags: 0,
		},
	};
}

test("replaces the entry-point contents inside its existing bytecode region", () => {
	const { bunBlob, bunOffsets } = buildBunBlob(
		[
			{
				name: Buffer.from("dependency"),
				contents: Buffer.from("dependency contents"),
				bytecode: Buffer.alloc(8, 0x44),
			},
			{
				name: Buffer.from("entry"),
				contents: Buffer.from("old entry"),
				bytecode: Buffer.alloc(64, 0x55),
			},
		],
		1,
	);
	const replacement = Buffer.from("new entry contents");

	const result = replaceEntryPointModuleInPlace(
		bunBlob,
		bunOffsets,
		SIZEOF_MODULE_NEW,
		replacement,
	);
	const module = parseModule(
		bunBlob,
		bunOffsets.modulesPtr.offset + SIZEOF_MODULE_NEW,
		SIZEOF_MODULE_NEW,
	);

	assert.equal(result.moduleIndex, 1);
	assert.equal(result.bytecodeCapacity, 64);
	assert.deepEqual(getPointerContent(bunBlob, module.contents), replacement);
	assert.deepEqual(module.bytecode, { offset: 0, length: 0 });
	assert.equal(bunBlob[result.bytecodeOffset + replacement.length], 0);
});

test("uses another module's bytecode region when the entry-point region is too small", () => {
	const donorContents = Buffer.from("donor contents");
	const { bunBlob, bunOffsets } = buildBunBlob(
		[
			{
				name: Buffer.from("entry"),
				contents: Buffer.from("old entry"),
				bytecode: Buffer.alloc(8, 0x55),
			},
			{
				name: Buffer.from("donor"),
				contents: donorContents,
				bytecode: Buffer.alloc(64, 0x66),
			},
		],
		0,
	);
	const replacement = Buffer.from("new entry contents from a split bundle");

	const result = replaceEntryPointModuleInPlace(
		bunBlob,
		bunOffsets,
		SIZEOF_MODULE_NEW,
		replacement,
	);
	const entry = parseModule(
		bunBlob,
		bunOffsets.modulesPtr.offset,
		SIZEOF_MODULE_NEW,
	);
	const donor = parseModule(
		bunBlob,
		bunOffsets.modulesPtr.offset + SIZEOF_MODULE_NEW,
		SIZEOF_MODULE_NEW,
	);

	assert.equal(result.moduleIndex, 0);
	assert.equal(result.storageModuleIndex, 1);
	assert.equal(result.bytecodeCapacity, 64);
	assert.deepEqual(getPointerContent(bunBlob, entry.contents), replacement);
	assert.deepEqual(entry.bytecode, { offset: 0, length: 0 });
	assert.deepEqual(donor.bytecode, { offset: 0, length: 0 });
	assert.deepEqual(getPointerContent(bunBlob, donor.contents), donorContents);
	assert.equal(bunBlob[result.bytecodeOffset + replacement.length], 0);
});

test("uses a packed contents span for a self-contained split bundle", () => {
	const { bunBlob, bunOffsets } = buildBunBlob(
		[
			{
				name: Buffer.alloc(1),
				contents: Buffer.alloc(8, 0x31),
				bytecode: Buffer.alloc(0),
			},
			{
				name: Buffer.alloc(1),
				contents: Buffer.alloc(8, 0x32),
				bytecode: Buffer.alloc(0),
			},
		],
		0,
	);
	const replacement = Buffer.alloc(16, 0x61);

	const result = replaceEntryPointModuleInPlace(
		bunBlob,
		bunOffsets,
		SIZEOF_MODULE_NEW,
		replacement,
		true,
	);
	const entry = parseModule(
		bunBlob,
		bunOffsets.modulesPtr.offset,
		SIZEOF_MODULE_NEW,
	);
	const retired = parseModule(
		bunBlob,
		bunOffsets.modulesPtr.offset + SIZEOF_MODULE_NEW,
		SIZEOF_MODULE_NEW,
	);

	assert.equal(result.bytecodeCapacity, 17);
	assert.deepEqual(getPointerContent(bunBlob, entry.contents), replacement);
	assert.deepEqual(entry.bytecode, { offset: 0, length: 0 });
	assert.deepEqual(retired.contents, { offset: 0, length: 0 });
	assert.deepEqual(retired.bytecode, { offset: 0, length: 0 });
	assert.equal(retired.moduleFormat, 0);
});

test("clears stale entry module metadata when replacing source", () => {
	const donorModuleInfo = Buffer.from("donor metadata");
	const { bunBlob, bunOffsets } = buildBunBlob(
		[
			{
				name: Buffer.from("entry"),
				contents: Buffer.from("old entry"),
				bytecode: Buffer.alloc(64, 0x55),
				moduleInfo: Buffer.from("stale entry metadata"),
			},
			{
				name: Buffer.from("donor"),
				contents: Buffer.from("donor contents"),
				bytecode: Buffer.alloc(8, 0x66),
				moduleInfo: donorModuleInfo,
			},
		],
		0,
	);

	replaceEntryPointModuleInPlace(
		bunBlob,
		bunOffsets,
		SIZEOF_MODULE_NEW,
		Buffer.from("new entry contents"),
	);
	const entry = parseModule(
		bunBlob,
		bunOffsets.modulesPtr.offset,
		SIZEOF_MODULE_NEW,
	);
	const donor = parseModule(
		bunBlob,
		bunOffsets.modulesPtr.offset + SIZEOF_MODULE_NEW,
		SIZEOF_MODULE_NEW,
	);

	assert.deepEqual(entry.moduleInfo, { offset: 0, length: 0 });
	assert.equal(entry.moduleFormat, 1);
	assert.equal(donor.moduleFormat, 1);
	assert.ok(donor.moduleInfo);
	assert.deepEqual(
		getPointerContent(bunBlob, donor.moduleInfo),
		donorModuleInfo,
	);
});

test("rejects an oversized replacement without mutating the Bun blob", () => {
	const { bunBlob, bunOffsets } = buildBunBlob(
		[
			{
				name: Buffer.from("entry"),
				contents: Buffer.from("old"),
				bytecode: Buffer.alloc(4, 0x66),
			},
		],
		0,
	);
	const before = Buffer.from(bunBlob);

	assert.throws(
		() =>
			replaceEntryPointModuleInPlace(
				bunBlob,
				bunOffsets,
				SIZEOF_MODULE_NEW,
				Buffer.alloc(5),
			),
		/Modified JS \(5 bytes\) exceeds bytecode area \(4 bytes\)/,
	);
	assert.deepEqual(bunBlob, before);
});

test("rejects an out-of-bounds bytecode region without mutating the Bun blob", () => {
	const { bunBlob, bunOffsets } = buildBunBlob(
		[
			{
				name: Buffer.from("entry"),
				contents: Buffer.from("old"),
				bytecode: Buffer.alloc(8, 0x66),
			},
		],
		0,
	);
	const bytecodePointerOffset = bunOffsets.modulesPtr.offset + 24;
	bunBlob.writeUInt32LE(bunBlob.length - 2, bytecodePointerOffset);
	const before = Buffer.from(bunBlob);

	assert.throws(
		() =>
			replaceEntryPointModuleInPlace(
				bunBlob,
				bunOffsets,
				SIZEOF_MODULE_NEW,
				Buffer.from("new"),
			),
		/Entry-point bytecode range/,
	);
	assert.deepEqual(bunBlob, before);
});
