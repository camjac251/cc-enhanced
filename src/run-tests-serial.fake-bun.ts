// Compiled by src/run-tests-serial.test.ts into a native executable that stands
// in for bun and mise. Each hardlinked copy reads `<executable>.json` for its
// role, so the same binary plays every fake on Linux, macOS, and Windows.
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import * as path from "node:path";

interface FakeConfig {
	role: "bun" | "mise";
	version?: string;
	bunPath?: string;
	failFile?: string;
	interruptRunner?: boolean;
}

const config = JSON.parse(
	readFileSync(`${process.execPath}.json`, "utf8"),
) as FakeConfig;
const args = process.argv.slice(2);

if (config.role === "mise") {
	if (args[0] === "which" && args[1] === "bun") {
		process.stdout.write(`${config.bunPath}\n`);
		process.exit(0);
	}
	process.stderr.write("unexpected mise arguments\n");
	process.exit(2);
}

if (args[0] === "--version") {
	process.stdout.write(`${config.version}\n`);
	process.exit(0);
}

const invocationLog = process.env.SERIAL_TEST_INVOCATIONS;
if (!invocationLog) throw new Error("SERIAL_TEST_INVOCATIONS is not set");
const label = (file: string) => path.basename(path.dirname(realpathSync(file)));
const pathHead = (process.env.PATH ?? "").split(path.delimiter)[0] ?? "";
const bunFileName = process.platform === "win32" ? "bun.exe" : "bun";
appendFileSync(
	invocationLog,
	`${JSON.stringify({
		bun: label(process.execPath),
		args: args.join(" "),
		pathHead,
		pathHeadBun: label(path.join(pathHead, bunFileName)),
	})}\n`,
);

const testFile = args[1] ?? "";
if (testFile.endsWith("alpha.test.ts")) {
	process.stdout.write("SKIP synthetic optional dependency unavailable\n");
	process.stderr.write("WARN synthetic runtime diagnostic\n");
}
if (config.failFile && testFile.endsWith(config.failFile)) process.exit(1);
if (config.interruptRunner) {
	process.kill(process.ppid, "SIGINT");
	setTimeout(() => process.exit(0), 500);
}
