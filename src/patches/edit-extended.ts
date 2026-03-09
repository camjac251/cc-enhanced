import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import template from "@babel/template";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import { parse, print } from "../loader.js";
import type { Patch } from "../types.js";
import {
	getObjectKeyName,
	getObjectPropertyByName,
	getVerifyAst,
	hasObjectKeyName,
	isMemberPropertyName,
} from "./ast-helpers.js";

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

function findEditSchemaObject(ast: t.File): t.ObjectExpression | null {
	let found: t.ObjectExpression | null = null;
	traverse.default(ast, {
		ObjectExpression(path) {
			if (found) return;
			if (!isLikelyEditSchemaObject(path.node)) return;
			const filePathProp = getObjectPropertyByName(path.node, "file_path");
			const replaceAllProp = getObjectPropertyByName(path.node, "replace_all");
			if (!filePathProp || !replaceAllProp) return;
			if (
				!t.isExpression(filePathProp.value) ||
				!t.isExpression(replaceAllProp.value)
			) {
				return;
			}
			if (
				(!t.isCallExpression(filePathProp.value) &&
					!t.isMemberExpression(filePathProp.value)) ||
				(!t.isCallExpression(replaceAllProp.value) &&
					!t.isMemberExpression(replaceAllProp.value))
			) {
				return;
			}
			found = path.node;
			path.stop();
		},
	});
	return found;
}

function isLikelyEditSchemaObject(objectExpr: t.ObjectExpression): boolean {
	let hasFilePath = false;
	let hasOldString = false;
	let hasNewString = false;
	let hasReplaceAll = false;

	for (const prop of objectExpr.properties) {
		if (!t.isObjectProperty(prop)) continue;
		const keyName = getObjectKeyName(prop.key);
		if (keyName === "file_path") hasFilePath = true;
		if (keyName === "old_string") hasOldString = true;
		if (keyName === "new_string") hasNewString = true;
		if (keyName === "replace_all") hasReplaceAll = true;
	}

	return hasFilePath && hasOldString && hasNewString && hasReplaceAll;
}

function getEffectiveSchemaFieldProp(
	schemaObject: t.ObjectExpression,
	fieldName: string,
): t.ObjectProperty | null {
	for (let i = schemaObject.properties.length - 1; i >= 0; i -= 1) {
		const prop = schemaObject.properties[i];
		if (t.isObjectProperty(prop) && getObjectKeyName(prop.key) === fieldName) {
			return prop;
		}
	}
	return null;
}

function compactPrintedExpression(expr: t.Expression): string {
	return print(expr).replace(/\s+/g, "");
}

function schemaFieldHasCoercePositive(
	schemaObject: t.ObjectExpression,
	fieldName: string,
): boolean {
	const fieldProp = getEffectiveSchemaFieldProp(schemaObject, fieldName);
	if (!fieldProp || !t.isExpression(fieldProp.value)) return false;
	const compact = compactPrintedExpression(fieldProp.value);
	return (
		compact.includes(".coerce.number().int().positive()") ||
		compact.includes(".coerce.number().int().min(1)") ||
		compact.includes(".coerce.number().int().gte(1)")
	);
}

function schemaFieldUsesAny(
	schemaObject: t.ObjectExpression,
	fieldName: string,
): boolean {
	const fieldProp = getEffectiveSchemaFieldProp(schemaObject, fieldName);
	if (!fieldProp || !t.isExpression(fieldProp.value)) return false;
	const compact = compactPrintedExpression(fieldProp.value);
	return compact.includes(".any(") || compact.includes(".any()");
}

function inspectValidateExtendedBypass(ast: t.File): {
	hasBypass: boolean;
	hasFileReadsInBypass: boolean;
} {
	let hasBypass = false;
	let hasFileReadsInBypass = false;

	traverse.default(ast, {
		ObjectMethod(path) {
			if (getObjectKeyName(path.node.key) !== "validateInput") return;

			traverse.default(
				path.node.body,
				{
					IfStatement(ifPath) {
						const test = ifPath.node.test;
						if (!t.isCallExpression(test)) return;
						if (
							!t.isIdentifier(test.callee, {
								name: "_claudeEditHasExtendedFields",
							})
						) {
							return;
						}
						if (
							test.arguments.length !== 1 ||
							!t.isIdentifier(test.arguments[0], { name: "_input" })
						) {
							return;
						}
						if (!t.isBlockStatement(ifPath.node.consequent)) return;

						let sawNormalizeCall = false;
						let sawReturnTrue = false;
						let sawFileReads = false;

						traverse.default(
							ifPath.node.consequent,
							{
								CallExpression(callPath) {
									if (
										t.isIdentifier(callPath.node.callee, {
											name: "_claudeEditNormalizeEdits",
										})
									) {
										sawNormalizeCall = true;
									}
									if (
										t.isMemberExpression(callPath.node.callee) &&
										t.isIdentifier(callPath.node.callee.object, {
											name: "_claudeFs",
										}) &&
										t.isIdentifier(callPath.node.callee.property) &&
										(callPath.node.callee.property.name === "readFileSync" ||
											callPath.node.callee.property.name === "existsSync" ||
											callPath.node.callee.property.name === "statSync")
									) {
										sawFileReads = true;
									}
								},
								ReturnStatement(returnPath) {
									const arg = returnPath.node.argument;
									if (!arg || !t.isObjectExpression(arg)) return;
									const resultProp = getObjectPropertyByName(arg, "result");
									if (!resultProp) return;
									if (t.isBooleanLiteral(resultProp.value, { value: true })) {
										sawReturnTrue = true;
									}
								},
							},
							ifPath.scope,
							ifPath,
						);

						if (sawNormalizeCall && sawReturnTrue) {
							hasBypass = true;
						}
						if (sawFileReads) {
							hasFileReadsInBypass = true;
						}
					},
				},
				path.scope,
				path,
			);
		},
	});

	return { hasBypass, hasFileReadsInBypass };
}

function isInputFieldTypeofStringCheck(
	test: t.Expression,
	fieldName: string,
): boolean {
	if (!t.isBinaryExpression(test, { operator: "===" })) return false;
	if (!t.isStringLiteral(test.right, { value: "string" })) return false;
	if (!t.isUnaryExpression(test.left, { operator: "typeof" })) return false;
	if (!t.isMemberExpression(test.left.argument)) return false;
	const member = test.left.argument;
	if (!t.isIdentifier(member.object, { name: "_input" })) return false;
	return isMemberPropertyName(member, fieldName);
}

function hasStructuredHintOldNewGuard(ast: t.File): boolean {
	let hasGuard = false;

	traverse.default(ast, {
		IfStatement(path) {
			const test = path.node.test;
			if (!t.isUnaryExpression(test, { operator: "!" })) return;
			if (!t.isIdentifier(test.argument, { name: "hasStructuredHint" })) return;
			if (!t.isBlockStatement(path.node.consequent)) return;

			let oldStringGuarded = false;
			let newStringGuarded = false;

			traverse.default(
				path.node.consequent,
				{
					AssignmentExpression(assignPath) {
						if (assignPath.node.operator !== "=") return;
						if (!t.isMemberExpression(assignPath.node.left)) return;
						if (
							!t.isIdentifier(assignPath.node.left.object, {
								name: "_input",
							})
						) {
							return;
						}
						if (!t.isConditionalExpression(assignPath.node.right)) return;

						if (
							isMemberPropertyName(assignPath.node.left, "old_string") &&
							isInputFieldTypeofStringCheck(
								assignPath.node.right.test,
								"old_string",
							)
						) {
							oldStringGuarded = true;
						}
						if (
							isMemberPropertyName(assignPath.node.left, "new_string") &&
							isInputFieldTypeofStringCheck(
								assignPath.node.right.test,
								"new_string",
							)
						) {
							newStringGuarded = true;
						}
					},
				},
				path.scope,
				path,
			);

			if (oldStringGuarded && newStringGuarded) {
				hasGuard = true;
				path.stop();
			}
		},
	});

	return hasGuard;
}

function hasRegexGlobalFlagStrip(ast: t.File): boolean {
	let found = false;

	traverse.default(ast, {
		CallExpression(path) {
			if (!t.isMemberExpression(path.node.callee)) return;
			if (!isMemberPropertyName(path.node.callee, "replace")) return;
			if (path.node.arguments.length < 2) return;
			const [arg0, arg1] = path.node.arguments;
			if (!t.isRegExpLiteral(arg0)) return;
			if (arg0.pattern !== "g" || arg0.flags !== "g") return;
			if (!t.isStringLiteral(arg1, { value: "" })) return;
			found = true;
			path.stop();
		},
	});

	return found;
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
			let patched = false;

			for (let i = 0; i < blockStmt.body.length; i++) {
				const stmt = blockStmt.body[i];
				if (!t.isVariableDeclaration(stmt)) continue;
				if (stmt.declarations.length < 2) continue;

				const firstDecl = stmt.declarations[0];
				const secondDecl = stmt.declarations[1];
				const remainingDecls = stmt.declarations.slice(2);

				if (!t.isIdentifier(firstDecl.id)) continue;
				if (!t.isObjectPattern(secondDecl.id)) continue;

				const inputVarName = firstDecl.id.name;

				const stmt1 = t.variableDeclaration(stmt.kind, [firstDecl]);
				const stmt2 = t.variableDeclaration(stmt.kind, [secondDecl]);
				const stmt3 =
					remainingDecls.length > 0
						? t.variableDeclaration(stmt.kind, remainingDecls)
						: null;

				const buildExtendedFieldCheck = template.default.statements(
					`
					if (INPUT.line_number !== undefined || INPUT.lineNumber !== undefined ||
						INPUT.start_line !== undefined || INPUT.startLine !== undefined ||
						INPUT.end_line !== undefined || INPUT.endLine !== undefined ||
						INPUT.diff !== undefined ||
						INPUT.pattern !== undefined ||
						(Array.isArray(INPUT.edits) && INPUT.edits.length > 0)) {
						return INPUT;
					}
				`,
					{ placeholderPattern: /^INPUT$/ },
				);
				const extendedFieldCheck = buildExtendedFieldCheck({
					INPUT: t.identifier(inputVarName),
				});

				blockStmt.body.splice(
					i,
					1,
					stmt1,
					...extendedFieldCheck,
					stmt2,
					...(stmt3 ? [stmt3] : []),
				);
				patched = true;
				break;
			}

			if (patched) {
				path.stop();
			}
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
							t.isObjectProperty(p) && hasObjectKeyName(p, "old_string"),
					) as t.ObjectProperty | undefined;
					const newProp = el.properties.find(
						(p: any) =>
							t.isObjectProperty(p) && hasObjectKeyName(p, "new_string"),
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

			const buildPatchCode = template.default.statements(
				`
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

                            const _normalized = _claudeEditNormalizeEdits(INPUT);
                            if (
                                !_normalized.error &&
                                _normalized.edits &&
                                _normalized.edits.length > 0
                            ) {
                                const _previewResult = _claudeApplyExtendedFileEdits(
                                    _content,
                                    _normalized.edits,
                                );
                                if (!_previewResult.error) {
                                    OLD_VAR = _content;
                                    NEW_VAR = _previewResult.content;
                                }
                            }
                        }
                    } catch (_e) {}

                    if (typeof OLD_VAR !== "string") OLD_VAR = "";
                    if (typeof NEW_VAR !== "string") NEW_VAR = "";
            `,
				{ placeholderPattern: /^ARG$|^OLD_VAR$|^NEW_VAR$/ },
			);

			const patchCode = buildPatchCode({
				ARG: t.identifier(argName),
				OLD_VAR: t.identifier(oldStringVarName),
				NEW_VAR: t.identifier(newStringVarName),
			});

			insertBeforePath.insertBefore(patchCode);
		},
	});
}

function getObjectPropertyName(
	prop: t.ObjectProperty | t.ObjectMethod,
): string | null {
	const key = prop.key;
	if (t.isIdentifier(key)) return key.name;
	if (t.isStringLiteral(key)) return key.value;
	return null;
}

function resolveToolName(path: any): string | null {
	const nameProp = path.node.properties.find(
		(p: any): p is t.ObjectProperty =>
			t.isObjectProperty(p) && getObjectPropertyName(p) === "name",
	);
	if (!nameProp) return null;

	if (t.isStringLiteral(nameProp.value)) return nameProp.value.value;
	if (!t.isIdentifier(nameProp.value)) return null;

	const binding = path.scope.getBinding(nameProp.value.name);
	const bindingNode = binding?.path?.node;
	if (
		t.isVariableDeclarator(bindingNode) &&
		t.isStringLiteral(bindingNode.init)
	) {
		return bindingNode.init.value;
	}
	return null;
}

function isReadStateGuardObject(expr: t.ObjectExpression): boolean {
	return expr.properties.some((prop) => {
		if (!t.isObjectProperty(prop)) return false;
		if (getObjectPropertyName(prop) !== "message") return false;
		if (!t.isStringLiteral(prop.value)) return false;
		return (
			prop.value.value.includes("File has not been read yet") ||
			prop.value.value.includes("File has been modified since read")
		);
	});
}

function patchReadStateGuards(ast: any): void {
	traverse.default(ast, {
		ObjectExpression(path: any) {
			const toolName = resolveToolName(path);
			if (toolName !== "Edit" && toolName !== "Write") return;

			const validateMethod = path.node.properties.find(
				(p: any): p is t.ObjectMethod =>
					t.isObjectMethod(p) && getObjectPropertyName(p) === "validateInput",
			);
			if (validateMethod) {
				traverse.default(
					validateMethod.body,
					{
						ReturnStatement(retPath: any) {
							if (
								!retPath.node.argument ||
								!t.isObjectExpression(retPath.node.argument)
							)
								return;
							if (!isReadStateGuardObject(retPath.node.argument)) return;

							retPath.node.argument = t.objectExpression([
								t.objectProperty(
									t.identifier("result"),
									t.booleanLiteral(true),
								),
							]);
						},
					},
					path.scope,
					path,
				);
			}

			const callMethod = path.node.properties.find(
				(p: any): p is t.ObjectMethod =>
					t.isObjectMethod(p) && getObjectPropertyName(p) === "call",
			);
			if (callMethod) {
				traverse.default(
					callMethod.body,
					{
						IfStatement(ifPath: any) {
							const test = ifPath.node.test;
							if (!t.isLogicalExpression(test, { operator: "||" })) return;
							if (!t.isUnaryExpression(test.left, { operator: "!" })) return;
							if (!t.isIdentifier(test.left.argument)) return;
							if (!t.isBinaryExpression(test.right, { operator: ">" })) return;
							if (!t.isMemberExpression(test.right.right)) return;
							if (!t.isIdentifier(test.right.right.object)) return;
							if (!isMemberPropertyName(test.right.right, "timestamp")) return;

							const stateVar = test.left.argument.name;
							if (test.right.right.object.name !== stateVar) return;

							ifPath.node.test = t.logicalExpression(
								"&&",
								t.identifier(stateVar),
								t.cloneNode(test.right),
							);
						},
					},
					path.scope,
					path,
				);
			}
		},
	});
}

const _appliedAsts = new WeakSet<t.File>();

function runEditToolPatch(ast: t.File): void {
	// Prevent double-injection if called multiple times on same AST
	if (_appliedAsts.has(ast)) return;
	_appliedAsts.add(ast);

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
					if (t.isAssignmentExpression(p.node) && t.isIdentifier(p.node.left)) {
						toolVarName = p.node.left.name;
						break;
					}
					p = p.parentPath;
				}
			}
		},
		ObjectExpression(path: any) {
			if (schemaObject || !isLikelyEditSchemaObject(path.node)) return;
			const filePathProp = getObjectPropertyByName(path.node, "file_path");
			const replaceAllProp = getObjectPropertyByName(path.node, "replace_all");
			if (!filePathProp || !replaceAllProp) return;
			if (
				!t.isExpression(filePathProp.value) ||
				!t.isExpression(replaceAllProp.value)
			) {
				return;
			}
			if (
				(t.isCallExpression(filePathProp.value) ||
					t.isMemberExpression(filePathProp.value)) &&
				(t.isCallExpression(replaceAllProp.value) ||
					t.isMemberExpression(replaceAllProp.value))
			) {
				schemaObject = path.node;
			}
		},
		ObjectMethod(path: any) {
			if (getObjectKeyName(path.node.key) === "description") {
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
		if (!fs.existsSync(templatePath)) {
			throw new Error(`edit_hook.js template not found at ${templatePath}`);
		}
		{
			const hookCode = fs
				.readFileSync(templatePath, "utf-8")
				.replace(/\nexport\s*\{\s*\};?\s*$/, "\n");
			const runtimeHookCode = adaptHookCodeForRuntime(hookCode);
			const hookAst = parse(runtimeHookCode);

			if (ast.program?.body) {
				ast.program.body.push(...hookAst.program.body);
			}

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

                    const hasOwn = (k) => Object.prototype.hasOwnProperty.call(_input, k);
                    const hasStructuredHint = hasOwn("line_number") || hasOwn("start_line") || hasOwn("end_line") || hasOwn("diff") || hasOwn("pattern") ||
                        (Array.isArray(_input.edits) && _input.edits.length > 0);
                    if (!hasStructuredHint) {
                        _input.old_string = typeof _input.old_string === "string" ? _input.old_string : (_input.old_string ?? "");
                        _input.new_string = typeof _input.new_string === "string" ? _input.new_string : (_input.new_string ?? "");
                    }
                    if (_claudeEditHasExtendedFields(_input)) {
                        let Q = _claudeEditNormalizeEdits(_input);
                        if (Q.error) return Q.error;
                        const _resolvedPath = _claudeResolvePath(String(_input.file_path || ""));
                        const _normalizedPath = String(_resolvedPath || "").toLowerCase();
                        if (_normalizedPath.endsWith(".ipynb")) {
                            return {
                                result: false,
                                behavior: "ask",
                                message: "File is a Jupyter Notebook. Use the NotebookEdit tool to edit this file.",
                                errorCode: 5
                            };
                        }
                        return { result: true };
                    }
                }`;

			const callLogic = `
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

                    const hasOwn = (k) => Object.prototype.hasOwnProperty.call(_input, k);
                    const hasStructuredHint = hasOwn("line_number") || hasOwn("start_line") || hasOwn("end_line") || hasOwn("diff") || hasOwn("pattern") ||
                        (Array.isArray(_input.edits) && _input.edits.length > 0);
                    if (!hasStructuredHint) {
                        _input.old_string = typeof _input.old_string === "string" ? _input.old_string : (_input.old_string ?? "");
                        _input.new_string = typeof _input.new_string === "string" ? _input.new_string : (_input.new_string ?? "");
                    }
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
                        _input.old_string = W;
                        _input.new_string = L.content;
                        _input.replace_all = false;
                    }
                    _args[0] = _input;
                }`;

			const validateMethod = editToolObj.properties.find(
				(p: any) =>
					t.isObjectMethod(p) && getObjectKeyName(p.key) === "validateInput",
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

				const logicAst = template.default.statements(validateLogic, {
					placeholderPattern: false,
				})();
				validateMethod.body.body.unshift(restoreParams);
				validateMethod.body.body.unshift(...logicAst);
			}

			const callMethod = editToolObj.properties.find(
				(p: any) => t.isObjectMethod(p) && getObjectKeyName(p.key) === "call",
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

				const logicAst = template.default.statements(callLogic, {
					placeholderPattern: false,
				})();

				callMethod.body.body.unshift(restoreParams);
				callMethod.body.body.unshift(...initVars);
				callMethod.body.body.splice(2, 0, ...logicAst);
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
					getObjectKeyName(p.key) === "mapToolResultToToolResultBlockParam",
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

				const logicAst = template.default.statements(mapResultLogic, {
					placeholderPattern: false,
				})();
				mapMethod.body.body.unshift(restoreParams);
				mapMethod.body.body.splice(1, 0, ...logicAst);
			}

			const eqMethod = editToolObj.properties.find(
				(p: any) =>
					t.isObjectMethod(p) && getObjectKeyName(p.key) === "inputsEquivalent",
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
				const logicAst = template.default.statements(eqLogic, {
					placeholderPattern: false,
				})();
				eqMethod.body.body.unshift(...logicAst);
			}
		}
	}

	if (schemaObject && t.isObjectExpression(schemaObject)) {
		const schemaExtensionCode = `
            ({
                line_number: __ZOD__.coerce.number().int().positive().optional().describe("Line insert: 1-based line number for insertion point"),
                line_position: __ZOD__.enum(["before", "after"]).default("before").optional().describe("Insert before (default) or after the line"),
                start_line: __ZOD__.coerce.number().int().positive().optional().describe("Range replace: start line (1-based)"),
                end_line: __ZOD__.coerce.number().int().positive().optional().describe("Range replace: end line (inclusive)"),
                diff: __ZOD__.string().optional().describe("Unified diff: apply patch with @@ -old +new @@ headers"),
                pattern: __ZOD__.string().optional().describe("Regex pattern to match (use with new_string for replacement)"),
                edits: __ZOD__.array(__ZOD__.strictObject({
                    old_string: __ZOD__.string().optional().describe("Text to replace (string mode)"),
                    new_string: __ZOD__.string().optional().describe("Replacement text"),
                    replace_all: __ZOD__.boolean().default(false).optional(),
                    line_number: __ZOD__.coerce.number().int().positive().optional(),
                    line_position: __ZOD__.enum(["before", "after"]).default("before").optional(),
                    start_line: __ZOD__.coerce.number().int().positive().optional(),
                    end_line: __ZOD__.coerce.number().int().positive().optional(),
                    diff: __ZOD__.string().optional().describe("Unified diff hunk for this edit"),
                    pattern: __ZOD__.string().optional().describe("Regex pattern to match (use with new_string)")
                })).min(1).optional().describe("Batch edits: array of edit operations (any mode)")
            })
            `;

		try {
			const replaceAllProp = schemaObject.properties.find(
				(p: any) => t.isObjectProperty(p) && hasObjectKeyName(p, "replace_all"),
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

				const schemaExtensionSource = schemaExtensionCode.replaceAll(
					"__ZOD__",
					zodVar,
				);
				const extAst = template.default.expression(schemaExtensionSource, {
					placeholderPattern: false,
				})() as any;
				if (!t.isObjectExpression(extAst)) {
					throw new Error(
						"Edit schema extension template did not produce an object expression",
					);
				}
				schemaObject.properties.push(...extAst.properties);

				for (const fieldName of ["old_string", "new_string"]) {
					const prop = schemaObject.properties.find(
						(p: any) => t.isObjectProperty(p) && hasObjectKeyName(p, fieldName),
					);
					if (prop) {
						const code = print((prop as any).value);
						if (!code.includes("optional()")) {
							(prop as any).value = template.default.expression(
								`(${code}).optional()`,
								{ placeholderPattern: false },
							)();
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
- The file_path parameter must be an absolute path, not relative
- Use Read when helpful to verify exact file context before editing
- Preserve indentation exactly as shown after Read line-number prefixes
- Prefer editing existing files; do not create new files unless explicitly requested
- Only use emojis if the user explicitly requests them
- File encoding (UTF-8/UTF-16) and line endings (LF/CRLF) are preserved automatically

Modes (choose one explicit mode per edit entry):

**String replace** (old_string/new_string):
- Best when you can provide unique surrounding context
- Fuzzy matching normalizes smart quotes and trailing whitespace
- Use replace_all:true only for intentional bulk changes
- If old_string is not unique, add surrounding context or use replace_all intentionally
- Empty old_string with non-empty new_string appends content

**Line insert** (line_number + new_string):
- line_number is 1-based
- Use line_position:"after" to insert below the line (default: "before")
- Good for imports, comments, or small additions at known locations
- Line numbers beyond file length append to the end of file

**Range replace** (start_line/end_line + new_string):
- start_line/end_line are 1-based and inclusive
- end_line is optional (single-line replace when omitted)
- Use new_string:"" to delete a line range
- start_line/end_line must be positive integers; invalid values are rejected
- start_line beyond file length is rejected (use line mode for append semantics)

**Unified diff** (diff):
- Use standard hunks with @@ -old,+new @@ headers
- Supports multiple hunks in one edit entry
- Useful for grouped non-adjacent edits
- Hunks are converted into string-replace operations and use the same fuzzy/uniqueness rules as string mode

**Regex** (pattern + new_string):
- Supports /pattern/flags or plain pattern syntax
- replace_all:true enables global replacement behavior
- Capture groups ($1, $2, ...) can be referenced in new_string

**Batch edits** (edits[]):
- Multiple operations in one call
- Each entry must declare exactly one explicit mode key:
  diff, pattern, line_number, or start_line/end_line

Field rules:
- line_number/start_line/end_line are 1-based positive integers
- Exactly one explicit mode key is allowed per edit entry
- Fuzzy matching is applied in string mode

Diff format reference:
\`\`\`
@@ -10,4 +10,5 @@
 context line
-old line
+new line
 context line
\`\`\`

Examples:
- String replace: \`{ file_path: "/abs/path/file.ts", old_string: "const x = 1;", new_string: "const x = 2;" }\`
- Bulk rename: \`{ file_path: "/abs/path/file.ts", old_string: "oldName", new_string: "newName", replace_all: true }\`
- Append content: \`{ file_path: "/abs/path/file.ts", old_string: "", new_string: "// appended content" }\`
- Line insert: \`{ file_path: "/abs/path/file.ts", line_number: 1, new_string: "import { foo } from 'bar';" }\`
- Insert after line: \`{ file_path: "/abs/path/file.ts", line_number: 10, line_position: "after", new_string: "// TODO: refactor" }\`
- Range replace: \`{ file_path: "/abs/path/file.ts", start_line: 15, end_line: 20, new_string: "// simplified block" }\`
- Range delete: \`{ file_path: "/abs/path/file.ts", start_line: 5, end_line: 8, new_string: "" }\`
- Regex replace: \`{ file_path: "/abs/path/file.ts", pattern: "console\\\\.log\\\\(.*?\\\\);?", new_string: "", replace_all: true }\`
- Regex capture: \`{ file_path: "/abs/path/file.ts", pattern: "version: '(\\\\d+)\\\\.(\\\\d+)'", new_string: "version: '$1.$2.0'" }\`
- Unified diff: \`{ file_path: "/abs/path/file.ts", diff: "@@ -5,3 +5,4 @@\\n function foo() {\\n-  return 1;\\n+  // Updated\\n+  return 2;\\n }" }\`
- Multi-hunk diff: \`{ file_path: "/abs/path/file.ts", diff: "@@ -1,2 +1,2 @@\\n-old header\\n+new header\\n context\\n@@ -50,2 +50,2 @@\\n context\\n-old footer\\n+new footer" }\`
- Batch edits: \`{ file_path: "/abs/path/file.ts", edits: [{ old_string: "foo", new_string: "bar" }, { line_number: 1, new_string: "// Header" }, { start_line: 100, end_line: 105, new_string: "" }] }\`

Error recovery:
- "old_string matches N locations": add surrounding context or use replace_all:true
- "String not found": re-read file and copy exact text
- "Diff hunk not found": refresh context and regenerate hunks
- "File modified since read": run Read again, then retry Edit
- For large multi-site changes, prefer batch edits or multiple targeted calls over one very large diff`;

	patchPreprocessingSwitch(ast, toolVarName);
	patchApprovalDialog(ast);
	patchReadStateGuards(ast);

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
			} else if (path.node.value === "File has not been read yet") {
				path.node.value = "Read-state validation failed";
			} else if (path.node.value === "File must be read first") {
				path.node.value = "Error editing file";
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
						t.isObjectProperty(p) && hasObjectKeyName(p, "structuredPatch"),
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

interface EditVerifyContext {
	code: string;
	ast: t.File;
	schemaObject: t.ObjectExpression;
}

function verifyEditSchema(ctx: EditVerifyContext): string | null {
	const { code, schemaObject } = ctx;
	if (!code.includes("line_number")) {
		return "Missing line_number field in Edit schema";
	}
	if (!schemaFieldHasCoercePositive(schemaObject, "line_number")) {
		return "line_number is not typed with coercing number schema";
	}
	if (!schemaFieldHasCoercePositive(schemaObject, "start_line")) {
		return "start_line is not typed with coercing number schema";
	}
	if (!schemaFieldHasCoercePositive(schemaObject, "end_line")) {
		return "end_line is not typed with coercing number schema";
	}
	if (
		schemaFieldUsesAny(schemaObject, "line_number") ||
		schemaFieldUsesAny(schemaObject, "start_line") ||
		schemaFieldUsesAny(schemaObject, "end_line")
	) {
		return "Line/range fields still use any() in Edit schema";
	}
	if (!code.includes("Each edit must specify exactly one explicit mode")) {
		return "Missing explicit mode exclusivity validation";
	}
	if (!code.includes("old_string cannot be empty when replace_all is true")) {
		return "Missing empty-old-string replace_all guard";
	}
	if (
		!code.includes("Invalid regex mode: pattern must be a non-empty string.")
	) {
		return "Missing invalid-empty regex pattern guard";
	}
	if (!code.includes("Invalid diff mode: diff must be a non-empty string.")) {
		return "Missing invalid-empty diff guard";
	}
	if (
		!code.includes("Invalid line mode: line_number must be a positive integer.")
	) {
		return "Missing invalid line_number guard";
	}
	if (
		!code.includes(
			"Invalid range mode: start_line/end_line must be positive integers.",
		)
	) {
		return "Missing invalid range mode guard";
	}
	// Check for the guard variables (semantic names from template, not minified vars)
	if (!code.includes("hasStartKey")) {
		return "Missing start_line null guard for explicit range mode";
	}
	if (!code.includes("hasEndKey")) {
		return "Missing end_line null guard for explicit range mode";
	}
	if (
		!code.includes(
			"Invalid range mode: start_line is required when end_line is provided.",
		)
	) {
		return "Missing end_line without start_line guard";
	}
	return null;
}

function verifyEditPromptAndHook(ctx: EditVerifyContext): string | null {
	const { code, ast } = ctx;
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
	if (!code.includes("Only use emojis if the user explicitly requests")) {
		return "Missing upstream emoji usage constraint";
	}
	if (!code.includes("_claudeApplyExtendedFileEdits")) {
		return "Missing injected edit hook (edit_hook.js not appended to AST)";
	}
	if (!code.includes("_previewResult")) {
		return "Preview block does not use unified normalize+apply pipeline";
	}
	if (code.includes("_previewLineInsert") || code.includes("_previewRange")) {
		return "Legacy per-mode preview generators still present";
	}
	if (!code.includes("Number.isInteger(C)")) {
		return "Line sanitizer no longer enforces integer-only line/range values";
	}
	if (code.includes("C = Math.floor(C)")) {
		return "Line sanitizer still floors non-integer line/range values";
	}
	if (code.includes("if (C < 1) C = 1")) {
		return "Line sanitizer still clamps non-positive line/range values to 1";
	}
	if (
		!code.includes(
			"Unsupported diff hunk: pure insertion hunks must include at least one context or removal line.",
		)
	) {
		return "Missing pure-insertion diff hunk guard";
	}
	if (!hasRegexGlobalFlagStrip(ast)) {
		return "Regex mode still allows /.../g to bypass replace_all semantics";
	}
	if (
		!code.includes(
			"old_string cannot be combined with explicit modes (diff, pattern, line_number, start_line/end_line).",
		)
	) {
		return "Missing mixed old_string + explicit-mode guard";
	}
	if (code.includes("Values beyond file length are clamped to file bounds")) {
		return "Prompt still claims range overflow clamping";
	}
	return null;
}

function verifyEditValidateAndCallFlow(ctx: EditVerifyContext): string | null {
	const { code, ast } = ctx;
	if (
		!code.includes(
			"provide either explicit mode fields (diff/pattern/line_number/start_line) or string mode fields (old_string/new_string).",
		)
	) {
		return "Missing empty-edit payload guard";
	}
	if (
		!code.includes(
			"old_string and new_string cannot both be empty. Use range/line mode for positional edits.",
		)
	) {
		return "Missing empty-string no-op guard";
	}
	if (
		!code.includes(
			"Invalid range: start_line exceeds file length. Use line mode for append-after-end behavior.",
		)
	) {
		return "Missing range start overflow guard";
	}
	if (
		!code.includes(
			"Invalid range: start_line exceeds file length. Use start_line:1 for empty files or line mode to append.",
		)
	) {
		return "Missing empty-file range start overflow guard";
	}

	const validateBypass = inspectValidateExtendedBypass(ast);
	if (validateBypass.hasFileReadsInBypass) {
		return "validateInput still performs file reads during extended mode preprocessing";
	}
	if (!validateBypass.hasBypass) {
		return "validateInput does not bypass legacy string-mode checks for extended edit modes";
	}
	if (
		!code.includes("toLowerCase().endsWith(") ||
		!code.includes(".ipynb") ||
		!code.includes("NotebookEdit")
	) {
		return "Extended validate bypass does not preserve structural notebook edit rejection";
	}
	if (code.includes("_claudeWriteFile(J, L.content, encoding, H)")) {
		return "Legacy extended call path still writes files directly";
	}
	if (
		code.includes(
			"_context.readFileState.set(J, { content: L.content, timestamp: Date.now() })",
		)
	) {
		return "Legacy extended call path still mutates readFileState directly";
	}
	if (!code.includes("_input.old_string = W;")) {
		return "Extended call path does not canonicalize old_string from current file";
	}
	if (!code.includes("_input.new_string = L.content;")) {
		return "Extended call path does not canonicalize new_string from transformed content";
	}
	if (!code.includes("_input.replace_all = false;")) {
		return "Extended call path does not force replace_all=false after canonicalization";
	}
	if (!code.includes("_args[0] = _input;")) {
		return "Extended call preprocess does not propagate normalized input back into call arguments";
	}
	if (code.includes("File must be read first")) {
		return "Read-first guard display text still present";
	}
	if (code.includes("File has not been read yet")) {
		return "Read-first guard matcher text still present";
	}
	return null;
}

function verifyEditAliasNormalization(ctx: EditVerifyContext): string | null {
	const { code, ast } = ctx;
	if (!code.includes('hasOwn("pattern")')) {
		return "Extended call/validate preprocess does not treat regex pattern as structured mode";
	}
	if (!code.includes("start_line: A.start_line ?? A.startLine")) {
		return "Top-level edit normalization is missing startLine -> start_line alias support";
	}
	if (!code.includes("end_line: A.end_line ?? A.endLine")) {
		return "Top-level edit normalization is missing endLine -> end_line alias support";
	}
	if (!code.includes("line_number: A.line_number ?? A.lineNumber")) {
		return "Top-level edit normalization is missing lineNumber -> line_number alias support";
	}
	if (!code.includes("lineNumber !== undefined")) {
		return "Preprocessing switch guard missing lineNumber alias";
	}
	if (!code.includes("startLine !== undefined")) {
		return "Preprocessing switch guard missing startLine alias";
	}
	if (!code.includes("endLine !== undefined")) {
		return "Preprocessing switch guard missing endLine alias";
	}
	if (!hasStructuredHintOldNewGuard(ast)) {
		return "Top-level explicit modes can still be broken by unconditional old_string coercion";
	}
	return null;
}

export const editTool: Patch = {
	tag: "edit-extended",

	astPasses: (ast) => [
		{
			pass: "mutate",
			visitor: {
				Program: {
					exit() {
						runEditToolPatch(ast);
					},
				},
			},
		},
	],

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) {
			return "Unable to parse AST during edit-extended verification";
		}
		const schemaObject = findEditSchemaObject(verifyAst);
		if (!schemaObject) {
			return "Unable to resolve Edit schema object for verification";
		}
		const context: EditVerifyContext = {
			code,
			ast: verifyAst,
			schemaObject,
		};
		const validators = [
			verifyEditSchema,
			verifyEditPromptAndHook,
			verifyEditValidateAndCallFlow,
			verifyEditAliasNormalization,
		];
		for (const validator of validators) {
			const result = validator(context);
			if (result) return result;
		}
		return true;
	},
};
