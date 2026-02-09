import traverse from "@babel/traverse";
import * as t from "@babel/types";
import { parse } from "../loader.js";
import type { Patch } from "../types.js";

/**
 * Modify Read tool to use bat for text files.
 *
 * Changes:
 * 1. Replace offset/limit with bat-style range parameter
 * 2. Text files are read via bat (better ranges, line numbers)
 * 3. Images/PDFs continue to work as before
 *
 * Range syntax (matches bat -r):
 * - "30:40" - lines 30 to 40
 * - "40:" - line 40 to end
 * - ":40" - start to line 40
 * - "-30:" - last 30 lines
 * - "50:+20" - line 50 plus 20 more
 * - "100::10" - line 100 with 10 lines context each side
 * - "30:40:2" - lines 30-40 with 2 lines context around the range
 */
// Coupling: identifies the Read tool via the same structural pattern as
// limits.ts. This patch replaces the prompt body, while limits modifies
// variable declarations. Both can coexist safely.

// Note: Code only supports png/jpg/jpeg/gif/webp (bN1 set) - upstream prompt is wrong about BMP/TIFF/HEIC
const NEW_READ_DESCRIPTION = `Read files from the local filesystem.

Usage:
- The file_path parameter must be an absolute path, not a relative path
- For text/code files, specify an optional range for partial reads
- You can read multiple files in parallel when needed
- If the user provides a screenshot path, use this tool to view it

Supported file types:
- Text/code files: Returns content with line numbers (uses bat internally)
- Images (PNG, JPG, GIF, WebP): Returns base64 image data with dimensions
- PDFs: Processed page by page with text and visual content

Binary files (audio, video, archives, executables, Office docs, fonts) cannot be read.

Range parameter (for text files only, uses bat syntax):
- \`30:40\` - lines 30 to 40
- \`40:\` - line 40 to end of file
- \`:40\` - start to line 40
- \`-30:\` - last 30 lines
- \`50:+20\` - line 50 plus 20 more lines
- \`100::10\` - line 100 with 10 lines of context each side
- \`30:40:2\` - lines 30-40 with 2 lines of context

Optional parameters:
- \`pages: "1-5"\` - For PDF files only. Required for large PDFs; max 20 pages per request.
- \`diff: true\` - Only show lines modified in git (added/removed/changed). Great for reviewing changes.
- \`show_whitespace: true\` - Reveal invisible characters (tabs→, spaces·, newlines␊). Use to debug indentation issues.

Examples:
- Read entire file: \`{ file_path: "/path/to/file.ts" }\`
- Read lines 100-200: \`{ file_path: "/path/to/file.ts", range: "100:200" }\`
- Read last 50 lines: \`{ file_path: "/path/to/file.ts", range: "-50:" }\`
- Read PDF pages 1-5: \`{ file_path: "/path/to/doc.pdf", pages: "1-5" }\`
- See git changes only: \`{ file_path: "/path/to/file.ts", diff: true }\`
- Debug whitespace: \`{ file_path: "/path/to/file.ts", show_whitespace: true }\``;

// These compatibility rewrites mutate any matching offset/limit nodes globally.
// Keep disabled by default to avoid collisions with unrelated tools/patches.
const ENABLE_GLOBAL_OFFSET_LIMIT_COMPAT_REWRITES = false;

export const readWithBat: Patch = {
	tag: "read-bat",

	// AST patches for structural changes (robust against minified names)
	ast: (ast) => {
		const patchText = (text: string): string => {
			let updated = text;

			updated = updated.replace(
				/Use offset and limit parameters to read specific portions of the file,/g,
				"Use the range parameter (bat syntax) to read specific portions of the file,",
			);
			updated = updated.replace(
				/Please use offset and limit parameters to read specific portions of the file,/g,
				"Please use the range parameter (bat syntax) to read specific portions of the file,",
			);
			updated = updated.replace(
				/or use the GrepTool to search for specific content/g,
				"or use rg/sg via Bash to search for specific content",
			);
			updated = updated.replace(
				/ tool to search for specific content/g,
				" tool with rg/sg to search for specific content",
			);

			return updated;
		};

		// 0. Replace remaining offset/limit guidance strings (2.1.12+)
		traverse.default(ast, {
			StringLiteral(path) {
				const updated = patchText(path.node.value);
				if (updated !== path.node.value) path.node.value = updated;
			},
			TemplateLiteral(path) {
				for (const quasi of path.node.quasis) {
					const rawUpdated = patchText(quasi.value.raw);
					if (rawUpdated !== quasi.value.raw) quasi.value.raw = rawUpdated;

					if (typeof quasi.value.cooked === "string") {
						const cookedUpdated = patchText(quasi.value.cooked);
						if (cookedUpdated !== quasi.value.cooked)
							quasi.value.cooked = cookedUpdated;
					}
				}
			},
		});

		// 0b. Patch Read tool schema (offset/limit -> range/diff/show_whitespace)
		traverse.default(ast, {
			CallExpression(path) {
				const callee = path.node.callee;
				if (!t.isMemberExpression(callee)) return;
				if (!t.isIdentifier(callee.property, { name: "strictObject" })) return;
				if (!t.isIdentifier(callee.object)) return;
				if (path.node.arguments.length < 1) return;

				const arg0 = path.node.arguments[0];
				if (!t.isObjectExpression(arg0)) return;

				const hasFilePath = arg0.properties.some(
					(p) =>
						t.isObjectProperty(p) &&
						t.isIdentifier(p.key, { name: "file_path" }),
				);
				if (!hasFilePath) return;

				// Match the Read schema by file_path description string.
				const filePathProp = arg0.properties.find(
					(p): p is t.ObjectProperty =>
						t.isObjectProperty(p) &&
						t.isIdentifier(p.key, { name: "file_path" }) &&
						t.isExpression(p.value) &&
						t.isCallExpression(p.value) &&
						t.isMemberExpression(p.value.callee) &&
						t.isIdentifier(p.value.callee.property, { name: "describe" }) &&
						p.value.arguments.length >= 1 &&
						t.isStringLiteral(p.value.arguments[0], {
							value: "The absolute path to the file to read",
						}),
				);
				if (!filePathProp) return;

				const hasRange = arg0.properties.some(
					(p) =>
						t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "range" }),
				);
				if (hasRange) return;

				const zodVarName = callee.object.name;
				const rangeDesc =
					"Line range using bat syntax: '30:40', '-30:', ':50', '100::10', '30:40:2'. Omit to read entire file.";
				const diffDesc =
					"Only show lines modified in git (added/removed/changed). Use to review changes in a file.";
				const wsDesc =
					"Reveal invisible characters: tabs (→), spaces (·), newlines (␊). Use to debug indentation issues.";

				const rangeExpr = (
					parse(
						`function _wrapper() { return ${zodVarName}.string().optional().describe(${JSON.stringify(
							rangeDesc,
						)}); }`,
					).program.body[0] as any
				).body.body[0].argument as t.Expression;
				const diffExpr = (
					parse(
						`function _wrapper() { return ${zodVarName}.boolean().optional().describe(${JSON.stringify(
							diffDesc,
						)}); }`,
					).program.body[0] as any
				).body.body[0].argument as t.Expression;
				const wsExpr = (
					parse(
						`function _wrapper() { return ${zodVarName}.boolean().optional().describe(${JSON.stringify(
							wsDesc,
						)}); }`,
					).program.body[0] as any
				).body.body[0].argument as t.Expression;

				const rangeProp = t.objectProperty(t.identifier("range"), rangeExpr);
				const diffProp = t.objectProperty(t.identifier("diff"), diffExpr);
				const wsProp = t.objectProperty(
					t.identifier("show_whitespace"),
					wsExpr,
				);

				const newProps: typeof arg0.properties = [];
				for (const prop of arg0.properties) {
					if (
						t.isObjectProperty(prop) &&
						t.isIdentifier(prop.key) &&
						(prop.key.name === "offset" || prop.key.name === "limit")
					) {
						continue;
					}

					newProps.push(prop);

					if (
						t.isObjectProperty(prop) &&
						t.isIdentifier(prop.key, { name: "file_path" })
					) {
						newProps.push(rangeProp, diffProp, wsProp);
					}
				}
				arg0.properties = newProps;
			},
		});

		// Track the range parameter variable name we create
		let rangeVarName: string | null = null;
		// Track the original read function identifier
		let originalReadFn: string | null = null;
		// Track the file path variable
		let _filePathVar: string | null = null;

		traverse.default(ast, {
			ObjectExpression(path) {
				// Find Read tool by name property
				const nameProp = path.node.properties.find(
					(p): p is t.ObjectProperty =>
						t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "name" }),
				);
				if (!nameProp) return;

				// Resolve the name value (could be string literal or variable reference)
				let nameVal: string | null = null;
				if (t.isStringLiteral(nameProp.value)) {
					nameVal = nameProp.value.value;
				} else if (t.isIdentifier(nameProp.value)) {
					const binding = path.scope.getBinding(nameProp.value.name);
					const init = binding?.path.node;
					if (t.isVariableDeclarator(init) && t.isStringLiteral(init.init)) {
						nameVal = init.init.value;
					}
				}
				if (nameVal !== "Read") return;

				// 1. Replace Read tool prompt/description strings (AST-only, avoids brittle string matching)
				const promptMethod = path.node.properties.find(
					(p): p is t.ObjectMethod =>
						t.isObjectMethod(p) && t.isIdentifier(p.key, { name: "prompt" }),
				);
				if (promptMethod) {
					promptMethod.body = t.blockStatement([
						t.returnStatement(t.stringLiteral(NEW_READ_DESCRIPTION)),
					]);
				}

				const descMethod = path.node.properties.find(
					(p): p is t.ObjectMethod =>
						t.isObjectMethod(p) &&
						t.isIdentifier(p.key, { name: "description" }),
				);
				if (descMethod) {
					descMethod.body = t.blockStatement([
						t.returnStatement(
							t.stringLiteral("Read files from the local filesystem."),
						),
					]);
				}

				// Keep Read examples aligned with range/pages semantics (avoid stale offset/limit examples).
				const inputExamplesProp = path.node.properties.find(
					(p): p is t.ObjectProperty =>
						t.isObjectProperty(p) &&
						((t.isIdentifier(p.key) && p.key.name === "input_examples") ||
							(t.isStringLiteral(p.key) && p.key.value === "input_examples")) &&
						t.isArrayExpression(p.value),
				);
				if (inputExamplesProp && t.isArrayExpression(inputExamplesProp.value)) {
					const newInputExamples = (
						parse(`
							function _wrapper() {
								return [
									{ file_path: "/Users/username/project/src/index.ts" },
									{ file_path: "/Users/username/project/README.md", range: "50:+100" },
									{ file_path: "/Users/username/project/design-doc.pdf", pages: "1-5" },
								];
							}
						`).program.body[0] as any
					).body.body[0].argument as t.ArrayExpression;
					inputExamplesProp.value = newInputExamples;
				}

				// Find the call method
				const callMethod = path.node.properties.find(
					(p): p is t.ObjectMethod =>
						t.isObjectMethod(p) && t.isIdentifier(p.key, { name: "call" }),
				);
				if (!callMethod) return;

				// Check if already patched (look for our bat args)
				const bodyStr = JSON.stringify(callMethod.body);
				if (bodyStr.includes("START_LINE")) return;

				// === 1. Modify call signature ===
				// Original: async call({ file_path: A, offset: Q = 1, limit: B = void 0 }, G)
				// New: async call({ file_path: A, range: R = void 0 }, G)
				const params = callMethod.params;
				if (params.length >= 1 && t.isObjectPattern(params[0])) {
					const objPattern = params[0];
					const newProps: (t.ObjectProperty | t.RestElement)[] = [];

					for (const prop of objPattern.properties) {
						if (t.isRestElement(prop)) {
							newProps.push(prop);
							continue;
						}
						if (!t.isObjectProperty(prop)) continue;

						const keyName = t.isIdentifier(prop.key) ? prop.key.name : null;

						if (keyName === "file_path") {
							newProps.push(prop);
							// Extract file_path variable name
							if (t.isAssignmentPattern(prop.value)) {
								_filePathVar = t.isIdentifier(prop.value.left)
									? prop.value.left.name
									: null;
							} else if (t.isIdentifier(prop.value)) {
								_filePathVar = prop.value.name;
							}
						} else if (keyName === "offset" || keyName === "limit") {
							// Skip - we're replacing with range
						} else {
							newProps.push(prop);
						}
					}

					// Add range parameter: range: R = void 0
					rangeVarName = "R";
					const rangeProp = t.objectProperty(
						t.identifier("range"),
						t.assignmentPattern(
							t.identifier(rangeVarName),
							t.unaryExpression("void", t.numericLiteral(0)),
						),
					);
					newProps.push(rangeProp);

					// Add diff parameter: diff: DIFF = void 0
					const diffProp = t.objectProperty(
						t.identifier("diff"),
						t.assignmentPattern(
							t.identifier("DIFF"),
							t.unaryExpression("void", t.numericLiteral(0)),
						),
					);
					newProps.push(diffProp);

					// Add show_whitespace parameter: show_whitespace: WSPC = void 0
					const wsProp = t.objectProperty(
						t.identifier("show_whitespace"),
						t.assignmentPattern(
							t.identifier("WSPC"),
							t.unaryExpression("void", t.numericLiteral(0)),
						),
					);
					newProps.push(wsProp);

					objPattern.properties = newProps;
				}

				// === 1b. Modify validateInput signature and range bypass ===
				// Original: async validateInput({ file_path: A, offset: Q, limit: B, pages: Y }, G)
				// New: async validateInput({ file_path: A, pages: Y, range: R, diff: DIFF }, G)
				const validateMethod = path.node.properties.find(
					(p): p is t.ObjectMethod =>
						t.isObjectMethod(p) &&
						t.isIdentifier(p.key, { name: "validateInput" }),
				);
				if (validateMethod) {
					const rangeId = t.identifier(rangeVarName || "R");
					const diffId = t.identifier("DIFF");
					const params = validateMethod.params;
					if (params.length >= 1 && t.isObjectPattern(params[0])) {
						const objPattern = params[0];
						let offsetVar: string | null = null;
						let limitVar: string | null = null;

						const newProps: (t.ObjectProperty | t.RestElement)[] = [];
						for (const prop of objPattern.properties) {
							if (t.isRestElement(prop)) {
								newProps.push(prop);
								continue;
							}
							if (!t.isObjectProperty(prop)) continue;

							const keyName = t.isIdentifier(prop.key)
								? prop.key.name
								: t.isStringLiteral(prop.key)
									? prop.key.value
									: null;
							if (keyName === "offset") {
								if (t.isIdentifier(prop.value)) offsetVar = prop.value.name;
								else if (t.isAssignmentPattern(prop.value)) {
									if (t.isIdentifier(prop.value.left))
										offsetVar = prop.value.left.name;
								}
								continue;
							}
							if (keyName === "limit") {
								if (t.isIdentifier(prop.value)) limitVar = prop.value.name;
								else if (t.isAssignmentPattern(prop.value)) {
									if (t.isIdentifier(prop.value.left))
										limitVar = prop.value.left.name;
								}
								continue;
							}
							// Preserve everything else (e.g. pages param, future upstream options)
							newProps.push(prop);
						}

						const hasKey = (name: string): boolean =>
							newProps.some(
								(p) =>
									t.isObjectProperty(p) &&
									((t.isIdentifier(p.key) && p.key.name === name) ||
										(t.isStringLiteral(p.key) && p.key.value === name)),
							);

						// Add range: R
						if (!hasKey("range"))
							newProps.push(t.objectProperty(t.identifier("range"), rangeId));
						// Add diff: DIFF (diff reads can also be small even for large files)
						if (!hasKey("diff"))
							newProps.push(t.objectProperty(t.identifier("diff"), diffId));
						objPattern.properties = newProps;

						// Update large-file guard to honor range/diff
						// Find: if (!eG1(Y) && !Q && !B) return ...
						const hasNegatedIdentifier = (node: any, name: string): boolean => {
							if (!node) return false;
							if (
								t.isUnaryExpression(node) &&
								node.operator === "!" &&
								t.isIdentifier(node.argument, { name })
							) {
								return true;
							}
							if (t.isLogicalExpression(node)) {
								return (
									hasNegatedIdentifier(node.left, name) ||
									hasNegatedIdentifier(node.right, name)
								);
							}
							return false;
						};

						// Find negated function call: !someFunc(arg)
						// Don't match by name since minified names change between versions
						const findNegatedFunctionCall = (
							node: any,
						): t.UnaryExpression | null => {
							if (!node) return null;
							if (
								t.isUnaryExpression(node) &&
								node.operator === "!" &&
								t.isCallExpression(node.argument) &&
								t.isIdentifier(node.argument.callee)
							) {
								return node;
							}
							if (t.isLogicalExpression(node)) {
								return (
									findNegatedFunctionCall(node.left) ||
									findNegatedFunctionCall(node.right)
								);
							}
							return null;
						};

						traverse.default(
							validateMethod.body,
							{
								IfStatement(ifPath) {
									const test = ifPath.node.test;

									// Must have both negated offset AND negated limit vars to be the right condition
									// This is the file size guard: if (!sizeCheck(w) && !K && !q)
									if (!offsetVar || !limitVar) return;
									if (!hasNegatedIdentifier(test, offsetVar)) return;
									if (!hasNegatedIdentifier(test, limitVar)) return;

									// Find the negated function call (the size check)
									const notSizeCheck = findNegatedFunctionCall(test);
									if (!notSizeCheck) return;

									// Replace: !sizeCheck(w) && !K && !q
									// With: !sizeCheck(w) && !R && !DIFF
									ifPath.node.test = t.logicalExpression(
										"&&",
										notSizeCheck,
										t.logicalExpression(
											"&&",
											t.unaryExpression("!", rangeId),
											t.unaryExpression("!", diffId),
										),
									);
									ifPath.stop();
								},
							},
							path.scope,
							path,
						);
					}
				}

				// === 2. Find and replace text reading logic ===
				// Look for: { content: X, lineCount: Y, totalLines: Z } = someFunc(path, offset, limit)
				traverse.default(
					callMethod.body,
					{
						VariableDeclarator(declPath) {
							const id = declPath.node.id;
							const init = declPath.node.init;

							// Must be ObjectPattern = CallExpression
							if (!t.isObjectPattern(id)) return;
							if (!t.isCallExpression(init)) return;

							// Check for content, lineCount, totalLines properties
							const hasContent = id.properties.some(
								(p) =>
									t.isObjectProperty(p) &&
									t.isIdentifier(p.key, { name: "content" }),
							);
							const hasLineCount = id.properties.some(
								(p) =>
									t.isObjectProperty(p) &&
									t.isIdentifier(p.key, { name: "lineCount" }),
							);
							const hasTotalLines = id.properties.some(
								(p) =>
									t.isObjectProperty(p) &&
									t.isIdentifier(p.key, { name: "totalLines" }),
							);

							if (!hasContent || !hasLineCount || !hasTotalLines) return;

							// Get original function and file path argument
							if (!t.isIdentifier(init.callee)) return;
							originalReadFn = init.callee.name;
							const fileArg = init.arguments[0];
							if (!t.isIdentifier(fileArg)) return;

							// Build bat reading async IIFE
							// (async function(filePath, range, diff, showWs, fallbackFn) { ... })(D, R, DIFF, WSPC, KtB)
							const batFn = t.functionExpression(
								null,
								[
									t.identifier("filePath"),
									t.identifier("range"),
									t.identifier("diff"),
									t.identifier("showWs"),
									t.identifier("fallbackFn"),
								],
								t.blockStatement([
									// var fs = await import("fs");
									t.variableDeclaration("var", [
										t.variableDeclarator(
											t.identifier("fs"),
											t.awaitExpression(
												t.callExpression(t.identifier("import"), [
													t.stringLiteral("fs"),
												]),
											),
										),
									]),
									// var stat = fs.statSync(filePath);
									t.variableDeclaration("var", [
										t.variableDeclarator(
											t.identifier("stat"),
											t.callExpression(
												t.memberExpression(
													t.identifier("fs"),
													t.identifier("statSync"),
												),
												[t.identifier("filePath")],
											),
										),
									]),
									// if (stat.isDirectory()) throw new Error("EISDIR: Cannot read a directory, use Bash with eza or fd to list directory contents: " + filePath);
									t.ifStatement(
										t.callExpression(
											t.memberExpression(
												t.identifier("stat"),
												t.identifier("isDirectory"),
											),
											[],
										),
										t.throwStatement(
											t.newExpression(t.identifier("Error"), [
												t.binaryExpression(
													"+",
													t.stringLiteral(
														"EISDIR: Cannot read a directory. Use Bash with eza or fd to list directory contents: ",
													),
													t.identifier("filePath"),
												),
											]),
										),
									),
									// Compute 1-based startLine for the returned content.
									// For negative ranges (e.g. -30:), compute an absolute startLine by counting
									// total lines once (streaming; doesn't load the full file into memory).
									...(
										parse(`function _wrapper() {
  if (stat.size === 0) {
    return { content: "", lineCount: 0, totalLines: 0, startLine: 1 };
  }

  var startLine = 1;
  var fileTotalLines = null;
  var normalizedRange = null;
  if (range !== void 0 && range !== null) {
    var rawRange = String(range).trim();
    // Be forgiving when callers include wrapper quotes around the range value.
    // This happens occasionally when tool-input rendering re-quotes scalar strings.
    while (rawRange.length >= 2) {
      var firstChar = rawRange[0];
      var lastChar = rawRange[rawRange.length - 1];
      var isDoubleQuoted = firstChar === '"' && lastChar === '"';
      var isSingleQuoted = firstChar === "'" && lastChar === "'";
      if (!isDoubleQuoted && !isSingleQuoted) break;
      rawRange = rawRange.slice(1, -1).trim();
    }
    if (rawRange.length > 0) {
      var numericRange = /^-?\\d+(?::(?:\\+?\\d+)?)?(?::\\d+)?$/;
      var fromStart = /^:\\d+(?::\\d+)?$/;
      if (!numericRange.test(rawRange) && !fromStart.test(rawRange)) {
        throw new Error(
          "Invalid range format. Use bat syntax like '30:40', ':40', '-30:', '50:+20', '100::10', or '30:40:2'."
        );
      }
      normalizedRange = rawRange;
    }
  }

  if (normalizedRange) {
    var r = normalizedRange;
    if (r.indexOf("::") !== -1) {
      var parts = r.split("::");
      var line = parseInt(parts[0], 10) || 1;
      var ctx = parseInt(parts[1], 10) || 0;
      startLine = Math.max(1, line - ctx);
    } else if (r[0] === ":") {
      startLine = 1;
    } else if (r[0] === "-") {
      // Negative start indices are relative to end-of-file. Compute total lines so we can
      // derive the absolute 1-based start line.
      var m = r.match(/^(-\\d+)(?::|$)/);
      if (m) {
        var neg = parseInt(m[1], 10);
        if (!isNaN(neg)) {
          if (fileTotalLines == null) {
            var fd = fs.openSync(filePath, "r");
            try {
              var buf = Buffer.allocUnsafe(65536);
              var bytesRead = 0;
              var newlines = 0;
              while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
                for (var i = 0; i < bytesRead; i++) if (buf[i] === 10) newlines++;
              }
              fileTotalLines = newlines + 1;
            } finally {
              fs.closeSync(fd);
            }
          }
          startLine = Math.max(1, fileTotalLines + neg + 1);
        }
      } else {
        startLine = 1;
      }
    } else {
      var colon = r.indexOf(":");
      var startStr = colon === -1 ? r : r.slice(0, colon);
      var parsed = parseInt(startStr, 10) || 1;
      startLine = Math.max(1, parsed);
    }
  }
}`).program.body[0] as any
									).body.body,
									// var cp = await import("child_process");
									t.variableDeclaration("var", [
										t.variableDeclarator(
											t.identifier("cp"),
											t.awaitExpression(
												t.callExpression(t.identifier("import"), [
													t.stringLiteral("child_process"),
												]),
											),
										),
									]),
									// var style = "plain";
									t.variableDeclaration("var", [
										t.variableDeclarator(
											t.identifier("style"),
											t.stringLiteral("plain"),
										),
									]),
									// var args = ["--style=" + style, "--color=never", "--paging=never"];
									t.variableDeclaration("var", [
										t.variableDeclarator(
											t.identifier("args"),
											t.arrayExpression([
												t.binaryExpression(
													"+",
													t.stringLiteral("--style="),
													t.identifier("style"),
												),
												t.stringLiteral("--color=never"),
												t.stringLiteral("--paging=never"),
											]),
										),
									]),
									// if (diff) args.push("-d");
									t.ifStatement(
										t.identifier("diff"),
										t.expressionStatement(
											t.callExpression(
												t.memberExpression(
													t.identifier("args"),
													t.identifier("push"),
												),
												[t.stringLiteral("-d")],
											),
										),
									),
									// if (showWs) args.push("-A");
									t.ifStatement(
										t.identifier("showWs"),
										t.expressionStatement(
											t.callExpression(
												t.memberExpression(
													t.identifier("args"),
													t.identifier("push"),
												),
												[t.stringLiteral("-A")],
											),
										),
									),
									// if (normalizedRange) args.push("-r", normalizedRange);
									t.ifStatement(
										t.identifier("normalizedRange"),
										t.expressionStatement(
											t.callExpression(
												t.memberExpression(
													t.identifier("args"),
													t.identifier("push"),
												),
												[
													t.stringLiteral("-r"),
													t.identifier("normalizedRange"),
												],
											),
										),
									),
									// args.push(filePath);
									t.expressionStatement(
										t.callExpression(
											t.memberExpression(
												t.identifier("args"),
												t.identifier("push"),
											),
											[t.identifier("filePath")],
										),
									),
									// try { ... } catch(e) { ... }
									t.tryStatement(
										t.blockStatement([
											// var output = cp.execFileSync("bat", args, { encoding: "utf8", maxBuffer: 10*1024*1024, timeout: 30000 });
											t.variableDeclaration("var", [
												t.variableDeclarator(
													t.identifier("output"),
													t.callExpression(
														t.memberExpression(
															t.identifier("cp"),
															t.identifier("execFileSync"),
														),
														[
															t.stringLiteral("bat"),
															t.identifier("args"),
															t.objectExpression([
																t.objectProperty(
																	t.identifier("encoding"),
																	t.stringLiteral("utf8"),
																),
																t.objectProperty(
																	t.identifier("maxBuffer"),
																	t.binaryExpression(
																		"*",
																		t.binaryExpression(
																			"*",
																			t.numericLiteral(10),
																			t.numericLiteral(1024),
																		),
																		t.numericLiteral(1024),
																	),
																),
																t.objectProperty(
																	t.identifier("timeout"),
																	t.numericLiteral(30000),
																),
															]),
														],
													),
												),
											]),
											// var lines = output.split("\n");
											t.variableDeclaration("var", [
												t.variableDeclarator(
													t.identifier("lines"),
													t.callExpression(
														t.memberExpression(
															t.identifier("output"),
															t.identifier("split"),
														),
														[t.stringLiteral("\n")],
													),
												),
											]),
											// var lineCount = lines.length;
											t.variableDeclaration("var", [
												t.variableDeclarator(
													t.identifier("lineCount"),
													t.memberExpression(
														t.identifier("lines"),
														t.identifier("length"),
													),
												),
											]),
											// var totalLines = fileTotalLines != null ? fileTotalLines : (normalizedRange ? Math.max(0, startLine + lineCount - 1) : lineCount);
											t.variableDeclaration("var", [
												t.variableDeclarator(
													t.identifier("totalLines"),
													t.conditionalExpression(
														t.binaryExpression(
															"!=",
															t.identifier("fileTotalLines"),
															t.nullLiteral(),
														),
														t.identifier("fileTotalLines"),
														t.conditionalExpression(
															t.identifier("normalizedRange"),
															t.callExpression(
																t.memberExpression(
																	t.identifier("Math"),
																	t.identifier("max"),
																),
																[
																	t.numericLiteral(0),
																	t.binaryExpression(
																		"-",
																		t.binaryExpression(
																			"+",
																			t.identifier("startLine"),
																			t.identifier("lineCount"),
																		),
																		t.numericLiteral(1),
																	),
																],
															),
															t.identifier("lineCount"),
														),
													),
												),
											]),
											// return { content: output, lineCount: lineCount, totalLines: totalLines, startLine: startLine };
											t.returnStatement(
												t.objectExpression([
													t.objectProperty(
														t.identifier("content"),
														t.identifier("output"),
													),
													t.objectProperty(
														t.identifier("lineCount"),
														t.identifier("lineCount"),
													),
													t.objectProperty(
														t.identifier("totalLines"),
														t.identifier("totalLines"),
													),
													t.objectProperty(
														t.identifier("startLine"),
														t.identifier("startLine"),
													),
												]),
											),
										]),
										t.catchClause(
											t.identifier("e"),
											t.blockStatement([
												// return { ...fallbackFn(filePath, 0, void 0), startLine: 1 };
												t.returnStatement(
													t.objectExpression([
														t.spreadElement(
															t.callExpression(t.identifier("fallbackFn"), [
																t.identifier("filePath"),
																t.numericLiteral(0),
																t.unaryExpression("void", t.numericLiteral(0)),
															]),
														),
														t.objectProperty(
															t.identifier("startLine"),
															t.numericLiteral(1),
														),
													]),
												),
											]),
										),
									),
								]),
							);

							// Mark function as async
							batFn.async = true;

							// Replace init with awaited IIFE call
							declPath.node.init = t.awaitExpression(
								t.callExpression(batFn, [
									fileArg,
									t.identifier(rangeVarName || "R"),
									t.identifier("DIFF"),
									t.identifier("WSPC"),
									t.identifier(originalReadFn),
								]),
							);

							// Ensure we also destructure startLine from the bat result
							const hasStartLine = id.properties.some(
								(p) =>
									t.isObjectProperty(p) &&
									t.isIdentifier(p.key, { name: "startLine" }),
							);
							if (!hasStartLine) {
								id.properties.push(
									t.objectProperty(
										t.identifier("startLine"),
										t.identifier("START_LINE"),
									),
								);
							}

							// Remove the offset calculation declarator if present
							// Original: let W = Q === 0 ? 0 : Q - 1, { content: K, ... } = KtB(...)
							// Both are in the SAME VariableDeclaration
							const varDeclPath = declPath.parentPath;
							if (varDeclPath && t.isVariableDeclaration(varDeclPath.node)) {
								const decls = varDeclPath.node.declarations;
								// Find and remove the offset calculation declarator
								const offsetIdx = decls.findIndex((d) => {
									// Look for: W = Q === 0 ? 0 : Q - 1
									if (!t.isConditionalExpression(d.init)) return false;
									const cond = d.init;
									return (
										t.isBinaryExpression(cond.test, { operator: "===" }) &&
										t.isNumericLiteral(cond.consequent, { value: 0 })
									);
								});
								if (offsetIdx >= 0) {
									decls.splice(offsetIdx, 1);
								}
							}

							declPath.stop();
						},
					},
					path.scope,
					path,
				);

				// === 3. Fix readFileState.set call ===
				// Change: Z.set(D, { content: K, timestamp: ..., offset: Q, limit: B })
				// To: Z.set(D, { content: K, timestamp: ..., range: R })
				traverse.default(
					callMethod.body,
					{
						CallExpression(callPath) {
							const callee = callPath.node.callee;
							if (!t.isMemberExpression(callee)) return;
							if (!t.isIdentifier(callee.property, { name: "set" })) return;

							// Check second argument is object with offset/limit
							const args = callPath.node.arguments;
							if (args.length < 2) return;
							const objArg = args[1];
							if (!t.isObjectExpression(objArg)) return;

							// Look for offset and limit properties
							const hasOffset = objArg.properties.some(
								(p) =>
									t.isObjectProperty(p) &&
									t.isIdentifier(p.key, { name: "offset" }),
							);
							const hasLimit = objArg.properties.some(
								(p) =>
									t.isObjectProperty(p) &&
									t.isIdentifier(p.key, { name: "limit" }),
							);

							if (!hasOffset || !hasLimit) return;

							// Remove offset and limit, add range
							objArg.properties = objArg.properties.filter(
								(p) =>
									!t.isObjectProperty(p) ||
									(!t.isIdentifier(p.key, { name: "offset" }) &&
										!t.isIdentifier(p.key, { name: "limit" })),
							);
							objArg.properties.push(
								t.objectProperty(
									t.identifier("range"),
									t.identifier(rangeVarName || "R"),
								),
							);
						},
					},
					path.scope,
					path,
				);

				// === 4. Fix startLine in result object ===
				// Change: startLine: Q (where Q was offset) to startLine: START_LINE
				traverse.default(
					callMethod.body,
					{
						ObjectProperty(propPath) {
							if (!t.isIdentifier(propPath.node.key, { name: "startLine" }))
								return;

							// Only change if value is an identifier (was bound to offset var)
							if (t.isIdentifier(propPath.node.value)) {
								// Check we're in a file: { ... } object (has numLines, totalLines siblings)
								const parent = propPath.parent;
								if (!t.isObjectExpression(parent)) return;

								const hasNumLines = parent.properties.some(
									(p) =>
										t.isObjectProperty(p) &&
										t.isIdentifier(p.key, { name: "numLines" }),
								);
								const hasTotalLines = parent.properties.some(
									(p) =>
										t.isObjectProperty(p) &&
										t.isIdentifier(p.key, { name: "totalLines" }),
								);

								if (hasNumLines && hasTotalLines) {
									propPath.node.value = t.identifier("START_LINE");
								}
							}
						},
					},
					path.scope,
					path,
				);

				path.stop();
			},
		});

		// === 5. Modify renderToolUseMessage to show range instead of offset/limit ===
		// Find: function X({ file_path: A, offset: Q, limit: B }, { verbose: G }) { ... }
		// Change to show range in the UI display
		traverse.default(ast, {
			FunctionDeclaration(path) {
				const params = path.node.params;
				if (params.length !== 2) return;

				// First param must be ObjectPattern with file_path, offset, limit
				const firstParam = params[0];
				if (!t.isObjectPattern(firstParam)) return;

				const hasFilePath = firstParam.properties.some(
					(p) =>
						t.isObjectProperty(p) &&
						t.isIdentifier(p.key, { name: "file_path" }),
				);
				const hasOffset = firstParam.properties.some(
					(p) =>
						t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "offset" }),
				);
				const hasLimit = firstParam.properties.some(
					(p) =>
						t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "limit" }),
				);

				if (!hasFilePath || !hasOffset || !hasLimit) return;

				// Second param must be ObjectPattern with verbose
				const secondParam = params[1];
				if (!t.isObjectPattern(secondParam)) return;

				const hasVerbose = secondParam.properties.some(
					(p) =>
						t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "verbose" }),
				);
				if (!hasVerbose) return;

				// Found the renderToolUseMessage function!
				// Extract variable names
				let filePathVar = "A";
				let verboseVar = "G";

				for (const prop of firstParam.properties) {
					if (
						t.isObjectProperty(prop) &&
						t.isIdentifier(prop.key, { name: "file_path" }) &&
						t.isIdentifier(prop.value)
					) {
						filePathVar = prop.value.name;
					}
				}

				for (const prop of secondParam.properties) {
					if (
						t.isObjectProperty(prop) &&
						t.isIdentifier(prop.key, { name: "verbose" }) &&
						t.isIdentifier(prop.value)
					) {
						verboseVar = prop.value.name;
					}
				}

				// Replace first param: remove offset/limit, add range/diff/show_whitespace
				const newFirstParam = t.objectPattern([
					t.objectProperty(
						t.identifier("file_path"),
						t.identifier(filePathVar),
					),
					t.objectProperty(t.identifier("range"), t.identifier("R")),
					t.objectProperty(t.identifier("diff"), t.identifier("DIFF")),
					t.objectProperty(
						t.identifier("show_whitespace"),
						t.identifier("WSPC"),
					),
				]);
				path.node.params[0] = newFirstParam;

				// Find createElement identifier, abbreviation function, check function, and component
				// by analyzing the function body
				let createElementId = "A3";
				let abbrFunc = "j6";
				let checkFunc = "C51";
				let filePathComp = "sk";
				let displayVar = "Z";

				traverse.default(
					path.node.body,
					{
						// Find: let Z = G ? A : j6(A)
						VariableDeclarator(declPath) {
							const init = declPath.node.init;
							if (!t.isConditionalExpression(init)) return;
							if (!t.isCallExpression(init.alternate)) return;
							if (!t.isIdentifier(init.alternate.callee)) return;
							if (t.isIdentifier(declPath.node.id)) {
								displayVar = declPath.node.id.name;
								abbrFunc = init.alternate.callee.name;
							}
						},
						// Find: if (C51(A)) return ""
						IfStatement(ifPath) {
							const test = ifPath.node.test;
							if (!t.isCallExpression(test)) return;
							if (!t.isIdentifier(test.callee)) return;
							const consequent = ifPath.node.consequent;
							if (!t.isReturnStatement(consequent)) return;
							if (!t.isStringLiteral(consequent.argument, { value: "" }))
								return;
							checkFunc = test.callee.name;
						},
						// Find: X.createElement(sk, { filePath: ... })
						CallExpression(callPath) {
							const callee = callPath.node.callee;
							if (!t.isMemberExpression(callee)) return;
							if (!t.isIdentifier(callee.property, { name: "createElement" }))
								return;
							if (!t.isIdentifier(callee.object)) return;

							const args = callPath.node.arguments;
							if (args.length >= 2 && t.isIdentifier(args[0])) {
								const objArg = args[1];
								if (
									t.isObjectExpression(objArg) &&
									objArg.properties.some(
										(p) =>
											t.isObjectProperty(p) &&
											t.isIdentifier(p.key, { name: "filePath" }),
									)
								) {
									createElementId = callee.object.name;
									filePathComp = args[0].name;
								}
							}
						},
					},
					path.scope,
					path,
				);

				// Build new function body with options display
				// Logic: build array of active options, join and display
				const newBody = t.blockStatement([
					// if (!A) return null;
					t.ifStatement(
						t.unaryExpression("!", t.identifier(filePathVar)),
						t.returnStatement(t.nullLiteral()),
					),
					// if (checkFunc(A)) return "";
					t.ifStatement(
						t.callExpression(t.identifier(checkFunc), [
							t.identifier(filePathVar),
						]),
						t.returnStatement(t.stringLiteral("")),
					),
					// let Z = G ? A : abbrFunc(A);
					t.variableDeclaration("let", [
						t.variableDeclarator(
							t.identifier(displayVar),
							t.conditionalExpression(
								t.identifier(verboseVar),
								t.identifier(filePathVar),
								t.callExpression(t.identifier(abbrFunc), [
									t.identifier(filePathVar),
								]),
							),
						),
					]),
					// var opts = [];
					t.variableDeclaration("var", [
						t.variableDeclarator(t.identifier("opts"), t.arrayExpression([])),
					]),
					// if (R) opts.push("range: " + R);
					t.ifStatement(
						t.identifier("R"),
						t.expressionStatement(
							t.callExpression(
								t.memberExpression(t.identifier("opts"), t.identifier("push")),
								[
									t.binaryExpression(
										"+",
										t.stringLiteral("range: "),
										t.identifier("R"),
									),
								],
							),
						),
					),
					// if (DIFF) opts.push("diff");
					t.ifStatement(
						t.identifier("DIFF"),
						t.expressionStatement(
							t.callExpression(
								t.memberExpression(t.identifier("opts"), t.identifier("push")),
								[t.stringLiteral("diff")],
							),
						),
					),
					// if (WSPC) opts.push("whitespace");
					t.ifStatement(
						t.identifier("WSPC"),
						t.expressionStatement(
							t.callExpression(
								t.memberExpression(t.identifier("opts"), t.identifier("push")),
								[t.stringLiteral("whitespace")],
							),
						),
					),
					// if (opts.length > 0) { return createElement(Fragment, ..., " · " + opts.join(", ")); }
					t.ifStatement(
						t.binaryExpression(
							">",
							t.memberExpression(t.identifier("opts"), t.identifier("length")),
							t.numericLiteral(0),
						),
						t.blockStatement([
							t.returnStatement(
								t.callExpression(
									t.memberExpression(
										t.identifier(createElementId),
										t.identifier("createElement"),
									),
									[
										t.memberExpression(
											t.identifier(createElementId),
											t.identifier("Fragment"),
										),
										t.nullLiteral(),
										t.callExpression(
											t.memberExpression(
												t.identifier(createElementId),
												t.identifier("createElement"),
											),
											[
												t.identifier(filePathComp),
												t.objectExpression([
													t.objectProperty(
														t.identifier("filePath"),
														t.identifier(filePathVar),
													),
												]),
												t.identifier(displayVar),
											],
										),
										t.binaryExpression(
											"+",
											t.stringLiteral(" · "),
											t.callExpression(
												t.memberExpression(
													t.identifier("opts"),
													t.identifier("join"),
												),
												[t.stringLiteral(", ")],
											),
										),
									],
								),
							),
						]),
					),
					// return createElement(sk, { filePath: A }, Z);
					t.returnStatement(
						t.callExpression(
							t.memberExpression(
								t.identifier(createElementId),
								t.identifier("createElement"),
							),
							[
								t.identifier(filePathComp),
								t.objectExpression([
									t.objectProperty(
										t.identifier("filePath"),
										t.identifier(filePathVar),
									),
								]),
								t.identifier(displayVar),
							],
						),
					),
				]);

				path.node.body = newBody;
				path.stop();
			},
		});

		// === 6/7. Legacy compatibility rewrites (disabled by default to avoid collisions) ===
		if (ENABLE_GLOBAL_OFFSET_LIMIT_COMPAT_REWRITES) {
			traverse.default(ast, {
				ObjectExpression(objPath) {
					const props = objPath.node.properties;

					const offsetProp = props.find(
						(p): p is t.ObjectProperty =>
							t.isObjectProperty(p) &&
							t.isIdentifier(p.key, { name: "offset" }),
					);
					const limitProp = props.find(
						(p): p is t.ObjectProperty =>
							t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "limit" }),
					);

					if (!offsetProp || !limitProp) return;

					const hasRange = props.some(
						(p) =>
							t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "range" }),
					);
					if (hasRange) return;

					const offsetVal = offsetProp.value;
					const limitVal = limitProp.value;
					if (!t.isExpression(offsetVal) || !t.isExpression(limitVal)) return;

					let rangeExpr: t.Expression;
					const isVoid = (node: t.Expression) =>
						t.isUnaryExpression(node) && node.operator === "void";

					if (isVoid(offsetVal) && isVoid(limitVal)) {
						rangeExpr = t.unaryExpression("void", t.numericLiteral(0));
					} else {
						rangeExpr = t.conditionalExpression(
							t.logicalExpression(
								"&&",
								t.cloneNode(offsetVal),
								t.cloneNode(limitVal),
							),
							t.binaryExpression(
								"+",
								t.binaryExpression(
									"+",
									t.cloneNode(offsetVal),
									t.stringLiteral(":"),
								),
								t.binaryExpression(
									"-",
									t.binaryExpression(
										"+",
										t.cloneNode(offsetVal),
										t.cloneNode(limitVal),
									),
									t.numericLiteral(1),
								),
							),
							t.conditionalExpression(
								t.cloneNode(offsetVal),
								t.binaryExpression(
									"+",
									t.cloneNode(offsetVal),
									t.stringLiteral(":"),
								),
								t.unaryExpression("void", t.numericLiteral(0)),
							),
						);
					}

					objPath.node.properties = props.filter(
						(p) =>
							!t.isObjectProperty(p) ||
							(!t.isIdentifier(p.key, { name: "offset" }) &&
								!t.isIdentifier(p.key, { name: "limit" })),
					);
					objPath.node.properties.push(
						t.objectProperty(t.identifier("range"), rangeExpr),
					);
				},
				VariableDeclarator(declPath) {
					const id = declPath.node.id;
					if (!t.isObjectPattern(id)) return;

					const props = id.properties;
					const offsetProp = props.find(
						(p): p is t.ObjectProperty =>
							t.isObjectProperty(p) &&
							t.isIdentifier(p.key, { name: "offset" }),
					);
					const limitProp = props.find(
						(p): p is t.ObjectProperty =>
							t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "limit" }),
					);

					if (!offsetProp || !limitProp) return;

					const hasRange = props.some(
						(p) =>
							t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "range" }),
					);
					if (hasRange) return;

					const offsetVar = t.isIdentifier(offsetProp.value)
						? offsetProp.value.name
						: null;
					const limitVar = t.isIdentifier(limitProp.value)
						? limitProp.value.name
						: null;
					if (!offsetVar || !limitVar) return;

					id.properties = props.filter(
						(p) =>
							!t.isObjectProperty(p) ||
							(!t.isIdentifier(p.key, { name: "offset" }) &&
								!t.isIdentifier(p.key, { name: "limit" })),
					);
					id.properties.push(
						t.objectProperty(t.identifier("range"), t.identifier("R")),
					);

					const funcParent = declPath.findParent((p) => p.isFunction());
					if (funcParent && t.isFunction(funcParent.node)) {
						const body = funcParent.node.body;
						if (t.isBlockStatement(body)) {
							const stmtParent = declPath.findParent((p) =>
								p.isVariableDeclaration(),
							);
							if (stmtParent) {
								const stmtIndex = body.body.indexOf(
									stmtParent.node as t.Statement,
								);
								if (stmtIndex >= 0) {
									const offsetDecl = t.variableDeclaration("var", [
										t.variableDeclarator(
											t.identifier(offsetVar),
											t.conditionalExpression(
												t.identifier("R"),
												t.logicalExpression(
													"||",
													t.callExpression(t.identifier("parseInt"), [
														t.memberExpression(
															t.callExpression(
																t.memberExpression(
																	t.identifier("R"),
																	t.identifier("split"),
																),
																[t.stringLiteral(":")],
															),
															t.numericLiteral(0),
															true,
														),
													]),
													t.unaryExpression("void", t.numericLiteral(0)),
												),
												t.unaryExpression("void", t.numericLiteral(0)),
											),
										),
									]);

									const limitDecl = t.variableDeclaration("var", [
										t.variableDeclarator(
											t.identifier(limitVar),
											t.conditionalExpression(
												t.identifier("R"),
												t.conditionalExpression(
													t.memberExpression(
														t.callExpression(
															t.memberExpression(
																t.identifier("R"),
																t.identifier("split"),
															),
															[t.stringLiteral(":")],
														),
														t.numericLiteral(1),
														true,
													),
													t.binaryExpression(
														"+",
														t.binaryExpression(
															"-",
															t.callExpression(t.identifier("parseInt"), [
																t.memberExpression(
																	t.callExpression(
																		t.memberExpression(
																			t.identifier("R"),
																			t.identifier("split"),
																		),
																		[t.stringLiteral(":")],
																	),
																	t.numericLiteral(1),
																	true,
																),
															]),
															t.callExpression(t.identifier("parseInt"), [
																t.memberExpression(
																	t.callExpression(
																		t.memberExpression(
																			t.identifier("R"),
																			t.identifier("split"),
																		),
																		[t.stringLiteral(":")],
																	),
																	t.numericLiteral(0),
																	true,
																),
															]),
														),
														t.numericLiteral(1),
													),
													t.unaryExpression("void", t.numericLiteral(0)),
												),
												t.unaryExpression("void", t.numericLiteral(0)),
											),
										),
									]);

									body.body.splice(stmtIndex + 1, 0, offsetDecl, limitDecl);
								}
							}
						}
					}
				},
			});

			traverse.default(ast, {
				LogicalExpression(path) {
					if (path.node.operator !== "&&") return;

					// Helper to check if node is `X.offset === void 0` or `X?.offset === void 0`
					const isPropertyVoidCheck = (
						node: t.Node,
						propName: string,
					): { obj: t.Expression; optional: boolean } | null => {
						if (!t.isBinaryExpression(node, { operator: "===" })) return null;
						const left = node.left;
						const right = node.right;

						// Check right is void 0
						if (!t.isUnaryExpression(right, { operator: "void" })) return null;

						// Check left is X.propName or X?.propName
						// Handle both MemberExpression and OptionalMemberExpression
						if (
							!t.isMemberExpression(left) &&
							!t.isOptionalMemberExpression(left)
						) {
							return null;
						}
						if (!t.isIdentifier(left.property, { name: propName })) return null;
						if (!t.isExpression(left.object)) return null;

						return { obj: left.object, optional: left.optional || false };
					};

					// Get object name if identifier
					const getObjName = (obj: t.Expression): string | null => {
						if (t.isIdentifier(obj)) return obj.name;
						return null;
					};

					// Check if right side is limit check
					const limitCheck = isPropertyVoidCheck(path.node.right, "limit");
					if (!limitCheck) return;

					const limitObjName = getObjName(limitCheck.obj);
					if (!limitObjName) return;

					// Search left side for matching offset check with same object
					const findOffsetCheck = (
						node: t.Node,
					): {
						node: t.BinaryExpression;
						parent: t.LogicalExpression | null;
					} | null => {
						const check = isPropertyVoidCheck(node, "offset");
						if (check && getObjName(check.obj) === limitObjName) {
							return { node: node as t.BinaryExpression, parent: null };
						}

						if (t.isLogicalExpression(node, { operator: "&&" })) {
							// Check right side of the && (where offset check usually is)
							const rightCheck = isPropertyVoidCheck(node.right, "offset");
							if (rightCheck && getObjName(rightCheck.obj) === limitObjName) {
								return {
									node: node.right as t.BinaryExpression,
									parent: node,
								};
							}
							// Recurse into left
							const leftResult = findOffsetCheck(node.left);
							if (leftResult) {
								// Update parent reference if found deeper
								if (!leftResult.parent) {
									leftResult.parent = node;
								}
								return leftResult;
							}
						}

						return null;
					};

					const offsetResult = findOffsetCheck(path.node.left);
					if (!offsetResult) return;

					// Build the replacement: X.range === void 0 (or X?.range)
					const rangeCheck = t.binaryExpression(
						"===",
						t.memberExpression(
							t.cloneNode(limitCheck.obj),
							t.identifier("range"),
							false,
							limitCheck.optional,
						),
						t.unaryExpression("void", t.numericLiteral(0)),
					);

					// Case 1: left side IS the offset check directly
					// Pattern: offset_check && limit_check → range_check
					if (path.node.left === offsetResult.node) {
						path.replaceWith(rangeCheck);
						return;
					}

					// Case 2: offset check is nested in left side
					// Pattern: (... && offset_check) && limit_check → (... && range_check)
					// We need to remove offset_check and replace limit_check with range_check

					// Helper to remove offset check from && chain and return modified expression
					const removeFromChain = (
						expr: t.Expression,
						toRemove: t.BinaryExpression,
					): t.Expression => {
						if (expr === toRemove) {
							// This shouldn't happen in Case 2, but handle it
							return rangeCheck;
						}
						if (!t.isLogicalExpression(expr, { operator: "&&" })) {
							return expr;
						}
						if (expr.right === toRemove) {
							// Right side is offset check, return left side
							return expr.left as t.Expression;
						}
						if (expr.left === toRemove) {
							// Left side is offset check, return right side
							return expr.right as t.Expression;
						}
						// Recurse into nested &&
						return t.logicalExpression(
							"&&",
							removeFromChain(expr.left as t.Expression, toRemove),
							expr.right as t.Expression,
						);
					};

					const newLeft = removeFromChain(
						path.node.left as t.Expression,
						offsetResult.node,
					);

					// Replace the whole expression with newLeft && rangeCheck
					path.replaceWith(t.logicalExpression("&&", newLeft, rangeCheck));
				},
			});
		}
	},

	verify: (code) => {
		// Check description was updated
		if (!code.includes("Line range using bat syntax")) {
			return "Missing range parameter description";
		}
		if (!code.includes("-30:")) {
			return "Missing negative range example in description";
		}
		if (!code.includes("30:40:2")) {
			return "Missing range-with-context example in description";
		}
		if (!code.includes("diff: true")) {
			return "Missing diff parameter description";
		}
		if (!code.includes("show_whitespace: true")) {
			return "Missing show_whitespace parameter description";
		}
		if (!code.includes('pages: "1-5"')) {
			return "Missing pages parameter documentation/example";
		}
		// Check parameters were added to schema (don't assume Zod var name)
		if (!code.match(/\brange:\s*\w+\.string\(\)/)) {
			return "Missing range parameter in schema";
		}
		if (!code.match(/\bdiff:\s*\w+\.boolean\(\)/)) {
			return "Missing diff parameter in schema";
		}
		if (!code.match(/\bshow_whitespace:\s*\w+\.boolean\(\)/)) {
			return "Missing show_whitespace parameter in schema";
		}
		// Check bat integration - look for our injected code
		if (!code.includes("execFileSync")) {
			return "Missing bat integration in text reading";
		}
		if (!code.includes("Invalid range format. Use bat syntax")) {
			return "Missing range validation for bat syntax";
		}
		if (
			!code.includes("while (rawRange.length >= 2)") ||
			!code.includes("rawRange.slice(1, -1).trim()")
		) {
			return "Missing wrapper-quote normalization for range values";
		}
		if (!code.includes('args.push("-r", normalizedRange)')) {
			return "Read command not using normalized range for bat";
		}
		if (code.includes('args.push("-r", range)')) {
			return "Read command still passes raw range directly to bat";
		}
		// Check diff flag is used
		if (!code.includes('args.push("-d")')) {
			return "Missing diff flag in bat command";
		}
		// Check show_whitespace flag is used
		if (!code.includes('args.push("-A")')) {
			return "Missing show_whitespace flag in bat command";
		}
		// Check directory detection
		if (!code.includes("isDirectory()")) {
			return "Missing directory check before bat read";
		}
		// Check call signature was updated
		if (!code.includes("range: R = void 0")) {
			return "Call signature not updated to use range";
		}
		if (!code.includes("diff: DIFF = void 0")) {
			return "Call signature not updated to use diff";
		}
		if (!code.includes("show_whitespace: WSPC = void 0")) {
			return "Call signature not updated to use show_whitespace";
		}
		// Check startLine is range-aware (used by F01() line numbering)
		if (!code.includes("startLine: START_LINE")) {
			return "Read result startLine not updated to use range";
		}
		// Check negative ranges compute absolute startLine (e.g. -30:)
		if (!code.includes("var fileTotalLines = null")) {
			return "Missing fileTotalLines tracking for negative ranges";
		}
		// Check offset/limit removed from Read schema (anchor on file_path describe text)
		if (
			code.match(/The absolute path to the file to read[\s\S]{0,800}\boffset:/)
		) {
			return "Old offset parameter still in Read schema";
		}
		if (
			code.match(/The absolute path to the file to read[\s\S]{0,800}\blimit:/)
		) {
			return "Old limit parameter still in Read schema";
		}
		if (code.includes("offset and limit parameters")) {
			return "Old offset/limit guidance still present";
		}
		// Check Read input_examples were migrated away from offset/limit
		if (
			!code.includes('/Users/username/project/design-doc.pdf", pages: "1-5"')
		) {
			return "Read input_examples missing PDF pages example";
		}
		if (
			!code.includes('/Users/username/project/README.md", range: "50:+100"')
		) {
			return "Read input_examples missing range example";
		}
		if (
			code.includes(
				'{ file_path: "/Users/username/project/README.md", limit: 100, offset: 50 }',
			)
		) {
			return "Legacy Read input_examples still use offset/limit";
		}
		// Check validateInput uses range instead of offset/limit
		if (code.match(/validateInput\(\{[^}]*file_path:[^}]*offset:/)) {
			return "validateInput still destructures offset (range bypass missing)";
		}
		// 2.1.30+ adds PDF pages support; validateInput must still destructure pages
		// (otherwise referencing the pages variable throws ReferenceError: <var> is not defined)
		if (
			code.includes("Use the pages parameter to read specific page ranges") &&
			!code.match(/validateInput\(\{[^}]*file_path:[^}]*pages:/)
		) {
			return "validateInput missing pages parameter (would crash)";
		}
		// Check renderToolUseMessage shows options
		if (!code.includes('opts.push("diff")')) {
			return "renderToolUseMessage not showing diff option";
		}
		if (!code.includes('opts.push("whitespace")')) {
			return "renderToolUseMessage not showing whitespace option";
		}
		return true;
	},
};
