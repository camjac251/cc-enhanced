import * as os from "node:os";
import * as path from "node:path";

export const DEFAULT_NATIVE_CACHE_DIR = path.join(
	os.homedir(),
	".claude-patcher",
	"native-cache",
);
