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
