import assert from "node:assert/strict";
import { test } from "node:test";
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

	// getServerForFile should still have [0] (primary access)
	assert.equal(
		output.includes("I[0]"),
		true,
		"getServerForFile [0] should be preserved",
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
