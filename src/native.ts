import * as fs from "node:fs";
import {
	BUN_TRAILER,
	type BunEmbeddedModule,
	type BunOffsets,
	detectModuleStructSize,
	getPointerContent,
	listEmbeddedModules,
	mapEntryPointModule,
	parseOffsets,
	replaceEntryPointModuleInPlace,
	SIZEOF_OFFSETS,
	toWriteError,
} from "./bun-format.js";
import {
	locateLiefBunSection,
	type NativeBunSectionLayout,
} from "./native-lief.js";
import {
	copyBunCjsEnvelope,
	extractClaudeJsFromNativeLinux,
	isElfBinary,
	repackNativeLinuxBinary,
	unwrapBunCjsModule,
	wrapBunCjsModule,
	wrapBunCjsModuleBuffer,
} from "./native-linux.js";

const MACHO_MAGIC_32_BE = Buffer.from([0xfe, 0xed, 0xfa, 0xce]);
const MACHO_MAGIC_64_BE = Buffer.from([0xfe, 0xed, 0xfa, 0xcf]);
const MACHO_MAGIC_32_LE = Buffer.from([0xce, 0xfa, 0xed, 0xfe]);
const MACHO_MAGIC_64_LE = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);
const MACHO_FAT = Buffer.from([0xca, 0xfe, 0xba, 0xbe]);
const PE_MAGIC = Buffer.from([0x4d, 0x5a]);

interface LiefBunData {
	binary: Buffer;
	bunBlob: Buffer;
	bunOffsets: BunOffsets;
	sectionHeaderSize: number;
	moduleStructSize: number;
	layout: NativeBunSectionLayout;
}

export type NativeBinaryKind = "elf" | "macho" | "pe" | "unknown";

export interface NativeEmbeddedModuleSet {
	entryPointId: number;
	modules: BunEmbeddedModule[];
}

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

function writeFixedLayoutBinary(
	content: Buffer,
	sourcePath: string,
	outputPath: string,
): void {
	const tmp = `${outputPath}.tmp`;
	try {
		fs.writeFileSync(tmp, content);
		const mode = fs.statSync(sourcePath).mode;
		fs.chmodSync(tmp, mode);
		fs.renameSync(tmp, outputPath);
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
	const layout = locateLiefBunSection(filePath);
	const binary = fs.readFileSync(filePath);
	const sectionData = binary.subarray(
		layout.fileOffset,
		layout.fileOffset + layout.fileSize,
	);
	const { bunBlob, bunOffsets, sectionHeaderSize, moduleStructSize } =
		parseSectionBunBlob(sectionData);
	return {
		binary,
		bunBlob,
		bunOffsets,
		sectionHeaderSize,
		moduleStructSize,
		layout,
	};
}

function extractClaudeJsFromBunBlob(
	bunBlob: Buffer,
	bunOffsets: BunOffsets,
	moduleStructSize: number,
): Buffer {
	const claudeJs = mapEntryPointModule(
		bunBlob,
		bunOffsets,
		moduleStructSize,
		(module) => {
			const contents = getPointerContent(bunBlob, module.contents);
			return contents.length > 0 ? contents : undefined;
		},
	);
	if (!claudeJs) {
		throw new Error(
			"Could not locate embedded entry-point module in Bun binary",
		);
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

export function extractEmbeddedModulesFromNativeBinary(
	filePath: string,
): NativeEmbeddedModuleSet {
	const kind = detectNativeBinaryKind(filePath);
	if (kind === "elf") {
		const extracted = extractClaudeJsFromNativeLinux(filePath);
		return {
			entryPointId: extracted.bunOffsets.entryPointId,
			modules: listEmbeddedModules(
				extracted.bunBlob,
				extracted.bunOffsets,
				extracted.moduleStructSize,
			),
		};
	}
	if (kind === "macho" || kind === "pe") {
		const extracted = extractLiefBunData(filePath);
		return {
			entryPointId: extracted.bunOffsets.entryPointId,
			modules: listEmbeddedModules(
				extracted.bunBlob,
				extracted.bunOffsets,
				extracted.moduleStructSize,
			),
		};
	}
	throw new Error(`Unsupported native binary: ${filePath}`);
}

export function repackNativeBinary(
	filePath: string,
	modifiedClaudeJs: Buffer,
	outputPath: string = filePath,
	allowPackedContentsSpan = false,
): void {
	const kind = detectNativeBinaryKind(filePath);
	if (kind === "elf") {
		repackNativeLinuxBinary(
			filePath,
			modifiedClaudeJs,
			outputPath,
			allowPackedContentsSpan,
		);
		return;
	}
	if (kind !== "macho" && kind !== "pe") {
		throw new Error(`Unsupported native binary: ${filePath}`);
	}

	const extracted = extractLiefBunData(filePath);
	const patchedBinary = Buffer.from(extracted.binary);
	const bunBlobStart =
		extracted.layout.fileOffset + extracted.sectionHeaderSize;
	const bunBlobEnd = bunBlobStart + extracted.bunBlob.length;
	const sectionEnd = extracted.layout.fileOffset + extracted.layout.fileSize;
	if (bunBlobEnd > sectionEnd) {
		throw new Error(
			`Bun payload range (${bunBlobStart}+${extracted.bunBlob.length}) exceeds ${extracted.layout.sectionName} section`,
		);
	}
	const patchedBunBlob = patchedBinary.subarray(bunBlobStart, bunBlobEnd);
	replaceEntryPointModuleInPlace(
		patchedBunBlob,
		extracted.bunOffsets,
		extracted.moduleStructSize,
		modifiedClaudeJs,
		allowPackedContentsSpan,
	);
	const roundTrip = extractClaudeJsFromBunBlob(
		patchedBunBlob,
		extracted.bunOffsets,
		extracted.moduleStructSize,
	);
	if (!roundTrip.equals(modifiedClaudeJs)) {
		throw new Error("Fixed-layout Bun entry-point verification failed");
	}
	if (
		patchedBinary.length !== extracted.binary.length ||
		!patchedBinary
			.subarray(0, extracted.layout.fileOffset)
			.equals(extracted.binary.subarray(0, extracted.layout.fileOffset)) ||
		!patchedBinary
			.subarray(sectionEnd)
			.equals(extracted.binary.subarray(sectionEnd))
	) {
		throw new Error(
			"Fixed-layout native repack changed bytes outside Bun section",
		);
	}

	writeFixedLayoutBinary(patchedBinary, filePath, outputPath);
}

export {
	copyBunCjsEnvelope,
	unwrapBunCjsModule,
	wrapBunCjsModule,
	wrapBunCjsModuleBuffer,
};
