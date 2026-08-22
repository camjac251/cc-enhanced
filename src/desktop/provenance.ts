import { DEFAULT_NATIVE_BUCKET } from "../native-release.js";
import {
	NATIVE_ARTIFACT_PLATFORMS,
	type NativeArtifactPlatform,
} from "../targets/contract.js";

export interface OfficialDesktopCodeManifestEntry {
	version: string;
	platform: NativeArtifactPlatform;
	binary: "claude" | "claude.exe";
	size: number;
	sha256: string;
	manifestUrl: string;
	manifestSignature: "not-provided";
}

export type DesktopManifestFetcher = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const MANIFEST_SIGNATURE_KEYS = [
	"signature",
	"signatures",
	"signed",
	"publicKey",
	"publicKeyId",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasSignatureShape(value: Record<string, unknown>): boolean {
	return MANIFEST_SIGNATURE_KEYS.some((key) => Object.hasOwn(value, key));
}

async function readBoundedResponse(response: Response): Promise<string> {
	const declaredLength = response.headers.get("content-length");
	if (declaredLength !== null) {
		const parsedLength = Number(declaredLength);
		if (
			!Number.isSafeInteger(parsedLength) ||
			parsedLength < 0 ||
			parsedLength > MAX_MANIFEST_BYTES
		) {
			throw new Error("Official release manifest exceeds response limit");
		}
	}
	if (!response.body) {
		throw new Error("Official release manifest response has no body");
	}
	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > MAX_MANIFEST_BYTES) {
			await reader.cancel();
			throw new Error("Official release manifest exceeds response limit");
		}
		chunks.push(Buffer.from(value));
	}
	return Buffer.concat(chunks, total).toString("utf8");
}

export async function fetchOfficialDesktopCodeManifestEntry(options: {
	version: string;
	platform: NativeArtifactPlatform;
	fetcher?: DesktopManifestFetcher;
}): Promise<OfficialDesktopCodeManifestEntry> {
	if (!VERSION_RE.test(options.version)) {
		throw new Error(
			"Desktop Code provenance requires an exact release version",
		);
	}
	if (!NATIVE_ARTIFACT_PLATFORMS.includes(options.platform)) {
		throw new Error("Desktop Code provenance platform is invalid");
	}
	const manifestUrl = `${DEFAULT_NATIVE_BUCKET}/${options.version}/manifest.json`;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	let response: Response;
	try {
		response = await (options.fetcher ?? fetch)(manifestUrl, {
			signal: controller.signal,
			redirect: "error",
		});
		if (!response.ok) {
			throw new Error(
				`Official release manifest request failed with HTTP ${response.status}`,
			);
		}
		const text = await readBoundedResponse(response);
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			throw new Error("Official release manifest JSON is invalid", {
				cause: error,
			});
		}
		if (!isRecord(parsed) || parsed.version !== options.version) {
			throw new Error("Official release manifest version is inconsistent");
		}
		if (hasSignatureShape(parsed)) {
			throw new Error("Manifest signature fields require an explicit verifier");
		}
		if (!isRecord(parsed.platforms)) {
			throw new Error("Official release manifest platforms map is invalid");
		}
		const candidate = parsed.platforms[options.platform];
		if (!isRecord(candidate)) {
			throw new Error(
				`Official release manifest lacks platform ${options.platform}`,
			);
		}
		if (hasSignatureShape(candidate)) {
			throw new Error("Manifest signature fields require an explicit verifier");
		}
		const expectedBinary = options.platform.startsWith("win32-")
			? "claude.exe"
			: "claude";
		if (candidate.binary !== expectedBinary) {
			throw new Error("Official release manifest binary name is inconsistent");
		}
		if (
			typeof candidate.size !== "number" ||
			!Number.isSafeInteger(candidate.size) ||
			candidate.size < 1 ||
			candidate.size > MAX_ARTIFACT_BYTES
		) {
			throw new Error("Official release manifest artifact size is invalid");
		}
		if (
			typeof candidate.checksum !== "string" ||
			!SHA256_RE.test(candidate.checksum.toLowerCase())
		) {
			throw new Error("Official release manifest checksum is invalid");
		}
		return {
			version: options.version,
			platform: options.platform,
			binary: expectedBinary,
			size: candidate.size,
			sha256: candidate.checksum.toLowerCase(),
			manifestUrl,
			manifestSignature: "not-provided",
		};
	} finally {
		clearTimeout(timeout);
	}
}
