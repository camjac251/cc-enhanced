import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import { parse, print } from "../loader.js";
import type { Patch } from "../types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function adaptHookCodeForRuntime(hookCode: string): string {
	const isNativeMode = process.env.CLAUDE_PATCHER_NATIVE_MODE === "1";
	if (!isNativeMode) return hookCode;

	return hookCode
		.replace(
			/^import \* as _claudeFs from "node:fs";\s*$/m,
			'const _claudeFs = require("node:fs");',
		)
		.replace(
			/^import \* as _claudePath from "node:path";\s*$/m,
			'const _claudePath = require("node:path");',
		);
}

function hasObjectPatternParamKeys(
	fnNode: any,
	requiredKeys: string[],
): boolean {
	if (
		!fnNode ||
		!Array.isArray(fnNode.params) ||
		fnNode.params.length !== 1 ||
		!t.isObjectPattern(fnNode.params[0])
	) {
		return false;
	}

	const props = fnNode.params[0].properties;
	return requiredKeys.every((key) =>
		props.some(
			(p: any) =>
				t.isObjectProperty(p) && t.isIdentifier(p.key) && p.key.name === key,
		),
	);
}

function patchPreprocessingSwitch(ast: any, editToolVarName: string | null) {
	if (!editToolVarName) return;

	traverse.default(ast, {
		SwitchCase(path: any) {
			const test = path.node.test;
			if (!test) return;

			if (!t.isMemberExpression(test)) return;
			if (!t.isIdentifier(test.object) || test.object.name !== editToolVarName)
				return;
			if (!t.isIdentifier(test.property) || test.property.name !== "name")
				return;

			const consequent = path.node.consequent;
			if (!consequent || consequent.length === 0) return;

			const blockStmt = consequent.find((n: any) => t.isBlockStatement(n));
			if (!blockStmt) return;

			for (let i = 0; i < blockStmt.body.length; i++) {
				const stmt = blockStmt.body[i];
				if (!t.isVariableDeclaration(stmt)) continue;
				if (stmt.declarations.length < 2) continue;

				const firstDecl = stmt.declarations[0];
				const secondDecl = stmt.declarations[1];

				if (!t.isIdentifier(firstDecl.id)) continue;
				if (!t.isObjectPattern(secondDecl.id)) continue;

				const inputVarName = firstDecl.id.name;

				const stmt1 = t.variableDeclaration(stmt.kind, [firstDecl]);
				const stmt2 = t.variableDeclaration(stmt.kind, [secondDecl]);

				const extendedFieldCheck = (
					parse(`
                    function _wrapper() {
                        if (${inputVarName}.line_number !== undefined || ${inputVarName}.start_line !== undefined ||
                            ${inputVarName}.end_line !== undefined || ${inputVarName}.diff !== undefined ||
                            ${inputVarName}.pattern !== undefined ||
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

function patchApprovalDialog(ast: any) {
	traverse.default(ast, {
		Function(path: any) {
			const body = path.node.body;
			if (!t.isBlockStatement(body)) return;

			let hasEditFileTitle = false;
			path.traverse({
				StringLiteral(innerPath: any) {
					if (innerPath.node.value === "Edit file") {
						hasEditFileTitle = true;
						innerPath.stop();
					}
				},
			});

			if (!hasEditFileTitle) return;

			// Avoid double-patching
			const funcStr = JSON.stringify(path.node.body);
			if (funcStr.includes("EXTENDED_EDIT_PREVIEW_v1")) return;

			if (path.node.params.length < 1 || !t.isIdentifier(path.node.params[0]))
				return;
			const argName = path.node.params[0].name;

			let oldStringVarName: string | null = null;
			let newStringVarName: string | null = null;
			let insertBeforePath: any = null;

			// Find the edits array creation: [{ old_string: X, new_string: Y, ... }]
			path.traverse({
				ArrayExpression(innerPath: any) {
					if (insertBeforePath) return;
					const el = innerPath.node.elements?.[0];
					if (!el || !t.isObjectExpression(el)) return;

					const oldProp = el.properties.find(
						(p: any) =>
							t.isObjectProperty(p) &&
							t.isIdentifier(p.key, { name: "old_string" }),
					) as t.ObjectProperty | undefined;
					const newProp = el.properties.find(
						(p: any) =>
							t.isObjectProperty(p) &&
							t.isIdentifier(p.key, { name: "new_string" }),
					) as t.ObjectProperty | undefined;

					if (!oldProp || !newProp) return;
					if (!t.isIdentifier(oldProp.value) || !t.isIdentifier(newProp.value))
						return;

					oldStringVarName = oldProp.value.name;
					newStringVarName = newProp.value.name;

					const stmtParent = innerPath.getStatementParent();
					if (!stmtParent) return;

					insertBeforePath = stmtParent;
					innerPath.stop();
				},
			});

			if (!oldStringVarName || !newStringVarName || !insertBeforePath) return;

			const patchCodeAst = parse(`
                function _wrapper() {
                    const _claudeEditPreviewMarker = "EXTENDED_EDIT_PREVIEW_v1";
                    try {
                        const INPUT = ARG && ARG.toolUseConfirm ? ARG.toolUseConfirm.input : null;
                        const _hasExtended =
                            INPUT &&
                            (INPUT.line_number !== undefined ||
                                INPUT.lineNumber !== undefined ||
                                INPUT.start_line !== undefined ||
                                INPUT.startLine !== undefined ||
                                INPUT.end_line !== undefined ||
                                INPUT.endLine !== undefined ||
                                (typeof INPUT.diff === "string" && INPUT.diff.trim().length > 0) ||
                                (typeof INPUT.pattern === "string" && INPUT.pattern.length > 0) ||
                                (Array.isArray(INPUT.edits) && INPUT.edits.length > 0));

                        if (_hasExtended) {
                            const _rawFilePath = INPUT.file_path;
                            const _absFilePath = _claudeResolvePath(String(_rawFilePath || ""));
                            const _fileExists =
                                _absFilePath && _claudeFs.existsSync(_absFilePath);
                            const _encoding = _fileExists
                                ? _claudeGetEncoding(_absFilePath)
                                : "utf8";

                            let _content = _fileExists
                                ? _claudeFs.readFileSync(_absFilePath, _encoding)
                                : "";
                            if (_content && typeof _content !== "string")
                                _content = _content.toString();
                            _content = String(_content).replace(/\\r\\n/g, "\\n");

                            const _lines = _content === "" ? [] : _content.split("\\n");
                            const _contextLines = 3;

                            const _previewLineInsert = (lineNumber, linePosition, newText) => {
                                const _lineNum = Math.max(
                                    1,
                                    Math.min(
                                        parseInt(lineNumber) || 1,
                                        _lines.length + 1,
                                    ),
                                );
                                const _insertIdx =
                                    String(linePosition || "before") === "after"
                                        ? _lineNum
                                        : _lineNum - 1;
                                const _startCtx = Math.max(0, _insertIdx - _contextLines);
                                const _endCtx = Math.min(
                                    _lines.length,
                                    _insertIdx + _contextLines,
                                );

                                const _beforeLines = _lines.slice(_startCtx, _insertIdx);
                                const _afterLines = _lines.slice(_insertIdx, _endCtx);

                                OLD_VAR = _beforeLines.concat(_afterLines).join("\\n");
                                NEW_VAR = _beforeLines
                                    .concat(String(newText || "").split("\\n"))
                                    .concat(_afterLines)
                                    .join("\\n");
                            };

                            const _previewRange = (startLine, endLine, newText) => {
                                const _startLine = Math.max(1, parseInt(startLine) || 1);
                                const _endLine = Math.max(
                                    _startLine,
                                    parseInt(endLine) || _startLine,
                                );
                                const _startIdx = _startLine - 1;
                                const _endIdx = Math.min(_endLine, _lines.length);
                                const _startCtx = Math.max(0, _startIdx - _contextLines);
                                const _endCtxIdx = Math.min(
                                    _lines.length,
                                    _endIdx + _contextLines,
                                );

                                const _beforeCtx = _lines.slice(_startCtx, _startIdx);
                                const _replacedLines = _lines.slice(_startIdx, _endIdx);
                                const _afterCtx = _lines.slice(_endIdx, _endCtxIdx);

                                OLD_VAR = _beforeCtx
                                    .concat(_replacedLines)
                                    .concat(_afterCtx)
                                    .join("\\n");
                                NEW_VAR = _beforeCtx
                                    .concat(String(newText || "").split("\\n"))
                                    .concat(_afterCtx)
                                    .join("\\n");
                            };

                            const _previewDiff = (diffText) => {
                                try {
                                    const diff = String(diffText || "");
                                    const parts = diff
                                        .split(
                                            /(^@@\\s+-\\d+(?:,\\d+)?\\s+\\+\\d+(?:,\\d+)?\\s+@@.*$)/gm,
                                        )
                                        .filter(Boolean);
                                    let header = null;
                                    for (const part of parts) {
                                        if (part.trim().startsWith("@@")) {
                                            header = part.trim();
                                            continue;
                                        }
                                        if (!header) continue;
                                        const headerMatch =
                                            /@@\\s+-(\\d+)(?:,(\\d+))?\\s+\\+(\\d+)(?:,(\\d+))?\\s+@@/.exec(
                                                header,
                                            );
                                        if (!headerMatch) {
                                            header = null;
                                            continue;
                                        }
                                        const blockLines = part.split(/\\r?\\n/);
                                        if (blockLines.length > 0 && blockLines[0] === "")
                                            blockLines.shift();
                                        const searchLines = [];
                                        const replaceLines = [];
                                        for (const line of blockLines) {
                                            if (line.startsWith(" ") || line === "") {
                                                const l = line.startsWith(" ")
                                                    ? line.slice(1)
                                                    : line;
                                                searchLines.push(l);
                                                replaceLines.push(l);
                                            } else if (line.startsWith("-")) {
                                                searchLines.push(line.slice(1));
                                            } else if (line.startsWith("+")) {
                                                replaceLines.push(line.slice(1));
                                            }
                                        }
                                        OLD_VAR = searchLines.join("\\n");
                                        NEW_VAR = replaceLines.join("\\n");
                                        return;
                                    }
                                    OLD_VAR = "";
                                    NEW_VAR = diff;
                                } catch (_e) {
                                    OLD_VAR = "";
                                    NEW_VAR = String(diffText || "");
                                }
                            };

                            const _previewRegex = (patternText, newText) => {
                                try {
                                    let _pattern = String(patternText || "");
                                    let _flags = "";
                                    const _regexMatch = _pattern.match(
                                        /^\\/(.+)\\/([gimsuy]*)$/,
                                    );
                                    if (_regexMatch) {
                                        _pattern = _regexMatch[1];
                                        _flags = _regexMatch[2] || "";
                                    }
                                    const _regex = new RegExp(_pattern, _flags.replace("g", ""));
                                    const _match = _content.match(_regex);
                                    if (_match && _match[0]) {
                                        OLD_VAR = _match[0];
                                        NEW_VAR = _match[0].replace(
                                            _regex,
                                            String(newText || ""),
                                        );
                                    } else {
                                        OLD_VAR = "";
                                        NEW_VAR = String(patternText || "");
                                    }
                                } catch (_e) {
                                    OLD_VAR = "";
                                    NEW_VAR = String(patternText || "");
                                }
                            };

                            if (Array.isArray(INPUT.edits) && INPUT.edits.length > 0) {
                                try {
                                    const _normalized = _claudeEditNormalizeEdits(INPUT);
                                    if (
                                        !_normalized.error &&
                                        _normalized.edits &&
                                        _normalized.edits.length > 0
                                    ) {
                                        const _e = _normalized.edits[0];
                                        if (_e.mode === "line") {
                                            _previewLineInsert(
                                                _e.lineNumber,
                                                _e.linePosition,
                                                _e.newString,
                                            );
                                        } else if (_e.mode === "range") {
                                            _previewRange(
                                                _e.startLine,
                                                _e.endLine,
                                                _e.newString,
                                            );
                                        } else if (_e.mode === "diff") {
                                            _previewDiff(_e.diff);
                                        } else if (_e.mode === "regex") {
                                            _previewRegex(_e.pattern, _e.newString);
                                        } else {
                                            OLD_VAR = _e.oldString || "";
                                            NEW_VAR = _e.newString || "";
                                        }
                                    }
                                } catch (_editsErr) {}
                            } else if (
                                INPUT.line_number !== undefined ||
                                INPUT.lineNumber !== undefined
                            ) {
                                _previewLineInsert(
                                    INPUT.line_number ?? INPUT.lineNumber,
                                    INPUT.line_position ?? INPUT.linePosition,
                                    INPUT.new_string ?? INPUT.newString,
                                );
                            } else if (
                                INPUT.start_line !== undefined ||
                                INPUT.startLine !== undefined ||
                                INPUT.end_line !== undefined ||
                                INPUT.endLine !== undefined
                            ) {
                                _previewRange(
                                    INPUT.start_line ?? INPUT.startLine,
                                    INPUT.end_line ?? INPUT.endLine,
                                    INPUT.new_string ?? INPUT.newString,
                                );
                            } else if (
                                typeof INPUT.diff === "string" &&
                                INPUT.diff.trim().length > 0
                            ) {
                                _previewDiff(INPUT.diff);
                            } else if (
                                typeof INPUT.pattern === "string" &&
                                INPUT.pattern.length > 0
                            ) {
                                _previewRegex(INPUT.pattern, INPUT.new_string ?? INPUT.newString);
                            }
                        }
                    } catch (_e) {}

                    if (typeof OLD_VAR !== "string") OLD_VAR = "";
                    if (typeof NEW_VAR !== "string") NEW_VAR = "";
                }
            `);

			traverse.default(patchCodeAst, {
				Identifier(p: any) {
					if (p.node.name === "ARG") p.node.name = argName;
					else if (p.node.name === "OLD_VAR") p.node.name = oldStringVarName;
					else if (p.node.name === "NEW_VAR") p.node.name = newStringVarName;
				},
			});

			const patchCode = (patchCodeAst.program.body[0] as any).body.body;
			insertBeforePath.insertBefore(patchCode);
		},
	});
}

function findFunctionLikeByObjectParamKeys(
	ast: any,
	requiredKeys: string[],
): string | null {
	let found: string | null = null;
	traverse.default(ast, {
		FunctionDeclaration(path: any) {
			if (found) return;
			if (!path.node.id) return;
			if (!hasObjectPatternParamKeys(path.node, requiredKeys)) return;

			found = path.node.id.name;
			path.stop();
		},
		VariableDeclarator(path: any) {
			if (found) return;
			if (!t.isIdentifier(path.node.id)) return;
			if (
				!t.isFunctionExpression(path.node.init) &&
				!t.isArrowFunctionExpression(path.node.init)
			) {
				return;
			}
			if (!hasObjectPatternParamKeys(path.node.init, requiredKeys)) return;

			found = path.node.id.name;
			path.stop();
		},
	});
	return found;
}

function findDiffGenerator(ast: any): string | null {
	return findFunctionLikeByObjectParamKeys(ast, [
		"filePath",
		"oldContent",
		"newContent",
	]);
}

function findEditPatchGenerator(ast: any): string | null {
	return findFunctionLikeByObjectParamKeys(ast, [
		"filePath",
		"fileContents",
		"edits",
	]);
}

export const editTool: Patch = {
	tag: "edit-extended",

	ast: async (ast) => {
		let toolVarName: string | null = null;
		let schemaObject: any = null;
		let editToolObj: any = null;

		traverse.default(ast, {
			StringLiteral(path: any) {
				if (path.node.value === "A tool for editing files") {
					let p = path.parentPath;
					while (p) {
						if (t.isVariableDeclarator(p.node) && t.isIdentifier(p.node.id)) {
							toolVarName = p.node.id.name;
							break;
						}
						if (
							t.isAssignmentExpression(p.node) &&
							t.isIdentifier(p.node.left)
						) {
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
			const templatePath = path.join(__dirname, "../templates/edit_hook.js");
			if (fs.existsSync(templatePath)) {
				const hookCode = fs
					.readFileSync(templatePath, "utf-8")
					.replace(/\nexport\s*\{\s*\};?\s*$/, "\n");
				const runtimeHookCode = adaptHookCodeForRuntime(hookCode);
				const hookAst = parse(runtimeHookCode);

				if (ast.program?.body) {
					ast.program.body.push(...hookAst.program.body);
				}

				const diffGenFunc =
					findDiffGenerator(ast) || "_claudeGenerateSimpleDiff";
				const editPatchGenFunc = findEditPatchGenerator(ast);

				const validateLogic = `
                {
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

                    _input.old_string = typeof _input.old_string === "string" ? _input.old_string : (_input.old_string ?? "");
                    _input.new_string = typeof _input.new_string === "string" ? _input.new_string : (_input.new_string ?? "");

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
                            const _patchEdits = L.appliedEdits ? L.appliedEdits.map(e => ({
                                old_string: e.oldString || "",
                                new_string: e.newString || "",
                                replace_all: e.replaceAll || false
                            })) : [];

                            ${
															editPatchGenFunc
																? `
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
                            `
																: `
                            structuredPatch = ${diffGenFunc}({
                                filePath: _input.file_path,
                                oldContent: W,
                                newContent: L.content
                            });
                            `
														}
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

				const callMethod = editToolObj.properties.find(
					(p: any) =>
						t.isObjectMethod(p) &&
						t.isIdentifier(p.key) &&
						p.key.name === "call",
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
						parse(`function _wrapper() ${mapResultLogic}`).program
							.body[0] as any
					).body;
					mapMethod.body.body.unshift(restoreParams);
					mapMethod.body.body.splice(1, 0, ...logicAst.body);
				}

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
			}
		}

		if (schemaObject && t.isObjectExpression(schemaObject)) {
			const schemaExtensionCode = `
            ({
                line_number: __ZOD__.any().optional().describe("Line insert: 1-based line number for insertion point"),
                line_position: __ZOD__.enum(["before", "after"]).default("before").optional().describe("Insert before (default) or after the line"),
                start_line: __ZOD__.any().optional().describe("Range replace: start line (1-based)"),
                end_line: __ZOD__.any().optional().describe("Range replace: end line (inclusive)"),
                diff: __ZOD__.string().optional().describe("Unified diff: apply patch with @@ -old +new @@ headers"),
                pattern: __ZOD__.string().optional().describe("Regex pattern to match (use with new_string for replacement)"),
                edits: __ZOD__.array(__ZOD__.strictObject({
                    old_string: __ZOD__.string().optional().describe("Text to replace (string mode)"),
                    new_string: __ZOD__.string().optional().describe("Replacement text"),
                    replace_all: __ZOD__.boolean().default(false).optional(),
                    line_number: __ZOD__.any().optional(),
                    line_position: __ZOD__.enum(["before", "after"]).default("before").optional(),
                    start_line: __ZOD__.any().optional(),
                    end_line: __ZOD__.any().optional(),
                    diff: __ZOD__.string().optional().describe("Unified diff hunk for this edit"),
                    pattern: __ZOD__.string().optional().describe("Regex pattern to match (use with new_string)")
                })).min(1).optional().describe("Batch edits: array of edit operations (any mode)")
            })
            `;

			try {
				const replaceAllProp = schemaObject.properties.find(
					(p: any) => t.isIdentifier(p.key) && p.key.name === "replace_all",
				);
				if (replaceAllProp) {
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

		const newPrompt = `Edit files using multiple modes: string replace, line insert, range replace, unified diff, regex, or batch.

Usage:
- The file_path parameter must be an absolute path, not a relative path
- Use ast-grep for code search and Read to view files before editing
- Preserve indentation exactly as shown after the line-number prefix from Read output
- Prefer editing existing files; don't create new files unless explicitly requested
- File encoding (UTF-8/UTF-16) and line endings (CRLF/LF) are auto-detected and preserved

Modes (choose one per edit):

**String replace** (old_string/new_string):
- Best for targeted changes where you have unique context
- Fuzzy matching: auto-normalizes smart quotes (\u2018\u2019\u201C\u201D \u2192 '") and trailing whitespace
- If old_string matches multiple locations, add more context lines to make it unique
- Use \`replace_all: true\` for intentional bulk replacements (e.g., renaming a variable)
- Empty old_string with new_string auto-appends to end of file

**Line insert** (line_number + new_string):
- Insert new lines at a specific position without needing surrounding context
- line_number is 1-based; use \`line_position: "after"\` to insert after the line (default: "before")
- Great for adding imports, new functions, or comments at known positions
- Line numbers beyond file length append to end; values < 1 are clamped to 1

**Range replace** (start_line/end_line + new_string):
- Replace entire line ranges when you know exact line numbers from Read output
- start_line and end_line are 1-based and inclusive
- Use empty new_string to delete lines; omit end_line to replace a single line
- Out-of-bounds lines are clamped to valid range

**Unified diff** (diff):
- Apply multiple related changes in one operation using standard diff format
- Can include multiple @@ hunks in a single diff for scattered changes
- Each hunk is converted to a string replace (context + removed lines \u2192 old_string, context + added lines \u2192 new_string)
- Same fuzzy matching and uniqueness checking as string replace mode

**Regex** (pattern + new_string):
- Pattern-based replacements with capture group support
- Supports \`/pattern/flags\` format or plain pattern string
- Use \`replace_all: true\` for global replacement (adds 'g' flag)
- Capture groups: $1, $2, etc. in new_string are interpolated

**Batch edits** (edits[]):
- Combine multiple operations in a single tool call
- Each entry can use any mode (string, line, range, diff, regex)
- Edits are sorted automatically: content-based first, then line-based bottom-up
- Useful for refactoring multiple related locations atomically

Diff format reference:
\`\`\`
@@ -10,4 +10,5 @@
 context line (unchanged)
-removed line
+added line
 context line (unchanged)
\`\`\`

Examples:
- String replace: \`{ file_path: "/path/file.ts", old_string: "const x = 1;", new_string: "const x = 2;" }\`
- Bulk rename: \`{ file_path: "/path/file.ts", old_string: "oldName", new_string: "newName", replace_all: true }\`
- Append to file: \`{ file_path: "/path/file.ts", old_string: "", new_string: "// appended content" }\`
- Line insert: \`{ file_path: "/path/file.ts", line_number: 1, new_string: "import { foo } from 'bar';" }\`
- Insert after: \`{ file_path: "/path/file.ts", line_number: 10, line_position: "after", new_string: "// TODO: refactor" }\`
- Range replace: \`{ file_path: "/path/file.ts", start_line: 15, end_line: 20, new_string: "// simplified" }\`
- Delete lines: \`{ file_path: "/path/file.ts", start_line: 5, end_line: 8, new_string: "" }\`
- Regex: \`{ file_path: "/path/file.ts", pattern: "console\\\\.log\\\\(.*?\\\\);?", new_string: "", replace_all: true }\`
- Regex capture: \`{ file_path: "/path/file.ts", pattern: "version: '(\\\\d+)\\\\.(\\\\d+)'", new_string: "version: '$1.$2.0'" }\`
- Unified diff:
  \`{ file_path: "/path/file.ts", diff: "@@ -5,3 +5,4 @@\\n function foo() {\\n-  return 1;\\n+  // Updated\\n+  return 2;\\n }" }\`
- Multi-hunk diff:
  \`{ file_path: "/path/file.ts", diff: "@@ -1,2 +1,2 @@\\n-old header\\n+new header\\n context\\n@@ -50,2 +50,2 @@\\n context\\n-old footer\\n+new footer" }\`
- Batch edits:
  \`{ file_path: "/path/file.ts", edits: [
    { old_string: "foo", new_string: "bar" },
    { line_number: 1, new_string: "// Header comment" },
    { start_line: 100, end_line: 105, new_string: "" }
  ] }\`

Error recovery:
- "old_string matches N locations": Add more surrounding lines to old_string for uniqueness
- "String not found": Check for smart quotes, trailing spaces, or use Read to verify exact content
- "Diff hunk not found": Context lines may have changed; re-read file or use batch edits instead
- "File not read yet": Use Read tool before editing to establish file state
- "File modified since read": File changed externally; re-read with Read tool before retrying
- For complex multi-site changes, prefer batch edits or multiple tool calls over large diffs`;

		patchPreprocessingSwitch(ast, toolVarName);
		patchApprovalDialog(ast);

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
	},

	verify: (code) => {
		if (!code.includes("line_number")) {
			return "Missing line_number field in Edit schema";
		}
		if (!code.includes("EXTENDED_EDIT_PREVIEW_v1")) {
			return "Missing Edit approval preview marker injection";
		}
		if (!code.includes("Edit files using multiple modes")) {
			return "Missing updated Edit tool description";
		}
		if (!code.includes("Diff format reference")) {
			return "Missing diff format reference section";
		}
		if (!code.includes("Error recovery")) {
			return "Missing error recovery guidance";
		}
		if (!code.includes("Fuzzy matching")) {
			return "Missing fuzzy matching documentation";
		}
		if (!code.includes("_claudeApplyExtendedFileEdits")) {
			return "Missing injected edit hook (edit_hook.js not appended to AST)";
		}
		return true;
	},
};
