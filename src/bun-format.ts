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
	// Ambiguous or neither — prefer new format (more likely with recent Bun)
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

export function isClaudeModule(moduleName: string): boolean {
	return (
		moduleName.endsWith("/claude") ||
		moduleName === "claude" ||
		moduleName.endsWith("/claude.exe") ||
		moduleName === "claude.exe" ||
		moduleName.endsWith("/src/entrypoints/cli.js")
	);
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

export function countClaudeModules(
	bunBlob: Buffer,
	bunOffsets: BunOffsets,
	moduleStructSize: number,
): number {
	let count = 0;
	mapModules(bunBlob, bunOffsets, moduleStructSize, (_module, moduleName) => {
		if (isClaudeModule(moduleName)) count++;
		return undefined;
	});
	return count;
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
