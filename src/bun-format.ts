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

export const BUSY_FILE_CODES = new Set(["ETXTBSY", "EBUSY", "EPERM"]);

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

export function mapModules<T>(
	bunBlob: Buffer,
	bunOffsets: BunOffsets,
	moduleStructSize: number,
	visitor: (
		module: BunModule,
		moduleName: string,
		index: number,
	) => T | undefined,
): T | undefined {
	const modulesList = getPointerContent(bunBlob, bunOffsets.modulesPtr);
	const moduleCount = Math.floor(modulesList.length / moduleStructSize);
	for (let i = 0; i < moduleCount; i++) {
		const module = parseModule(
			modulesList,
			i * moduleStructSize,
			moduleStructSize,
		);
		const moduleName = getPointerContent(bunBlob, module.name).toString(
			"utf-8",
		);
		const result = visitor(module, moduleName, i);
		if (result !== undefined) return result;
	}
	return undefined;
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

export interface BunEntryPointReplacement {
	moduleIndex: number;
	storageModuleIndex: number;
	moduleEntryOffset: number;
	bytecodeOffset: number;
	bytecodeCapacity: number;
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
			contents: getPointerContent(bunBlob, module.contents),
			module,
		};
	});
}

export function replaceEntryPointModuleInPlace(
	bunBlob: Buffer,
	bunOffsets: BunOffsets,
	moduleStructSize: number,
	modifiedClaudeJs: Buffer,
): BunEntryPointReplacement {
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
	const moduleIndex = bunOffsets.entryPointId;
	if (moduleIndex >= moduleCount) {
		throw new Error(
			`Bun entry-point module index (${moduleIndex}) exceeds module count (${moduleCount})`,
		);
	}

	const modules = Array.from({ length: moduleCount }, (_, index) => {
		const entryOffset = bunOffsets.modulesPtr.offset + index * moduleStructSize;
		assertBoundedRange(
			index === moduleIndex ? "Entry-point module" : `Module ${index}`,
			entryOffset,
			moduleStructSize,
			bunBlob.length,
		);
		const module = parseModule(bunBlob, entryOffset, moduleStructSize);
		assertBoundedRange(
			index === moduleIndex
				? "Entry-point bytecode"
				: `Module ${index} bytecode`,
			module.bytecode.offset,
			module.bytecode.length,
			bunBlob.length,
		);
		return { index, entryOffset, module };
	});
	const entry = modules[moduleIndex];
	const storage = modules
		.filter(
			(candidate) =>
				candidate.module.bytecode.length >= modifiedClaudeJs.length,
		)
		.sort((left, right) => {
			if (left.index === moduleIndex) return -1;
			if (right.index === moduleIndex) return 1;
			return left.module.bytecode.length - right.module.bytecode.length;
		})[0];

	if (!storage) {
		const largestCapacity = modules.reduce(
			(largest, candidate) =>
				Math.max(largest, candidate.module.bytecode.length),
			0,
		);
		throw new Error(
			`Modified JS (${modifiedClaudeJs.length} bytes) exceeds bytecode area (${largestCapacity} bytes)`,
		);
	}
	if (modifiedClaudeJs.length > 0xffff_ffff) {
		throw new Error(
			`Modified JS (${modifiedClaudeJs.length} bytes) exceeds Bun pointer capacity`,
		);
	}

	const moduleTableEnd =
		bunOffsets.modulesPtr.offset + bunOffsets.modulesPtr.length;
	const bytecodeEnd =
		storage.module.bytecode.offset + storage.module.bytecode.length;
	if (
		storage.module.bytecode.offset < moduleTableEnd &&
		bytecodeEnd > bunOffsets.modulesPtr.offset
	) {
		throw new Error("Replacement bytecode overlaps Bun module metadata");
	}

	modifiedClaudeJs.copy(bunBlob, storage.module.bytecode.offset);
	if (modifiedClaudeJs.length < storage.module.bytecode.length) {
		bunBlob[storage.module.bytecode.offset + modifiedClaudeJs.length] = 0;
	}
	bunBlob.writeUInt32LE(storage.module.bytecode.offset, entry.entryOffset + 8);
	bunBlob.writeUInt32LE(modifiedClaudeJs.length, entry.entryOffset + 12);
	bunBlob.writeUInt32LE(0, entry.entryOffset + 24);
	bunBlob.writeUInt32LE(0, entry.entryOffset + 28);
	if (moduleStructSize === SIZEOF_MODULE_NEW) {
		bunBlob.writeUInt32LE(0, entry.entryOffset + 32);
		bunBlob.writeUInt32LE(0, entry.entryOffset + 36);
	}
	if (storage.index !== moduleIndex) {
		bunBlob.writeUInt32LE(0, storage.entryOffset + 24);
		bunBlob.writeUInt32LE(0, storage.entryOffset + 28);
	}

	return {
		moduleIndex,
		storageModuleIndex: storage.index,
		moduleEntryOffset: entry.entryOffset,
		bytecodeOffset: storage.module.bytecode.offset,
		bytecodeCapacity: storage.module.bytecode.length,
	};
}

export function toWriteError(error: unknown, targetPath: string): Error {
	const fallback =
		error instanceof Error ? error.message : String(error ?? "Unknown error");
	if (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof (error as { code: unknown }).code === "string"
	) {
		const code = (error as { code: string }).code;
		if (BUSY_FILE_CODES.has(code)) {
			return new Error(
				`Cannot write patched binary to ${targetPath} while it is in use (${code}). Close running Claude processes and retry.`,
			);
		}
	}
	return new Error(
		`Failed writing patched binary to ${targetPath}: ${fallback}`,
	);
}
