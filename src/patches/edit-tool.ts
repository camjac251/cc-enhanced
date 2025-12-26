import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import { parse, print } from "../loader.js";
import type { PatchContext } from "../types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Patch the Ly2 preprocessing function that strips extended fields before they reach the tool.
 * The switch case for fD.name only returns { replace_all, file_path, old_string, new_string }
 * which loses line_number, start_line, end_line, diff, edits.
 */
function patchPreprocessingSwitch(ast: any, editToolVarName: string | null) {
	if (!editToolVarName) return;

	traverse.default(ast, {
		SwitchCase(path: any) {
			const test = path.node.test;
			if (!test) return;

			// Check if this is case TOOLVAR.name:
			if (!t.isMemberExpression(test)) return;
			if (!t.isIdentifier(test.object) || test.object.name !== editToolVarName)
				return;
			if (!t.isIdentifier(test.property) || test.property.name !== "name")
				return;

			const consequent = path.node.consequent;
			if (!consequent || consequent.length === 0) return;

			const blockStmt = consequent.find((n: any) => t.isBlockStatement(n));
			if (!blockStmt) return;

			// Find the variable declaration: let X = schema.parse(...), { destructure } = ...
			// Match by structure, not by variable name (names change between minified builds)
			for (let i = 0; i < blockStmt.body.length; i++) {
				const stmt = blockStmt.body[i];
				if (!t.isVariableDeclaration(stmt)) continue;
				if (stmt.declarations.length < 2) continue;

				const firstDecl = stmt.declarations[0];
				const secondDecl = stmt.declarations[1];

				// First decl must be an identifier (any name)
				if (!t.isIdentifier(firstDecl.id)) continue;
				// Second decl must be an object pattern (destructuring)
				if (!t.isObjectPattern(secondDecl.id)) continue;

				// Capture the actual variable name used
				const inputVarName = firstDecl.id.name;

				// Split into two statements
				const stmt1 = t.variableDeclaration(stmt.kind, [firstDecl]);
				const stmt2 = t.variableDeclaration(stmt.kind, [secondDecl]);

				// Create the early return check using the captured variable name
				const extendedFieldCheck = (
					parse(`
                    function _wrapper() {
                        if (${inputVarName}.line_number !== undefined || ${inputVarName}.start_line !== undefined ||
                            ${inputVarName}.end_line !== undefined || ${inputVarName}.diff !== undefined ||
                            (Array.isArray(${inputVarName}.edits) && ${inputVarName}.edits.length > 0)) {
                            return ${inputVarName};
                        }
                    }
                `).program.body[0] as any
				).body.body;

				blockStmt.body.splice(i, 1, stmt1, ...extendedFieldCheck, stmt2);
				break;
			}

			path.stop();
		},
	});
}

// Patch the approval dialog to show proper previews for extended edit modes
function patchApprovalDialog(ast: any, fsVarName: string) {
	traverse.default(ast, {
		FunctionDeclaration(path: any) {
			// Find tx2 function - it has "Edit file" as title and calls fD.inputSchema.parse
			const body = path.node.body;
			if (!t.isBlockStatement(body)) return;

			// Look for the characteristic pattern: title: "Edit file"
			let hasEditFileTitle = false;
			let hasInputSchemaParse = false;

			traverse.default(t.file(t.program([path.node])), {
				StringLiteral(innerPath: any) {
					if (innerPath.node.value === "Edit file") {
						hasEditFileTitle = true;
					}
				},
				MemberExpression(innerPath: any) {
					if (
						t.isIdentifier(innerPath.node.property) &&
						innerPath.node.property.name === "inputSchema"
					) {
						hasInputSchemaParse = true;
					}
				},
			});

			if (!hasEditFileTitle || !hasInputSchemaParse) return;

			// Found the function! Inject logic to generate proper old_string/new_string for extended modes

			// Dynamic variable detection
			let inputVarName = "B"; // Fallback
			let oldStringVarName = "Z"; // Fallback
			let newStringVarName = "I"; // Fallback
			let insertionIndex = -1;

			// Find where variables are destructured: { file_path: G, old_string: Z, new_string: Y, replace_all: J } = B;
			for (let i = 0; i < body.body.length; i++) {
				const stmt = body.body[i];
				if (t.isVariableDeclaration(stmt)) {
					for (const decl of stmt.declarations) {
						if (t.isObjectPattern(decl.id) && t.isIdentifier(decl.init)) {
							// Check properties
							const props = decl.id.properties;
							const hasFilePath = props.some(
								(p: any) =>
									t.isObjectProperty(p) &&
									t.isIdentifier(p.key) &&
									p.key.name === "file_path",
							);
							const hasOldString = props.some(
								(p: any) =>
									t.isObjectProperty(p) &&
									t.isIdentifier(p.key) &&
									p.key.name === "old_string",
							);
							const hasNewString = props.some(
								(p: any) =>
									t.isObjectProperty(p) &&
									t.isIdentifier(p.key) &&
									p.key.name === "new_string",
							);

							if (hasFilePath && hasOldString && hasNewString) {
								inputVarName = decl.init.name;

								const oldStringProp = props.find(
									(p: any) =>
										t.isObjectProperty(p) &&
										t.isIdentifier(p.key) &&
										p.key.name === "old_string",
								) as t.ObjectProperty;
								if (oldStringProp && t.isIdentifier(oldStringProp.value)) {
									oldStringVarName = oldStringProp.value.name;
								}

								const newStringProp = props.find(
									(p: any) =>
										t.isObjectProperty(p) &&
										t.isIdentifier(p.key) &&
										p.key.name === "new_string",
								) as t.ObjectProperty;
								if (newStringProp && t.isIdentifier(newStringProp.value)) {
									newStringVarName = newStringProp.value.name;
								}

								insertionIndex = i + 1;
								break;
							}
						}
					}
				}
				if (insertionIndex !== -1) break;
			}

			if (insertionIndex === -1) return;

			// Helper to replace identifiers in the patch code
			const patchCodeAst = parse(`
                function _wrapper() {
                    // Extended edit preview - generate proper old_string/new_string with context
                    if (INPUT.line_number !== undefined || INPUT.start_line !== undefined || INPUT.diff !== undefined || (Array.isArray(INPUT.edits) && INPUT.edits.length > 0)) {
                        try {
                            const _filePath = INPUT.file_path;
                            const _fs = FS_VAR;
                            const _fileExists = _fs.existsSync(_filePath);
                            const _content = _fileExists ? _fs.readFileSync(_filePath, "utf-8") : "";
                            const _lines = _content.split("\\n");
                            const _contextLines = 3;

                            if (INPUT.line_number !== undefined) {
                                // Line insert - show context around insertion point
                                const _lineNum = Math.max(1, Math.min(parseInt(INPUT.line_number) || 1, _lines.length + 1));
                                const _insertIdx = INPUT.line_position === "after" ? _lineNum : _lineNum - 1;
                                const _startCtx = Math.max(0, _insertIdx - _contextLines);
                                const _endCtx = Math.min(_lines.length, _insertIdx + _contextLines);

                                const _beforeLines = _lines.slice(_startCtx, _insertIdx);
                                const _afterLines = _lines.slice(_insertIdx, _endCtx);

                                OLD_VAR = _beforeLines.concat(_afterLines).join("\\n");
                                NEW_VAR = _beforeLines.concat((INPUT.new_string || "").split("\\n")).concat(_afterLines).join("\\n");
                            } else if (INPUT.start_line !== undefined) {
                                // Range replace - show the lines being replaced vs new content
                                const _startLine = Math.max(1, parseInt(INPUT.start_line) || 1);
                                const _endLine = Math.max(_startLine, parseInt(INPUT.end_line) || _startLine);
                                const _startIdx = _startLine - 1;
                                const _endIdx = Math.min(_endLine, _lines.length);
                                const _startCtx = Math.max(0, _startIdx - _contextLines);
                                const _endCtxIdx = Math.min(_lines.length, _endIdx + _contextLines);

                                const _beforeCtx = _lines.slice(_startCtx, _startIdx);
                                const _replacedLines = _lines.slice(_startIdx, _endIdx);
                                const _afterCtx = _lines.slice(_endIdx, _endCtxIdx);

                                OLD_VAR = _beforeCtx.concat(_replacedLines).concat(_afterCtx).join("\\n");
                                NEW_VAR = _beforeCtx.concat((INPUT.new_string || "").split("\\n")).concat(_afterCtx).join("\\n");
                            } else if (INPUT.diff !== undefined) {
                                // Diff mode - apply the diff to show before/after
                                const _diffResult = _claudeEditApplyDiff(_content, { diff: INPUT.diff });
                                if (!_diffResult.error) {
                                    OLD_VAR = _content;
                                    NEW_VAR = _diffResult.content;
                                } else {
                                    // Fallback: show raw diff
                                    OLD_VAR = "";
                                    NEW_VAR = INPUT.diff || "";
                                }
                            } else if (Array.isArray(INPUT.edits) && INPUT.edits.length > 0) {
                                // Batch edits - apply all edits and show before/after
                                const _normalizedEdits = _claudeEditNormalizeEdits(INPUT);
                                if (!_normalizedEdits.error) {
                                    const _batchResult = _claudeApplyExtendedFileEdits(_content, _normalizedEdits.edits);
                                    if (!_batchResult.error) {
                                        OLD_VAR = _content;
                                        NEW_VAR = _batchResult.content;
                                    }
                                }
                            }
                        } catch (_e) {
                            // Fallback to simple display
                            OLD_VAR = "";
                            NEW_VAR = INPUT.new_string || INPUT.diff || "";
                        }
                    }
                }
            `);

			traverse.default(patchCodeAst, {
				Identifier(p: any) {
					if (p.node.name === "INPUT") p.node.name = inputVarName;
					else if (p.node.name === "OLD_VAR") p.node.name = oldStringVarName;
					else if (p.node.name === "NEW_VAR") p.node.name = newStringVarName;
					else if (p.node.name === "FS_VAR") p.node.name = fsVarName;
				},
			});

			const patchCode = (patchCodeAst.program.body[0] as any).body.body;
			body.body.splice(insertionIndex, 0, ...patchCode);

			path.stop();
		},
	});
}

// Find the diff generator function by its parameter signature (oldContent/newContent style)
function findDiffGenerator(ast: any): string | null {
	let found: string | null = null;
	traverse.default(ast, {
		FunctionDeclaration(path: any) {
			if (found) return;
			if (
				path.node.params.length === 1 &&
				t.isObjectPattern(path.node.params[0])
			) {
				const props = path.node.params[0].properties;
				const hasFilePath = props.some(
					(p: any) =>
						t.isObjectProperty(p) &&
						t.isIdentifier(p.key) &&
						p.key.name === "filePath",
				);
				const hasOldContent = props.some(
					(p: any) =>
						t.isObjectProperty(p) &&
						t.isIdentifier(p.key) &&
						p.key.name === "oldContent",
				);
				const hasNewContent = props.some(
					(p: any) =>
						t.isObjectProperty(p) &&
						t.isIdentifier(p.key) &&
						p.key.name === "newContent",
				);

				if (hasFilePath && hasOldContent && hasNewContent && path.node.id) {
					found = path.node.id.name;
					path.stop();
				}
			}
		},
	});
	return found;
}

// Find the edit patch generator function (oN style - takes filePath, fileContents, edits)
function findEditPatchGenerator(ast: any): string | null {
	let found: string | null = null;
	traverse.default(ast, {
		FunctionDeclaration(path: any) {
			if (found) return;
			if (
				path.node.params.length === 1 &&
				t.isObjectPattern(path.node.params[0])
			) {
				const props = path.node.params[0].properties;
				const hasFilePath = props.some(
					(p: any) =>
						t.isObjectProperty(p) &&
						t.isIdentifier(p.key) &&
						p.key.name === "filePath",
				);
				const hasFileContents = props.some(
					(p: any) =>
						t.isObjectProperty(p) &&
						t.isIdentifier(p.key) &&
						p.key.name === "fileContents",
				);
				const hasEdits = props.some(
					(p: any) =>
						t.isObjectProperty(p) &&
						t.isIdentifier(p.key) &&
						p.key.name === "edits",
				);

				if (hasFilePath && hasFileContents && hasEdits && path.node.id) {
					found = path.node.id.name;
					path.stop();
				}
			}
		},
	});
	return found;
}

function findFsImportName(ast: any): string | null {
	let name: string | null = null;
	traverse.default(ast, {
		ImportDeclaration(path: any) {
			if (path.node.source.value === "fs") {
				for (const spec of path.node.specifiers) {
					if (t.isImportNamespaceSpecifier(spec)) {
						name = spec.local.name;
						path.stop();
					}
				}
			}
		},
	});
	return name;
}

export async function editTool(ast: any, ctx: PatchContext) {
	let toolVarName: string | null = null;
	let schemaObject: any = null;
	let editToolObj: any = null;

	// Detect fs variable name
	const fsVarName = findFsImportName(ast) || "fs";

	// Find Edit tool by its description string
	traverse.default(ast, {
		StringLiteral(path: any) {
			if (path.node.value === "A tool for editing files") {
				let p = path.parentPath;
				while (p) {
					if (t.isVariableDeclarator(p.node) && t.isIdentifier(p.node.id)) {
						toolVarName = p.node.id.name;
						break;
					}
					if (t.isAssignmentExpression(p.node) && t.isIdentifier(p.node.left)) {
						toolVarName = p.node.left.name;
						break;
					}
					p = p.parentPath;
				}
			}
		},
		ObjectExpression(path: any) {
			const props = path.node.properties;
			let hasFilePath = false;
			let hasReplaceAll = false;

			for (const p of props) {
				if (!t.isObjectProperty(p)) continue;
				const key = p.key;
				if (t.isIdentifier(key)) {
					if (key.name === "file_path") hasFilePath = true;
					if (key.name === "replace_all") hasReplaceAll = true;
				}
			}

			if (hasFilePath && hasReplaceAll) {
				const filePathProp = props.find(
					(p: any) => t.isIdentifier(p.key) && p.key.name === "file_path",
				);
				if (
					filePathProp &&
					(t.isCallExpression(filePathProp.value) ||
						t.isMemberExpression(filePathProp.value))
				) {
					schemaObject = path.node;
				}
			}
		},
		ObjectMethod(path: any) {
			if (path.node.key.name === "description") {
				const body = path.node.body.body;
				if (body.length > 0 && t.isReturnStatement(body[0])) {
					const arg = body[0].argument;
					if (
						t.isStringLiteral(arg) &&
						arg.value === "A tool for editing files"
					) {
						editToolObj = path.parentPath.node;
					}
				}
			}
		},
	});

	if (toolVarName && editToolObj) {
		// Inject self-contained helpers
		const templatePath = path.join(__dirname, "../templates/edit_hook.js");
		if (fs.existsSync(templatePath)) {
			const hookCode = fs.readFileSync(templatePath, "utf-8");
			const hookAst = parse(hookCode);

			if (ast.program?.body) {
				ast.program.body.push(...hookAst.program.body);
			}

			// Discover the internal diff generator function by its signature
			const diffGenFunc = findDiffGenerator(ast) || "_claudeGenerateSimpleDiff";
			// Also find the edit patch generator (oN style - takes edits array)
			const editPatchGenFunc = findEditPatchGenerator(ast);

			// Simplified logic - helpers are self-contained, no variable substitution needed
			const validateLogic = `
            {
                // Normalize camelCase to snake_case
                const _normalizeKeys = (obj) => {
                    if (!obj || typeof obj !== "object") return obj;
                    if (obj.lineNumber !== undefined && obj.line_number === undefined) obj.line_number = obj.lineNumber;
                    if (obj.startLine !== undefined && obj.start_line === undefined) obj.start_line = obj.startLine;
                    if (obj.endLine !== undefined && obj.end_line === undefined) obj.end_line = obj.endLine;
                    if (obj.linePosition !== undefined && obj.line_position === undefined) obj.line_position = obj.linePosition;
                    if (obj.replaceAll !== undefined && obj.replace_all === undefined) obj.replace_all = obj.replaceAll;
                    if (obj.oldString !== undefined && obj.old_string === undefined) obj.old_string = obj.oldString;
                    if (obj.newString !== undefined && obj.new_string === undefined) obj.new_string = obj.newString;
                    return obj;
                };
                _input = _normalizeKeys(_input);
                if (Array.isArray(_input.edits)) {
                    _input.edits = _input.edits.map(_normalizeKeys);
                }

                // Coerce to strings
                _input.old_string = typeof _input.old_string === "string" ? _input.old_string : (_input.old_string ?? "");
                _input.new_string = typeof _input.new_string === "string" ? _input.new_string : (_input.new_string ?? "");

                // Fallback: only new_string provided -> append to end
                const hasOwn = (k) => Object.prototype.hasOwnProperty.call(_input, k);
                const hasStructuredHint = hasOwn("line_number") || hasOwn("start_line") || hasOwn("end_line") || hasOwn("diff") ||
                    (Array.isArray(_input.edits) && _input.edits.length > 0);
                if (!hasStructuredHint && _input.old_string === "" && _input.new_string !== "") {
                    _input.line_number = Number.MAX_SAFE_INTEGER;
                    _input.line_position = _input.line_position || "after";
                }

                if (_claudeEditHasExtendedFields(_input)) {
                    let Q = _claudeEditNormalizeEdits(_input);
                    if (Q.error) return Q.error;

                    let I = _claudeResolvePath(_input.file_path);
                    let Y = _claudeFs.existsSync(I);

                    if (Y && I.endsWith(".ipynb"))
                        return { result: false, message: "Use NotebookEdit for .ipynb files", errorCode: 5 };

                    if (Y && Q.edits.some((W) => W.mode === "string" && W.oldString === ""))
                        return { result: false, message: "Cannot use empty old_string on existing file", errorCode: 3 };

                    let encoding = Y ? _claudeGetEncoding(I) : "utf8";
                    let V = Y ? _claudeFs.readFileSync(I, encoding) : "";
                    if (V && typeof V !== "string") V = V.toString();

                    let J = _claudeApplyExtendedFileEdits(V, Q.edits);
                    if (J.error) return J.error;
                    return { result: true };
                }
            }`;

			const callLogic = `
            {
                if (_claudeEditHasExtendedFields(_input)) {
                    let Z = _claudeEditNormalizeEdits(_input);
                    if (Z.error) throw Error(Z.error.message);

                    let J = _claudeResolvePath(_input.file_path);
                    let X = _claudeFs.existsSync(J);
                    let encoding = X ? _claudeGetEncoding(J) : "utf8";
                    let W = X ? _claudeFs.readFileSync(J, encoding) : "";
                    if (W && typeof W !== "string") W = W.toString();

                    let L = _claudeApplyExtendedFileEdits(W, Z.edits);
                    if (L.error) throw Error(L.error.message);

                    let dirPath = _claudePath.dirname(J);
                    _claudeFs.mkdirSync(dirPath, { recursive: true });

                    let H = X ? _claudeGetNewline(J) : "LF";
                    _claudeWriteFile(J, L.content, encoding, H);

                    if (_context && _context.readFileState) {
                        _context.readFileState.set(J, { content: L.content, timestamp: Date.now() });
                    }

                    let structuredPatch = [];
                    try {
                        // Convert our edits to the format oN expects: { old_string, new_string, replace_all }
                        const _patchEdits = L.appliedEdits ? L.appliedEdits.map(e => ({
                            old_string: e.oldString || "",
                            new_string: e.newString || "",
                            replace_all: e.replaceAll || false
                        })) : [];

                        // Use edit patch generator if available (matches original output format)
                        ${editPatchGenFunc ? `
                        if (_patchEdits.length > 0) {
                            structuredPatch = ${editPatchGenFunc}({
                                filePath: _input.file_path,
                                fileContents: W,
                                edits: _patchEdits
                            });
                        } else {
                            structuredPatch = ${diffGenFunc}({
                                filePath: _input.file_path,
                                oldContent: W,
                                newContent: L.content
                            });
                        }
                        ` : `
                        structuredPatch = ${diffGenFunc}({
                            filePath: _input.file_path,
                            oldContent: W,
                            newContent: L.content
                        });
                        `}
                        if (!Array.isArray(structuredPatch)) structuredPatch = [];
                    } catch (e) {}

                    return {
                        data: {
                            filePath: _input.file_path,
                            oldString: (L.firstString && L.firstString.oldString) || "",
                            newString: (L.firstString && L.firstString.newString) || "",
                            originalFile: W,
                            userModified: _context?.userModified ?? false,
                            replaceAll: (L.firstString && L.firstString.replaceAll) || false,
                            appliedEditsCount: Z.edits.length,
                            structuredPatch: structuredPatch,
                            warning: L.warning || undefined
                        },
                    };
                }
            }`;

			// Patch validateInput
			const validateMethod = editToolObj.properties.find(
				(p: any) =>
					t.isObjectMethod(p) &&
					t.isIdentifier(p.key) &&
					p.key.name === "validateInput",
			);
			if (validateMethod) {
				const originalParams = validateMethod.params;
				validateMethod.params = [
					t.identifier("_input"),
					t.identifier("_context"),
				];

				const restoreParams = t.variableDeclaration("let", [
					t.variableDeclarator(
						t.arrayPattern(originalParams),
						t.arrayExpression([
							t.identifier("_input"),
							t.identifier("_context"),
						]),
					),
				]);

				const logicAst = (
					parse(`function _wrapper() ${validateLogic}`).program.body[0] as any
				).body;
				validateMethod.body.body.unshift(restoreParams);
				validateMethod.body.body.unshift(...logicAst.body);
			}

			// Patch call
			const callMethod = editToolObj.properties.find(
				(p: any) =>
					t.isObjectMethod(p) && t.isIdentifier(p.key) && p.key.name === "call",
			);
			if (callMethod) {
				const originalParams = callMethod.params;
				callMethod.params = [t.restElement(t.identifier("_args"))];

				const restoreParams = t.variableDeclaration("let", [
					t.variableDeclarator(
						t.arrayPattern(originalParams),
						t.identifier("_args"),
					),
				]);

				const initVars = [
					t.variableDeclaration("let", [
						t.variableDeclarator(
							t.identifier("_input"),
							t.memberExpression(
								t.identifier("_args"),
								t.numericLiteral(0),
								true,
							),
						),
					]),
					t.variableDeclaration("let", [
						t.variableDeclarator(
							t.identifier("_context"),
							t.memberExpression(
								t.identifier("_args"),
								t.numericLiteral(1),
								true,
							),
						),
					]),
				];

				const logicAst = (
					parse(`function _wrapper() ${callLogic}`).program.body[0] as any
				).body;

				callMethod.body.body.unshift(restoreParams);
				callMethod.body.body.unshift(...initVars);
				callMethod.body.body.splice(2, 0, ...logicAst.body);
			}

			// Patch mapToolResultToToolResultBlockParam
			const mapResultLogic = `
            {
                if (_result && typeof _result.appliedEditsCount === "number" && _result.appliedEditsCount > 0) {
                    let Q = _result.appliedEditsCount === 1 ? "1 edit" : _result.appliedEditsCount + " edits";
                    let msg = "The file " + _result.filePath + " has been updated with " + Q + ".";
                    if (_result.warning) {
                        msg += "\\n\\nWarning: " + _result.warning;
                    }
                    return {
                        tool_use_id: _toolUseId,
                        type: "tool_result",
                        content: msg
                    };
                }
            }`;

			const mapMethod = editToolObj.properties.find(
				(p: any) =>
					t.isObjectMethod(p) &&
					t.isIdentifier(p.key) &&
					p.key.name === "mapToolResultToToolResultBlockParam",
			);
			if (mapMethod) {
				const originalParams = mapMethod.params;
				mapMethod.params = [
					t.identifier("_result"),
					t.identifier("_toolUseId"),
				];

				const restoreParams = t.variableDeclaration("let", [
					t.variableDeclarator(
						t.arrayPattern(originalParams),
						t.arrayExpression([
							t.identifier("_result"),
							t.identifier("_toolUseId"),
						]),
					),
				]);

				const logicAst = (
					parse(`function _wrapper() ${mapResultLogic}`).program.body[0] as any
				).body;
				mapMethod.body.body.unshift(restoreParams);
				mapMethod.body.body.splice(1, 0, ...logicAst.body);
			}

			// Patch inputsEquivalent
			const eqMethod = editToolObj.properties.find(
				(p: any) =>
					t.isObjectMethod(p) &&
					t.isIdentifier(p.key) &&
					p.key.name === "inputsEquivalent",
			);
			if (
				eqMethod &&
				eqMethod.params.length >= 2 &&
				t.isIdentifier(eqMethod.params[0]) &&
				t.isIdentifier(eqMethod.params[1])
			) {
				const arg1 = eqMethod.params[0].name;
				const arg2 = eqMethod.params[1].name;

				const eqLogic = `
                {
                    if (_claudeEditHasExtendedFields(${arg1}) || _claudeEditHasExtendedFields(${arg2})) {
                        return JSON.stringify(${arg1}) === JSON.stringify(${arg2});
                    }
                }`;
				const logicAst = (
					parse(`function _wrapper() ${eqLogic}`).program.body[0] as any
				).body;
				eqMethod.body.body.unshift(...logicAst.body);
			}

			ctx.report.edit_tool_extended = true;
		} else {
			ctx.report.edit_hook_injection_failed = true;
		}
	} else {
		ctx.report.edit_hook_injection_failed = true;
	}

	// Extend schema with new fields
	if (schemaObject && t.isObjectExpression(schemaObject)) {
		const schemaExtensionCode = `
        ({
            line_number: __ZOD__.any().optional().describe("Line insert: 1-based line number for insertion point"),
            line_position: __ZOD__.enum(["before", "after"]).default("before").optional().describe("Insert before (default) or after the line"),
            start_line: __ZOD__.any().optional().describe("Range replace: start line (1-based)"),
            end_line: __ZOD__.any().optional().describe("Range replace: end line (inclusive)"),
            diff: __ZOD__.string().optional().describe("Unified diff: apply patch with @@ -old +new @@ headers"),
            edits: __ZOD__.array(__ZOD__.strictObject({
                old_string: __ZOD__.string().describe("Text to replace (string mode)"),
                new_string: __ZOD__.string().describe("Replacement text"),
                replace_all: __ZOD__.boolean().default(false).optional(),
                line_number: __ZOD__.any().optional(),
                line_position: __ZOD__.enum(["before", "after"]).default("before").optional(),
                start_line: __ZOD__.any().optional(),
                end_line: __ZOD__.any().optional()
            })).min(1).optional().describe("Batch multiple edits in one call")
        })
        `;

		try {
			const replaceAllProp = schemaObject.properties.find(
				(p: any) => t.isIdentifier(p.key) && p.key.name === "replace_all",
			);
			if (replaceAllProp) {
				// Find the Zod variable name
				let zodVar = "_";
				let curr = (replaceAllProp as any).value;
				while (curr) {
					if (t.isCallExpression(curr)) curr = curr.callee;
					else if (t.isMemberExpression(curr)) curr = curr.object;
					else if (t.isIdentifier(curr)) {
						zodVar = curr.name;
						break;
					} else break;
				}

				const adaptedCode = schemaExtensionCode.replace(/__ZOD__/g, zodVar);
				const extAst = (parse(adaptedCode).program.body[0] as any).expression;
				schemaObject.properties.push(...extAst.properties);

				// Make old_string and new_string optional
				for (const fieldName of ["old_string", "new_string"]) {
					const prop = schemaObject.properties.find(
						(p: any) => t.isIdentifier(p.key) && p.key.name === fieldName,
					);
					if (prop) {
						const code = print((prop as any).value);
						if (!code.includes("optional()")) {
							(prop as any).value = parse(
								`(${code}).optional()`,
							).program.body[0].expression;
						}
					}
				}
			}
		} catch (e) {
			console.error("Failed to extend edit schema", e);
		}
	}

	// Update prompts
	const newPrompt = `Edit supports string replace, line insert, line-range replace, and unified diffs.

Usage:
- Diff: provide \`diff\` with a standard unified diff hunk (start with @@ ... @@). Robust matching is used, so exact line numbers are less critical than context.
- Inserts: provide line_number (1-based) and new_string; optional line_position "before"|"after".
- Range: provide start_line/end_line and new_string.
- Batch: provide edits[] entries with any mix of fields (including diff).
- String: old_string/new_string; use replace_all for renames.
- Use ast-grep for code search and bat to view code; avoid Read except for PDFs/images. Preserve indentation exactly as shown after the line-number prefix from outputs.
- Prefer editing existing files; don't create new files unless explicitly requested.

When to use each mode:
- **String replace** (old_string/new_string): Best for targeted changes where you have unique context. Fuzzy matches smart quotes.
- **Line insert** (line_number + new_string): Insert new lines at a specific position without needing surrounding context.
- **Range replace** (start_line/end_line + new_string): Replace entire line ranges when you know exact line numbers from bat output.
- **Unified diff** (diff): Apply multiple related changes in one operation using standard diff format.
- **Batch edits** (edits[]): Combine multiple operations (any mode) in a single tool call.`;

	// Patch preprocessing switch to pass through extended fields
	patchPreprocessingSwitch(ast, toolVarName);

	// Patch the approval dialog (tx2) to handle extended edit modes
	patchApprovalDialog(ast, fsVarName);

	traverse.default(ast, {
		StringLiteral(path: any) {
			if (
				path.node.value.startsWith(
					"Performs exact string replacements in files",
				)
			) {
				path.node.value = newPrompt;
			} else if (path.node.value === "A tool for editing files") {
				path.node.value =
					"Edit files (string replace, diff, insert, line-range)";
			}
		},
		TemplateLiteral(path: any) {
			if (
				path.node.quasis.length > 0 &&
				path.node.quasis[0].value.raw.startsWith(
					"Performs exact string replacements in files",
				)
			) {
				path.replaceWith(t.stringLiteral(newPrompt));
			}
		},
		// Protect structuredPatch.reduce from undefined
		FunctionDeclaration(path: any) {
			if (
				path.node.params.length === 1 &&
				t.isObjectPattern(path.node.params[0])
			) {
				const props = path.node.params[0].properties;
				const patchProp = props.find(
					(p: any): p is t.ObjectProperty =>
						t.isObjectProperty(p) &&
						t.isIdentifier(p.key) &&
						p.key.name === "structuredPatch",
				);

				if (patchProp && t.isIdentifier(patchProp.value)) {
					const patchVarName = patchProp.value.name;

					traverse.default(t.file(t.program([path.node])), {
						CallExpression(innerPath: any) {
							if (
								t.isMemberExpression(innerPath.node.callee) &&
								t.isIdentifier(innerPath.node.callee.property) &&
								(innerPath.node.callee.property.name === "reduce" ||
									innerPath.node.callee.property.name === "map")
							) {
								const object = innerPath.node.callee.object;
								if (t.isIdentifier(object) && object.name === patchVarName) {
									innerPath.node.callee.object = t.logicalExpression(
										"||",
										object,
										t.arrayExpression([]),
									);
								}
							}
						},
					});
				}
			}
		},
	});
}
