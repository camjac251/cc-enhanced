import * as fs from "node:fs";
import {
	BUN_TRAILER,
	type BunOffsets,
	countClaudeModules,
	detectModuleStructSize,
	getPointerContent,
	isClaudeModule,
	mapModules,
	parseModule,
	parseOffsets,
	SIZEOF_OFFSETS,
	toWriteError,
} from "./bun-format.js";

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]); // \x7fELF

interface ExtractedNativeLinux {
	binary: Buffer;
	bunBlob: Buffer; // [data][offsets][trailer]
	bunOffsets: BunOffsets;
	bunBlobStart: number; // absolute offset in binary for bunBlob start
	moduleStructSize: number;
	tailValue: bigint;
	claudeJs: Buffer;
}

interface BunCjsWrapper {
	prefix: string;
	body: string;
	suffix: string;
}

const BUN_CJS_HEADER = "// @bun @bytecode @bun-cjs";
const BUN_CJS_WRAPPER_RE =
	/^\(function\s*\(exports,\s*require,\s*module,\s*__filename,\s*__dirname\)\s*\{$/;

export function unwrapBunCjsModule(code: string): BunCjsWrapper | null {
	if (!code.startsWith(BUN_CJS_HEADER)) return null;

	const headerEnd = code.indexOf("\n");
	if (headerEnd < 0) return null;

	const wrapperStart = code.indexOf("(function", headerEnd + 1);
	if (wrapperStart < 0) return null;

	const bodyStart = code.indexOf("{", wrapperStart);
	if (bodyStart < 0) return null;

	const wrapperDecl = code.slice(wrapperStart, bodyStart + 1);
	if (!BUN_CJS_WRAPPER_RE.test(wrapperDecl)) return null;

	const suffixMatch = /\}\);?\s*$/.exec(code);
	if (!suffixMatch || suffixMatch.index <= bodyStart) return null;

	const suffixStart = suffixMatch.index;
	return {
		prefix: code.slice(0, bodyStart + 1),
		body: code.slice(bodyStart + 1, suffixStart),
		suffix: code.slice(suffixStart),
	};
}

export function wrapBunCjsModule(wrapper: BunCjsWrapper, body: string): string {
	return `${wrapper.prefix}${body}${wrapper.suffix}`;
}

function parseLinuxBunBlob(binary: Buffer): {
	bunBlob: Buffer;
	bunOffsets: BunOffsets;
	bunBlobStart: number;
	moduleStructSize: number;
} {
	if (binary.length < BUN_TRAILER.length + 8 + SIZEOF_OFFSETS) {
		throw new Error("Binary too small to contain Bun overlay");
	}

	const tailCount = binary.readBigUInt64LE(binary.length - 8);
	if (tailCount <= 0n || tailCount > BigInt(binary.length)) {
		throw new Error(`Invalid Bun overlay size in tail: ${tailCount}`);
	}

	const trailerEnd = binary.length - 8;
	const trailerStart = trailerEnd - BUN_TRAILER.length;
	if (trailerStart < 0) {
		throw new Error("Invalid Bun trailer position");
	}

	const trailer = binary.subarray(trailerStart, trailerEnd);
	if (!trailer.equals(BUN_TRAILER)) {
		throw new Error("Bun trailer not found at expected location");
	}

	const offsetsEnd = trailerStart;
	const offsetsStart = offsetsEnd - SIZEOF_OFFSETS;
	if (offsetsStart < 0) {
		throw new Error("Invalid offsets position");
	}

	const offsetsBytes = binary.subarray(offsetsStart, offsetsEnd);
	const bunOffsets = parseOffsets(offsetsBytes);

	if (
		bunOffsets.byteCount <= 0n ||
		bunOffsets.byteCount > BigInt(binary.length)
	) {
		throw new Error(
			`Invalid byteCount in Bun offsets: ${bunOffsets.byteCount}`,
		);
	}
	const byteCountNumber = Number(bunOffsets.byteCount);
	if (!Number.isSafeInteger(byteCountNumber)) {
		throw new Error(
			`byteCount is too large for JS indexing: ${bunOffsets.byteCount}`,
		);
	}

	const dataStart = offsetsStart - byteCountNumber;
	if (dataStart < 0) {
		throw new Error("Computed Bun data start is before file start");
	}

	const bunBlob = binary.subarray(dataStart, trailerEnd); // [data][offsets][trailer]
	const expectedLength = byteCountNumber + SIZEOF_OFFSETS + BUN_TRAILER.length;
	if (bunBlob.length !== expectedLength) {
		throw new Error(
			`Unexpected Bun blob length: got ${bunBlob.length}, expected ${expectedLength}`,
		);
	}

	const moduleStructSize = detectModuleStructSize(bunOffsets.modulesPtr.length);

	return { bunBlob, bunOffsets, bunBlobStart: dataStart, moduleStructSize };
}

/**
 * Rebuild Bun blob by appending new claude content to existing data
 * and patching the module entry in-place (Linux overlay strategy).
 */
function rebuildBunBlob(
	oldBunBlob: Buffer,
	oldOffsets: BunOffsets,
	modifiedClaudeJs: Buffer,
	moduleStructSize: number,
): Buffer {
	const oldDataLength = oldBunBlob.length - SIZEOF_OFFSETS - BUN_TRAILER.length;
	if (oldDataLength <= 0) {
		throw new Error("Invalid Bun blob data length");
	}
	const oldData = oldBunBlob.subarray(0, oldDataLength);

	const modulesStart = oldOffsets.modulesPtr.offset;
	const modulesLength = oldOffsets.modulesPtr.length;
	if (
		modulesStart < 0 ||
		modulesLength <= 0 ||
		modulesStart + modulesLength > oldData.length
	) {
		throw new Error("Invalid modules pointer range in Bun offsets");
	}
	const modulesList = oldData.subarray(
		modulesStart,
		modulesStart + modulesLength,
	);
	const moduleCount = Math.floor(modulesLength / moduleStructSize);
	if (moduleCount <= 0) {
		throw new Error("No modules found in Bun blob");
	}

	let claudeModuleIndex = -1;
	for (let i = 0; i < moduleCount; i++) {
		const module = parseModule(
			modulesList,
			i * moduleStructSize,
			moduleStructSize,
		);
		const moduleName = getPointerContent(oldData, module.name).toString(
			"utf-8",
		);
		if (isClaudeModule(moduleName)) {
			claudeModuleIndex = i;
			break;
		}
	}

	if (claudeModuleIndex < 0) {
		throw new Error("Could not locate embedded claude module in Bun blob");
	}

	const newContentOffset = oldData.length;
	const newData = Buffer.allocUnsafe(
		oldData.length + modifiedClaudeJs.length + 1,
	);
	oldData.copy(newData, 0);
	modifiedClaudeJs.copy(newData, newContentOffset);
	newData[newContentOffset + modifiedClaudeJs.length] = 0;

	const moduleEntryOffset = modulesStart + claudeModuleIndex * moduleStructSize;
	const contentsPointerOffset = moduleEntryOffset + 8; // name pointer is first 8 bytes
	newData.writeUInt32LE(newContentOffset, contentsPointerOffset);
	newData.writeUInt32LE(modifiedClaudeJs.length, contentsPointerOffset + 4);
	// Force Bun to use updated source text for this module.
	// Keeping stale embedded bytecode can crash module instantiation.
	// Bytecode is the 4th StringPointer (offset +24) in both old and new formats.
	const bytecodePointerOffset = moduleEntryOffset + 24;
	newData.writeUInt32LE(0, bytecodePointerOffset);
	newData.writeUInt32LE(0, bytecodePointerOffset + 4);

	const newOffsets = Buffer.allocUnsafe(SIZEOF_OFFSETS);
	newOffsets.fill(0);
	let offsetsPos = 0;
	newOffsets.writeBigUInt64LE(BigInt(newData.length), offsetsPos);
	offsetsPos += 8;
	newOffsets.writeUInt32LE(oldOffsets.modulesPtr.offset, offsetsPos);
	newOffsets.writeUInt32LE(oldOffsets.modulesPtr.length, offsetsPos + 4);
	offsetsPos += 8;
	newOffsets.writeUInt32LE(oldOffsets.entryPointId, offsetsPos);
	offsetsPos += 4;
	newOffsets.writeUInt32LE(oldOffsets.compileExecArgvPtr.offset, offsetsPos);
	newOffsets.writeUInt32LE(
		oldOffsets.compileExecArgvPtr.length,
		offsetsPos + 4,
	);
	offsetsPos += 8;
	newOffsets.writeUInt32LE(oldOffsets.flags, offsetsPos);

	return Buffer.concat([newData, newOffsets, BUN_TRAILER]);
}

function writeBinaryAtomically(targetPath: string, content: Buffer): void {
	const tmp = `${targetPath}.tmp`;
	const mode = fs.statSync(targetPath).mode;
	try {
		fs.writeFileSync(tmp, content);
		fs.chmodSync(tmp, mode);
		fs.renameSync(tmp, targetPath);
	} catch (error) {
		try {
			if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
		} catch {
			// best-effort cleanup
		}
		throw toWriteError(error, targetPath);
	}
}

export function isElfBinary(filePath: string): boolean {
	try {
		const fd = fs.openSync(filePath, "r");
		const buf = Buffer.allocUnsafe(4);
		const read = fs.readSync(fd, buf, 0, 4, 0);
		fs.closeSync(fd);
		if (read !== 4) return false;
		return buf.equals(ELF_MAGIC);
	} catch {
		return false;
	}
}

export function extractClaudeJsFromNativeLinux(
	filePath: string,
): ExtractedNativeLinux {
	const binary = fs.readFileSync(filePath);
	const { bunBlob, bunOffsets, bunBlobStart, moduleStructSize } =
		parseLinuxBunBlob(binary);
	const tailValue = binary.readBigUInt64LE(binary.length - 8);
	const matchCount = countClaudeModules(bunBlob, bunOffsets, moduleStructSize);
	if (matchCount > 1) {
		throw new Error(
			`Ambiguous Bun binary: ${matchCount} modules match isClaudeModule (expected exactly 1)`,
		);
	}
	const claudeJs = mapModules(
		bunBlob,
		bunOffsets,
		moduleStructSize,
		(module, moduleName) => {
			if (!isClaudeModule(moduleName)) return undefined;
			const contents = getPointerContent(bunBlob, module.contents);
			return contents.length > 0 ? contents : undefined;
		},
	);
	if (!claudeJs) {
		throw new Error("Could not locate embedded claude module in Bun binary");
	}
	return {
		binary,
		bunBlob,
		bunOffsets,
		bunBlobStart,
		moduleStructSize,
		tailValue,
		claudeJs,
	};
}

export function repackNativeLinuxBinary(
	filePath: string,
	modifiedClaudeJs: Buffer,
	outputPath: string = filePath,
): void {
	const extracted = extractClaudeJsFromNativeLinux(filePath);
	const rebuiltBunBlob = rebuildBunBlob(
		extracted.bunBlob,
		extracted.bunOffsets,
		modifiedClaudeJs,
		extracted.moduleStructSize,
	);
	const newOverlay = Buffer.allocUnsafe(rebuiltBunBlob.length + 8);
	rebuiltBunBlob.copy(newOverlay, 0);
	// Bun native binaries have used different trailer conventions across releases:
	// some store full file size, others store overlay size. Preserve the original mode.
	const tailUsesFileSize =
		extracted.tailValue === BigInt(extracted.binary.length);
	const tailValue = tailUsesFileSize
		? BigInt(extracted.bunBlobStart + rebuiltBunBlob.length + 8)
		: BigInt(rebuiltBunBlob.length);
	newOverlay.writeBigUInt64LE(tailValue, rebuiltBunBlob.length);

	const patchedBinary = Buffer.concat([
		extracted.binary.subarray(0, extracted.bunBlobStart),
		newOverlay,
	]);

	if (outputPath === filePath) {
		writeBinaryAtomically(filePath, patchedBinary);
		return;
	}
	try {
		fs.writeFileSync(outputPath, patchedBinary);
		fs.chmodSync(outputPath, fs.statSync(filePath).mode);
	} catch (error) {
		throw toWriteError(error, outputPath);
	}
}
