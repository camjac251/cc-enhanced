import * as t from "@babel/types";
import { type NodePath, traverse, type Visitor } from "../babel.js";
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
 *
 * Filename routing: helper functions (_lspByName / _lspGlobRe) are injected into
 * the factory so getServerForFile and the lifecycle functions fall back to
 * matching a server by exact basename (`filenames`) or glob (`filenamePatterns`)
 * when the file extension yields no server, e.g. `Dockerfile` / `Dockerfile.dev`.
 * The manifest schema fields those read are added by the lsp-filename-schema patch.
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

	traverse(ast, {
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
			const openFile = propMap.get("openFile");
			const changeFile = propMap.get("changeFile");
			const saveFile = propMap.get("saveFile");
			const closeFile = propMap.get("closeFile");
			const shutdown = propMap.get("shutdown");
			const getServerForFile = propMap.get("getServerForFile");
			if (
				!openFile ||
				!changeFile ||
				!saveFile ||
				!closeFile ||
				!shutdown ||
				!getServerForFile
			)
				return;

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
				openFile,
				changeFile,
				saveFile,
				closeFile,
				shutdown,
				getServerForFile,
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
  if (!_ns || _ns.length === 0) _ns = _lspByName(${file});
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
    var _lg = _lspLang(_sv, ${file}, _ext);
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
  if (!_ns || _ns.length === 0) _ns = _lspByName(${file});
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
      var _lg = _lspLang(_sv, ${file}, _ext);
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
  if (!_ns || _ns.length === 0) _ns = _lspByName(${file});
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
  if (!_ns || _ns.length === 0) _ns = _lspByName(${file});
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

function buildGetServerForFile(r: LspRefs, params: string[]): t.Statement[] {
	const [file] = params;
	// Extension lookup first (primary [0] preserved for sendRequest/navigation),
	// then fall back to filename/pattern routing via the injected _lspByName helper.
	// prettier-ignore
	return parseBody(
		`function _r(${file}) {
  var _ext = ${r.pathMod}.extname(${file}).toLowerCase();
  var _ns = ${r.extMap}.get(_ext);
  if (!_ns || _ns.length === 0) _ns = _lspByName(${file});
  if (!_ns || _ns.length === 0) return;
  var _h = _ns[0];
  if (!_h) return;
  return ${r.serverMap}.get(_h);
}`,
	);
}

/**
 * Filename-routing helpers injected once into the LSP factory body. They let a
 * server match by exact basename (`filenames`) or glob (`filenamePatterns`) when
 * the file extension yields no server, e.g. `Dockerfile` / `Dockerfile.dev`.
 * `_lspByName` returns an array of server names (matching the extMap value shape)
 * so the lifecycle/getServerForFile callers can treat it identically.
 */
function buildFilenameHelpers(r: LspRefs): t.Statement[] {
	// prettier-ignore
	return parseBody(
		`function _wrap() {
  function _lspEsc(_c) {
    return "\\\\^$.|?*+()[]{}".indexOf(_c) >= 0 ? "\\\\" + _c : _c;
  }
  function _lspGlobRe(_p) {
    var _o = "";
    for (var _i = 0; _i < _p.length; _i++) {
      var _c = _p.charAt(_i);
      _o += _c === "*" ? ".*" : _c === "?" ? "." : _lspEsc(_c);
    }
    return new RegExp("^" + _o + "$");
  }
  function _lspBase(_file) {
    return String(_file).split("/").pop().split("\\\\").pop();
  }
  function _lspFileLang(_cfg, _base) {
    if (_cfg.filenames && _cfg.filenames[_base]) return _cfg.filenames[_base];
    var _pats = _cfg.filenamePatterns;
    if (_pats) {
      for (var _p in _pats) {
        if (_lspGlobRe(_p).test(_base)) return _pats[_p];
      }
    }
  }
  function _lspLang(_sv, _file, _ext) {
    var _cfg = _sv && _sv.config;
    if (!_cfg) return "plaintext";
    if (_cfg.extensionToLanguage && _cfg.extensionToLanguage[_ext]) return _cfg.extensionToLanguage[_ext];
    return _lspFileLang(_cfg, _lspBase(_file)) || "plaintext";
  }
  function _lspByName(_file) {
    var _b = _lspBase(_file);
    var _out = [];
    for (var _ent of ${r.serverMap}) {
      var _nm = _ent[0], _sv = _ent[1];
      var _cfg = _sv && _sv.config;
      if (!_cfg) continue;
      if (_lspFileLang(_cfg, _b)) _out.push(_nm);
    }
    return _out.length ? _out : void 0;
  }
}`,
	);
}

// === Mutation visitor ===

function createMutateVisitor(refs: LspRefs): Visitor {
	const builders = new Map<string, (params: string[]) => t.Statement[]>([
		[refs.getServerForFile, (p) => buildGetServerForFile(refs, p)],
		[refs.openFile, (p) => buildOpenFile(refs, p)],
		[refs.changeFile, (p) => buildChangeFile(refs, p)],
		[refs.saveFile, (p) => buildSaveFile(refs, p)],
		[refs.closeFile, (p) => buildCloseFile(refs, p)],
	]);

	let replaced = 0;

	return {
		FunctionDeclaration(path) {
			if (!path.node.id) return;

			// The factory itself: inject the filename-routing helpers once at the
			// top of its body so getServerForFile and the lifecycle functions can
			// reference _lspByName. Descent then continues into the rewritten
			// lifecycle functions below.
			if (path.node.id.name === refs.factoryName) {
				const body = path.node.body.body;
				const alreadyInjected = body.some(
					(s) => t.isFunctionDeclaration(s) && s.id?.name === "_lspByName",
				);
				if (!alreadyInjected) {
					body.unshift(...buildFilenameHelpers(refs));
				}
				return;
			}

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
						`LSP multi-server: rewrote ${replaced} manager function(s)`,
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
	traverse(verifyAst, {
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

		// Stronger structural check: find a ForStatement whose body contains a
		// sendNotification CallExpression carrying THIS lifecycle's method
		// string as one of its arguments. The previous check accepted any
		// ForStatement plus any matching string anywhere in the function, so
		// a refactor that broke the for-loop / notification coupling (or
		// moved the method string into a comment) would silently pass.
		let forWithMatchingNotification = false;
		walkNode(fn, (node) => {
			if (!t.isForStatement(node)) return;
			let matched = false;
			walkNode(node.body, (inner) => {
				if (matched) return;
				if (!t.isCallExpression(inner)) return;
				const callee = inner.callee;
				const isSendNotification =
					(t.isMemberExpression(callee) &&
						((t.isIdentifier(callee.property) &&
							callee.property.name === "sendNotification") ||
							(t.isStringLiteral(callee.property) &&
								callee.property.value === "sendNotification"))) ||
					t.isIdentifier(callee, { name: "sendNotification" });
				if (!isSendNotification) return;
				const carriesMethod = inner.arguments.some((arg) =>
					t.isStringLiteral(arg, { value: method }),
				);
				if (carriesMethod) matched = true;
			});
			if (matched) forWithMatchingNotification = true;
		});

		if (!forWithMatchingNotification) {
			return `${label} missing for-loop with sendNotification("${method}") inside its body`;
		}
	}

	// For openFile and changeFile, the per-URI tracking map (Map<uri, Set<string>>)
	// must accumulate. Assert that the function body either constructs a
	// `new Set()` for a fresh URI or calls `.add(...)` on an existing tracker.
	// The previous verifier never inspected this and would accept the
	// upstream pre-patch Map<uri, string> shape.
	for (const { name, label } of [
		{ name: refs.openFile, label: "openFile" },
		{ name: refs.changeFile, label: "changeFile" },
	]) {
		const fn = (factoryBody as t.Statement[]).find(
			(s): s is t.FunctionDeclaration =>
				t.isFunctionDeclaration(s) && s.id?.name === name,
		);
		if (!fn) continue;
		let hasSetAddOrConstruction = false;
		walkNode(fn, (node) => {
			if (hasSetAddOrConstruction) return;
			if (
				t.isNewExpression(node) &&
				t.isIdentifier(node.callee, { name: "Set" })
			) {
				hasSetAddOrConstruction = true;
				return;
			}
			if (!t.isCallExpression(node)) return;
			const callee = node.callee;
			if (!t.isMemberExpression(callee)) return;
			const propName =
				(t.isIdentifier(callee.property) && callee.property.name) ||
				(t.isStringLiteral(callee.property) && callee.property.value) ||
				null;
			if (propName === "add") hasSetAddOrConstruction = true;
		});
		if (!hasSetAddOrConstruction) {
			return `${label} does not look like it tracks tracked URIs as a Set (no .add() or new Set() observed)`;
		}
	}

	// closeFile must untrack the URI from the per-URI tracking map so a later
	// reopen is not skipped as "already open". Require a `.delete(...)` call on
	// the discovered tracking map inside closeFile.
	{
		const closeFn = (factoryBody as t.Statement[]).find(
			(s): s is t.FunctionDeclaration =>
				t.isFunctionDeclaration(s) && s.id?.name === refs.closeFile,
		);
		if (closeFn) {
			let hasTrackMapDelete = false;
			walkNode(closeFn, (node) => {
				if (hasTrackMapDelete) return;
				if (!t.isCallExpression(node)) return;
				const callee = node.callee;
				if (!t.isMemberExpression(callee)) return;
				const propName =
					(t.isIdentifier(callee.property) && callee.property.name) ||
					(t.isStringLiteral(callee.property) && callee.property.value) ||
					null;
				if (propName !== "delete") return;
				if (t.isIdentifier(callee.object, { name: refs.trackMap })) {
					hasTrackMapDelete = true;
				}
			});
			if (!hasTrackMapDelete) {
				return "closeFile does not delete the closed URI from the tracking map";
			}
		}
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

	// Filename routing: the factory must define _lspByName, and both the
	// navigation path (getServerForFile) and the diagnostics path (openFile)
	// must fall back to it so extensionless files (Dockerfile) and glob
	// patterns (Dockerfile.*) resolve to a server.
	const hasByNameDecl = (factoryBody as t.Statement[]).some(
		(s): s is t.FunctionDeclaration =>
			t.isFunctionDeclaration(s) && s.id?.name === "_lspByName",
	);
	if (!hasByNameDecl)
		return "filename-routing helper (_lspByName) not injected into LSP factory";

	const hasLangDecl = (factoryBody as t.Statement[]).some(
		(s): s is t.FunctionDeclaration =>
			t.isFunctionDeclaration(s) && s.id?.name === "_lspLang",
	);
	if (!hasLangDecl)
		return "filename language helper (_lspLang) not injected into LSP factory";

	const referencesIdentifier = (
		fn: t.Node | undefined,
		identifier: string,
	): boolean => {
		if (!fn) return false;
		let found = false;
		walkNode(fn, (node) => {
			if (t.isIdentifier(node, { name: identifier })) found = true;
		});
		return found;
	};

	const factoryFn = (name: string): t.FunctionDeclaration | undefined =>
		(factoryBody as t.Statement[]).find(
			(s): s is t.FunctionDeclaration =>
				t.isFunctionDeclaration(s) && s.id?.name === name,
		);

	for (const { fn, label } of [
		{ fn: gsf, label: "getServerForFile" },
		{ fn: factoryFn(refs.openFile), label: "openFile" },
		{ fn: factoryFn(refs.changeFile), label: "changeFile" },
		{ fn: factoryFn(refs.saveFile), label: "saveFile" },
		{ fn: factoryFn(refs.closeFile), label: "closeFile" },
	]) {
		if (!referencesIdentifier(fn, "_lspByName")) {
			return `${label} does not fall back to filename routing (_lspByName)`;
		}
	}

	for (const { fn, label } of [
		{ fn: factoryFn(refs.openFile), label: "openFile" },
		{ fn: factoryFn(refs.changeFile), label: "changeFile" },
	]) {
		if (!referencesIdentifier(fn, "_lspLang")) {
			return `${label} does not derive didOpen languageId from filename routing (_lspLang)`;
		}
	}

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
