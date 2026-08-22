import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import type { DesktopInventoryEvidence } from "./contract.js";
import {
	type DesktopSdkContractEvidence,
	inspectDesktopSdkPublicContract,
	validateDesktopSdkContractEvidence,
} from "./sdk-contract.js";

const PACKAGE_NAME = "@anthropic-ai/claude-agent-sdk";
const SDK_VERSION = "0.3.235";
const METADATA_URL =
	"https://registry.npmjs.org/@anthropic-ai%2Fclaude-agent-sdk/0.3.235";
const TARBALL_URL =
	"https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.235.tgz";

const DECLARATIONS = `
export declare type PermissionUpdate = { type: "addRules" };
export declare type PermissionDecisionClassification = "safe" | "unknown";
export declare type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    suggestions?: PermissionUpdate[];
    blockedPath?: string;
    decisionReason?: string;
    title?: string;
    displayName?: string;
    description?: string;
    toolUseID: string;
    agentID?: string;
    requestId: string;
    matchedAskRule?: {
      source: string;
      toolName: string;
      ruleContent?: string;
    };
  },
) => Promise<PermissionResult | null>;
export declare type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk"
  | "auto";
export declare type PermissionResult =
  | {
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: PermissionUpdate[];
      toolUseID?: string;
      decisionClassification?: PermissionDecisionClassification;
    }
  | {
      behavior: "deny";
      message: string;
      interrupt?: boolean;
      toolUseID?: string;
      decisionClassification?: PermissionDecisionClassification;
    };
`;

function inventory(
	overrides: Partial<DesktopInventoryEvidence> = {},
): DesktopInventoryEvidence {
	return {
		schemaVersion: 1,
		platform: "win32",
		desktop: {
			locatorId: "desktop:1.34493.0",
			layout: "windows-squirrel",
			version: "1.34493.0",
			packagedAgentSdk: { status: "resolved", version: SDK_VERSION },
			declaredCodePin: { status: "unresolved", version: null },
			asarMemberCount: 258,
		},
		cachedCode: [],
		selectedCodeLocatorId: null,
		selectedCodeReason: null,
		createdAt: "2026-08-21T01:58:53.418Z",
		...overrides,
	};
}

interface TarMember {
	name: string;
	contents?: Buffer;
	type?: string;
}

function writeOctal(
	header: Buffer,
	value: number,
	offset: number,
	length: number,
): void {
	const encoded = value.toString(8).padStart(length - 1, "0");
	if (encoded.length > length - 1) throw new Error("fixture octal overflow");
	header.write(encoded, offset, length - 1, "ascii");
	header[offset + length - 1] = 0;
}

function tarMember(member: TarMember): Buffer {
	const contents = member.contents ?? Buffer.alloc(0);
	const header = Buffer.alloc(512);
	if (Buffer.byteLength(member.name) > 100) {
		throw new Error("fixture path is too long");
	}
	header.write(member.name, 0, 100, "utf8");
	writeOctal(header, 0o644, 100, 8);
	writeOctal(header, 0, 108, 8);
	writeOctal(header, 0, 116, 8);
	writeOctal(header, contents.length, 124, 12);
	writeOctal(header, 0, 136, 12);
	header.fill(0x20, 148, 156);
	header.write(member.type ?? "0", 156, 1, "ascii");
	header.write("ustar\0", 257, 6, "binary");
	header.write("00", 263, 2, "ascii");
	let checksum = 0;
	for (const byte of header) checksum += byte;
	const checksumText = checksum.toString(8).padStart(6, "0");
	header.write(checksumText, 148, 6, "ascii");
	header[154] = 0;
	header[155] = 0x20;
	const padding = Buffer.alloc((512 - (contents.length % 512)) % 512);
	return Buffer.concat([header, contents, padding]);
}

function createTarball(
	declarations = DECLARATIONS,
	extraMembers: TarMember[] = [],
): Buffer {
	const packageJson = Buffer.from(
		JSON.stringify({
			name: PACKAGE_NAME,
			version: SDK_VERSION,
			types: "sdk.d.ts",
		}),
	);
	const members = [
		{ name: "package/package.json", contents: packageJson },
		{ name: "package/sdk.d.ts", contents: Buffer.from(declarations) },
		...extraMembers,
	];
	return gzipSync(
		Buffer.concat([...members.map(tarMember), Buffer.alloc(1024)]),
	);
}

interface FetchFixtureOptions {
	tarball?: Buffer;
	metadataText?: string;
	metadataOverrides?: Record<string, unknown>;
	tarballContentLength?: string;
	redirectMetadata?: boolean;
}

function createFetchFixture(options: FetchFixtureOptions = {}): {
	fetcher: typeof fetch;
	calls: Array<{ url: string; redirect: RequestRedirect | undefined }>;
} {
	const tarball = options.tarball ?? createTarball();
	const integrity = `sha512-${createHash("sha512")
		.update(tarball)
		.digest("base64")}`;
	const metadata = {
		name: PACKAGE_NAME,
		version: SDK_VERSION,
		dist: {
			integrity,
			tarball: TARBALL_URL,
			signatures: [
				{ keyid: "SHA256:synthetic-registry-key", sig: "c2lnbmF0dXJl" },
			],
		},
		...options.metadataOverrides,
	};
	const metadataText = options.metadataText ?? JSON.stringify(metadata);
	const calls: Array<{
		url: string;
		redirect: RequestRedirect | undefined;
	}> = [];
	const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, redirect: init?.redirect });
		if (url === METADATA_URL) {
			const response = new Response(metadataText, {
				status: 200,
				headers: { "content-length": String(Buffer.byteLength(metadataText)) },
			});
			if (options.redirectMetadata) {
				Object.defineProperty(response, "redirected", { value: true });
			}
			return response;
		}
		if (url === TARBALL_URL) {
			return new Response(new Uint8Array(tarball), {
				status: 200,
				headers: {
					"content-length":
						options.tarballContentLength ?? String(tarball.length),
				},
			});
		}
		throw new Error(`unexpected fixture URL ${url}`);
	}) as typeof fetch;
	return { fetcher, calls };
}

function assertHappyContract(evidence: DesktopSdkContractEvidence): void {
	assert.equal(evidence.schemaVersion, 1);
	assert.deepEqual(evidence.inventoryBinding, {
		sha256: evidence.inventoryBinding.sha256,
		platform: "win32",
		desktopLocatorId: "desktop:1.34493.0",
		desktopVersion: "1.34493.0",
		packagedAgentSdkVersion: SDK_VERSION,
	});
	assert.match(evidence.inventoryBinding.sha256, /^[a-f0-9]{64}$/);
	assert.deepEqual(evidence.registry, {
		packageName: PACKAGE_NAME,
		version: SDK_VERSION,
		metadataOrigin: "https://registry.npmjs.org",
		tarballOrigin: "https://registry.npmjs.org",
		integrityAlgorithm: "sha512",
		integrityVerified: true,
		signaturePresence: "present-unverified",
		signatureCount: 1,
		compressedBytes: evidence.registry.compressedBytes,
		archiveMembers: 2,
		declarationMembers: 1,
		declarationBytes: Buffer.byteLength(DECLARATIONS),
	});
	assert.ok(evidence.registry.compressedBytes > 0);
	assert.deepEqual(evidence.permissionContract.callback.parameters, [
		{ name: "toolName", type: "string" },
		{ name: "input", type: "Record<string, unknown>" },
		{ name: "options", type: "context" },
	]);
	assert.deepEqual(evidence.permissionContract.callback.contextFields, [
		{ name: "signal", required: true, type: "AbortSignal" },
		{ name: "suggestions", required: false, type: "PermissionUpdate[]" },
		{ name: "blockedPath", required: false, type: "string" },
		{ name: "decisionReason", required: false, type: "string" },
		{ name: "title", required: false, type: "string" },
		{ name: "displayName", required: false, type: "string" },
		{ name: "description", required: false, type: "string" },
		{ name: "toolUseID", required: true, type: "string" },
		{ name: "agentID", required: false, type: "string" },
		{ name: "requestId", required: true, type: "string" },
		{
			name: "matchedAskRule",
			required: false,
			type: "{ source: string; toolName: string; ruleContent?: string }",
		},
	]);
	assert.deepEqual(evidence.permissionContract.result, {
		typeName: "PermissionResult",
		allowUpdatedInput: "optional-record",
		denyMessage: "required-string",
	});
	assert.deepEqual(evidence.permissionContract.mode.values, [
		"default",
		"acceptEdits",
		"bypassPermissions",
		"plan",
		"dontAsk",
		"auto",
	]);
	assert.deepEqual(evidence.boundaries, {
		bundledRuntimeIdentity: "not-proven",
		liveCallbackExecution: "not-run",
		uiProjection: "not-run",
	});
}

test("audits the exact inventory-bound public SDK contract deterministically", async () => {
	const fixture = createFetchFixture();
	const first = await inspectDesktopSdkPublicContract({
		inventory: inventory(),
		fetcher: fixture.fetcher,
	});
	const second = await inspectDesktopSdkPublicContract({
		inventory: inventory(),
		fetcher: createFetchFixture().fetcher,
	});

	assertHappyContract(first);
	assert.deepEqual(second, first);
	assert.deepEqual(fixture.calls, [
		{ url: METADATA_URL, redirect: "error" },
		{ url: TARBALL_URL, redirect: "error" },
	]);
	assert.doesNotThrow(() => validateDesktopSdkContractEvidence(first));
});

test("requires a validated Desktop row with a resolved packaged SDK", async () => {
	let calls = 0;
	const fetcher = (async () => {
		calls += 1;
		throw new Error("must not fetch");
	}) as typeof fetch;
	const noDesktop = inventory({ desktop: null });
	await assert.rejects(
		inspectDesktopSdkPublicContract({ inventory: noDesktop, fetcher }),
		/Desktop application/i,
	);
	const unresolved = inventory();
	if (!unresolved.desktop) throw new Error("fixture Desktop row is missing");
	unresolved.desktop.packagedAgentSdk = { status: "unresolved", version: null };
	await assert.rejects(
		inspectDesktopSdkPublicContract({ inventory: unresolved, fetcher }),
		/packaged Agent SDK.*resolved/i,
	);
	assert.equal(calls, 0);
});

test("rejects metadata drift, redirects, duplicate keys, and integrity failures", async () => {
	const tarball = createTarball();
	const cases: Array<{ fixture: FetchFixtureOptions; error: RegExp }> = [
		{
			fixture: { metadataOverrides: { name: "unexpected-package" } },
			error: /package name/i,
		},
		{
			fixture: { metadataOverrides: { version: "0.3.236" } },
			error: /package version/i,
		},
		{
			fixture: {
				metadataOverrides: {
					dist: {
						integrity: `sha512-${createHash("sha512")
							.update(tarball)
							.digest("base64")}`,
						tarball: "https://example.invalid/package.tgz",
					},
				},
			},
			error: /official npm registry tarball/i,
		},
		{
			fixture: {
				metadataOverrides: {
					dist: {
						integrity: `sha256-${createHash("sha256")
							.update(tarball)
							.digest("base64")}`,
						tarball: TARBALL_URL,
					},
				},
			},
			error: /sha512/i,
		},
		{
			fixture: {
				metadataOverrides: {
					dist: {
						integrity: `sha512-${Buffer.alloc(64, 7).toString("base64")}`,
						tarball: TARBALL_URL,
					},
				},
			},
			error: /integrity mismatch/i,
		},
		{
			fixture: {
				metadataText: `{"name":"${PACKAGE_NAME}","name":"${PACKAGE_NAME}"}`,
			},
			error: /duplicate key/i,
		},
		{ fixture: { redirectMetadata: true }, error: /redirect/i },
		{
			fixture: { tarballContentLength: String(4 * 1024 * 1024 + 1) },
			error: /compressed.*limit/i,
		},
	];
	for (const current of cases) {
		await assert.rejects(
			inspectDesktopSdkPublicContract({
				inventory: inventory(),
				fetcher: createFetchFixture(current.fixture).fetcher,
			}),
			current.error,
		);
	}
});

test("rejects unsafe, linked, corrupt, and over-populated tar archives", async () => {
	const unsafe = createTarball(DECLARATIONS, [
		{ name: "package/../escape.d.ts", contents: Buffer.from("export {}") },
	]);
	const linked = createTarball(DECLARATIONS, [
		{ name: "package/link.d.ts", type: "2" },
	]);
	const crowded = createTarball(
		DECLARATIONS,
		Array.from({ length: 63 }, (_, index) => ({
			name: `package/extra-${index}.txt`,
			contents: Buffer.from("x"),
		})),
	);
	const duplicate = createTarball(DECLARATIONS, [
		{ name: "package/sdk.d.ts", contents: Buffer.from("export {}") },
	]);
	const oversizedMember = createTarball(DECLARATIONS, [
		{
			name: "package/oversized.bin",
			contents: Buffer.alloc(2 * 1024 * 1024 + 1),
		},
	]);
	const oversizedExpanded = gzipSync(Buffer.alloc(16 * 1024 * 1024 + 1));
	const checksumExpanded = gunzipSync(createTarball());
	checksumExpanded[0] = (checksumExpanded[0] ?? 0) ^ 1;
	const checksumBroken = gzipSync(checksumExpanded);

	for (const [tarball, error] of [
		[unsafe, /member path/i],
		[linked, /member type/i],
		[crowded, /member count/i],
		[duplicate, /paths must be unique/i],
		[oversizedMember, /member size/i],
		[oversizedExpanded, /expanded-size limit/i],
		[checksumBroken, /checksum/i],
	] as const) {
		await assert.rejects(
			inspectDesktopSdkPublicContract({
				inventory: inventory(),
				fetcher: createFetchFixture({ tarball }).fetcher,
			}),
			error,
		);
	}
});

test("fails closed when required declaration shapes drift or become ambiguous", async () => {
	const cases: Array<{
		declarations: string;
		extraDeclarations?: string;
		error: RegExp;
	}> = [
		{
			declarations: DECLARATIONS,
			extraDeclarations: DECLARATIONS,
			error: /CanUseTool.*ambiguous/i,
		},
		{
			declarations: DECLARATIONS.replace(
				"input: Record<string, unknown>",
				"input: unknown",
			),
			error: /CanUseTool.*input/i,
		},
		{
			declarations: DECLARATIONS.replace("title?: string;", ""),
			error: /CanUseTool.*context/i,
		},
		{
			declarations: DECLARATIONS.replace(
				"updatedInput?: Record<string, unknown>",
				"updatedInput: Record<string, unknown>",
			),
			error: /updatedInput/i,
		},
		{
			declarations: DECLARATIONS.replace("message: string", "message?: string"),
			error: /deny message/i,
		},
		{
			declarations: DECLARATIONS.replace('\n  | "auto";', ";"),
			error: /PermissionMode/i,
		},
	];
	for (const current of cases) {
		await assert.rejects(
			inspectDesktopSdkPublicContract({
				inventory: inventory(),
				fetcher: createFetchFixture({
					tarball: createTarball(
						current.declarations,
						current.extraDeclarations
							? [
									{
										name: "package/duplicate.d.ts",
										contents: Buffer.from(current.extraDeclarations),
									},
								]
							: [],
					),
				}).fetcher,
			}),
			current.error,
		);
	}
});

test("runtime evidence validation rejects unknown fields and promoted boundaries", async () => {
	const evidence = await inspectDesktopSdkPublicContract({
		inventory: inventory(),
		fetcher: createFetchFixture().fetcher,
	});
	const withPath = structuredClone(evidence) as DesktopSdkContractEvidence & {
		archivePath?: string;
	};
	withPath.archivePath = "/private/package/sdk.d.ts";
	assert.throws(
		() => validateDesktopSdkContractEvidence(withPath),
		/unknown.*archivePath/i,
	);
	const promoted = structuredClone(evidence);
	(
		promoted.boundaries as { bundledRuntimeIdentity: string }
	).bundledRuntimeIdentity = "verified";
	assert.throws(
		() => validateDesktopSdkContractEvidence(promoted),
		/bundledRuntimeIdentity/i,
	);
});
