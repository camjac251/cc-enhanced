import * as fs from "node:fs/promises";
import type { DesktopVersionResolution } from "./contract.js";

export interface DesktopPackageMetadata {
	packageVersion: string;
	packagedAgentSdk: DesktopVersionResolution;
	declaredCodePin: DesktopVersionResolution;
	memberCount: number;
}

const MAX_HEADER_BYTES = 16 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 1024 * 1024;
const MAX_MEMBERS = 4096;
const MAX_PATH_DEPTH = 32;
const VERSION_RE = /^\d+(?:\.\d+){2,3}(?:[-+][0-9A-Za-z.-]+)?$/;

type JsonObject = Record<string, unknown>;

interface AsarFileNode {
	size: number;
	offset: number;
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
				if (keys.has(key)) throw new Error(`${label} has duplicate key ${key}`);
				keys.add(key);
				skipWhitespace();
				if (input[index] !== ":")
					throw new Error(`${label} contains invalid JSON`);
				index += 1;
				parseValue(depth + 1);
				skipWhitespace();
				if (input[index] === "}") {
					index += 1;
					return;
				}
				if (input[index] !== ",")
					throw new Error(`${label} contains invalid JSON`);
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
				if (input[index] !== ",")
					throw new Error(`${label} contains invalid JSON`);
				index += 1;
			}
		}
		if (character === '"') {
			parseString();
			return;
		}
		const remaining = input.slice(index);
		const primitive = remaining.match(
			/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/,
		)?.[0];
		if (!primitive) throw new Error(`${label} contains invalid JSON`);
		index += primitive.length;
	};
	parseValue(0);
	skipWhitespace();
	if (index !== input.length)
		throw new Error(`${label} contains trailing JSON data`);
}

function parseVersionResolution(value: unknown): DesktopVersionResolution {
	if (value === undefined) return { status: "unresolved", version: null };
	if (typeof value !== "string" || !VERSION_RE.test(value)) {
		throw new Error("Desktop package contains an invalid semantic version");
	}
	return { status: "resolved", version: value };
}

async function readExact(
	handle: fs.FileHandle,
	position: number,
	length: number,
): Promise<Buffer> {
	if (
		!Number.isSafeInteger(position) ||
		!Number.isSafeInteger(length) ||
		length < 0
	) {
		throw new Error("ASAR read range is invalid");
	}
	const buffer = Buffer.alloc(length);
	const { bytesRead } = await handle.read(buffer, 0, length, position);
	if (bytesRead !== length)
		throw new Error("ASAR read is outside archive range");
	return buffer;
}

function validateMemberName(name: string, depth: number): void {
	if (
		!name ||
		name === "." ||
		name === ".." ||
		name.includes("/") ||
		name.includes("\\") ||
		name.includes("\0") ||
		depth > MAX_PATH_DEPTH
	) {
		throw new Error("ASAR member path is invalid");
	}
}

function inspectHeader(
	header: unknown,
	dataOffset: number,
	archiveSize: number,
): { memberCount: number; packageNode: AsarFileNode } {
	if (!isObject(header) || !isObject(header.files)) {
		throw new Error("Unsupported ASAR header shape");
	}
	const stack: Array<{ files: JsonObject; depth: number; root: boolean }> = [
		{ files: header.files, depth: 1, root: true },
	];
	let memberCount = 0;
	let visitedNodes = 0;
	let packageNode: AsarFileNode | null = null;
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) break;
		for (const [name, rawNode] of Object.entries(current.files)) {
			visitedNodes += 1;
			if (visitedNodes > MAX_MEMBERS) {
				throw new Error("ASAR member count exceeds limit");
			}
			validateMemberName(name, current.depth);
			if (!isObject(rawNode)) throw new Error("Unsupported ASAR member shape");
			if ("link" in rawNode) throw new Error("ASAR links are not supported");
			if (isObject(rawNode.files)) {
				stack.push({
					files: rawNode.files,
					depth: current.depth + 1,
					root: false,
				});
				continue;
			}
			memberCount += 1;
			if (rawNode.unpacked === true) {
				if (current.root && name === "package.json") {
					throw new Error("ASAR package.json cannot be unpacked");
				}
				continue;
			}
			if (
				typeof rawNode.size !== "number" ||
				!Number.isSafeInteger(rawNode.size) ||
				rawNode.size < 0 ||
				typeof rawNode.offset !== "string" ||
				!/^\d+$/.test(rawNode.offset)
			) {
				throw new Error("ASAR member range is invalid");
			}
			const offset = Number(rawNode.offset);
			if (!Number.isSafeInteger(offset)) {
				throw new Error("ASAR member offset is outside safe range");
			}
			const end = dataOffset + offset + rawNode.size;
			if (!Number.isSafeInteger(end) || end > archiveSize) {
				throw new Error("ASAR member is outside archive range");
			}
			if (current.root && name === "package.json") {
				packageNode = { size: rawNode.size, offset };
			}
		}
	}
	if (!packageNode) throw new Error("ASAR package.json member is missing");
	return { memberCount, packageNode };
}

function readDependencyVersion(
	packageJson: JsonObject,
): DesktopVersionResolution {
	const values: unknown[] = [];
	for (const field of ["dependencies", "devDependencies"] as const) {
		const section = packageJson[field];
		if (section === undefined) continue;
		if (!isObject(section)) {
			throw new Error(`Desktop package ${field} must be an object`);
		}
		if ("@anthropic-ai/claude-agent-sdk" in section) {
			values.push(section["@anthropic-ai/claude-agent-sdk"]);
		}
	}
	if (values.length > 1) {
		throw new Error("Desktop package has duplicate Agent SDK declarations");
	}
	return parseVersionResolution(values[0]);
}

export async function readDesktopPackageMetadata(
	asarPath: string,
): Promise<DesktopPackageMetadata> {
	const handle = await fs.open(asarPath, "r");
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size < 16 || !Number.isSafeInteger(stat.size)) {
			throw new Error("ASAR archive size is invalid");
		}
		const prefix = await readExact(handle, 0, 16);
		const sizePicklePayload = prefix.readUInt32LE(0);
		const headerSize = prefix.readUInt32LE(4);
		const headerPicklePayload = prefix.readUInt32LE(8);
		const stringSize = prefix.readUInt32LE(12);
		if (sizePicklePayload !== 4) {
			throw new Error("Unsupported ASAR size header");
		}
		if (
			headerSize < 12 ||
			headerSize > MAX_HEADER_BYTES ||
			headerPicklePayload + 4 !== headerSize ||
			stringSize < 2 ||
			stringSize > headerPicklePayload - 4 ||
			8 + headerSize > stat.size
		) {
			throw new Error("ASAR header exceeds limit or archive range");
		}
		const headerString = await readExact(handle, 16, stringSize);
		let header: unknown;
		const headerJson = headerString.toString("utf8");
		try {
			assertNoDuplicateJsonKeys(headerJson, "ASAR header");
			header = JSON.parse(headerJson);
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("ASAR header")) {
				throw error;
			}
			throw new Error("ASAR header JSON is invalid", { cause: error });
		}
		const dataOffset = 8 + headerSize;
		const inspected = inspectHeader(header, dataOffset, stat.size);
		if (inspected.packageNode.size > MAX_PACKAGE_BYTES) {
			throw new Error("ASAR package.json exceeds member-size limit");
		}
		const packageBytes = await readExact(
			handle,
			dataOffset + inspected.packageNode.offset,
			inspected.packageNode.size,
		);
		let packageJson: unknown;
		const packageJsonText = packageBytes.toString("utf8");
		try {
			assertNoDuplicateJsonKeys(packageJsonText, "Desktop package.json");
			packageJson = JSON.parse(packageJsonText);
		} catch (error) {
			if (
				error instanceof Error &&
				error.message.startsWith("Desktop package.json")
			) {
				throw error;
			}
			throw new Error("Desktop package.json is invalid", { cause: error });
		}
		if (!isObject(packageJson)) {
			throw new Error("Desktop package.json must be an object");
		}
		const packageVersion = packageJson.version;
		if (
			typeof packageVersion !== "string" ||
			!VERSION_RE.test(packageVersion)
		) {
			throw new Error("Desktop package version is invalid");
		}
		return {
			packageVersion,
			packagedAgentSdk: readDependencyVersion(packageJson),
			declaredCodePin: parseVersionResolution(packageJson.claudeCodeVersion),
			memberCount: inspected.memberCount,
		};
	} finally {
		await handle.close();
	}
}
