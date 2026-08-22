import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	inspectNativeSignaturePresence,
	inspectNativeSignaturePresenceFromReader,
} from "./native-signature-presence.js";

function createPeFixture(withCertificate: boolean): Buffer {
	const binary = Buffer.alloc(512);
	binary.write("MZ", 0, "ascii");
	binary.writeUInt32LE(0x80, 0x3c);
	binary.write("PE\0\0", 0x80, "binary");
	binary.writeUInt16LE(0xf0, 0x80 + 4 + 16);
	const optional = 0x80 + 4 + 20;
	binary.writeUInt16LE(0x20b, optional);
	binary.writeUInt32LE(16, optional + 108);
	if (withCertificate) {
		const securityDirectory = optional + 112 + 4 * 8;
		binary.writeUInt32LE(0x1c0, securityDirectory);
		binary.writeUInt32LE(0x40, securityDirectory + 4);
	}
	return binary;
}

function createMachOFixture(withSignature: boolean): Buffer {
	const binary = Buffer.alloc(128);
	binary.set([0xcf, 0xfa, 0xed, 0xfe], 0);
	binary.writeUInt32LE(1, 16);
	binary.writeUInt32LE(withSignature ? 16 : 8, 20);
	const command = 32;
	binary.writeUInt32LE(withSignature ? 0x1d : 0x2, command);
	binary.writeUInt32LE(withSignature ? 16 : 8, command + 4);
	if (withSignature) {
		binary.writeUInt32LE(64, command + 8);
		binary.writeUInt32LE(32, command + 12);
	}
	return binary;
}

test("bounded signature inspection distinguishes PE, Mach-O, and Linux states", async () => {
	const pe = createPeFixture(true);
	let requestedBytes = 0;
	const peResult = await inspectNativeSignaturePresenceFromReader(
		{
			size: pe.length,
			read: async (offset, length) => {
				requestedBytes += length;
				return pe.subarray(offset, offset + length);
			},
		},
		"win32-x64",
	);
	assert.deepEqual(peResult, {
		presence: "present",
		mechanism: "pe-certificate-table",
	});
	assert.equal(requestedBytes < pe.length, true);

	const macho = createMachOFixture(true);
	assert.deepEqual(
		await inspectNativeSignaturePresenceFromReader(
			{
				size: macho.length,
				read: async (offset, length) => macho.subarray(offset, offset + length),
			},
			"darwin-arm64",
		),
		{
			presence: "present",
			mechanism: "macho-code-signature-command",
		},
	);
	assert.deepEqual(
		await inspectNativeSignaturePresenceFromReader(
			{
				size: 1,
				read: async () => Buffer.alloc(0),
			},
			"linux-x64",
		),
		{ presence: "not-applicable", mechanism: "not-applicable" },
	);
});

test("signature inspection rejects unbounded or inconsistent header claims", async () => {
	const malformedMachO = createMachOFixture(false);
	malformedMachO.writeUInt32LE(32 * 1024 * 1024, 20);
	await assert.rejects(
		inspectNativeSignaturePresenceFromReader(
			{
				size: malformedMachO.length,
				read: async (offset, length) =>
					malformedMachO.subarray(offset, offset + length),
			},
			"darwin-x64",
		),
		/load commands.*limit/i,
	);

	const inconsistentPe = createPeFixture(true);
	const optional = 0x80 + 4 + 20;
	const securityDirectory = optional + 112 + 4 * 8;
	inconsistentPe.writeUInt32LE(500, securityDirectory);
	inconsistentPe.writeUInt32LE(64, securityDirectory + 4);
	await assert.rejects(
		inspectNativeSignaturePresenceFromReader(
			{
				size: inconsistentPe.length,
				read: async (offset, length) =>
					inconsistentPe.subarray(offset, offset + length),
			},
			"win32-x64",
		),
		/certificate table is inconsistent/i,
	);
});

test("file-handle signature inspection preserves the same bounded result", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "signature-presence-"),
	);
	const filePath = path.join(tempDir, "claude.exe");
	try {
		await fs.writeFile(filePath, createPeFixture(false));
		const handle = await fs.open(filePath, "r");
		try {
			assert.deepEqual(
				await inspectNativeSignaturePresence(handle, "win32-x64", 512),
				{
					presence: "absent",
					mechanism: "pe-certificate-table",
				},
			);
		} finally {
			await handle.close();
		}
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});
