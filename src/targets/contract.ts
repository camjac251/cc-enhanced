export const NATIVE_ARTIFACT_PLATFORMS = [
	"linux-x64",
	"linux-arm64",
	"linux-x64-musl",
	"linux-arm64-musl",
	"darwin-x64",
	"darwin-arm64",
	"win32-x64",
	"win32-arm64",
] as const;

export type NativeArtifactPlatform = (typeof NATIVE_ARTIFACT_PLATFORMS)[number];

const nativeArtifactPlatformSet = new Set<string>(NATIVE_ARTIFACT_PLATFORMS);

export function isNativeArtifactPlatform(
	value: string,
): value is NativeArtifactPlatform {
	return nativeArtifactPlatformSet.has(value);
}

export function parseNativeArtifactPlatform(
	value: string,
): NativeArtifactPlatform {
	if (isNativeArtifactPlatform(value)) return value;
	throw new Error(
		`Unsupported native artifact platform ${JSON.stringify(value)}. Supported platforms: ${NATIVE_ARTIFACT_PLATFORMS.join(", ")}`,
	);
}

export type HostOperatingSystem = "linux" | "darwin" | "win32";
export type CpuArchitecture = "x64" | "arm64";
export type LinuxLibc = "glibc" | "musl";
export type NativeBinaryFormat = "elf" | "macho" | "pe";

export type RuntimeSurface =
	| "cli"
	| "desktop-local"
	| "desktop-wsl"
	| "desktop-ssh"
	| "remote-control"
	| "self-hosted-runner";

export type TargetKind =
	| "standalone-cli"
	| "desktop-local"
	| "desktop-wsl"
	| "desktop-ssh"
	| "self-hosted-runner";

export const VERSION_LANES = [
	"cli-latest",
	"desktop-current",
	"runner-pinned",
] as const;

export type VersionLane = (typeof VERSION_LANES)[number];

export interface TargetDescriptor {
	id: string;
	kind: TargetKind;
	surface: RuntimeSurface;
	platform: NativeArtifactPlatform;
	versionLane: VersionLane;
}

export const ARTIFACT_RECEIPT_SCHEMA_VERSION = 1 as const;

export type ArtifactEvidenceStatus =
	| "pass"
	| "fail"
	| "not-run"
	| "not-required";

export type UpstreamManifestSignatureStatus =
	| "verified"
	| "not-provided"
	| "not-run";

export interface ArtifactReceipt {
	schemaVersion: typeof ARTIFACT_RECEIPT_SCHEMA_VERSION;
	targetId: string;
	upstreamVersion: string;
	upstreamPlatform: NativeArtifactPlatform;
	upstreamChecksum: string;
	upstreamManifestChecksumVerified: boolean;
	upstreamManifestSignature: UpstreamManifestSignatureStatus;
	cleanSha256: string;
	patchedSha256: string;
	profile: string;
	selectedTags: string[];
	patcherRevision: string;
	binaryFormat: NativeBinaryFormat;
	structuralVerification: ArtifactEvidenceStatus;
	signingPolicy: string;
	signingVerification: ArtifactEvidenceStatus;
	hostExecution: ArtifactEvidenceStatus;
	createdAt: string;
}
