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
	tailValue: bigint;
} {
	if (binary.length < BUN_TRAILER.length + 8 + SIZEOF_OFFSETS) {
		throw new Error("Binary too small to contain Bun overlay");
	}

	// Older binaries have the overlay at EOF; newer builds append ELF sections
	// after it, and the embedded JS can also contain false-positive trailer
	// strings. Scan backward and validate each candidate instead of trusting the
	// first match blindly.
	let searchFrom = binary.length - BUN_TRAILER.length;
	let lastError: Error | null = null;

	while (searchFrom >= 0) {
		const trailerStart = binary.lastIndexOf(BUN_TRAILER, searchFrom);
		if (trailerStart < 0) break;

		try {
			const trailerEnd = trailerStart + BUN_TRAILER.length;

			// The 8-byte tail value sits immediately after the trailer.
			const tailValue =
				trailerEnd + 8 <= binary.length
					? binary.readBigUInt64LE(trailerEnd)
					: 0n;

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
			const expectedLength =
				byteCountNumber + SIZEOF_OFFSETS + BUN_TRAILER.length;
			if (bunBlob.length !== expectedLength) {
				throw new Error(
					`Unexpected Bun blob length: got ${bunBlob.length}, expected ${expectedLength}`,
				);
			}

			const moduleStructSize = detectModuleStructSize(
				bunOffsets.modulesPtr.length,
			);

			return {
				bunBlob,
				bunOffsets,
				bunBlobStart: dataStart,
				moduleStructSize,
				tailValue,
			};
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			searchFrom = trailerStart - 1;
		}
	}

	if (lastError) {
		throw lastError;
	}
	throw new Error("Bun trailer not found in binary");
}

/**
 * Rebuild Bun blob by appending new claude content to existing data
 * and patching the module entry in-place (Linux overlay strategy).
 */

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
	const { bunBlob, bunOffsets, bunBlobStart, moduleStructSize, tailValue } =
		parseLinuxBunBlob(binary);
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

	// Bun 1.3+ validates overlay integrity via memory-mapped PT_LOAD segments.
	// Rebuilding the overlay (appending data, changing byteCount) breaks this.
	// Instead, patch in-place: write the new content over the bytecode area
	// (which is zeroed anyway) and update the module's content pointer.
	const claudeModule = findClaudeModuleEntry(
		extracted.bunBlob,
		extracted.bunOffsets,
		extracted.moduleStructSize,
	);

	if (modifiedClaudeJs.length > claudeModule.bytecodeLen) {
		throw new Error(
			`Modified JS (${modifiedClaudeJs.length} bytes) exceeds bytecode area (${claudeModule.bytecodeLen} bytes)`,
		);
	}

	// Copy the full binary (we patch in-place)
	const patchedBinary = Buffer.from(extracted.binary);
	const dataStart = extracted.bunBlobStart;

	// Write new content over the bytecode region
	const newContentOff = claudeModule.bytecodeOff;
	modifiedClaudeJs.copy(patchedBinary, dataStart + newContentOff);
	// Null-terminate
	if (modifiedClaudeJs.length < claudeModule.bytecodeLen) {
		patchedBinary[dataStart + newContentOff + modifiedClaudeJs.length] = 0;
	}

	// Update content pointer to the new location
	const moduleEntryBase =
		dataStart +
		extracted.bunOffsets.modulesPtr.offset +
		claudeModule.index * extracted.moduleStructSize;
	patchedBinary.writeUInt32LE(newContentOff, moduleEntryBase + 8); // contents.offset
	patchedBinary.writeUInt32LE(modifiedClaudeJs.length, moduleEntryBase + 12); // contents.length

	// Zero out bytecode pointer
	patchedBinary.writeUInt32LE(0, moduleEntryBase + 24);
	patchedBinary.writeUInt32LE(0, moduleEntryBase + 28);

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

function findClaudeModuleEntry(
	bunBlob: Buffer,
	bunOffsets: BunOffsets,
	moduleStructSize: number,
): { index: number; bytecodeOff: number; bytecodeLen: number } {
	const moduleCount = Math.floor(
		bunOffsets.modulesPtr.length / moduleStructSize,
	);
	for (let i = 0; i < moduleCount; i++) {
		const module = parseModule(
			bunBlob.subarray(
				bunOffsets.modulesPtr.offset,
				bunOffsets.modulesPtr.offset + bunOffsets.modulesPtr.length,
			),
			i * moduleStructSize,
			moduleStructSize,
		);
		const moduleName = getPointerContent(bunBlob, module.name).toString(
			"utf-8",
		);
		if (isClaudeModule(moduleName)) {
			return {
				index: i,
				bytecodeOff: module.bytecode.offset,
				bytecodeLen: module.bytecode.length,
			};
		}
	}
	throw new Error("Could not locate claude module for in-place repack");
}
