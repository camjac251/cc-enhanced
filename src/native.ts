import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import {
	BUN_TRAILER,
	type BunOffsets,
	countClaudeModules,
	detectModuleStructSize,
	getPointerContent,
	isClaudeModule,
	mapModules,
	parseOffsets,
	SIZEOF_MODULE_NEW,
	SIZEOF_OFFSETS,
	type StringPointer,
	toWriteError,
} from "./bun-format.js";
import {
	extractClaudeJsFromNativeLinux,
	isElfBinary,
	repackNativeLinuxBinary,
	unwrapBunCjsModule,
	wrapBunCjsModule,
} from "./native-linux.js";

const require = createRequire(import.meta.url);

const MACHO_MAGIC_32_BE = Buffer.from([0xfe, 0xed, 0xfa, 0xce]);
const MACHO_MAGIC_64_BE = Buffer.from([0xfe, 0xed, 0xfa, 0xcf]);
const MACHO_MAGIC_32_LE = Buffer.from([0xce, 0xfa, 0xed, 0xfe]);
const MACHO_MAGIC_64_LE = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);
const MACHO_FAT = Buffer.from([0xca, 0xfe, 0xba, 0xbe]);
const PE_MAGIC = Buffer.from([0x4d, 0x5a]);

interface LiefBunData {
	bunBlob: Buffer;
	bunOffsets: BunOffsets;
	sectionHeaderSize: number;
	moduleStructSize: number;
	format: "MachO" | "PE";
	binary: any;
	segment?: any;
	section: any;
}

type NodeLiefModule = {
	logging?: { disable?: () => void };
	parse: (filePath: string) => any;
};

export type NativeBinaryKind = "elf" | "macho" | "pe" | "unknown";

function parseSectionBunBlob(sectionData: Buffer): {
	bunBlob: Buffer;
	bunOffsets: BunOffsets;
	sectionHeaderSize: number;
	moduleStructSize: number;
} {
	if (sectionData.length < 4) {
		throw new Error("Native section is too small");
	}

	const sizeU32 = sectionData.readUInt32LE(0);
	const expectedU32 = 4 + sizeU32;
	const hasU64 = sectionData.length >= 8;
	const sizeU64 = hasU64 ? Number(sectionData.readBigUInt64LE(0)) : 0;
	const expectedU64 = 8 + sizeU64;

	let sectionHeaderSize: number;
	let bunBlobSize: number;
	if (
		hasU64 &&
		Number.isFinite(sizeU64) &&
		expectedU64 <= sectionData.length &&
		expectedU64 >= sectionData.length - 4096
	) {
		sectionHeaderSize = 8;
		bunBlobSize = sizeU64;
	} else if (
		Number.isFinite(sizeU32) &&
		expectedU32 <= sectionData.length &&
		expectedU32 >= sectionData.length - 4096
	) {
		sectionHeaderSize = 4;
		bunBlobSize = sizeU32;
	} else {
		throw new Error(
			`Could not determine Bun section header format (len=${sectionData.length})`,
		);
	}

	const bunBlob = sectionData.subarray(
		sectionHeaderSize,
		sectionHeaderSize + bunBlobSize,
	);
	if (bunBlob.length < SIZEOF_OFFSETS + BUN_TRAILER.length) {
		throw new Error("Bun section payload too small");
	}

	const trailerStart = bunBlob.length - BUN_TRAILER.length;
	const trailer = bunBlob.subarray(trailerStart);
	if (!trailer.equals(BUN_TRAILER)) {
		throw new Error("Bun trailer missing from section payload");
	}

	const offsetsStart = bunBlob.length - SIZEOF_OFFSETS - BUN_TRAILER.length;
	const offsets = bunBlob.subarray(offsetsStart, offsetsStart + SIZEOF_OFFSETS);
	const bunOffsets = parseOffsets(offsets);
	const moduleStructSize = detectModuleStructSize(bunOffsets.modulesPtr.length);

	return { bunBlob, bunOffsets, sectionHeaderSize, moduleStructSize };
}

function rebuildBunBlob(
	oldBunBlob: Buffer,
	oldOffsets: BunOffsets,
	modifiedClaudeJs: Buffer,
	moduleStructSize: number,
): Buffer {
	const isNewFormat = moduleStructSize === SIZEOF_MODULE_NEW;
	const stringsPerModule = isNewFormat ? 6 : 4;
	const strings: Buffer[] = [];
	const modules: Array<{
		name: Buffer;
		contents: Buffer;
		sourcemap: Buffer;
		bytecode: Buffer;
		moduleInfo: Buffer;
		bytecodeOriginPath: Buffer;
		encoding: number;
		loader: number;
		moduleFormat: number;
		side: number;
	}> = [];

	mapModules(oldBunBlob, oldOffsets, moduleStructSize, (module, moduleName) => {
		const nameBytes = getPointerContent(oldBunBlob, module.name);
		const contentsBytes = isClaudeModule(moduleName)
			? modifiedClaudeJs
			: getPointerContent(oldBunBlob, module.contents);
		const sourcemapBytes = getPointerContent(oldBunBlob, module.sourcemap);
		const bytecodeBytes = getPointerContent(oldBunBlob, module.bytecode);
		const moduleInfoBytes = module.moduleInfo
			? getPointerContent(oldBunBlob, module.moduleInfo)
			: Buffer.alloc(0);
		const bytecodeOriginPathBytes = module.bytecodeOriginPath
			? getPointerContent(oldBunBlob, module.bytecodeOriginPath)
			: Buffer.alloc(0);

		modules.push({
			name: nameBytes,
			contents: contentsBytes,
			sourcemap: sourcemapBytes,
			bytecode: bytecodeBytes,
			moduleInfo: moduleInfoBytes,
			bytecodeOriginPath: bytecodeOriginPathBytes,
			encoding: module.encoding,
			loader: module.loader,
			moduleFormat: module.moduleFormat,
			side: module.side,
		});
		strings.push(nameBytes, contentsBytes, sourcemapBytes, bytecodeBytes);
		if (isNewFormat) {
			strings.push(moduleInfoBytes, bytecodeOriginPathBytes);
		}
		return undefined;
	});

	let offset = 0;
	const pointers: StringPointer[] = [];
	for (const str of strings) {
		pointers.push({ offset, length: str.length });
		offset += str.length + 1;
	}

	const modulesListOffset = offset;
	const modulesListSize = modules.length * moduleStructSize;
	offset += modulesListSize;

	const compileExecArgv = getPointerContent(
		oldBunBlob,
		oldOffsets.compileExecArgvPtr,
	);
	const compileExecArgvOffset = offset;
	const compileExecArgvLength = compileExecArgv.length;
	offset += compileExecArgvLength + 1;

	const offsetsOffset = offset;
	offset += SIZEOF_OFFSETS;

	const trailerOffset = offset;
	offset += BUN_TRAILER.length;

	const out = Buffer.allocUnsafe(offset);
	out.fill(0);

	let i = 0;
	for (const ptr of pointers) {
		const str = strings[i++];
		if (ptr.length > 0) {
			str.copy(out, ptr.offset, 0, ptr.length);
		}
		out[ptr.offset + ptr.length] = 0;
	}

	if (compileExecArgvLength > 0) {
		compileExecArgv.copy(out, compileExecArgvOffset, 0, compileExecArgvLength);
		out[compileExecArgvOffset + compileExecArgvLength] = 0;
	}

	for (let moduleIndex = 0; moduleIndex < modules.length; moduleIndex++) {
		const moduleData = modules[moduleIndex];
		const base = moduleIndex * stringsPerModule;

		let pos = modulesListOffset + moduleIndex * moduleStructSize;
		out.writeUInt32LE(pointers[base].offset, pos);
		out.writeUInt32LE(pointers[base].length, pos + 4);
		pos += 8;
		out.writeUInt32LE(pointers[base + 1].offset, pos);
		out.writeUInt32LE(pointers[base + 1].length, pos + 4);
		pos += 8;
		out.writeUInt32LE(pointers[base + 2].offset, pos);
		out.writeUInt32LE(pointers[base + 2].length, pos + 4);
		pos += 8;
		out.writeUInt32LE(pointers[base + 3].offset, pos);
		out.writeUInt32LE(pointers[base + 3].length, pos + 4);
		pos += 8;
		if (isNewFormat) {
			out.writeUInt32LE(pointers[base + 4].offset, pos);
			out.writeUInt32LE(pointers[base + 4].length, pos + 4);
			pos += 8;
			out.writeUInt32LE(pointers[base + 5].offset, pos);
			out.writeUInt32LE(pointers[base + 5].length, pos + 4);
			pos += 8;
		}
		out.writeUInt8(moduleData.encoding, pos);
		out.writeUInt8(moduleData.loader, pos + 1);
		out.writeUInt8(moduleData.moduleFormat, pos + 2);
		out.writeUInt8(moduleData.side, pos + 3);
	}

	let offsetsPos = offsetsOffset;
	out.writeBigUInt64LE(BigInt(offsetsOffset), offsetsPos);
	offsetsPos += 8;
	out.writeUInt32LE(modulesListOffset, offsetsPos);
	out.writeUInt32LE(modulesListSize, offsetsPos + 4);
	offsetsPos += 8;
	out.writeUInt32LE(oldOffsets.entryPointId, offsetsPos);
	offsetsPos += 4;
	out.writeUInt32LE(compileExecArgvOffset, offsetsPos);
	out.writeUInt32LE(compileExecArgvLength, offsetsPos + 4);
	offsetsPos += 8;
	out.writeUInt32LE(oldOffsets.flags, offsetsPos);

	BUN_TRAILER.copy(out, trailerOffset);
	return out;
}

function loadNodeLief(): NodeLiefModule {
	try {
		return require("node-lief") as NodeLiefModule;
	} catch {
		throw new Error(
			"Mach-O/PE native patching requires node-lief. Install it with `bun add node-lief`.",
		);
	}
}

function maybeCodesignMac(outputPath: string): void {
	if (process.platform !== "darwin") return;
	try {
		execFileSync("codesign", ["-s", "-", "-f", outputPath], {
			stdio: "ignore",
		});
	} catch {
		// best-effort re-signing
	}
}

function writeLiefBinary(
	binary: any,
	sourcePath: string,
	outputPath: string,
	format: "MachO" | "PE",
): void {
	const tmp = `${outputPath}.tmp`;
	try {
		binary.write(tmp);
		const mode = fs.statSync(sourcePath).mode;
		fs.chmodSync(tmp, mode);
		fs.renameSync(tmp, outputPath);
		if (format === "MachO") maybeCodesignMac(outputPath);
	} catch (error) {
		try {
			if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
		} catch {
			// best-effort cleanup
		}
		throw toWriteError(error, outputPath);
	}
}

function extractLiefBunData(filePath: string): LiefBunData {
	const lief = loadNodeLief();
	lief.logging?.disable?.();
	const binary = lief.parse(filePath);
	if (!binary) {
		throw new Error(`Unable to parse native binary: ${filePath}`);
	}

	if (binary.format === "MachO") {
		const segment = binary.getSegment("__BUN");
		const section = segment?.getSection("__bun");
		if (!section) throw new Error("Mach-O __BUN/__bun section not found");
		const sectionData = Buffer.from(section.content as Uint8Array);
		const { bunBlob, bunOffsets, sectionHeaderSize, moduleStructSize } =
			parseSectionBunBlob(sectionData);
		return {
			bunBlob,
			bunOffsets,
			sectionHeaderSize,
			moduleStructSize,
			format: "MachO",
			binary,
			segment,
			section,
		};
	}

	if (binary.format === "PE") {
		const section = (binary.sections?.() ?? []).find(
			(s: any) => s.name === ".bun",
		);
		if (!section) throw new Error("PE .bun section not found");
		const sectionData = Buffer.from(section.content as Uint8Array);
		const { bunBlob, bunOffsets, sectionHeaderSize, moduleStructSize } =
			parseSectionBunBlob(sectionData);
		return {
			bunBlob,
			bunOffsets,
			sectionHeaderSize,
			moduleStructSize,
			format: "PE",
			binary,
			section,
		};
	}

	throw new Error(
		`Unsupported native binary format from node-lief: ${binary.format}`,
	);
}

function extractClaudeJsFromBunBlob(
	bunBlob: Buffer,
	bunOffsets: BunOffsets,
	moduleStructSize: number,
): Buffer {
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
	return claudeJs;
}

export function detectNativeBinaryKind(filePath: string): NativeBinaryKind {
	if (isElfBinary(filePath)) return "elf";
	try {
		const fd = fs.openSync(filePath, "r");
		const buf = Buffer.allocUnsafe(4);
		const read = fs.readSync(fd, buf, 0, 4, 0);
		fs.closeSync(fd);
		if (read < 2) return "unknown";
		if (
			buf.equals(MACHO_MAGIC_32_BE) ||
			buf.equals(MACHO_MAGIC_64_BE) ||
			buf.equals(MACHO_MAGIC_32_LE) ||
			buf.equals(MACHO_MAGIC_64_LE) ||
			buf.equals(MACHO_FAT)
		) {
			return "macho";
		}
		if (buf.subarray(0, 2).equals(PE_MAGIC)) {
			return "pe";
		}
		return "unknown";
	} catch {
		return "unknown";
	}
}

export function isNativeBinary(filePath: string): boolean {
	return detectNativeBinaryKind(filePath) !== "unknown";
}

export function extractClaudeJsFromNativeBinary(filePath: string): Buffer {
	const kind = detectNativeBinaryKind(filePath);
	if (kind === "elf") {
		return extractClaudeJsFromNativeLinux(filePath).claudeJs;
	}
	if (kind === "macho" || kind === "pe") {
		const extracted = extractLiefBunData(filePath);
		return extractClaudeJsFromBunBlob(
			extracted.bunBlob,
			extracted.bunOffsets,
			extracted.moduleStructSize,
		);
	}
	throw new Error(`Unsupported native binary: ${filePath}`);
}

export function repackNativeBinary(
	filePath: string,
	modifiedClaudeJs: Buffer,
	outputPath: string = filePath,
): void {
	const kind = detectNativeBinaryKind(filePath);
	if (kind === "elf") {
		repackNativeLinuxBinary(filePath, modifiedClaudeJs, outputPath);
		return;
	}
	if (kind !== "macho" && kind !== "pe") {
		throw new Error(`Unsupported native binary: ${filePath}`);
	}

	const extracted = extractLiefBunData(filePath);
	const rebuiltBunBlob = rebuildBunBlob(
		extracted.bunBlob,
		extracted.bunOffsets,
		modifiedClaudeJs,
		extracted.moduleStructSize,
	);
	const header =
		extracted.sectionHeaderSize === 8
			? Buffer.allocUnsafe(8)
			: Buffer.allocUnsafe(4);
	if (extracted.sectionHeaderSize === 8) {
		header.writeBigUInt64LE(BigInt(rebuiltBunBlob.length), 0);
	} else {
		header.writeUInt32LE(rebuiltBunBlob.length, 0);
	}
	const newSectionData = Buffer.concat([header, rebuiltBunBlob]);

	if (extracted.format === "MachO") {
		const binary = extracted.binary;
		if (binary.hasCodeSignature) {
			binary.removeSignature();
		}
		const currentSize = Number(extracted.section.size ?? 0);
		const growth = newSectionData.length - currentSize;
		if (
			growth > 0 &&
			extracted.segment &&
			typeof binary.extendSegment === "function"
		) {
			const pageSize = 16384;
			const extendBy = Math.ceil(growth / pageSize) * pageSize;
			const ok = binary.extendSegment(extracted.segment, extendBy);
			if (!ok) throw new Error("Failed to extend Mach-O __BUN segment");
		}
		extracted.section.content = newSectionData;
		extracted.section.size = BigInt(newSectionData.length);
		writeLiefBinary(binary, filePath, outputPath, "MachO");
		return;
	}

	extracted.section.content = newSectionData;
	extracted.section.virtualSize = BigInt(newSectionData.length);
	extracted.section.size = BigInt(newSectionData.length);
	writeLiefBinary(extracted.binary, filePath, outputPath, "PE");
}

export { unwrapBunCjsModule, wrapBunCjsModule };
