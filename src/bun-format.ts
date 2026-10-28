/**
 * Shared Bun binary format primitives.
 * Used by both native-linux.ts (ELF overlay) and native.ts (Mach-O/PE section via node-lief).
 */

export const BUN_TRAILER = Buffer.from("\n---- Bun! ----\n");
export const SIZEOF_OFFSETS = 32;
export const SIZEOF_STRING_POINTER = 8;
// Module struct sizes vary by Bun version:
// Old format (pre-~1.3.7): 4 StringPointers + 4 u8s = 36 bytes
// New format (~1.3.7+):    6 StringPointers + 4 u8s = 52 bytes (adds moduleInfo, bytecodeOriginPath)
export const SIZEOF_MODULE_OLD = 4 * SIZEOF_STRING_POINTER + 4;
export const SIZEOF_MODULE_NEW = 6 * SIZEOF_STRING_POINTER + 4;
export const BUN_MODULE_FORMAT_ESM = 1;
export const BUN_MODULE_FORMAT_CJS = 2;

const CJS_HEADERS = ["// @bun @bun-cjs", "// @bun @bytecode @bun-cjs"].map(
	(text) => ({ text, bytes: Buffer.from(text) }),
);

export function hasBunCjsHeader(source: string | Buffer): boolean {
	for (const { text, bytes } of CJS_HEADERS) {
		if (typeof source === "string") {
			if (
				source.startsWith(text) &&
				(source.length === text.length ||
					source[text.length] === "\n" ||
					source[text.length] === "\r")
			)
				return true;
		} else if (
			source.length >= bytes.length &&
			source.compare(bytes, 0, bytes.length, 0, bytes.length) === 0
		) {
			const next = source[bytes.length];
			if (next === undefined || next === 10 || next === 13) return true;
		}
	}
	return false;
}

export interface StringPointer {
	offset: number;
	length: number;
}

export interface BunOffsets {
	byteCount: bigint;
	modulesPtr: StringPointer;
	entryPointId: number;
	compileExecArgvPtr: StringPointer;
	flags: number;
}

export interface BunModule {
	name: StringPointer;
	contents: StringPointer;
	sourcemap: StringPointer;
	bytecode: StringPointer;
	moduleInfo?: StringPointer;
	bytecodeOriginPath?: StringPointer;
	encoding: number;
	loader: number;
	moduleFormat: number;
	side: number;
}

export interface BunEmbeddedModule {
	index: number;
	moduleEntryOffset: number;
	name: string;
	/** Source bytes, decoded to UTF-8 when serialized as UTF-16. */
	contents: Buffer;
	module: BunModule;
}

export function parseStringPointer(
	buffer: Buffer,
	offset: number,
): StringPointer {
	return {
		offset: buffer.readUInt32LE(offset),
		length: buffer.readUInt32LE(offset + 4),
	};
}

export function parseOffsets(buffer: Buffer): BunOffsets {
	let pos = 0;
	const byteCount = buffer.readBigUInt64LE(pos);
	pos += 8;
	const modulesPtr = parseStringPointer(buffer, pos);
	pos += 8;
	const entryPointId = buffer.readUInt32LE(pos);
	pos += 4;
	const compileExecArgvPtr = parseStringPointer(buffer, pos);
	pos += 8;
	const flags = buffer.readUInt32LE(pos);
	return { byteCount, modulesPtr, entryPointId, compileExecArgvPtr, flags };
}

/**
 * Detects the module struct size from the modules list byte length.
 * Bun >=1.3.7 uses 52-byte entries (6 StringPointers + 4 u8s);
 * older versions use 36-byte entries (4 StringPointers + 4 u8s).
 */
export function detectModuleStructSize(modulesListLength: number): number {
	const fitsNew = modulesListLength % SIZEOF_MODULE_NEW === 0;
	const fitsOld = modulesListLength % SIZEOF_MODULE_OLD === 0;
	if (fitsNew && !fitsOld) return SIZEOF_MODULE_NEW;
	if (fitsOld && !fitsNew) return SIZEOF_MODULE_OLD;
	// Ambiguous or neither: prefer new format (more likely with recent Bun)
	return SIZEOF_MODULE_NEW;
}

export function parseModule(
	buffer: Buffer,
	offset: number,
	moduleStructSize: number,
): BunModule {
	let pos = offset;
	const name = parseStringPointer(buffer, pos);
	pos += 8;
	const contents = parseStringPointer(buffer, pos);
	pos += 8;
	const sourcemap = parseStringPointer(buffer, pos);
	pos += 8;
	const bytecode = parseStringPointer(buffer, pos);
	pos += 8;
	let moduleInfo: StringPointer | undefined;
	let bytecodeOriginPath: StringPointer | undefined;
	if (moduleStructSize === SIZEOF_MODULE_NEW) {
		moduleInfo = parseStringPointer(buffer, pos);
		pos += 8;
		bytecodeOriginPath = parseStringPointer(buffer, pos);
		pos += 8;
	}
	const encoding = buffer.readUInt8(pos);
	pos += 1;
	const loader = buffer.readUInt8(pos);
	pos += 1;
	const moduleFormat = buffer.readUInt8(pos);
	pos += 1;
	const side = buffer.readUInt8(pos);
	return {
		name,
		contents,
		sourcemap,
		bytecode,
		moduleInfo,
		bytecodeOriginPath,
		encoding,
		loader,
		moduleFormat,
		side,
	};
}

export function getPointerContent(buffer: Buffer, ptr: StringPointer): Buffer {
	return buffer.subarray(ptr.offset, ptr.offset + ptr.length);
}

export function getModuleContents(buffer: Buffer, module: BunModule): Buffer {
	const contents = getPointerContent(buffer, module.contents);
	// Bun's serialized encoding 2 stores little-endian UTF-16 source.
	// https://github.com/oven-sh/bun/blob/main/src/standalone_graph/StandaloneModuleGraph.rs
	if (module.encoding === 2) {
		if (contents.length % 2 !== 0) {
			throw new Error("Embedded UTF-16 module has an incomplete code unit");
		}
		return Buffer.from(contents.toString("utf16le"), "utf8");
	}
	return contents;
}

export function mapEntryPointModule<T>(
	bunBlob: Buffer,
	bunOffsets: BunOffsets,
	moduleStructSize: number,
	visitor: (module: BunModule, index: number) => T | undefined,
): T | undefined {
	const modulesList = getPointerContent(bunBlob, bunOffsets.modulesPtr);
	const moduleCount = Math.floor(modulesList.length / moduleStructSize);
	const moduleIndex = bunOffsets.entryPointId;
	if (moduleIndex >= moduleCount) return undefined;
	const module = parseModule(
		modulesList,
		moduleIndex * moduleStructSize,
		moduleStructSize,
	);
	return visitor(module, moduleIndex);
}

function assertBoundedRange(
	label: string,
	offset: number,
	length: number,
	bufferLength: number,
): void {
	if (
		!Number.isSafeInteger(offset) ||
		!Number.isSafeInteger(length) ||
		offset < 0 ||
		length < 0 ||
		offset + length > bufferLength
	) {
		throw new Error(
			`${label} range (${offset}+${length}) exceeds Bun blob (${bufferLength} bytes)`,
		);
	}
}

export function listEmbeddedModules(
	bunBlob: Buffer,
	bunOffsets: BunOffsets,
	moduleStructSize: number,
): BunEmbeddedModule[] {
	assertBoundedRange(
		"Module table",
		bunOffsets.modulesPtr.offset,
		bunOffsets.modulesPtr.length,
		bunBlob.length,
	);
	if (
		moduleStructSize !== SIZEOF_MODULE_OLD &&
		moduleStructSize !== SIZEOF_MODULE_NEW
	) {
		throw new Error(`Unsupported Bun module struct size: ${moduleStructSize}`);
	}
	if (bunOffsets.modulesPtr.length % moduleStructSize !== 0) {
		throw new Error(
			`Bun module table length (${bunOffsets.modulesPtr.length}) is not divisible by module struct size (${moduleStructSize})`,
		);
	}

	const moduleCount = bunOffsets.modulesPtr.length / moduleStructSize;
	return Array.from({ length: moduleCount }, (_, index) => {
		const moduleEntryOffset =
			bunOffsets.modulesPtr.offset + index * moduleStructSize;
		assertBoundedRange(
			`Module ${index}`,
			moduleEntryOffset,
			moduleStructSize,
			bunBlob.length,
		);
		const module = parseModule(bunBlob, moduleEntryOffset, moduleStructSize);
		assertBoundedRange(
			`Module ${index} name`,
			module.name.offset,
			module.name.length,
			bunBlob.length,
		);
		assertBoundedRange(
			`Module ${index} contents`,
			module.contents.offset,
			module.contents.length,
			bunBlob.length,
		);
		return {
			index,
			moduleEntryOffset,
			name: getPointerContent(bunBlob, module.name).toString("utf-8"),
			contents: getModuleContents(bunBlob, module),
			module,
		};
	});
}
