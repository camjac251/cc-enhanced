import * as os from "node:os";
import * as path from "node:path";

export const DEFAULT_VERSIONS_DIR = path.join(
	os.homedir(),
	".local",
	"share",
	"claude",
	"versions",
);

export const DEFAULT_BIN_LINK = path.join(
	os.homedir(),
	".local",
	"bin",
	"claude",
);

export const DEFAULT_NATIVE_CACHE_DIR = path.join(
	os.homedir(),
	".claude-patcher",
	"native-cache",
);

export interface VersionPaths {
	versionsDir: string;
	currentLink: string;
	previousLink: string;
	binLink: string;
}

export function resolveVersionPaths(overrides?: {
	versionsDir?: string;
	binLink?: string;
}): VersionPaths {
	const versionsDir = overrides?.versionsDir ?? DEFAULT_VERSIONS_DIR;
	return {
		versionsDir,
		currentLink: path.join(versionsDir, "current"),
		previousLink: path.join(versionsDir, "previous"),
		binLink: overrides?.binLink ?? DEFAULT_BIN_LINK,
	};
}
