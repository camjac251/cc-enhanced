import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import {
	fileLinkTargets,
	resolveFileLinkHrefForEnv,
} from "./file-link-targets.js";

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

const FILE_LINK_FIXTURE = `
function Cs(props) { return props; }
function B1(e) {
  let memo = cache.c(5),
    { filePath: n, children: r } = e,
    o;
  if (memo[0] !== n) (o = N.pathToFileURL(n)), (memo[0] = n), (memo[1] = o);
  else o = memo[1];
  let s = r ?? n,
    i;
  if (memo[2] !== o.href || memo[3] !== s)
    (i = jsxRuntime.jsx(Cs, { url: o.href, children: s })), (memo[2] = o.href), (memo[3] = s), (memo[4] = i);
  else i = memo[4];
  return i;
}
`;

test("verify rejects unpatched file hyperlink component", () => {
	const ast = parse(FILE_LINK_FIXTURE);
	const code = print(ast);
	const result = fileLinkTargets.verify(code, ast);
	assert.notEqual(result, true);
	assert.equal(typeof result, "string");
});

test("file-link-targets routes file hyperlink href through helper", async () => {
	const ast = parse(FILE_LINK_FIXTURE);
	await runFileLinkTargetsViaPasses(ast);
	const output = print(ast);

	assert.match(output, /function _ccEnhancedFileHref\(/);
	assert.match(output, /url: _ccEnhancedFileHref\(n, o\.href\)/);
	assert.equal(fileLinkTargets.verify(output, ast), true);
	assert.equal(fileLinkTargets.verify(output), true);
});

test("file-link-targets verifier ignores expression-bodied functions", async () => {
	const ast = parse(`
const noop = (value) => value;
${FILE_LINK_FIXTURE}
`);
	await runFileLinkTargetsViaPasses(ast);
	const output = print(ast);

	assert.equal(fileLinkTargets.verify(output, ast), true);
	assert.equal(fileLinkTargets.verify(output), true);
});

test("file-link-targets helper turns WSL paths into Windows-readable file URLs by default", async () => {
	const ast = parse(FILE_LINK_FIXTURE);
	await runFileLinkTargetsViaPasses(ast);
	const output = print(ast);
	assert.match(output, /return "file:" \+ uncPath;/);

	assert.equal(
		resolveFileLinkHrefForEnv(
			"/home/cam/project/with space.ts",
			"file:///home/cam/project/with%20space.ts",
			{ WSL_DISTRO_NAME: "Ubuntu" },
		),
		"file://wsl.localhost/Ubuntu/home/cam/project/with%20space.ts",
	);
});

test("file-link-targets helper supports VS Code and remote WSL URL modes", async () => {
	const ast = parse(FILE_LINK_FIXTURE);
	await runFileLinkTargetsViaPasses(ast);
	const output = print(ast);
	assert.match(output, /return "vscode:\/\/file" \+ uncPath;/);
	assert.match(output, /return "vscode:\/\/vscode-remote\/wsl\+"/);

	assert.equal(
		resolveFileLinkHrefForEnv(
			"/home/cam/project/app.ts",
			"file:///home/cam/project/app.ts",
			{
				CLAUDE_CODE_FILE_LINK_MODE: "vscode",
				WSL_DISTRO_NAME: "Ubuntu",
			},
		),
		"vscode://file//wsl.localhost/Ubuntu/home/cam/project/app.ts",
	);

	assert.equal(
		resolveFileLinkHrefForEnv(
			"/home/cam/project/app.ts",
			"file:///home/cam/project/app.ts",
			{
				CLAUDE_CODE_FILE_LINK_MODE: "vscode-remote",
				WSL_DISTRO_NAME: "Ubuntu",
			},
		),
		"vscode://vscode-remote/wsl+Ubuntu/home/cam/project/app.ts",
	);
});

test("file-link-targets helper can be disabled and handles /mnt drive paths", async () => {
	const ast = parse(FILE_LINK_FIXTURE);
	await runFileLinkTargetsViaPasses(ast);
	const output = print(ast);

	assert.match(output, /return "vscode:\/\/file\/" \+ drivePath;/);
	assert.equal(
		resolveFileLinkHrefForEnv(
			"/home/cam/project/app.ts",
			"file:///home/cam/project/app.ts",
			{
				CLAUDE_CODE_FILE_LINK_MODE: "off",
				WSL_DISTRO_NAME: "Ubuntu",
			},
		),
		"file:///home/cam/project/app.ts",
	);

	assert.equal(
		resolveFileLinkHrefForEnv(
			"/mnt/c/Users/Cam/My Project/app.ts",
			"file:///mnt/c/Users/Cam/My%20Project/app.ts",
			{
				CLAUDE_CODE_FILE_LINK_MODE: "vscode",
				WSL_DISTRO_NAME: "Ubuntu",
			},
		),
		"vscode://file/c:/Users/Cam/My%20Project/app.ts",
	);
});
