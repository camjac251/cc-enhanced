import { createHash, timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { parse } from "@babel/parser";
import * as t from "@babel/types";
import {
	type DesktopInventoryEvidence,
	type DesktopPlatform,
	validateDesktopInventoryEvidence,
} from "./contract.js";

export const DESKTOP_SDK_CONTRACT_SCHEMA_VERSION = 1 as const;

const PACKAGE_NAME = "@anthropic-ai/claude-agent-sdk";
const REGISTRY_ORIGIN = "https://registry.npmjs.org";
const MAX_METADATA_BYTES = 256 * 1024;
const MAX_COMPRESSED_BYTES = 4 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_MEMBERS = 64;
const MAX_MEMBER_BYTES = 2 * 1024 * 1024;
const MAX_DECLARATION_BYTES = 2 * 1024 * 1024;
const MAX_SIGNATURES = 16;
const FETCH_TIMEOUT_MS = 15_000;
const VERSION_RE = /^\d+(?:\.\d+){2,3}(?:[-+][0-9A-Za-z.-]+)?$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

const CALLBACK_PARAMETERS = [
	{ name: "toolName", type: "string" },
	{ name: "input", type: "Record<string, unknown>" },
	{ name: "options", type: "context" },
] as const;

const CALLBACK_CONTEXT_FIELDS = [
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
] as const;

const PERMISSION_MODES = [
	"default",
	"acceptEdits",
	"bypassPermissions",
	"plan",
	"dontAsk",
	"auto",
] as const;

export interface DesktopSdkContractContextField {
	name: (typeof CALLBACK_CONTEXT_FIELDS)[number]["name"];
	required: boolean;
	type: (typeof CALLBACK_CONTEXT_FIELDS)[number]["type"];
}

export interface DesktopSdkContractEvidence {
	schemaVersion: typeof DESKTOP_SDK_CONTRACT_SCHEMA_VERSION;
	inventoryBinding: {
		sha256: string;
		platform: DesktopPlatform;
		desktopLocatorId: string;
		desktopVersion: string;
		packagedAgentSdkVersion: string;
	};
	registry: {
		packageName: typeof PACKAGE_NAME;
		version: string;
		metadataOrigin: typeof REGISTRY_ORIGIN;
		tarballOrigin: typeof REGISTRY_ORIGIN;
		integrityAlgorithm: "sha512";
		integrityVerified: true;
		signaturePresence: "present-unverified" | "not-provided";
		signatureCount: number;
		compressedBytes: number;
		archiveMembers: number;
		declarationMembers: number;
		declarationBytes: number;
	};
	permissionContract: {
		callback: {
			typeName: "CanUseTool";
			parameters: Array<{ name: string; type: string }>;
			contextFields: DesktopSdkContractContextField[];
			returnType: "Promise<PermissionResult | null>";
		};
		result: {
			typeName: "PermissionResult";
			allowUpdatedInput: "optional-record";
			denyMessage: "required-string";
		};
		mode: {
			typeName: "PermissionMode";
			values: Array<(typeof PERMISSION_MODES)[number]>;
		};
	};
	boundaries: {
		bundledRuntimeIdentity: "not-proven";
		liveCallbackExecution: "not-run";
		uiProjection: "not-run";
	};
}

export interface InspectDesktopSdkPublicContractOptions {
	inventory: DesktopInventoryEvidence;
	fetcher?: typeof fetch;
}

type JsonObject = Record<string, unknown>;

interface RegistryMetadata {
	integrity: string;
	tarballUrl: string;
	signatureCount: number;
}

interface TarInspection {
	memberCount: number;
	declarations: Buffer[];
	declarationBytes: number;
}

interface ExportedTypeAlias {
	name: string;
	typeAnnotation: t.TSType;
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
	value: unknown,
	expected: readonly string[],
	label: string,
): asserts value is JsonObject {
	if (!isObject(value)) throw new Error(`${label} must be an object`);
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (actual.length !== wanted.length) {
		const unknown = actual.filter((key) => !wanted.includes(key));
		const missing = wanted.filter((key) => !actual.includes(key));
		if (unknown.length > 0) {
			throw new Error(`${label} contains unknown field ${unknown[0]}`);
		}
		throw new Error(`${label} is missing field ${missing[0]}`);
	}
	for (let index = 0; index < wanted.length; index += 1) {
		if (actual[index] !== wanted[index]) {
			throw new Error(`${label} contains unknown field ${actual[index]}`);
		}
	}
}

function assertNoDuplicateJsonKeys(input: string, label: string): void {
	let index = 0;
	const skipWhitespace = () => {
		while (/\s/.test(input[index] ?? "")) index += 1;
	};
	const parseString = (): string => {
		if (input[index] !== '"') throw new Error(`${label} contains invalid JSON`);
		const start = index;
		index += 1;
		while (index < input.length) {
			const character = input[index];
			if (character === "\\") {
				index += 2;
				continue;
			}
			index += 1;
			if (character === '"') {
				try {
					return JSON.parse(input.slice(start, index)) as string;
				} catch (error) {
					throw new Error(`${label} contains invalid JSON`, { cause: error });
				}
			}
		}
		throw new Error(`${label} contains an unterminated JSON string`);
	};
	const parseValue = (depth: number): void => {
		if (depth > 64) throw new Error(`${label} JSON depth exceeds limit`);
		skipWhitespace();
		const character = input[index];
		if (character === "{") {
			index += 1;
			skipWhitespace();
			const keys = new Set<string>();
			if (input[index] === "}") {
				index += 1;
				return;
			}
			for (;;) {
				skipWhitespace();
				const key = parseString();
				if (keys.has(key)) {
					throw new Error(`${label} has duplicate key ${key}`);
				}
				keys.add(key);
				skipWhitespace();
				if (input[index] !== ":") {
					throw new Error(`${label} contains invalid JSON`);
				}
				index += 1;
				parseValue(depth + 1);
				skipWhitespace();
				if (input[index] === "}") {
					index += 1;
					return;
				}
				if (input[index] !== ",") {
					throw new Error(`${label} contains invalid JSON`);
				}
				index += 1;
			}
		}
		if (character === "[") {
			index += 1;
			skipWhitespace();
			if (input[index] === "]") {
				index += 1;
				return;
			}
			for (;;) {
				parseValue(depth + 1);
				skipWhitespace();
				if (input[index] === "]") {
					index += 1;
					return;
				}
				if (input[index] !== ",") {
					throw new Error(`${label} contains invalid JSON`);
				}
				index += 1;
			}
		}
		if (character === '"') {
			parseString();
			return;
		}
		const primitive = input
			.slice(index)
			.match(
				/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/,
			)?.[0];
		if (!primitive) throw new Error(`${label} contains invalid JSON`);
		index += primitive.length;
	};
	parseValue(0);
	skipWhitespace();
	if (index !== input.length) {
		throw new Error(`${label} contains trailing JSON data`);
	}
}

function parseJsonObject(input: Buffer, label: string): JsonObject {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(input);
	} catch (error) {
		throw new Error(`${label} is not valid UTF-8`, { cause: error });
	}
	assertNoDuplicateJsonKeys(text, label);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`${label} contains invalid JSON`, { cause: error });
	}
	if (!isObject(parsed)) throw new Error(`${label} must be an object`);
	return parsed;
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "boolean")
		return JSON.stringify(value);
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error("Canonical JSON number is invalid");
		}
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	}
	if (isObject(value)) {
		return (
			"{" +
			Object.keys(value)
				.sort()
				.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
				.join(",") +
			"}"
		);
	}
	throw new Error("Canonical JSON contains an unsupported value");
}

function exactMetadataUrl(version: string): string {
	return (
		REGISTRY_ORIGIN +
		"/@anthropic-ai%2Fclaude-agent-sdk/" +
		encodeURIComponent(version)
	);
}

function exactTarballUrl(version: string): string {
	return (
		REGISTRY_ORIGIN +
		"/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-" +
		encodeURIComponent(version) +
		".tgz"
	);
}

async function readBoundedResponse(
	response: Response,
	limit: number,
	label: string,
): Promise<Buffer> {
	const contentLength = response.headers.get("content-length");
	if (contentLength !== null) {
		if (!/^\d+$/.test(contentLength)) {
			throw new Error(`${label} content length is invalid`);
		}
		const declared = Number(contentLength);
		if (!Number.isSafeInteger(declared) || declared > limit) {
			throw new Error(`${label} exceeds compressed or response-size limit`);
		}
	}
	if (!response.body) throw new Error(`${label} response body is missing`);
	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let total = 0;
	try {
		for (;;) {
			const current = await reader.read();
			if (current.done) break;
			const chunk = Buffer.from(current.value);
			total += chunk.length;
			if (total > limit) {
				await reader.cancel();
				throw new Error(`${label} exceeds compressed or response-size limit`);
			}
			chunks.push(chunk);
		}
	} finally {
		reader.releaseLock();
	}
	if (contentLength !== null && total !== Number(contentLength)) {
		throw new Error(`${label} content length does not match response bytes`);
	}
	return Buffer.concat(chunks, total);
}

async function fetchBounded(
	url: string,
	limit: number,
	label: string,
	fetcher: typeof fetch,
): Promise<Buffer> {
	let response: Response;
	try {
		response = await fetcher(url, {
			redirect: "error",
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			headers: { accept: "application/json, application/octet-stream" },
		});
	} catch (error) {
		throw new Error(`${label} request failed`, { cause: error });
	}
	if (response.redirected || (response.url !== "" && response.url !== url)) {
		throw new Error(`${label} redirect is not allowed`);
	}
	if (!response.ok) {
		throw new Error(`${label} request returned HTTP ${response.status}`);
	}
	return readBoundedResponse(response, limit, label);
}

function readRegistryMetadata(
	bytes: Buffer,
	version: string,
): RegistryMetadata {
	const metadata = parseJsonObject(bytes, "SDK registry metadata");
	if (metadata.name !== PACKAGE_NAME) {
		throw new Error(
			"SDK registry package name does not match the expected package",
		);
	}
	if (metadata.version !== version) {
		throw new Error("SDK registry package version does not match inventory");
	}
	if (!isObject(metadata.dist)) {
		throw new Error("SDK registry metadata dist is invalid");
	}
	const integrity = metadata.dist.integrity;
	if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
		throw new Error("SDK registry integrity must use one sha512 SRI digest");
	}
	if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) {
		throw new Error("SDK registry sha512 integrity form is invalid");
	}
	const digestText = integrity.slice("sha512-".length);
	const digest = Buffer.from(digestText, "base64");
	if (digest.length !== 64 || digest.toString("base64") !== digestText) {
		throw new Error("SDK registry sha512 integrity digest is invalid");
	}
	const expectedTarball = exactTarballUrl(version);
	if (metadata.dist.tarball !== expectedTarball) {
		throw new Error(
			"SDK metadata does not name the exact official npm registry tarball",
		);
	}
	let signatureCount = 0;
	const signatures = metadata.dist.signatures;
	if (signatures !== undefined) {
		if (!Array.isArray(signatures) || signatures.length > MAX_SIGNATURES) {
			throw new Error("SDK registry signatures are malformed or exceed limit");
		}
		for (const signature of signatures) {
			if (
				!isObject(signature) ||
				typeof signature.keyid !== "string" ||
				signature.keyid.length < 1 ||
				signature.keyid.length > 512 ||
				typeof signature.sig !== "string" ||
				signature.sig.length < 1 ||
				signature.sig.length > 8192
			) {
				throw new Error("SDK registry signature record is malformed");
			}
		}
		signatureCount = signatures.length;
	}
	return { integrity, tarballUrl: expectedTarball, signatureCount };
}

function verifyTarballIntegrity(tarball: Buffer, integrity: string): void {
	const expected = Buffer.from(integrity.slice("sha512-".length), "base64");
	const actual = createHash("sha512").update(tarball).digest();
	if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
		throw new Error("SDK tarball sha512 integrity mismatch");
	}
}

function isZeroBlock(block: Buffer): boolean {
	for (const byte of block) if (byte !== 0) return false;
	return true;
}

function decodeTarField(field: Buffer, label: string): string {
	const zero = field.indexOf(0);
	const end = zero === -1 ? field.length : zero;
	if (zero !== -1 && !isZeroBlock(field.subarray(zero))) {
		throw new Error(`${label} has non-zero data after its terminator`);
	}
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(
			field.subarray(0, end),
		);
	} catch (error) {
		throw new Error(`${label} is not valid UTF-8`, { cause: error });
	}
}

function parseTarOctal(field: Buffer, label: string): number {
	for (const byte of field) {
		if (byte !== 0 && byte !== 0x20 && (byte < 0x30 || byte > 0x37)) {
			throw new Error(`${label} contains a non-octal byte`);
		}
	}
	const text = field.toString("ascii").replaceAll("\0", " ").trim();
	if (!/^[0-7]+$/.test(text)) throw new Error(`${label} is not octal`);
	const value = Number.parseInt(text, 8);
	if (!Number.isSafeInteger(value)) {
		throw new Error(`${label} exceeds safe range`);
	}
	return value;
}

function validateTarPath(name: string, type: string): string {
	const normalized =
		type === "5" && name.endsWith("/") ? name.slice(0, -1) : name;
	if (
		!normalized.startsWith("package/") ||
		normalized.length > 256 ||
		normalized.includes("\\") ||
		normalized.includes("\0") ||
		normalized.startsWith("/")
	) {
		throw new Error("SDK tar member path is invalid");
	}
	const segments = normalized.split("/");
	if (
		segments.length > 32 ||
		segments.some(
			(segment) => segment === "" || segment === "." || segment === "..",
		)
	) {
		throw new Error("SDK tar member path is invalid");
	}
	return normalized;
}

function inspectTarball(tarball: Buffer, version: string): TarInspection {
	let expanded: Buffer;
	try {
		expanded = gunzipSync(tarball, { maxOutputLength: MAX_EXPANDED_BYTES });
	} catch (error) {
		throw new Error(
			"SDK tarball gzip expansion failed or exceeded expanded-size limit",
			{ cause: error },
		);
	}
	if (
		expanded.length < 1024 ||
		expanded.length > MAX_EXPANDED_BYTES ||
		expanded.length % 512 !== 0
	) {
		throw new Error("SDK tarball expanded size or block alignment is invalid");
	}
	let offset = 0;
	let memberCount = 0;
	let declarationBytes = 0;
	let packageJson: Buffer | null = null;
	const declarations: Buffer[] = [];
	const paths = new Set<string>();
	let terminated = false;
	while (offset < expanded.length) {
		const header = expanded.subarray(offset, offset + 512);
		if (header.length !== 512) throw new Error("SDK tar header is truncated");
		if (isZeroBlock(header)) {
			const next = expanded.subarray(offset + 512, offset + 1024);
			if (next.length !== 512 || !isZeroBlock(next)) {
				throw new Error("SDK tarball is missing its terminal zero blocks");
			}
			if (!isZeroBlock(expanded.subarray(offset))) {
				throw new Error("SDK tarball has data after its terminal zero blocks");
			}
			terminated = true;
			break;
		}
		if (
			!header.subarray(257, 263).equals(Buffer.from("ustar\0", "binary")) ||
			!header.subarray(263, 265).equals(Buffer.from("00", "ascii"))
		) {
			throw new Error("SDK tar member does not use the bounded ustar format");
		}
		const expectedChecksum = parseTarOctal(
			header.subarray(148, 156),
			"SDK tar checksum",
		);
		let actualChecksum = 0;
		for (let index = 0; index < header.length; index += 1) {
			actualChecksum +=
				index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
		}
		if (actualChecksum !== expectedChecksum) {
			throw new Error("SDK tar member checksum does not match");
		}
		const type =
			decodeTarField(header.subarray(156, 157), "SDK tar type") || "0";
		if (type !== "0" && type !== "5") {
			throw new Error("SDK tar member type is not a regular file or directory");
		}
		const name = decodeTarField(header.subarray(0, 100), "SDK tar name");
		const prefix = decodeTarField(header.subarray(345, 500), "SDK tar prefix");
		const memberPath = validateTarPath(
			prefix ? `${prefix}/${name}` : name,
			type,
		);
		if (paths.has(memberPath)) {
			throw new Error("SDK tar member paths must be unique");
		}
		paths.add(memberPath);
		memberCount += 1;
		if (memberCount > MAX_ARCHIVE_MEMBERS) {
			throw new Error("SDK tar member count exceeds limit");
		}
		const size = parseTarOctal(
			header.subarray(124, 136),
			"SDK tar member size",
		);
		if (size > MAX_MEMBER_BYTES) {
			throw new Error("SDK tar member size exceeds limit");
		}
		if (type === "5" && size !== 0) {
			throw new Error("SDK tar directory cannot contain file bytes");
		}
		const contentStart = offset + 512;
		const contentEnd = contentStart + size;
		if (!Number.isSafeInteger(contentEnd) || contentEnd > expanded.length) {
			throw new Error("SDK tar member range exceeds the archive");
		}
		if (type === "0") {
			const contents = Buffer.from(expanded.subarray(contentStart, contentEnd));
			if (memberPath === "package/package.json") packageJson = contents;
			if (memberPath.endsWith(".d.ts")) {
				declarationBytes += contents.length;
				if (declarationBytes > MAX_DECLARATION_BYTES) {
					throw new Error("SDK declaration bytes exceed limit");
				}
				declarations.push(contents);
			}
		}
		const paddedSize = Math.ceil(size / 512) * 512;
		const paddedEnd = contentStart + paddedSize;
		if (
			!Number.isSafeInteger(paddedEnd) ||
			paddedEnd > expanded.length ||
			!isZeroBlock(expanded.subarray(contentEnd, paddedEnd))
		) {
			throw new Error("SDK tar member padding is invalid");
		}
		offset = paddedEnd;
	}
	if (!terminated) throw new Error("SDK tarball has no terminal zero blocks");
	if (!packageJson) throw new Error("SDK package manifest is missing");
	const packageData = parseJsonObject(packageJson, "SDK package manifest");
	if (packageData.name !== PACKAGE_NAME) {
		throw new Error("SDK package manifest name does not match metadata");
	}
	if (packageData.version !== version) {
		throw new Error("SDK package manifest version does not match metadata");
	}
	if (declarations.length < 1) {
		throw new Error("SDK package contains no public declaration members");
	}
	return { memberCount, declarations, declarationBytes };
}

function collectExportedAliases(
	declarations: readonly Buffer[],
): ExportedTypeAlias[] {
	const aliases: ExportedTypeAlias[] = [];
	for (const declaration of declarations) {
		let ast: t.File;
		try {
			ast = parse(declaration.toString("utf8"), {
				sourceType: "module",
				plugins: [["typescript", { dts: true }]],
			});
		} catch (error) {
			throw new Error("SDK public declarations are not valid TypeScript", {
				cause: error,
			});
		}
		for (const statement of ast.program.body) {
			if (
				t.isExportNamedDeclaration(statement) &&
				statement.declaration &&
				t.isTSTypeAliasDeclaration(statement.declaration)
			) {
				aliases.push({
					name: statement.declaration.id.name,
					typeAnnotation: statement.declaration.typeAnnotation,
				});
			}
		}
	}
	return aliases;
}

function requireAlias(
	aliases: readonly ExportedTypeAlias[],
	name: string,
): t.TSType {
	const matches = aliases.filter((alias) => alias.name === name);
	if (matches.length === 0) throw new Error(`${name} public type is missing`);
	if (matches.length !== 1) {
		throw new Error(`${name} public type is ambiguous`);
	}
	const match = matches[0];
	if (!match) throw new Error(`${name} public type is missing`);
	return match.typeAnnotation;
}

function unwrapType(type: t.TSType): t.TSType {
	let current = type;
	while (t.isTSParenthesizedType(current)) current = current.typeAnnotation;
	return current;
}

function referenceArguments(reference: t.TSTypeReference): t.TSType[] {
	const compatible = reference as t.TSTypeReference & {
		typeArguments?: t.TSTypeParameterInstantiation | null;
		typeParameters?: t.TSTypeParameterInstantiation | null;
	};
	return (
		compatible.typeArguments?.params ?? compatible.typeParameters?.params ?? []
	);
}

function isTypeReference(type: t.TSType, name: string): boolean {
	const unwrapped = unwrapType(type);
	return (
		t.isTSTypeReference(unwrapped) &&
		t.isIdentifier(unwrapped.typeName, { name }) &&
		referenceArguments(unwrapped).length === 0
	);
}

function isRecordStringUnknown(type: t.TSType): boolean {
	const unwrapped = unwrapType(type);
	if (
		!t.isTSTypeReference(unwrapped) ||
		!t.isIdentifier(unwrapped.typeName, { name: "Record" })
	) {
		return false;
	}
	const parameters = referenceArguments(unwrapped);
	return (
		parameters.length === 2 &&
		t.isTSStringKeyword(parameters[0]) &&
		t.isTSUnknownKeyword(parameters[1])
	);
}

function parameterType(parameter: t.Identifier, label: string): t.TSType {
	const annotation = parameter.typeAnnotation?.typeAnnotation;
	if (!annotation || !t.isTSType(annotation)) {
		throw new Error(`${label} TypeScript annotation is missing`);
	}
	return annotation;
}

interface TypeProperty {
	name: string;
	optional: boolean;
	type: t.TSType;
}

function typeProperties(type: t.TSType, label: string): TypeProperty[] {
	const unwrapped = unwrapType(type);
	if (!t.isTSTypeLiteral(unwrapped)) {
		throw new Error(`${label} must be an object type`);
	}
	const properties: TypeProperty[] = [];
	const names = new Set<string>();
	for (const member of unwrapped.members) {
		if (
			!t.isTSPropertySignature(member) ||
			member.computed ||
			(!t.isIdentifier(member.key) && !t.isStringLiteral(member.key))
		) {
			throw new Error(`${label} contains an unsupported member`);
		}
		const name = t.isIdentifier(member.key)
			? member.key.name
			: member.key.value;
		if (names.has(name)) {
			throw new Error(`${label} contains duplicate field ${name}`);
		}
		names.add(name);
		const annotation = member.typeAnnotation?.typeAnnotation;
		if (!annotation) throw new Error(`${label} field ${name} has no type`);
		properties.push({
			name,
			optional: Boolean(member.optional),
			type: annotation,
		});
	}
	return properties;
}

function requireProperty(
	properties: readonly TypeProperty[],
	name: string,
	label: string,
): TypeProperty {
	const property = properties.find((candidate) => candidate.name === name);
	if (!property) throw new Error(`${label} is missing field ${name}`);
	return property;
}

function validateMatchedAskRule(type: t.TSType): boolean {
	let properties: TypeProperty[];
	try {
		properties = typeProperties(type, "CanUseTool matchedAskRule");
	} catch {
		return false;
	}
	if (properties.length !== 3) return false;
	const source = requireProperty(
		properties,
		"source",
		"CanUseTool matchedAskRule",
	);
	const toolName = requireProperty(
		properties,
		"toolName",
		"CanUseTool matchedAskRule",
	);
	const ruleContent = requireProperty(
		properties,
		"ruleContent",
		"CanUseTool matchedAskRule",
	);
	return (
		!source.optional &&
		t.isTSStringKeyword(unwrapType(source.type)) &&
		!toolName.optional &&
		t.isTSStringKeyword(unwrapType(toolName.type)) &&
		ruleContent.optional &&
		t.isTSStringKeyword(unwrapType(ruleContent.type))
	);
}

function validateContext(type: t.TSType): void {
	const properties = typeProperties(type, "CanUseTool context");
	if (properties.length !== CALLBACK_CONTEXT_FIELDS.length) {
		throw new Error(
			"CanUseTool context fields do not match the audited contract",
		);
	}
	for (const expected of CALLBACK_CONTEXT_FIELDS) {
		const property = requireProperty(
			properties,
			expected.name,
			"CanUseTool context",
		);
		if (property.optional === expected.required) {
			throw new Error(
				`CanUseTool context field ${expected.name} optionality drifted`,
			);
		}
		let matches = false;
		if (expected.type === "string") {
			matches = t.isTSStringKeyword(unwrapType(property.type));
		} else if (expected.type === "AbortSignal") {
			matches = isTypeReference(property.type, "AbortSignal");
		} else if (expected.type === "PermissionUpdate[]") {
			const unwrapped = unwrapType(property.type);
			matches =
				t.isTSArrayType(unwrapped) &&
				isTypeReference(unwrapped.elementType, "PermissionUpdate");
		} else {
			matches = validateMatchedAskRule(property.type);
		}
		if (!matches) {
			throw new Error(`CanUseTool context field ${expected.name} type drifted`);
		}
	}
}

function validateCallbackReturn(type: t.TSType | null | undefined): void {
	if (!type) throw new Error("CanUseTool return type is missing");
	const unwrapped = unwrapType(type);
	if (
		!t.isTSTypeReference(unwrapped) ||
		!t.isIdentifier(unwrapped.typeName, { name: "Promise" })
	) {
		throw new Error(
			"CanUseTool return type is not Promise<PermissionResult | null>",
		);
	}
	const promiseArguments = referenceArguments(unwrapped);
	if (promiseArguments.length !== 1) {
		throw new Error(
			"CanUseTool return type is not Promise<PermissionResult | null>",
		);
	}
	const promiseResult = promiseArguments[0];
	if (!promiseResult) {
		throw new Error(
			"CanUseTool return type is not Promise<PermissionResult | null>",
		);
	}
	const result = unwrapType(promiseResult);
	if (!t.isTSUnionType(result) || result.types.length !== 2) {
		throw new Error(
			"CanUseTool return type is not Promise<PermissionResult | null>",
		);
	}
	const hasResult = result.types.some((candidate) =>
		isTypeReference(candidate, "PermissionResult"),
	);
	const hasNull = result.types.some((candidate) =>
		t.isTSNullKeyword(unwrapType(candidate)),
	);
	if (!hasResult || !hasNull) {
		throw new Error(
			"CanUseTool return type is not Promise<PermissionResult | null>",
		);
	}
}

function validateCanUseTool(type: t.TSType): void {
	const unwrapped = unwrapType(type);
	if (!t.isTSFunctionType(unwrapped)) {
		throw new Error("CanUseTool public type is not a callback");
	}
	if (unwrapped.params.length !== CALLBACK_PARAMETERS.length) {
		throw new Error("CanUseTool parameter count drifted");
	}
	const parameters = unwrapped.params;
	for (let index = 0; index < CALLBACK_PARAMETERS.length; index += 1) {
		const expected = CALLBACK_PARAMETERS[index];
		const parameter = parameters[index];
		if (
			!expected ||
			!parameter ||
			!t.isIdentifier(parameter, { name: expected.name })
		) {
			throw new Error(`CanUseTool ${expected?.name ?? "parameter"} is invalid`);
		}
		const typeAnnotation = parameterType(
			parameter,
			`CanUseTool ${expected.name}`,
		);
		if (
			(expected.name === "toolName" &&
				!t.isTSStringKeyword(unwrapType(typeAnnotation))) ||
			(expected.name === "input" && !isRecordStringUnknown(typeAnnotation))
		) {
			throw new Error(`CanUseTool ${expected.name} type drifted`);
		}
		if (expected.name === "options") validateContext(typeAnnotation);
	}
	validateCallbackReturn(unwrapped.returnType?.typeAnnotation);
}

function literalBehavior(properties: readonly TypeProperty[]): string | null {
	const behavior = properties.find((property) => property.name === "behavior");
	if (!behavior || behavior.optional) return null;
	const type = unwrapType(behavior.type);
	return t.isTSLiteralType(type) && t.isStringLiteral(type.literal)
		? type.literal.value
		: null;
}

function validatePermissionResult(type: t.TSType): void {
	const unwrapped = unwrapType(type);
	if (!t.isTSUnionType(unwrapped) || unwrapped.types.length !== 2) {
		throw new Error(
			"PermissionResult must contain one allow and one deny branch",
		);
	}
	const branches = unwrapped.types.map((branch) =>
		typeProperties(branch, "PermissionResult branch"),
	);
	const allow = branches.filter(
		(branch) => literalBehavior(branch) === "allow",
	);
	const deny = branches.filter((branch) => literalBehavior(branch) === "deny");
	if (allow.length !== 1 || deny.length !== 1) {
		throw new Error("PermissionResult allow or deny branch is ambiguous");
	}
	const allowBranch = allow[0];
	const denyBranch = deny[0];
	if (!allowBranch || !denyBranch) {
		throw new Error("PermissionResult allow or deny branch is ambiguous");
	}
	const updatedInput = requireProperty(
		allowBranch,
		"updatedInput",
		"PermissionResult allow branch",
	);
	if (!updatedInput.optional || !isRecordStringUnknown(updatedInput.type)) {
		throw new Error(
			"PermissionResult allow updatedInput must be an optional record",
		);
	}
	const message = requireProperty(
		denyBranch,
		"message",
		"PermissionResult deny branch",
	);
	if (message.optional || !t.isTSStringKeyword(unwrapType(message.type))) {
		throw new Error("PermissionResult deny message must be a required string");
	}
}

function validatePermissionMode(type: t.TSType): void {
	const unwrapped = unwrapType(type);
	if (!t.isTSUnionType(unwrapped)) {
		throw new Error("PermissionMode must be an exact string-literal union");
	}
	const values: string[] = [];
	for (const candidate of unwrapped.types) {
		const literal = unwrapType(candidate);
		if (!t.isTSLiteralType(literal) || !t.isStringLiteral(literal.literal)) {
			throw new Error("PermissionMode must be an exact string-literal union");
		}
		values.push(literal.literal.value);
	}
	if (
		values.length !== PERMISSION_MODES.length ||
		new Set(values).size !== values.length ||
		PERMISSION_MODES.some((mode) => !values.includes(mode))
	) {
		throw new Error(
			"PermissionMode literals do not match the audited contract",
		);
	}
}

function validatePublicContract(declarations: readonly Buffer[]): void {
	const aliases = collectExportedAliases(declarations);
	validateCanUseTool(requireAlias(aliases, "CanUseTool"));
	validatePermissionResult(requireAlias(aliases, "PermissionResult"));
	validatePermissionMode(requireAlias(aliases, "PermissionMode"));
}

function copyContextFields(): DesktopSdkContractContextField[] {
	return CALLBACK_CONTEXT_FIELDS.map((field) => ({ ...field }));
}

function copyPermissionModes(): Array<(typeof PERMISSION_MODES)[number]> {
	return [...PERMISSION_MODES];
}

function assertIntegerRange(
	value: unknown,
	minimum: number,
	maximum: number,
	label: string,
): asserts value is number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < minimum ||
		value > maximum
	) {
		throw new Error(`${label} is outside its valid range`);
	}
}

function assertExactArray(
	value: unknown,
	expected: unknown,
	label: string,
): void {
	if (canonicalJson(value) !== canonicalJson(expected)) {
		throw new Error(`${label} does not match the audited public contract`);
	}
}

export function validateDesktopSdkContractEvidence(
	evidence: DesktopSdkContractEvidence,
): void {
	assertExactKeys(
		evidence,
		[
			"schemaVersion",
			"inventoryBinding",
			"registry",
			"permissionContract",
			"boundaries",
		],
		"Desktop SDK contract evidence",
	);
	if (evidence.schemaVersion !== DESKTOP_SDK_CONTRACT_SCHEMA_VERSION) {
		throw new Error("Unsupported Desktop SDK contract evidence schema");
	}
	assertExactKeys(
		evidence.inventoryBinding,
		[
			"sha256",
			"platform",
			"desktopLocatorId",
			"desktopVersion",
			"packagedAgentSdkVersion",
		],
		"Desktop SDK inventory binding",
	);
	if (!SHA256_RE.test(evidence.inventoryBinding.sha256)) {
		throw new Error("Desktop SDK inventory binding SHA-256 is invalid");
	}
	if (
		evidence.inventoryBinding.platform !== "linux" &&
		evidence.inventoryBinding.platform !== "darwin" &&
		evidence.inventoryBinding.platform !== "win32"
	) {
		throw new Error("Desktop SDK inventory binding platform is invalid");
	}
	if (
		!/^desktop:[a-z0-9][a-z0-9:._-]{0,119}$/.test(
			evidence.inventoryBinding.desktopLocatorId,
		)
	) {
		throw new Error("Desktop SDK inventory binding locator is invalid");
	}
	if (
		!VERSION_RE.test(evidence.inventoryBinding.desktopVersion) ||
		!VERSION_RE.test(evidence.inventoryBinding.packagedAgentSdkVersion)
	) {
		throw new Error("Desktop SDK inventory binding version is invalid");
	}
	assertExactKeys(
		evidence.registry,
		[
			"packageName",
			"version",
			"metadataOrigin",
			"tarballOrigin",
			"integrityAlgorithm",
			"integrityVerified",
			"signaturePresence",
			"signatureCount",
			"compressedBytes",
			"archiveMembers",
			"declarationMembers",
			"declarationBytes",
		],
		"Desktop SDK registry evidence",
	);
	if (
		evidence.registry.packageName !== PACKAGE_NAME ||
		evidence.registry.version !==
			evidence.inventoryBinding.packagedAgentSdkVersion ||
		evidence.registry.metadataOrigin !== REGISTRY_ORIGIN ||
		evidence.registry.tarballOrigin !== REGISTRY_ORIGIN ||
		evidence.registry.integrityAlgorithm !== "sha512" ||
		evidence.registry.integrityVerified !== true
	) {
		throw new Error(
			"Desktop SDK registry identity or integrity evidence is invalid",
		);
	}
	assertIntegerRange(
		evidence.registry.signatureCount,
		0,
		MAX_SIGNATURES,
		"Desktop SDK registry signature count",
	);
	if (
		(evidence.registry.signaturePresence === "not-provided" &&
			evidence.registry.signatureCount !== 0) ||
		(evidence.registry.signaturePresence === "present-unverified" &&
			evidence.registry.signatureCount < 1) ||
		(evidence.registry.signaturePresence !== "not-provided" &&
			evidence.registry.signaturePresence !== "present-unverified")
	) {
		throw new Error("Desktop SDK registry signature presence is invalid");
	}
	assertIntegerRange(
		evidence.registry.compressedBytes,
		1,
		MAX_COMPRESSED_BYTES,
		"Desktop SDK compressed bytes",
	);
	assertIntegerRange(
		evidence.registry.archiveMembers,
		1,
		MAX_ARCHIVE_MEMBERS,
		"Desktop SDK archive member count",
	);
	assertIntegerRange(
		evidence.registry.declarationMembers,
		1,
		evidence.registry.archiveMembers,
		"Desktop SDK declaration member count",
	);
	assertIntegerRange(
		evidence.registry.declarationBytes,
		1,
		MAX_DECLARATION_BYTES,
		"Desktop SDK declaration bytes",
	);
	assertExactKeys(
		evidence.permissionContract,
		["callback", "result", "mode"],
		"Desktop SDK permission contract",
	);
	assertExactKeys(
		evidence.permissionContract.callback,
		["typeName", "parameters", "contextFields", "returnType"],
		"Desktop SDK callback contract",
	);
	if (
		evidence.permissionContract.callback.typeName !== "CanUseTool" ||
		evidence.permissionContract.callback.returnType !==
			"Promise<PermissionResult | null>"
	) {
		throw new Error("Desktop SDK CanUseTool callback identity is invalid");
	}
	assertExactArray(
		evidence.permissionContract.callback.parameters,
		CALLBACK_PARAMETERS,
		"Desktop SDK CanUseTool parameters",
	);
	assertExactArray(
		evidence.permissionContract.callback.contextFields,
		CALLBACK_CONTEXT_FIELDS,
		"Desktop SDK CanUseTool context fields",
	);
	assertExactKeys(
		evidence.permissionContract.result,
		["typeName", "allowUpdatedInput", "denyMessage"],
		"Desktop SDK PermissionResult contract",
	);
	if (
		evidence.permissionContract.result.typeName !== "PermissionResult" ||
		evidence.permissionContract.result.allowUpdatedInput !==
			"optional-record" ||
		evidence.permissionContract.result.denyMessage !== "required-string"
	) {
		throw new Error("Desktop SDK PermissionResult contract is invalid");
	}
	assertExactKeys(
		evidence.permissionContract.mode,
		["typeName", "values"],
		"Desktop SDK PermissionMode contract",
	);
	if (evidence.permissionContract.mode.typeName !== "PermissionMode") {
		throw new Error("Desktop SDK PermissionMode type identity is invalid");
	}
	assertExactArray(
		evidence.permissionContract.mode.values,
		PERMISSION_MODES,
		"Desktop SDK PermissionMode values",
	);
	assertExactKeys(
		evidence.boundaries,
		["bundledRuntimeIdentity", "liveCallbackExecution", "uiProjection"],
		"Desktop SDK evidence boundaries",
	);
	if (evidence.boundaries.bundledRuntimeIdentity !== "not-proven") {
		throw new Error(
			"Desktop SDK bundledRuntimeIdentity must remain not-proven",
		);
	}
	if (evidence.boundaries.liveCallbackExecution !== "not-run") {
		throw new Error("Desktop SDK liveCallbackExecution must remain not-run");
	}
	if (evidence.boundaries.uiProjection !== "not-run") {
		throw new Error("Desktop SDK uiProjection must remain not-run");
	}
}

export async function inspectDesktopSdkPublicContract(
	options: InspectDesktopSdkPublicContractOptions,
): Promise<DesktopSdkContractEvidence> {
	validateDesktopInventoryEvidence(options.inventory);
	const desktop = options.inventory.desktop;
	if (!desktop) {
		throw new Error(
			"Desktop application row is required for an SDK contract audit",
		);
	}
	if (desktop.packagedAgentSdk.status !== "resolved") {
		throw new Error(
			"Packaged Agent SDK must be resolved before contract audit",
		);
	}
	const version = desktop.packagedAgentSdk.version;
	const fetcher = options.fetcher ?? fetch;
	const metadataBytes = await fetchBounded(
		exactMetadataUrl(version),
		MAX_METADATA_BYTES,
		"SDK registry metadata",
		fetcher,
	);
	const metadata = readRegistryMetadata(metadataBytes, version);
	const tarball = await fetchBounded(
		metadata.tarballUrl,
		MAX_COMPRESSED_BYTES,
		"SDK tarball compressed bytes",
		fetcher,
	);
	verifyTarballIntegrity(tarball, metadata.integrity);
	const archive = inspectTarball(tarball, version);
	validatePublicContract(archive.declarations);
	const evidence: DesktopSdkContractEvidence = {
		schemaVersion: DESKTOP_SDK_CONTRACT_SCHEMA_VERSION,
		inventoryBinding: {
			sha256: createHash("sha256")
				.update(canonicalJson(options.inventory))
				.digest("hex"),
			platform: options.inventory.platform,
			desktopLocatorId: desktop.locatorId,
			desktopVersion: desktop.version,
			packagedAgentSdkVersion: version,
		},
		registry: {
			packageName: PACKAGE_NAME,
			version,
			metadataOrigin: REGISTRY_ORIGIN,
			tarballOrigin: REGISTRY_ORIGIN,
			integrityAlgorithm: "sha512",
			integrityVerified: true,
			signaturePresence:
				metadata.signatureCount > 0 ? "present-unverified" : "not-provided",
			signatureCount: metadata.signatureCount,
			compressedBytes: tarball.length,
			archiveMembers: archive.memberCount,
			declarationMembers: archive.declarations.length,
			declarationBytes: archive.declarationBytes,
		},
		permissionContract: {
			callback: {
				typeName: "CanUseTool",
				parameters: CALLBACK_PARAMETERS.map((parameter) => ({
					...parameter,
				})),
				contextFields: copyContextFields(),
				returnType: "Promise<PermissionResult | null>",
			},
			result: {
				typeName: "PermissionResult",
				allowUpdatedInput: "optional-record",
				denyMessage: "required-string",
			},
			mode: {
				typeName: "PermissionMode",
				values: copyPermissionModes(),
			},
		},
		boundaries: {
			bundledRuntimeIdentity: "not-proven",
			liveCallbackExecution: "not-run",
			uiProjection: "not-run",
		},
	};
	validateDesktopSdkContractEvidence(evidence);
	return evidence;
}
