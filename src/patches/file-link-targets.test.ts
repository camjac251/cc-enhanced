import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { fileLinkTargets } from "./file-link-targets.js";

async function runFileLinkTargetsViaPasses(ast: any): Promise<void> {
	const passes = (await fileLinkTargets.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: fileLinkTargets.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

const FILE_DISPATCH_FIXTURE = `
const calls = [];
const control = { failCommand: "", throwCommand: "" };
async function runProcess(command, args, ...extra) {
  calls.push({ command, args, extra });
  if (command === control.throwCommand) {
    const error = new Error("sensitive path: /tmp/private-artifact.png");
    error.name = "SpawnError";
    throw error;
  }
  if (command === control.failCommand) return { code: 1 };
  return { code: 0 };
}
const pathApi = {
  fileURLToPath(value) {
    return decodeURIComponent(new URL(value).pathname);
  },
  pathToFileURL(value) {
    return { href: "file://" + encodeURI(value) };
  },
};
async function revealFile(filePath) {
  try {
    const { code } = await runProcess("dbus-send", [
      "--session",
      "--print-reply",
      "--dest=org.freedesktop.FileManager1",
      "--type=method_call",
      "/org/freedesktop/FileManager1",
      "org.freedesktop.FileManager1.ShowItems",
      \`array:string:\${pathApi.pathToFileURL(filePath).href.replaceAll(",", "%2C")}\`,
      "string:",
    ]);
    return code === 0;
  } catch {
    return false;
  }
}
const allowedSchemes = new Set(["https:"]);
async function openGeneric(value) {
  calls.push({ command: "generic", args: [value] });
  return { ok: true };
}
function warn(message, options) {
  calls.push({ command: "log", args: [message, options], extra: [] });
}
async function dispatchClickedLink(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const protocol = parsed.protocol;
  if (protocol === "file:") {
    if (parsed.host !== "") return false;
    try {
      return await revealFile(pathApi.fileURLToPath(value));
    } catch {
      return false;
    }
  }
  if (!allowedSchemes.has(protocol)) {
    warn(\`[hyperlink] refusing to dispatch clicked link with non-allowlisted scheme \${protocol}\`, { level: "warn" });
    return false;
  }
  return (await openGeneric(value)).ok;
}
`;

const SECOND_DISPATCH_FIXTURE = `
async function dispatchClickedLinkCopy(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const protocol = parsed.protocol;
  if (protocol === "file:") {
    if (parsed.host !== "") return false;
    try {
      return await revealFile(pathApi.fileURLToPath(value));
    } catch {
      return false;
    }
  }
  if (!allowedSchemes.has(protocol)) {
    warn(\`[hyperlink] refusing to dispatch clicked link with non-allowlisted scheme \${protocol}\`, { level: "warn" });
    return false;
  }
  return (await openGeneric(value)).ok;
}
`;

type RuntimeCall = {
	command: string;
	args: unknown[];
	extra: unknown[];
};

type PatchedRuntime = {
	calls: RuntimeCall[];
	control: { failCommand: string; throwCommand: string };
	dispatchClickedLink(value: string): Promise<boolean>;
};

async function patchFixture(): Promise<{ ast: any; output: string }> {
	const ast = parse(FILE_DISPATCH_FIXTURE);
	await runFileLinkTargetsViaPasses(ast);
	return { ast, output: print(ast) };
}

function loadPatchedRuntime(
	output: string,
	env: Record<string, string | undefined>,
	platform = "linux",
): PatchedRuntime {
	return runInNewContext(
		`(() => {
${output}
return { calls, control, dispatchClickedLink };
})()`,
		{
			URL,
			process: { env, platform },
		},
	) as PatchedRuntime;
}

function snapshotRuntimeCalls(calls: RuntimeCall[]): RuntimeCall[] {
	return Array.from(calls, (call) => ({
		command: call.command,
		args: Array.from(call.args),
		extra: Array.from(call.extra),
	}));
}

test("verify rejects an unpatched stock file dispatcher", () => {
	const ast = parse(FILE_DISPATCH_FIXTURE);
	const code = print(ast);
	const result = fileLinkTargets.verify(code, ast);
	assert.notEqual(result, true);
	assert.equal(typeof result, "string");
});

test("file-link-targets patches the stock file dispatcher", async () => {
	const { ast, output } = await patchFixture();

	assert.match(
		output,
		/async function _ccEnhancedOpenFileTarget\(filePath, stockOpen, runProcess, logWarning\)/,
	);
	assert.match(
		output,
		/return await _ccEnhancedOpenFileTarget\(pathApi\.fileURLToPath\(value\), revealFile, runProcess, warn\)/,
	);
	assert.equal(fileLinkTargets.verify(output, ast), true);
	assert.equal(fileLinkTargets.verify(output), true);
});

test("file-link-targets accepts minified false returns", async () => {
	const ast = parse(
		FILE_DISPATCH_FIXTURE.replaceAll("return false;", "return !1;"),
	);
	await runFileLinkTargetsViaPasses(ast);
	const output = print(ast);

	assert.match(output, /return await _ccEnhancedOpenFileTarget/);
	assert.equal(fileLinkTargets.verify(output, ast), true);
});

test("auto mode detects standard WSL environment markers", async () => {
	const { output } = await patchFixture();
	const filePath = "/tmp/screenshot $(ignored); still.png";
	const fileUrl = "file:///tmp/screenshot%20%24(ignored)%3B%20still.png";

	for (const env of [
		{ WSL_INTEROP: "/run/WSL/1_interop" },
		{ WSL_DISTRO_NAME: "Ubuntu" },
		{ WSLENV: "PATH/l" },
	]) {
		const runtime = loadPatchedRuntime(output, env);
		assert.equal(await runtime.dispatchClickedLink(fileUrl), true);
		assert.deepEqual(snapshotRuntimeCalls(runtime.calls), [
			{ command: "wslview", args: [filePath], extra: [] },
		]);
	}
});

test("auto mode preserves stock behavior outside WSL", async () => {
	const { output } = await patchFixture();
	const fileUrl = "file:///tmp/report.pdf";

	for (const [env, platform] of [
		[{}, "linux"],
		[{ WSL_DISTRO_NAME: "Ubuntu" }, "win32"],
	] as const) {
		const runtime = loadPatchedRuntime(output, env, platform);
		assert.equal(await runtime.dispatchClickedLink(fileUrl), true);
		assert.equal(runtime.calls.length, 1);
		assert.equal(runtime.calls[0]?.command, "dbus-send");
	}
});

test("explicit modes override automatic WSL routing", async () => {
	const { output } = await patchFixture();
	const filePath = "/tmp/report with spaces.md";
	const fileUrl = "file:///tmp/report%20with%20spaces.md";

	for (const mode of ["stock", "off"]) {
		const stock = loadPatchedRuntime(output, {
			CLAUDE_CODE_FILE_OPEN_MODE: mode,
			CLAUDE_CODE_FILE_OPENER: "/opt/bin/ignored",
			WSL_DISTRO_NAME: "Ubuntu",
		});
		assert.equal(await stock.dispatchClickedLink(fileUrl), true);
		assert.equal(stock.calls[0]?.command, "dbus-send");
	}

	const forcedWslview = loadPatchedRuntime(
		output,
		{ CLAUDE_CODE_FILE_OPEN_MODE: "wslview" },
		"darwin",
	);
	assert.equal(await forcedWslview.dispatchClickedLink(fileUrl), true);
	assert.deepEqual(snapshotRuntimeCalls(forcedWslview.calls), [
		{ command: "wslview", args: [filePath], extra: [] },
	]);

	const vscode = loadPatchedRuntime(output, {
		CLAUDE_CODE_FILE_OPEN_MODE: "vscode",
	});
	assert.equal(await vscode.dispatchClickedLink(fileUrl), true);
	assert.deepEqual(snapshotRuntimeCalls(vscode.calls), [
		{
			command: "code",
			args: ["--reuse-window", filePath],
			extra: [],
		},
	]);

	const custom = loadPatchedRuntime(output, {
		CLAUDE_CODE_FILE_OPENER: "/opt/bin/smart-open",
		WSL_DISTRO_NAME: "Ubuntu",
	});
	assert.equal(await custom.dispatchClickedLink(fileUrl), true);
	assert.deepEqual(snapshotRuntimeCalls(custom.calls), [
		{
			command: "/opt/bin/smart-open",
			args: [filePath],
			extra: [],
		},
	]);

	const builtInWins = loadPatchedRuntime(output, {
		CLAUDE_CODE_FILE_OPEN_MODE: "vscode",
		CLAUDE_CODE_FILE_OPENER: "/opt/bin/ignored",
	});
	assert.equal(await builtInWins.dispatchClickedLink(fileUrl), true);
	assert.equal(builtInWins.calls[0]?.command, "code");

	const forcedWslviewWins = loadPatchedRuntime(output, {
		CLAUDE_CODE_FILE_OPEN_MODE: "wslview",
		CLAUDE_CODE_FILE_OPENER: "/opt/bin/ignored",
	});
	assert.equal(await forcedWslviewWins.dispatchClickedLink(fileUrl), true);
	assert.equal(forcedWslviewWins.calls[0]?.command, "wslview");
});

test("legacy explicit disable values preserve stock behavior", async () => {
	const { output } = await patchFixture();
	const fileUrl = "file:///tmp/report.pdf";

	for (const legacyMode of ["off", "none", "default", "vanilla"]) {
		const runtime = loadPatchedRuntime(output, {
			CLAUDE_CODE_FILE_LINK_MODE: legacyMode,
			CLAUDE_CODE_FILE_OPENER: "/opt/bin/ignored",
			WSL_DISTRO_NAME: "Ubuntu",
		});
		assert.equal(await runtime.dispatchClickedLink(fileUrl), true);
		assert.equal(runtime.calls[0]?.command, "dbus-send");
	}

	const currentModeWins = loadPatchedRuntime(output, {
		CLAUDE_CODE_FILE_OPEN_MODE: "auto",
		CLAUDE_CODE_FILE_LINK_MODE: "off",
		WSL_DISTRO_NAME: "Ubuntu",
	});
	assert.equal(await currentModeWins.dispatchClickedLink(fileUrl), true);
	assert.equal(currentModeWins.calls[0]?.command, "wslview");
});

test("a nonzero enhanced opener logs safely without a second launch", async () => {
	const { output } = await patchFixture();
	const runtime = loadPatchedRuntime(output, {
		WSL_DISTRO_NAME: "Ubuntu",
	});
	runtime.control.failCommand = "wslview";

	const fileUrl = "file:///tmp/recoverable.png";
	assert.equal(await runtime.dispatchClickedLink(fileUrl), false);
	assert.deepEqual(
		snapshotRuntimeCalls(runtime.calls).map((call) => call.command),
		["wslview", "log"],
	);
	assert.match(
		String(runtime.calls[1]?.args[0]),
		/wslview opener failed \(exit 1\)/,
	);
	assert.doesNotMatch(String(runtime.calls[1]?.args[0]), /recoverable|\/tmp/);
});

test("a thrown enhanced opener logs only the error class", async () => {
	const { output } = await patchFixture();
	const runtime = loadPatchedRuntime(output, {
		WSL_DISTRO_NAME: "Ubuntu",
	});
	runtime.control.throwCommand = "wslview";

	assert.equal(
		await runtime.dispatchClickedLink("file:///tmp/private-artifact.png"),
		false,
	);
	assert.deepEqual(
		snapshotRuntimeCalls(runtime.calls).map((call) => call.command),
		["wslview", "log"],
	);
	const message = String(runtime.calls[1]?.args[0]);
	assert.match(message, /wslview opener failed \(exception\)/);
	assert.doesNotMatch(message, /private|artifact|\/tmp|sensitive/);
});

test("verifier rejects a helper declaration without dispatcher integration", async () => {
	const { output } = await patchFixture();
	const tampered = output.replace(
		/return await _ccEnhancedOpenFileTarget\(pathApi\.fileURLToPath\(value\), revealFile, runProcess, warn\);/,
		"return await revealFile(pathApi.fileURLToPath(value));",
	);
	assert.notEqual(tampered, output);

	const result = fileLinkTargets.verify(tampered, parse(tampered));
	assert.notEqual(result, true);
	assert.equal(typeof result, "string");
});

test("verifier rejects duplicate dispatcher integration", async () => {
	const { output } = await patchFixture();
	const integration =
		"_ccEnhancedOpenFileTarget(pathApi.fileURLToPath(value), revealFile, runProcess, warn)";
	const duplicated = output.replace(
		`return await ${integration};`,
		`return (await ${integration}) && (await ${integration});`,
	);
	assert.notEqual(duplicated, output);

	const result = fileLinkTargets.verify(duplicated, parse(duplicated));
	assert.notEqual(result, true);
	assert.equal(typeof result, "string");
});

test("stock runner result-field drift fails closed without mutation", async () => {
	const ast = parse(
		FILE_DISPATCH_FIXTURE.replace(
			"const { code } = await runProcess",
			"const { status: code } = await runProcess",
		),
	);
	await runFileLinkTargetsViaPasses(ast);
	const output = print(ast);

	assert.doesNotMatch(output, /function _ccEnhancedOpenFileTarget/);
	assert.notEqual(fileLinkTargets.verify(output, ast), true);
});

test("stock runner success-contract drift fails closed without mutation", async () => {
	const ast = parse(
		FILE_DISPATCH_FIXTURE.replace("return code === 0;", "return true;"),
	);
	await runFileLinkTargetsViaPasses(ast);
	const output = print(ast);

	assert.doesNotMatch(output, /function _ccEnhancedOpenFileTarget/);
	assert.notEqual(fileLinkTargets.verify(output, ast), true);
});

test("a shadowed warning logger fails closed without mutation", async () => {
	const shadowed = FILE_DISPATCH_FIXTURE.replace(
		"if (!allowedSchemes.has(protocol)) {\n    warn(",
		`if (!allowedSchemes.has(protocol)) {
    const warn = (message, options) => {
      calls.push({ command: "shadow-log", args: [message, options], extra: [] });
    };
    warn(`,
	);
	assert.notEqual(shadowed, FILE_DISPATCH_FIXTURE);
	const ast = parse(shadowed);
	await runFileLinkTargetsViaPasses(ast);
	const output = print(ast);

	assert.doesNotMatch(output, /function _ccEnhancedOpenFileTarget/);
	assert.notEqual(fileLinkTargets.verify(output, ast), true);
});

test("a reassigned stock exit-code binding fails closed without mutation", async () => {
	const reassigned = FILE_DISPATCH_FIXTURE.replace(
		"const { code } = await runProcess",
		"let { code } = await runProcess",
	).replace("return code === 0;", "code = 0;\n    return code === 0;");
	const ast = parse(reassigned);
	await runFileLinkTargetsViaPasses(ast);
	const output = print(ast);

	assert.doesNotMatch(output, /function _ccEnhancedOpenFileTarget/);
	assert.notEqual(fileLinkTargets.verify(output, ast), true);
});

test("a decoy stock success comparison fails closed without mutation", async () => {
	const ast = parse(
		FILE_DISPATCH_FIXTURE.replace(
			"return code === 0;",
			'if (filePath === "/never") return code === 0;\n    return true;',
		),
	);
	await runFileLinkTargetsViaPasses(ast);
	const output = print(ast);

	assert.doesNotMatch(output, /function _ccEnhancedOpenFileTarget/);
	assert.notEqual(fileLinkTargets.verify(output, ast), true);
});

test("verifier rejects an inverted empty-host guard", async () => {
	const { output } = await patchFixture();
	const tampered = output.replace('parsed.host !== ""', 'parsed.host === ""');
	assert.notEqual(tampered, output);

	const result = fileLinkTargets.verify(tampered, parse(tampered));
	assert.notEqual(result, true);
	assert.equal(typeof result, "string");
});

test("verifier rejects helper control-flow drift", async () => {
	const { output } = await patchFixture();
	const tampered = output.replace('mode === "stock"', 'mode !== "stock"');
	assert.notEqual(tampered, output);

	const result = fileLinkTargets.verify(tampered, parse(tampered));
	assert.notEqual(result, true);
	assert.equal(typeof result, "string");
});

test("file-link-targets is idempotent", async () => {
	const ast = parse(FILE_DISPATCH_FIXTURE);
	await runFileLinkTargetsViaPasses(ast);
	const once = print(ast);
	await runFileLinkTargetsViaPasses(ast);
	const twice = print(ast);

	assert.equal(twice, once);
	assert.equal(fileLinkTargets.verify(twice, ast), true);
});

test("ambiguous stock dispatchers fail closed without mutation", async () => {
	const ast = parse(`${FILE_DISPATCH_FIXTURE}\n${SECOND_DISPATCH_FIXTURE}`);
	await runFileLinkTargetsViaPasses(ast);
	const output = print(ast);

	assert.doesNotMatch(output, /function _ccEnhancedOpenFileTarget/);
	const result = fileLinkTargets.verify(output, ast);
	assert.notEqual(result, true);
	assert.equal(typeof result, "string");
});
