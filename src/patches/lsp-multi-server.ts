import type { NodePath } from "@babel/traverse";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import { parse } from "../loader.js";
import type { Patch } from "../types.js";
import { getObjectKeyName, getVerifyAst } from "./ast-helpers.js";

/**
 * Multi-LSP server patch: fans out lifecycle notifications (didOpen, didChange,
 * didSave, didClose) to ALL servers registered for a file extension, not just
 * the first. Fixes anthropics/claude-code#32912.
 *
 * sendRequest continues to use the primary (first) server for type intelligence.
 * Diagnostics already iterate all servers (yF8 handler).
 *
 * The tracking map (A) is changed from Map<uri, serverName> to
 * Map<uri, Set<serverName>> for per-server open-file tracking. Existing
 * consumers (isFileOpen: A.has(), shutdown: A.clear()) work unchanged.
 */

interface LspRefs {
	factoryName: string;
	// Functions (from return object property values)
	openFile: string;
	changeFile: string;
	saveFile: string;
	closeFile: string;
	shutdown: string;
	getServerForFile: string;
	// Map variables (from first 3-Map VariableDeclaration)
	serverMap: string; // server instances: name -> server
	extMap: string; // extension -> serverName[]
	trackMap: string; // uri -> open tracking
	// Module/utility refs (from function body scanning)
	pathMod: string; // path module (extname, resolve)
	urlMod: string; // url module (pathToFileURL)
	logFn: string; // log function
	errFn: string; // error report function
}

let discoveredRefs: LspRefs | null = null;

// === Discovery ===

function discoverRefs(ast: t.File): LspRefs | null {
	let result: LspRefs | null = null;

	traverse.default(ast, {
		ReturnStatement(path) {
			const arg = path.node.argument;
			if (!t.isObjectExpression(arg)) return;

			// Build map of property name -> identifier name from return object
			const propMap = new Map<string, string>();
			for (const p of arg.properties) {
				if (!t.isObjectProperty(p)) continue;
				const key = getObjectKeyName(p.key);
				if (key && t.isIdentifier(p.value)) propMap.set(key, p.value.name);
			}

			// Verify this is the LSP server manager return object
			const required = [
				"getServerForFile",
				"ensureServerStarted",
				"sendRequest",
				"openFile",
				"changeFile",
				"saveFile",
				"closeFile",
				"isFileOpen",
				"shutdown",
				"getAllServers",
			];
			if (!required.every((k) => propMap.has(k))) return;

			// Walk up to enclosing FunctionDeclaration
			let fp: NodePath | null = path.parentPath;
			while (fp && !fp.isFunctionDeclaration()) fp = fp.parentPath;
			if (!fp?.isFunctionDeclaration()) return;
			const factoryFn = fp.node as t.FunctionDeclaration;
			if (!factoryFn.id) return;

			const body = factoryFn.body.body;

			// Extract Maps: first VariableDeclaration with 3+ new Map() declarators
			let serverMap = "";
			let extMap = "";
			let trackMap = "";
			for (const stmt of body) {
				if (!t.isVariableDeclaration(stmt)) continue;
				const maps = stmt.declarations.filter(
					(d) =>
						t.isNewExpression(d.init) &&
						t.isIdentifier(d.init.callee, { name: "Map" }) &&
						t.isIdentifier(d.id),
				);
				if (maps.length >= 3) {
					serverMap = (maps[0].id as t.Identifier).name;
					extMap = (maps[1].id as t.Identifier).name;
					trackMap = (maps[2].id as t.Identifier).name;
					break;
				}
			}
			if (!serverMap || !extMap || !trackMap) return;

			// Extract module/utility refs by scanning all function bodies in factory
			let pathMod = "";
			let urlMod = "";
			let logFn = "";
			let errFn = "";
			for (const stmt of body) {
				if (!t.isFunctionDeclaration(stmt)) continue;
				walkNode(stmt, (node) => {
					if (
						t.isMemberExpression(node) &&
						t.isIdentifier(node.property) &&
						t.isIdentifier(node.object)
					) {
						if (node.property.name === "extname") pathMod = node.object.name;
						if (node.property.name === "pathToFileURL")
							urlMod = node.object.name;
					}
					if (
						t.isCallExpression(node) &&
						t.isIdentifier(node.callee) &&
						node.arguments.length >= 1
					) {
						const a = node.arguments[0];
						// Log function: called with string/template containing "LSP:"
						if (
							t.isTemplateLiteral(a) &&
							a.quasis.some((q) => q.value.raw.includes("LSP:"))
						)
							logFn = node.callee.name;
						if (t.isStringLiteral(a) && a.value.includes("LSP:"))
							logFn = node.callee.name;
						// Also handle string concatenation: "LSP: ..." + x
						if (t.isBinaryExpression(a, { operator: "+" })) {
							const left = getLeftmostString(a);
							if (left?.includes("LSP:")) logFn = node.callee.name;
						}
						// Error function: called with Error(...) as argument
						if (
							(t.isNewExpression(a) || t.isCallExpression(a)) &&
							t.isIdentifier(a.callee, { name: "Error" })
						)
							errFn = errFn || node.callee.name;
					}
				});
			}
			if (!pathMod || !urlMod || !logFn || !errFn) return;

			result = {
				factoryName: factoryFn.id.name,
				openFile: propMap.get("openFile")!,
				changeFile: propMap.get("changeFile")!,
				saveFile: propMap.get("saveFile")!,
				closeFile: propMap.get("closeFile")!,
				shutdown: propMap.get("shutdown")!,
				getServerForFile: propMap.get("getServerForFile")!,
				serverMap,
				extMap,
				trackMap,
				pathMod,
				urlMod,
				logFn,
				errFn,
			};
			path.stop();
		},
	});

	return result;
}

/** Extract the leftmost StringLiteral from a BinaryExpression chain (a + b + c). */
function getLeftmostString(node: t.Node): string | null {
	if (t.isStringLiteral(node)) return node.value;
	if (t.isBinaryExpression(node, { operator: "+" }))
		return getLeftmostString(node.left);
	return null;
}

/** Simple recursive AST walker (avoids full traverse for small subtrees). */
function walkNode(node: t.Node, visit: (n: t.Node) => void): void {
	visit(node);
	for (const key of t.VISITOR_KEYS[node.type] || []) {
		const child = (node as any)[key];
		if (Array.isArray(child)) {
			for (const c of child)
				if (c && typeof c.type === "string") walkNode(c, visit);
		} else if (child && typeof child.type === "string") {
			walkNode(child, visit);
		}
	}
}

// === Replacement code builders ===

/** Parse a function declaration string and return its body statements. */
function parseBody(code: string): t.Statement[] {
	const ast = parse(code);
	const fn = ast.program.body[0];
	if (!t.isFunctionDeclaration(fn))
		throw Error("parseBody: expected FunctionDeclaration");
	return fn.body.body;
}

function buildOpenFile(r: LspRefs, params: string[]): t.Statement[] {
	const [file, text] = params;
	// prettier-ignore
	return parseBody(
		`async function _r(${file}, ${text}) {
  var _ext = ${r.pathMod}.extname(${file}).toLowerCase();
  var _ns = ${r.extMap}.get(_ext);
  if (!_ns || _ns.length === 0) return;
  var _uri = ${r.urlMod}.pathToFileURL(${r.pathMod}.resolve(${file})).href;
  for (var _i = 0; _i < _ns.length; _i++) {
    var _sv = ${r.serverMap}.get(_ns[_i]);
    if (!_sv) continue;
    if (_sv.state === "stopped") {
      try { await _sv.start(); } catch (_e) {
        ${r.errFn}(Error("Failed to start LSP server for file " + ${file} + ": " + _e.message));
        continue;
      }
    }
    var _os = ${r.trackMap}.get(_uri);
    if (_os instanceof Set && _os.has(_ns[_i])) {
      ${r.logFn}("LSP: File already open in " + _ns[_i] + ", skipping didOpen for " + ${file});
      continue;
    }
    var _lg = _sv.config.extensionToLanguage[_ext] || "plaintext";
    try {
      await _sv.sendNotification("textDocument/didOpen", {
        textDocument: { uri: _uri, languageId: _lg, version: 1, text: ${text} }
      });
      if (!${r.trackMap}.has(_uri)) ${r.trackMap}.set(_uri, new Set());
      ${r.trackMap}.get(_uri).add(_ns[_i]);
      ${r.logFn}("LSP: Sent didOpen for " + ${file} + " to " + _ns[_i] + " (languageId: " + _lg + ")");
    } catch (_e) {
      ${r.errFn}(Error("Failed to sync file open " + ${file} + " to " + _ns[_i] + ": " + _e.message));
    }
  }
}`,
	);
}

function buildChangeFile(r: LspRefs, params: string[]): t.Statement[] {
	const [file, text] = params;
	// prettier-ignore
	return parseBody(
		`async function _r(${file}, ${text}) {
  var _ext = ${r.pathMod}.extname(${file}).toLowerCase();
  var _ns = ${r.extMap}.get(_ext);
  if (!_ns || _ns.length === 0) return;
  var _uri = ${r.urlMod}.pathToFileURL(${r.pathMod}.resolve(${file})).href;
  var _os = ${r.trackMap}.get(_uri);
  for (var _i = 0; _i < _ns.length; _i++) {
    var _sv = ${r.serverMap}.get(_ns[_i]);
    if (!_sv) continue;
    if (_sv.state === "running" && _os instanceof Set && _os.has(_ns[_i])) {
      try {
        await _sv.sendNotification("textDocument/didChange", {
          textDocument: { uri: _uri, version: 1 },
          contentChanges: [{ text: ${text} }]
        });
        ${r.logFn}("LSP: Sent didChange for " + ${file} + " to " + _ns[_i]);
      } catch (_e) {
        ${r.errFn}(Error("Failed to sync file change " + ${file} + " to " + _ns[_i] + ": " + _e.message));
      }
    } else {
      if (_sv.state === "stopped") {
        try { await _sv.start(); } catch (_e) {
          ${r.errFn}(Error("Failed to start LSP server for file " + ${file} + ": " + _e.message));
          continue;
        }
      }
      var _lg = _sv.config.extensionToLanguage[_ext] || "plaintext";
      try {
        await _sv.sendNotification("textDocument/didOpen", {
          textDocument: { uri: _uri, languageId: _lg, version: 1, text: ${text} }
        });
        if (!${r.trackMap}.has(_uri)) ${r.trackMap}.set(_uri, new Set());
        ${r.trackMap}.get(_uri).add(_ns[_i]);
        ${r.logFn}("LSP: Sent didOpen for " + ${file} + " to " + _ns[_i] + " (languageId: " + _lg + ")");
      } catch (_e) {
        ${r.errFn}(Error("Failed to sync file open " + ${file} + " to " + _ns[_i] + ": " + _e.message));
      }
    }
  }
}`,
	);
}

function buildSaveFile(r: LspRefs, params: string[]): t.Statement[] {
	const [file] = params;
	// prettier-ignore
	return parseBody(
		`async function _r(${file}) {
  var _ext = ${r.pathMod}.extname(${file}).toLowerCase();
  var _ns = ${r.extMap}.get(_ext);
  if (!_ns || _ns.length === 0) return;
  var _uri = ${r.urlMod}.pathToFileURL(${r.pathMod}.resolve(${file})).href;
  for (var _i = 0; _i < _ns.length; _i++) {
    var _sv = ${r.serverMap}.get(_ns[_i]);
    if (!_sv || _sv.state !== "running") continue;
    try {
      await _sv.sendNotification("textDocument/didSave", {
        textDocument: { uri: _uri }
      });
      ${r.logFn}("LSP: Sent didSave for " + ${file} + " to " + _ns[_i]);
    } catch (_e) {
      ${r.errFn}(Error("Failed to sync file save " + ${file} + " to " + _ns[_i] + ": " + _e.message));
    }
  }
}`,
	);
}

function buildCloseFile(r: LspRefs, params: string[]): t.Statement[] {
	const [file] = params;
	// prettier-ignore
	return parseBody(
		`async function _r(${file}) {
  var _ext = ${r.pathMod}.extname(${file}).toLowerCase();
  var _ns = ${r.extMap}.get(_ext);
  if (!_ns || _ns.length === 0) return;
  var _uri = ${r.urlMod}.pathToFileURL(${r.pathMod}.resolve(${file})).href;
  for (var _i = 0; _i < _ns.length; _i++) {
    var _sv = ${r.serverMap}.get(_ns[_i]);
    if (!_sv || _sv.state !== "running") continue;
    try {
      await _sv.sendNotification("textDocument/didClose", {
        textDocument: { uri: _uri }
      });
      ${r.logFn}("LSP: Sent didClose for " + ${file} + " to " + _ns[_i]);
    } catch (_e) {
      ${r.errFn}(Error("Failed to sync file close " + ${file} + " to " + _ns[_i] + ": " + _e.message));
    }
  }
  ${r.trackMap}.delete(_uri);
}`,
	);
}

// === Mutation visitor ===

function createMutateVisitor(refs: LspRefs): traverse.Visitor {
	const builders = new Map<string, (params: string[]) => t.Statement[]>([
		[refs.openFile, (p) => buildOpenFile(refs, p)],
		[refs.changeFile, (p) => buildChangeFile(refs, p)],
		[refs.saveFile, (p) => buildSaveFile(refs, p)],
		[refs.closeFile, (p) => buildCloseFile(refs, p)],
	]);

	let replaced = 0;

	return {
		FunctionDeclaration(path) {
			if (!path.node.id) return;
			const builder = builders.get(path.node.id.name);
			if (!builder) return;

			// Only modify functions inside the LSP factory
			let parent: NodePath | null = path.parentPath;
			while (parent) {
				if (
					parent.isFunctionDeclaration() &&
					parent.node.id?.name === refs.factoryName
				)
					break;
				parent = parent.parentPath;
			}
			if (!parent) return;

			const params = path.node.params
				.filter((p): p is t.Identifier => t.isIdentifier(p))
				.map((p) => p.name);

			path.node.body.body = builder(params);
			replaced++;
		},
		Program: {
			exit() {
				if (replaced > 0) {
					console.log(
						`LSP multi-server: replaced ${replaced} lifecycle function(s)`,
					);
				}
			},
		},
	};
}

// === Verification ===

function verifyMultiServer(code: string, ast?: t.File): true | string {
	const verifyAst = getVerifyAst(code, ast);
	if (!verifyAst)
		return "Unable to parse AST for lsp-multi-server verification";

	// Re-discover to confirm the factory exists
	const refs = discoverRefs(verifyAst);
	if (!refs) return "LSP server manager factory not found";

	// Find the factory function and check lifecycle functions have for-loops
	let factoryBody: t.Statement[] | null = null;
	traverse.default(verifyAst, {
		FunctionDeclaration(path) {
			if (path.node.id?.name === refs.factoryName) {
				factoryBody = path.node.body.body;
				path.stop();
			}
		},
	});
	if (!factoryBody) return "Factory function body not found";

	const lifecycleFns = [
		{ name: refs.openFile, method: "textDocument/didOpen", label: "openFile" },
		{
			name: refs.changeFile,
			method: "textDocument/didChange",
			label: "changeFile",
		},
		{ name: refs.saveFile, method: "textDocument/didSave", label: "saveFile" },
		{
			name: refs.closeFile,
			method: "textDocument/didClose",
			label: "closeFile",
		},
	];

	for (const { name, method, label } of lifecycleFns) {
		const fn = (factoryBody as t.Statement[]).find(
			(s): s is t.FunctionDeclaration =>
				t.isFunctionDeclaration(s) && s.id?.name === name,
		);
		if (!fn) return `${label} function (${name}) not found in factory`;

		// Check for a ForStatement in the function body (multi-server iteration)
		let hasFor = false;
		let hasMethod = false;
		walkNode(fn, (node) => {
			if (t.isForStatement(node)) hasFor = true;
			if (t.isStringLiteral(node) && node.value === method) hasMethod = true;
		});

		if (!hasFor) return `${label} missing for-loop (multi-server iteration)`;
		if (!hasMethod) return `${label} missing "${method}" notification`;
	}

	// Verify getServerForFile still returns primary (I[0] pattern intact)
	const gsf = (factoryBody as t.Statement[]).find(
		(s): s is t.FunctionDeclaration =>
			t.isFunctionDeclaration(s) && s.id?.name === refs.getServerForFile,
	);
	if (!gsf) return "getServerForFile function not found";
	let hasIndexZero = false;
	walkNode(gsf, (node) => {
		if (
			t.isMemberExpression(node) &&
			t.isNumericLiteral(node.property, { value: 0 })
		)
			hasIndexZero = true;
	});
	if (!hasIndexZero)
		return "getServerForFile [0] primary access pattern missing";

	return true;
}

// === Patch export ===

export const lspMultiServer: Patch = {
	tag: "lsp-multi-server",

	astPasses: (ast) => {
		discoveredRefs = discoverRefs(ast);
		if (!discoveredRefs) {
			console.log("LSP multi-server: factory not found, skipping");
			return [];
		}

		return [
			{
				pass: "mutate",
				visitor: createMutateVisitor(discoveredRefs),
			},
		];
	},

	verify: verifyMultiServer,
};
