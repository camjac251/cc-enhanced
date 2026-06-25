import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { lspMultiServer } from "./lsp-multi-server.js";

async function runViaPasses(ast: any): Promise<void> {
	const passes = (await lspMultiServer.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: lspMultiServer.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

// Minimal fixture that reproduces the LSP server manager factory structure.
// Uses stable string anchors (property names, method strings) that the patch
// discovers, with minified-style single-letter locals.
const LSP_FACTORY_FIXTURE = `
var kn = { extname: (f) => ".py", resolve: (f) => "/abs/" + f };
var XTH = { pathToFileURL: (p) => ({ href: "file://" + p }) };
function v(msg) {}
function PH(err) {}

function XF8() {
  let H = new Map(),
    $ = new Map(),
    A = new Map();

  async function L() {}
  async function D() {
    H.clear(); $.clear(); A.clear();
  }

  function f(Y) {
    let j = kn.extname(Y).toLowerCase(),
      I = $.get(j);
    if (!I || I.length === 0) return;
    let X = I[0];
    if (!X) return;
    return H.get(X);
  }

  async function _(Y) {
    let j = f(Y);
    if (!j) return;
    if (j.state === "stopped") await j.start();
    return j;
  }

  async function M(Y, j, I) {
    let X = await _(Y);
    if (!X) return;
    return await X.sendRequest(j, I);
  }

  function K() { return H; }

  async function q(Y, j) {
    let I = await _(Y);
    if (!I) return;
    let X = XTH.pathToFileURL(kn.resolve(Y)).href;
    if (A.get(X) === I.name) {
      v(\`LSP: File already open, skipping didOpen for \${Y}\`);
      return;
    }
    let G = kn.extname(Y).toLowerCase(),
      W = I.config.extensionToLanguage[G] || "plaintext";
    try {
      await I.sendNotification("textDocument/didOpen", {
        textDocument: { uri: X, languageId: W, version: 1, text: j }
      });
      A.set(X, I.name);
      v(\`LSP: Sent didOpen for \${Y} (languageId: \${W})\`);
    } catch (E) {
      let Z = Error(\`Failed to sync file open \${Y}: \${E.message}\`);
      throw (PH(Z), Z);
    }
  }

  async function P(Y, j) {
    let I = f(Y);
    if (!I || I.state !== "running") return q(Y, j);
    let X = XTH.pathToFileURL(kn.resolve(Y)).href;
    if (A.get(X) !== I.name) return q(Y, j);
    try {
      await I.sendNotification("textDocument/didChange", {
        textDocument: { uri: X, version: 1 },
        contentChanges: [{ text: j }]
      });
      v(\`LSP: Sent didChange for \${Y}\`);
    } catch (G) {
      throw (PH(Error(\`Failed to sync file change \${Y}\`)), Error("fail"));
    }
  }

  async function O(Y) {
    let j = f(Y);
    if (!j || j.state !== "running") return;
    try {
      await j.sendNotification("textDocument/didSave", {
        textDocument: { uri: XTH.pathToFileURL(kn.resolve(Y)).href }
      });
      v(\`LSP: Sent didSave for \${Y}\`);
    } catch (I) {
      throw (PH(Error(\`Failed to sync file save \${Y}\`)), Error("fail"));
    }
  }

  async function w(Y) {
    let j = f(Y);
    if (!j || j.state !== "running") return;
    let I = XTH.pathToFileURL(kn.resolve(Y)).href;
    try {
      await j.sendNotification("textDocument/didClose", { textDocument: { uri: I } });
      A.delete(I);
      v(\`LSP: Sent didClose for \${Y}\`);
    } catch (X) {
      throw (PH(Error(\`Failed to sync file close \${Y}\`)), Error("fail"));
    }
  }

  function z(Y) {
    let j = XTH.pathToFileURL(kn.resolve(Y)).href;
    return A.has(j);
  }

  return {
    initialize: L,
    shutdown: D,
    getServerForFile: f,
    ensureServerStarted: _,
    sendRequest: M,
    getAllServers: K,
    openFile: q,
    changeFile: P,
    saveFile: O,
    closeFile: w,
    isFileOpen: z,
  };
}
`;

test("verify rejects unpatched LSP factory", () => {
	const ast = parse(LSP_FACTORY_FIXTURE);
	const code = print(ast);
	const result = lspMultiServer.verify(code, ast);
	assert.notEqual(result, true, "verify should reject unpatched code");
	assert.equal(typeof result, "string");
});

test("lsp-multi-server replaces all 4 lifecycle functions", async () => {
	const ast = parse(LSP_FACTORY_FIXTURE);
	await runViaPasses(ast);
	const output = print(ast);

	// Each lifecycle function should now have a for-loop
	// openFile: for loop with didOpen
	assert.match(output, /for\s*\(/, "should contain for-loop");

	// All 4 LSP methods should still be present
	assert.equal(output.includes('"textDocument/didOpen"'), true);
	assert.equal(output.includes('"textDocument/didChange"'), true);
	assert.equal(output.includes('"textDocument/didSave"'), true);
	assert.equal(output.includes('"textDocument/didClose"'), true);

	// getServerForFile is rewritten to add filename fallback but must still
	// take the primary ([0]) of the resolved server-name list.
	assert.equal(
		output.includes("_ns[0]"),
		true,
		"getServerForFile [0] primary access should be preserved",
	);

	// sendRequest and ensureServerStarted should be unchanged (still call f/getServerForFile)
	assert.equal(output.includes("sendRequest"), true);

	// Verify passes
	assert.equal(lspMultiServer.verify(output, ast), true);
	assert.equal(lspMultiServer.verify(output), true);
});

test("lsp-multi-server verify catches missing for-loop", () => {
	// Fixture where openFile has no for-loop (original single-server code)
	const ast = parse(LSP_FACTORY_FIXTURE);
	const code = print(ast);
	const result = lspMultiServer.verify(code, ast);
	assert.equal(typeof result, "string");
	assert.match(String(result), /for-loop|iteration|missing/i);
});

test("lsp-multi-server uses Set-based tracking", async () => {
	const ast = parse(LSP_FACTORY_FIXTURE);
	await runViaPasses(ast);
	const output = print(ast);

	// Should use instanceof Set for open-file tracking
	assert.equal(
		output.includes("instanceof Set"),
		true,
		"should use Set-based tracking",
	);
	// Should create new Set() for tracking
	assert.equal(
		output.includes("new Set()"),
		true,
		"should create tracking Sets",
	);
});

test("lsp-multi-server preserves getServerForFile and sendRequest", async () => {
	const ast = parse(LSP_FACTORY_FIXTURE);
	await runViaPasses(ast);
	const output = print(ast);

	// Return object should still export all the same properties
	assert.equal(output.includes("getServerForFile:"), true);
	assert.equal(output.includes("ensureServerStarted:"), true);
	assert.equal(output.includes("sendRequest:"), true);
	assert.equal(output.includes("openFile:"), true);
	assert.equal(output.includes("closeFile:"), true);
	assert.equal(output.includes("isFileOpen:"), true);
});

test("lsp-multi-server couples a for-loop to every lifecycle method", async () => {
	const ast = parse(LSP_FACTORY_FIXTURE);
	await runViaPasses(ast);
	const output = print(ast);
	for (const method of [
		"textDocument/didOpen",
		"textDocument/didChange",
		"textDocument/didSave",
		"textDocument/didClose",
	]) {
		// The method string must sit after a `for (` in the same function-sized
		// window, mirroring verify()'s for-loop/sendNotification coupling without
		// relying on minified names.
		const idx = output.indexOf(JSON.stringify(method));
		assert.notEqual(idx, -1, `${method} present`);
		const forIdx = output.lastIndexOf("for (", idx);
		assert.notEqual(
			forIdx,
			-1,
			`${method} should be preceded by a for-loop (multi-server fan-out)`,
		);
	}
});

test("lsp-multi-server tolerates an extra (4th) Map in the factory", async () => {
	// Mirror upstream: add a trailing document-version Map as the 4th declarator.
	const fourMapFixture = LSP_FACTORY_FIXTURE.replace(
		"let H = new Map(),\n    $ = new Map(),\n    A = new Map();",
		"let H = new Map(),\n    $ = new Map(),\n    A = new Map(),\n    VER = new Map();",
	);
	assert.notEqual(
		fourMapFixture,
		LSP_FACTORY_FIXTURE,
		"fixture rewrite must apply (Map declaration shape changed)",
	);
	const ast = parse(fourMapFixture);
	await runViaPasses(ast);
	const output = print(ast);
	// Discovery must still pick the URI tracker (3rd map) for Set-based tracking.
	assert.equal(output.includes("instanceof Set"), true);
	assert.equal(output.includes("new Set()"), true);
	assert.equal(lspMultiServer.verify(output, ast), true);
});

test("lsp-multi-server discovers errFn from a non-lifecycle function", async () => {
	// Strip the direct PH(Error(...)) calls from the lifecycle catches and place
	// the sole errFn source in an init-style function, matching the real bundle
	// shape where errFn is resolved from an Error()-first-arg call outside any
	// lifecycle function.
	let fixture = LSP_FACTORY_FIXTURE.replaceAll(
		/throw \(PH\(Error\([^;]*?\)\), Error\("fail"\)\);/g,
		'throw Error("fail");',
	).replace("throw (PH(Z), Z);", "throw Z;");
	// Inject an init function whose only error path calls PH(Error(...)).
	fixture = fixture.replace(
		"async function L() {}",
		'async function L() { try { await Promise.resolve(); } catch (e) { PH(Error("init failed: " + e.message)); } }',
	);
	assert.notEqual(fixture, LSP_FACTORY_FIXTURE, "fixture rewrite must apply");
	const ast = parse(fixture);
	await runViaPasses(ast);
	const output = print(ast);
	// Patch must still have applied (errFn resolved -> builders injected the loops).
	assert.equal(output.includes('"textDocument/didOpen"'), true);
	assert.equal(output.includes("instanceof Set"), true);
	assert.equal(lspMultiServer.verify(output, ast), true);
});

test("lsp-multi-server verify fails when closeFile stops untracking the URI", async () => {
	const ast = parse(LSP_FACTORY_FIXTURE);
	await runViaPasses(ast);
	const output = print(ast);
	assert.equal(lspMultiServer.verify(output), true);
	// Drop the tracking-map delete from the patched closeFile body. A reopen
	// would then be skipped as "already open", so verify must reject this.
	const mutated = output.replace(/A\.delete\([^)]*\);/, "");
	assert.notEqual(mutated, output, "precondition: closeFile delete present");
	const result = lspMultiServer.verify(mutated);
	assert.equal(typeof result, "string");
	assert.match(String(result), /closeFile does not delete the closed URI/);
});

test("lsp-multi-server fails closed when errFn cannot be discovered", async () => {
	// errFn is discovered only from a call whose first argument is Error(...).
	// Strip every such call so errFn is undiscoverable, then assert the patch
	// declines to mutate AND verify reports a hard failure instead of a silent
	// no-op promote.
	const fixture = LSP_FACTORY_FIXTURE.replaceAll(
		/throw \(PH\(Error\([^;]*?\)\), Error\("fail"\)\);/g,
		'throw Error("fail");',
	).replace("throw (PH(Z), Z);", "throw Z;");
	assert.notEqual(fixture, LSP_FACTORY_FIXTURE, "fixture rewrite must apply");
	const ast = parse(fixture);
	const passes = (await lspMultiServer.astPasses?.(ast)) ?? [];
	assert.equal(
		passes.length,
		0,
		"no mutation passes when errFn is undiscoverable",
	);
	const output = print(ast);
	const result = lspMultiServer.verify(output, ast);
	assert.notEqual(
		result,
		true,
		"verify must fail rather than silently pass when discovery fails",
	);
	assert.equal(typeof result, "string");
});

test("lsp-multi-server assigns trackMap from the 3rd Map even with a 4th present", async () => {
	const fourMapFixture = LSP_FACTORY_FIXTURE.replace(
		"let H = new Map(),\n    $ = new Map(),\n    A = new Map();",
		"let H = new Map(),\n    $ = new Map(),\n    A = new Map(),\n    VER = new Map();",
	);
	assert.notEqual(
		fourMapFixture,
		LSP_FACTORY_FIXTURE,
		"fixture rewrite must apply",
	);
	const ast = parse(fourMapFixture);
	await runViaPasses(ast);
	const output = print(ast);
	// closeFile must delete from the 3rd map (A), the discovered tracking map,
	// not from the trailing 4th map (VER).
	assert.match(
		output,
		/A\.delete\(/,
		"trackMap (3rd map) must be the one closeFile untracks",
	);
	assert.equal(
		output.includes("VER.delete("),
		false,
		"the 4th map must not be treated as the tracking map",
	);
	assert.equal(lspMultiServer.verify(output, ast), true);
});

test("lsp-multi-server injects filename-routing helper and wires fallbacks", async () => {
	const ast = parse(LSP_FACTORY_FIXTURE);
	await runViaPasses(ast);
	const output = print(ast);

	// Helpers injected into the factory.
	assert.equal(
		output.includes("function _lspByName("),
		true,
		"filename-routing helper should be injected",
	);
	assert.equal(
		output.includes("function _lspGlobRe("),
		true,
		"glob helper should be injected",
	);
	// getServerForFile and the lifecycle path fall back to the helper.
	assert.match(output, /_lspByName\(/, "callers should invoke the helper");
	// verify enforces the feature (both with and without a pre-parsed AST).
	assert.equal(lspMultiServer.verify(output, ast), true);
	assert.equal(lspMultiServer.verify(output), true);
});

test("lsp-multi-server verify catches dropped filename routing", async () => {
	const ast = parse(LSP_FACTORY_FIXTURE);
	await runViaPasses(ast);
	const output = print(ast);
	assert.equal(lspMultiServer.verify(output), true);
	// Remove the helper declaration; verify must reject rather than silently pass.
	const mutated = output.replace("function _lspByName(", "function _gone(");
	assert.notEqual(mutated, output, "precondition: helper declaration present");
	const result = lspMultiServer.verify(mutated);
	assert.equal(typeof result, "string");
	assert.match(String(result), /_lspByName/);
});

test("lsp-multi-server verify catches filename routing without language helper", async () => {
	const ast = parse(LSP_FACTORY_FIXTURE);
	await runViaPasses(ast);
	const output = print(ast);
	assert.equal(lspMultiServer.verify(output), true);
	const mutated = output.replace(
		/var _lg = _lspLang\([^;]+;/,
		'var _lg = _sv.config.extensionToLanguage[_ext] || "plaintext";',
	);
	assert.notEqual(mutated, output, "precondition: _lspLang call present");
	const result = lspMultiServer.verify(mutated);
	assert.equal(typeof result, "string");
	assert.match(String(result), /languageId.*_lspLang/);
});

test("lsp-multi-server routes Dockerfile and globs through lifecycle functions (execution)", async () => {
	const ast = parse(LSP_FACTORY_FIXTURE);
	await runViaPasses(ast);
	const output = print(ast);

	// Materialize the patched factory in an isolated context and drive it with a
	// populated serverMap. Executing the emitted code is the point of this test:
	// it exercises the real glob/basename logic, not a re-implementation.
	const factory = vm.runInNewContext(`${output}; XF8`) as () => {
		getServerForFile: (f: string) => unknown;
		getAllServers: () => Map<string, unknown>;
		openFile: (f: string, text: string) => Promise<void>;
		changeFile: (f: string, text: string) => Promise<void>;
		saveFile: (f: string) => Promise<void>;
		closeFile: (f: string) => Promise<void>;
	};
	const mgr = factory();
	const notifications: Array<{
		server: string;
		method: string;
		params: { textDocument?: { languageId?: string } };
	}> = [];
	const makeServer = (
		name: string,
		config: {
			extensionToLanguage: Record<string, string>;
			filenames: Record<string, string>;
			filenamePatterns: Record<string, string>;
		},
	) => ({
		name,
		state: "running",
		config,
		sendNotification: async (
			method: string,
			params: { textDocument?: { languageId?: string } },
		) => {
			notifications.push({ server: name, method, params });
		},
	});
	const docker = makeServer("docker", {
		extensionToLanguage: {},
		filenames: { Dockerfile: "dockerfile", Containerfile: "dockerfile" },
		filenamePatterns: { "Dockerfile.*": "dockerfile-pattern" },
	});
	const lint = makeServer("docker-lint", {
		extensionToLanguage: {},
		filenames: { Dockerfile: "dockerlint" },
		filenamePatterns: { "Dockerfile.*": "dockerlint-pattern" },
	});
	mgr.getAllServers().set("docker", docker);
	mgr.getAllServers().set("docker-lint", lint);

	// Exact basename (extensionless), bare and path-qualified.
	assert.equal(mgr.getServerForFile("Dockerfile"), docker);
	assert.equal(mgr.getServerForFile("/srv/app/Dockerfile"), docker);
	assert.equal(mgr.getServerForFile("Containerfile"), docker);
	// Glob pattern.
	assert.equal(mgr.getServerForFile("Dockerfile.dev"), docker);
	assert.equal(mgr.getServerForFile("Dockerfile.prod"), docker);
	// Non-matches resolve to nothing (glob is anchored, not a loose prefix).
	assert.equal(mgr.getServerForFile("notes.txt"), undefined);
	assert.equal(mgr.getServerForFile("Dockerfilex"), undefined);

	await mgr.openFile("Dockerfile", "FROM alpine");
	assert.deepEqual(
		notifications.map((n) => [
			n.server,
			n.method,
			n.params.textDocument?.languageId,
		]),
		[
			["docker", "textDocument/didOpen", "dockerfile"],
			["docker-lint", "textDocument/didOpen", "dockerlint"],
		],
	);

	notifications.length = 0;
	await mgr.changeFile("Dockerfile", "FROM busybox");
	await mgr.saveFile("Dockerfile");
	await mgr.closeFile("Dockerfile");
	assert.deepEqual(
		notifications.map((n) => [n.server, n.method]),
		[
			["docker", "textDocument/didChange"],
			["docker-lint", "textDocument/didChange"],
			["docker", "textDocument/didSave"],
			["docker-lint", "textDocument/didSave"],
			["docker", "textDocument/didClose"],
			["docker-lint", "textDocument/didClose"],
		],
	);

	notifications.length = 0;
	await mgr.openFile("Dockerfile.dev", "FROM alpine");
	assert.deepEqual(
		notifications.map((n) => [
			n.server,
			n.method,
			n.params.textDocument?.languageId,
		]),
		[
			["docker", "textDocument/didOpen", "dockerfile-pattern"],
			["docker-lint", "textDocument/didOpen", "dockerlint-pattern"],
		],
	);

	notifications.length = 0;
	await mgr.openFile("notes.txt", "plain text");
	assert.deepEqual(notifications, []);
});
