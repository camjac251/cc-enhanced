import type { FileHandle } from "node:fs/promises";
import type { NativeArtifactPlatform } from "./targets/contract.js";

export type NativeSignaturePresence = "present" | "absent" | "not-applicable";
export type NativeSignatureMechanism =
	| "pe-certificate-table"
	| "macho-code-signature-command"
	| "not-applicable";

export interface NativeSignaturePresenceEvidence {
	presence: NativeSignaturePresence;
	mechanism: NativeSignatureMechanism;
}

export interface NativeRandomAccessReader {
	size: number;
	read(offset: number, length: number): Promise<Buffer>;
}

const MAX_NATIVE_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const MAX_PE_HEADER_OFFSET = 16 * 1024 * 1024;
const MAX_MACHO_LOAD_COMMAND_BYTES = 16 * 1024 * 1024;
const MAX_MACHO_LOAD_COMMANDS = 4096;
const LC_CODE_SIGNATURE = 0x1d;

async function readExact(
	reader: NativeRandomAccessReader,
	offset: number,
	length: number,
	label: string,
): Promise<Buffer> {
	if (
		!Number.isSafeInteger(offset) ||
		!Number.isSafeInteger(length) ||
		offset < 0 ||
		length < 0 ||
		offset + length > reader.size
	) {
		throw new Error(`${label} is outside the native artifact`);
	}
	const bytes = await reader.read(offset, length);
	if (bytes.length !== length) {
		throw new Error(`${label} could not be read completely`);
	}
	return bytes;
}

async function inspectPeCertificateTable(
	reader: NativeRandomAccessReader,
): Promise<NativeSignaturePresenceEvidence> {
	const dos = await readExact(reader, 0, 0x40, "PE DOS header");
	if (dos.toString("ascii", 0, 2) !== "MZ") {
		throw new Error("Windows artifact lacks a valid DOS header");
	}
	const peOffset = dos.readUInt32LE(0x3c);
	if (peOffset < 0x40 || peOffset > MAX_PE_HEADER_OFFSET) {
		throw new Error(
			"Windows artifact PE header offset exceeds inspection limit",
		);
	}
	const coff = await readExact(reader, peOffset, 24, "PE and COFF headers");
	if (coff.toString("binary", 0, 4) !== "PE\0\0") {
		throw new Error("Windows artifact lacks a valid PE header");
	}
	const optionalSize = coff.readUInt16LE(20);
	const optionalOffset = peOffset + 24;
	const optional = await readExact(
		reader,
		optionalOffset,
		optionalSize,
		"PE optional header",
	);
	if (optional.length < 2) {
		throw new Error("Windows artifact optional header is too small");
	}
	const magic = optional.readUInt16LE(0);
	const numberOfDirectoriesOffset = magic === 0x20b ? 108 : 92;
	const directoriesOffset = magic === 0x20b ? 112 : 96;
	if (magic !== 0x20b && magic !== 0x10b) {
		throw new Error("Windows artifact has an unsupported PE optional header");
	}
	if (numberOfDirectoriesOffset + 4 > optional.length) {
		throw new Error("Windows artifact data-directory count is out of bounds");
	}
	const numberOfDirectories = optional.readUInt32LE(numberOfDirectoriesOffset);
	if (numberOfDirectories <= 4) {
		return { presence: "absent", mechanism: "pe-certificate-table" };
	}
	const securityDirectory = directoriesOffset + 4 * 8;
	if (securityDirectory + 8 > optional.length) {
		throw new Error("Windows artifact security directory is out of bounds");
	}
	const certificateOffset = optional.readUInt32LE(securityDirectory);
	const certificateSize = optional.readUInt32LE(securityDirectory + 4);
	if (certificateOffset === 0 && certificateSize === 0) {
		return { presence: "absent", mechanism: "pe-certificate-table" };
	}
	if (
		certificateOffset === 0 ||
		certificateSize === 0 ||
		certificateOffset + certificateSize > reader.size
	) {
		throw new Error("Windows artifact certificate table is inconsistent");
	}
	return { presence: "present", mechanism: "pe-certificate-table" };
}

type MachOByteOrder = { headerSize: number; littleEndian: boolean };

function parseMachOByteOrder(magic: Buffer): MachOByteOrder {
	const key = magic.toString("hex");
	switch (key) {
		case "cefaedfe":
			return { headerSize: 28, littleEndian: true };
		case "cffaedfe":
			return { headerSize: 32, littleEndian: true };
		case "feedface":
			return { headerSize: 28, littleEndian: false };
		case "feedfacf":
			return { headerSize: 32, littleEndian: false };
		default:
			throw new Error("macOS artifact lacks a supported thin Mach-O header");
	}
}

function readUInt32(
	buffer: Buffer,
	offset: number,
	littleEndian: boolean,
): number {
	return littleEndian
		? buffer.readUInt32LE(offset)
		: buffer.readUInt32BE(offset);
}

async function inspectMachOCodeSignature(
	reader: NativeRandomAccessReader,
): Promise<NativeSignaturePresenceEvidence> {
	const magic = await readExact(reader, 0, 4, "Mach-O magic");
	const byteOrder = parseMachOByteOrder(magic);
	const header = await readExact(
		reader,
		0,
		byteOrder.headerSize,
		"Mach-O header",
	);
	const commandCount = readUInt32(header, 16, byteOrder.littleEndian);
	const commandBytes = readUInt32(header, 20, byteOrder.littleEndian);
	if (commandCount > MAX_MACHO_LOAD_COMMANDS) {
		throw new Error("Mach-O load command count exceeds inspection limit");
	}
	if (commandBytes > MAX_MACHO_LOAD_COMMAND_BYTES) {
		throw new Error("Mach-O load commands exceed inspection limit");
	}
	const commandsEnd = byteOrder.headerSize + commandBytes;
	if (commandsEnd > reader.size) {
		throw new Error("Mach-O load commands are outside the native artifact");
	}

	let offset = byteOrder.headerSize;
	for (let index = 0; index < commandCount; index += 1) {
		const commandHeader = await readExact(
			reader,
			offset,
			8,
			"Mach-O load command header",
		);
		const command = readUInt32(commandHeader, 0, byteOrder.littleEndian);
		const commandSize = readUInt32(commandHeader, 4, byteOrder.littleEndian);
		if (
			commandSize < 8 ||
			commandSize % 4 !== 0 ||
			offset + commandSize > commandsEnd
		) {
			throw new Error("Mach-O load command is inconsistent");
		}
		if (command === LC_CODE_SIGNATURE) {
			if (commandSize < 16) {
				throw new Error("Mach-O code-signature command is too small");
			}
			const codeSignature = await readExact(
				reader,
				offset,
				16,
				"Mach-O code-signature command",
			);
			const dataOffset = readUInt32(codeSignature, 8, byteOrder.littleEndian);
			const dataSize = readUInt32(codeSignature, 12, byteOrder.littleEndian);
			if (
				dataOffset === 0 ||
				dataSize === 0 ||
				dataOffset + dataSize > reader.size
			) {
				throw new Error("Mach-O code-signature range is inconsistent");
			}
			return {
				presence: "present",
				mechanism: "macho-code-signature-command",
			};
		}
		offset += commandSize;
	}
	if (offset !== commandsEnd) {
		throw new Error("Mach-O load command size is inconsistent");
	}
	return {
		presence: "absent",
		mechanism: "macho-code-signature-command",
	};
}

export async function inspectNativeSignaturePresenceFromReader(
	reader: NativeRandomAccessReader,
	platform: NativeArtifactPlatform,
): Promise<NativeSignaturePresenceEvidence> {
	if (
		!Number.isSafeInteger(reader.size) ||
		reader.size < 1 ||
		reader.size > MAX_NATIVE_ARTIFACT_BYTES
	) {
		throw new Error("Native artifact size exceeds signature inspection limit");
	}
	if (platform.startsWith("linux-")) {
		return { presence: "not-applicable", mechanism: "not-applicable" };
	}
	if (platform.startsWith("win32-")) {
		return await inspectPeCertificateTable(reader);
	}
	return await inspectMachOCodeSignature(reader);
}

function hasSameIdentity(
	left: Awaited<ReturnType<FileHandle["stat"]>>,
	right: Awaited<ReturnType<FileHandle["stat"]>>,
): boolean {
	return (
		left.size === right.size &&
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs
	);
}

export async function inspectNativeSignaturePresence(
	handle: FileHandle,
	platform: NativeArtifactPlatform,
	expectedSize: number,
): Promise<NativeSignaturePresenceEvidence> {
	const before = await handle.stat();
	if (before.size !== expectedSize) {
		throw new Error("Native artifact size changed before signature inspection");
	}
	const result = await inspectNativeSignaturePresenceFromReader(
		{
			size: before.size,
			read: async (offset, length) => {
				const buffer = Buffer.alloc(length);
				const { bytesRead } = await handle.read(buffer, 0, length, offset);
				return buffer.subarray(0, bytesRead);
			},
		},
		platform,
	);
	const after = await handle.stat();
	if (!hasSameIdentity(before, after)) {
		throw new Error("Native artifact changed during signature inspection");
	}
	return result;
}
