import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	createNativeSigningPlan,
	finalizeNativeSigning,
	hasPeCertificateTable,
} from "./native-signing.js";

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

test("signing plans reject incompatible hosts and platform policies", () => {
	assert.throws(
		() =>
			createNativeSigningPlan({
				artifactPath: "/staged/claude",
				platform: "darwin-arm64",
				hostPlatform: "linux-arm64",
				policy: { kind: "macos-adhoc" },
			}),
		/matching host platform/i,
	);
	assert.throws(
		() =>
			createNativeSigningPlan({
				artifactPath: "/staged/claude",
				platform: "linux-x64",
				hostPlatform: "linux-x64",
				policy: { kind: "macos-adhoc" },
			}),
		/not compatible/i,
	);

	const plan = createNativeSigningPlan({
		artifactPath: "/staged/claude",
		platform: "linux-x64",
		hostPlatform: "linux-x64",
		policy: { kind: "not-required" },
	});
	assert.equal(plan.policyName, "not-required");
	assert.deepEqual(plan.commands, []);
});

test("macOS plans distinguish ad-hoc and configured identity signing", () => {
	const adHoc = createNativeSigningPlan({
		artifactPath: "/staged/claude",
		platform: "darwin-arm64",
		hostPlatform: "darwin-arm64",
		policy: { kind: "macos-adhoc" },
	});
	assert.equal(adHoc.policyName, "macos-adhoc");
	assert.deepEqual(
		adHoc.commands.map((command) => command.stage),
		["sign", "verify", "inspect"],
	);
	assert.deepEqual(adHoc.commands[0]?.args.slice(0, 3), [
		"--force",
		"--sign",
		"-",
	]);

	const identity = createNativeSigningPlan({
		artifactPath: "/staged/claude",
		platform: "darwin-x64",
		hostPlatform: "darwin-x64",
		policy: { kind: "macos-identity", identity: "Local Signing Identity" },
	});
	assert.equal(identity.policyName, "macos-identity");
	assert.equal(identity.commands[0]?.args[2], "Local Signing Identity");
	assert.throws(
		() =>
			createNativeSigningPlan({
				artifactPath: "/staged/claude",
				platform: "darwin-x64",
				hostPlatform: "darwin-x64",
				policy: { kind: "macos-identity", identity: "-" },
			}),
		/configured identity/i,
	);
});

test("Windows plans require the SDK executable and explicit safe selectors", () => {
	const auth = createNativeSigningPlan({
		artifactPath: "C:\\staged\\claude.exe",
		platform: "win32-x64",
		hostPlatform: "win32-x64",
		policy: {
			kind: "windows-authenticode",
			certificateThumbprint: "0123456789abcdef0123456789abcdef01234567",
			timestampUrl: "https://timestamp.example.test",
		},
		signToolPath: "C:\\Windows Kits\\signtool.exe",
	});
	assert.equal(auth.policyName, "windows-authenticode");
	assert.deepEqual(
		auth.commands.map((command) => command.stage),
		["sign", "verify"],
	);
	assert.deepEqual(auth.commands[0]?.args.slice(0, 8), [
		"sign",
		"/sha1",
		"0123456789ABCDEF0123456789ABCDEF01234567",
		"/fd",
		"SHA256",
		"/tr",
		"https://timestamp.example.test",
		"/td",
	]);
	assert.deepEqual(auth.commands[1]?.args.slice(0, 3), ["verify", "/pa", "/v"]);

	assert.throws(
		() =>
			createNativeSigningPlan({
				artifactPath: "C:\\staged\\claude.exe",
				platform: "win32-x64",
				hostPlatform: "win32-x64",
				policy: {
					kind: "windows-authenticode",
					certificateThumbprint: "0123456789abcdef0123456789abcdef01234567",
					timestampUrl: "http://timestamp.example.test",
				},
				signToolPath: "signtool",
			}),
		/Windows SDK signtool\.exe/i,
	);
	assert.throws(
		() =>
			createNativeSigningPlan({
				artifactPath: "C:\\staged\\claude.exe",
				platform: "win32-x64",
				hostPlatform: "win32-x64",
				policy: {
					kind: "windows-authenticode",
					certificateThumbprint: "0123456789abcdef0123456789abcdef01234567",
					timestampUrl: "https://timestamp.example.test",
				},
				signToolPath: "tools\\signtool.exe",
			}),
		/Windows SDK signtool\.exe/i,
	);
	assert.throws(
		() =>
			createNativeSigningPlan({
				artifactPath: "C:\\staged\\claude.exe",
				platform: "win32-x64",
				hostPlatform: "win32-x64",
				policy: { kind: "windows-explicit-unsigned", acknowledged: false },
				signToolPath: "signtool.exe",
			}),
		/acknowledgement/i,
	);
});

test("macOS finalization verifies the selected signature class", async () => {
	const calls: string[] = [];
	const result = await finalizeNativeSigning({
		artifactPath: "/staged/claude",
		platform: "darwin-arm64",
		hostPlatform: "darwin-arm64",
		policy: { kind: "macos-adhoc" },
		runCommand: async (command) => {
			calls.push(command.stage);
			return {
				exitCode: 0,
				stdout: "",
				stderr: command.stage === "inspect" ? "Signature=adhoc\n" : "",
			};
		},
	});
	assert.deepEqual(calls, ["sign", "verify", "inspect"]);
	assert.equal(result.policyName, "macos-adhoc");
	assert.equal(result.verification, "pass");
	assert.deepEqual(result.warningCodes, ["macos-adhoc-identity"]);

	await assert.rejects(
		finalizeNativeSigning({
			artifactPath: "/staged/claude",
			platform: "darwin-arm64",
			hostPlatform: "darwin-arm64",
			policy: { kind: "macos-identity", identity: "Local Identity" },
			runCommand: async (command) => ({
				exitCode: 0,
				stdout: "",
				stderr: command.stage === "inspect" ? "Signature=adhoc\n" : "",
			}),
		}),
		/did not expose an identity/i,
	);
});

test("PE certificate-table inspection distinguishes signed and unsigned images", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "pe-signing-fixture-"),
	);
	const unsignedPath = path.join(tempDir, "unsigned.exe");
	const signedPath = path.join(tempDir, "signed.exe");
	try {
		const unsigned = createPeFixture(false);
		await fs.writeFile(unsignedPath, unsigned);

		const signed = createPeFixture(true);
		const optional = 0x80 + 4 + 20;
		const securityDirectory = optional + 112 + 4 * 8;
		await fs.writeFile(signedPath, signed);

		assert.equal(await hasPeCertificateTable(unsignedPath), false);
		assert.equal(await hasPeCertificateTable(signedPath), true);

		const inconsistentPath = path.join(tempDir, "inconsistent.exe");
		const inconsistent = Buffer.from(unsigned);
		inconsistent.writeUInt32LE(0x1f0, securityDirectory);
		inconsistent.writeUInt32LE(0x40, securityDirectory + 4);
		await fs.writeFile(inconsistentPath, inconsistent);
		await assert.rejects(
			hasPeCertificateTable(inconsistentPath),
			/certificate table is inconsistent/i,
		);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("Windows finalization verifies embedded signing and explicit removal", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pe-finalize-"));
	const authPath = path.join(tempDir, "auth.exe");
	const unsignedPath = path.join(tempDir, "unsigned.exe");
	try {
		await fs.writeFile(authPath, createPeFixture(false));
		const authCalls: string[] = [];
		const authResult = await finalizeNativeSigning({
			artifactPath: authPath,
			platform: "win32-x64",
			hostPlatform: "win32-x64",
			policy: {
				kind: "windows-authenticode",
				certificateThumbprint: "0123456789abcdef0123456789abcdef01234567",
				timestampUrl: "https://timestamp.example.test",
			},
			runCommand: async (command) => {
				authCalls.push(command.stage);
				if (command.stage === "sign") {
					await fs.writeFile(authPath, createPeFixture(true));
				}
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		});
		assert.deepEqual(authCalls, ["sign", "verify"]);
		assert.equal(authResult.verification, "pass");

		await fs.writeFile(unsignedPath, createPeFixture(true));
		const unsignedCalls: string[] = [];
		const unsignedResult = await finalizeNativeSigning({
			artifactPath: unsignedPath,
			platform: "win32-x64",
			hostPlatform: "win32-x64",
			policy: {
				kind: "windows-explicit-unsigned",
				acknowledged: true,
			},
			runCommand: async (command) => {
				unsignedCalls.push(command.stage);
				await fs.writeFile(unsignedPath, createPeFixture(false));
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		});
		assert.deepEqual(unsignedCalls, ["remove"]);
		assert.equal(unsignedResult.verification, "pass");
		assert.deepEqual(unsignedResult.warningCodes, [
			"windows-unsigned-artifact",
		]);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});
