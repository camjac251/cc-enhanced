import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import template from "@babel/template";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import { parse } from "../loader.js";
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

const EXTENDED_EDIT_TRANSPORT_PREFIX = "__claude_edit_extended_v1__:";
const EXTENDED_EDIT_TRANSPORT_DECODE = "_claudeDecodeExtendedEditTransport";

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

function findNamedToolObjectPath(ast: t.File, toolName: string): any {
	let found: any = null;
	traverse.default(ast, {
		ObjectExpression(path) {
			if (found) return;
			if (resolveToolName(path) !== toolName) return;
			found = path;
			path.stop();
		},
	});
	return found;
}

function getToolObjectMethod(
	toolObject: t.ObjectExpression,
	methodName: string,
): t.ObjectMethod | null {
	return (
		toolObject.properties.find(
			(prop): prop is t.ObjectMethod =>
				t.isObjectMethod(prop) && getObjectKeyName(prop.key) === methodName,
		) ?? null
	);
}

function inspectValidateExtendedFlow(validateMethod: t.ObjectMethod | null): {
	hasCanonicalization: boolean;
	hasEarlyReturnTrue: boolean;
} {
	let hasCanonicalization = false;
	let hasEarlyReturnTrue = false;
	if (!validateMethod) {
		return { hasCanonicalization, hasEarlyReturnTrue };
	}

	const validateWrapper = t.file(
		t.program([t.functionDeclaration(null, [], validateMethod.body)]),
	);

	traverse.default(validateWrapper, {
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
			let sawCanonicalizeCall = false;
			let sawReturnTrue = false;

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
							t.isIdentifier(callPath.node.callee, {
								name: "_claudeEditCanonicalizeInput",
							})
						) {
							sawCanonicalizeCall = true;
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

			if (sawNormalizeCall && sawCanonicalizeCall) {
				hasCanonicalization = true;
			}
			if (sawReturnTrue) {
				hasEarlyReturnTrue = true;
			}
		},
	});

	return { hasCanonicalization, hasEarlyReturnTrue };
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
                        const INPUT_RAW = ARG && ARG.toolUseConfirm ? ARG.toolUseConfirm.input : null;
                        const INPUT = ${EXTENDED_EDIT_TRANSPORT_DECODE}(INPUT_RAW);
                        const _hasExtended =
                            INPUT &&
                            _claudeEditHasExtendedFields(INPUT);

                        if (_hasExtended) {
                            const _previewResult = _claudeEditCanonicalizeInput(INPUT);
                            if (!_previewResult.error) {
                                OLD_VAR = _previewResult.oldString;
                                NEW_VAR = _previewResult.newString;
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

function patchReadStateGuards(ast: any): void {
	traverse.default(ast, {
		ObjectExpression(path: any) {
			const toolName = resolveToolName(path);
			if (toolName !== "Edit") return;

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
								t.logicalExpression(
									"||",
									t.unaryExpression("!", t.identifier(stateVar)),
									t.cloneNode(test.right),
								),
								t.unaryExpression(
									"!",
									t.callExpression(
										t.identifier("_claudeEditHasExtendedFields"),
										[t.identifier("_input")],
									),
								),
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

function patchIdeDiffConfigGuards(ast: t.File): void {
	traverse.default(ast, {
		ConditionalExpression(path: any) {
			if (!t.isNullLiteral(path.node.alternate)) return;
			if (!t.isCallExpression(path.node.consequent)) return;
			if (!t.isMemberExpression(path.node.consequent.callee)) return;
			if (
				!t.isIdentifier(path.node.consequent.callee.property, {
					name: "getConfig",
				})
			) {
				return;
			}
			if (path.node.consequent.arguments.length !== 1) return;
			const [parsedInput] = path.node.consequent.arguments;
			if (!t.isExpression(parsedInput)) return;

			const diffSupportRef = path.node.consequent.callee.object;
			if (
				!t.isIdentifier(diffSupportRef) ||
				!t.isIdentifier(path.node.test, { name: diffSupportRef.name })
			) {
				return;
			}

			path.node.consequent = t.conditionalExpression(
				t.callExpression(t.identifier("_claudeEditHasExtendedFields"), [
					t.callExpression(t.identifier(EXTENDED_EDIT_TRANSPORT_DECODE), [
						t.cloneNode(parsedInput),
					]),
				]),
				t.nullLiteral(),
				t.callExpression(
					t.memberExpression(
						t.cloneNode(diffSupportRef),
						t.identifier("getConfig"),
					),
					[t.cloneNode(parsedInput)],
				),
			);
		},
	});
}

function injectExtendedEditTransportHelpers(ast: t.File): void {
	const existing = ast.program.body.some(
		(stmt) =>
			t.isFunctionDeclaration(stmt) &&
			t.isIdentifier(stmt.id, {
				name: EXTENDED_EDIT_TRANSPORT_DECODE,
			}),
	);
	if (existing) return;

	const helperStatements = template.default.statements(
		`
        const _claudeExtendedEditTransportPrefix = ${JSON.stringify(EXTENDED_EDIT_TRANSPORT_PREFIX)};

        function ${EXTENDED_EDIT_TRANSPORT_DECODE}(INPUT) {
            if (!INPUT || typeof INPUT !== "object") return INPUT;
            if (_claudeEditHasExtendedFields(INPUT)) return INPUT;
            if (typeof INPUT.old_string !== "string") return INPUT;
            if (!INPUT.old_string.startsWith(_claudeExtendedEditTransportPrefix)) {
                return INPUT;
            }
            if (typeof INPUT.new_string === "string" && INPUT.new_string !== "") {
                return INPUT;
            }
            try {
                const payload = JSON.parse(
                    INPUT.old_string.slice(_claudeExtendedEditTransportPrefix.length),
                );
                if (!payload || typeof payload !== "object") return INPUT;
                if (payload.file_path === undefined && INPUT.file_path !== undefined) {
                    payload.file_path = INPUT.file_path;
                }
                return payload;
            } catch {
                return INPUT;
            }
        }
        `,
		{ placeholderPattern: false },
	)();

	ast.program.body.push(...helperStatements);
}

/**
 * Modify the Edit tool's Zod strictObject schema for batch edit support:
 * 1. Add `edits` as an optional array field
 * 2. Make `old_string` and `new_string` optional (required enforcement moves to validateInput)
 *
 * Without this, the generic tool dispatch rejects batch payloads during `safeParse()`
 * with "unexpected parameter" and "required parameter missing" errors before the Edit
 * tool's own validation and normalization logic can run.
 */
function patchEditSchemaForBatchEdits(ast: t.File): void {
	traverse.default(ast, {
		CallExpression(path) {
			if (!t.isMemberExpression(path.node.callee)) return;
			if (!isMemberPropertyName(path.node.callee, "strictObject")) return;
			if (path.node.arguments.length < 1) return;

			const arg0 = path.node.arguments[0];
			if (!t.isObjectExpression(arg0)) return;

			// Match the Edit schema by old_string + new_string + replace_all
			const hasOldString = arg0.properties.some(
				(p) => t.isObjectProperty(p) && hasObjectKeyName(p, "old_string"),
			);
			const hasNewString = arg0.properties.some(
				(p) => t.isObjectProperty(p) && hasObjectKeyName(p, "new_string"),
			);
			const hasReplaceAll = arg0.properties.some(
				(p) => t.isObjectProperty(p) && hasObjectKeyName(p, "replace_all"),
			);
			if (!hasOldString || !hasNewString || !hasReplaceAll) return;

			// Already patched?
			const hasEdits = arg0.properties.some(
				(p) => t.isObjectProperty(p) && hasObjectKeyName(p, "edits"),
			);
			if (hasEdits) return;

			// Resolve the Zod variable name from the method receiver
			if (!t.isIdentifier(path.node.callee.object)) return;
			const zodVar = path.node.callee.object.name;

			// Make old_string and new_string optional so batch-only payloads pass safeParse.
			// Wrap: y.string().describe(...) -> y.string().optional().describe(...)
			for (const prop of arg0.properties) {
				if (!t.isObjectProperty(prop)) continue;
				const keyName = getObjectKeyName(prop.key);
				if (keyName !== "old_string" && keyName !== "new_string") continue;
				if (!t.isCallExpression(prop.value)) continue;

				// Pattern: z.string().describe("...") - insert .optional() before .describe()
				const describeCall = prop.value;
				if (!t.isMemberExpression(describeCall.callee)) continue;
				if (!isMemberPropertyName(describeCall.callee, "describe")) continue;

				// Wrap the receiver with .optional(): receiver.describe(...) -> receiver.optional().describe(...)
				const receiver = describeCall.callee.object;
				describeCall.callee.object = t.callExpression(
					t.memberExpression(
						t.cloneNode(receiver, true) as t.Expression,
						t.identifier("optional"),
					),
					[],
				);
			}

			// Add edits field: z.array(z.object({ old_string, new_string, replace_all })).optional()
			const editEntrySchema = t.callExpression(
				t.memberExpression(t.identifier(zodVar), t.identifier("object")),
				[
					t.objectExpression([
						t.objectProperty(
							t.identifier("old_string"),
							t.callExpression(
								t.memberExpression(
									t.identifier(zodVar),
									t.identifier("string"),
								),
								[],
							),
						),
						t.objectProperty(
							t.identifier("new_string"),
							t.callExpression(
								t.memberExpression(
									t.identifier(zodVar),
									t.identifier("string"),
								),
								[],
							),
						),
						t.objectProperty(
							t.identifier("replace_all"),
							t.callExpression(
								t.memberExpression(
									t.callExpression(
										t.memberExpression(
											t.identifier(zodVar),
											t.identifier("boolean"),
										),
										[],
									),
									t.identifier("optional"),
								),
								[],
							),
						),
					]),
				],
			);

			const editsSchema = t.callExpression(
				t.memberExpression(
					t.callExpression(
						t.memberExpression(t.identifier(zodVar), t.identifier("array")),
						[editEntrySchema],
					),
					t.identifier("optional"),
				),
				[],
			);

			arg0.properties.push(
				t.objectProperty(t.identifier("edits"), editsSchema),
			);

			path.stop();
		},
	});
}

function getObjectPatternBindingName(
	pattern: t.ObjectPattern,
	propertyName: string,
): string | null {
	for (const prop of pattern.properties) {
		if (!t.isObjectProperty(prop) || !hasObjectKeyName(prop, propertyName)) {
			continue;
		}
		if (t.isIdentifier(prop.value)) return prop.value.name;
	}
	return null;
}

function buildHasExtendedFieldsCall(inputName: string): t.CallExpression {
	return t.callExpression(t.identifier("_claudeEditHasExtendedFields"), [
		t.identifier(inputName),
	]);
}

function getLegacyParsedEditArrayInputName(
	node: t.Expression,
): { inputName: string } | null {
	if (!t.isArrayExpression(node) || node.elements.length !== 1) return null;
	const [entry] = node.elements;
	if (!entry || !t.isObjectExpression(entry)) return null;

	let parsedInputName: string | null = null;
	for (const propertyName of ["old_string", "new_string", "replace_all"]) {
		const prop = entry.properties.find(
			(candidate): candidate is t.ObjectProperty =>
				t.isObjectProperty(candidate) &&
				hasObjectKeyName(candidate, propertyName),
		);
		if (!prop || !t.isMemberExpression(prop.value)) return null;
		if (!t.isIdentifier(prop.value.object)) return null;
		if (!isMemberPropertyName(prop.value, propertyName)) return null;

		if (!parsedInputName) {
			parsedInputName = prop.value.object.name;
			continue;
		}
		if (prop.value.object.name !== parsedInputName) {
			return null;
		}
	}

	if (!parsedInputName) return null;
	return { inputName: parsedInputName };
}

function patchStructuredEditInputNormalization(
	ast: t.File,
	toolVarName: string,
): void {
	traverse.default(ast, {
		CallExpression(path) {
			if (path.node.arguments.length < 1) return;
			const [inputArg] = path.node.arguments;
			if (!t.isObjectExpression(inputArg)) return;

			const switchCase = path.findParent((parentPath) =>
				parentPath.isSwitchCase(),
			);
			if (!switchCase || !t.isSwitchCase(switchCase.node)) return;
			if (!t.isMemberExpression(switchCase.node.test)) return;
			if (
				!t.isIdentifier(switchCase.node.test.object, { name: toolVarName }) ||
				!isMemberPropertyName(switchCase.node.test, "name")
			) {
				return;
			}

			const variableDeclarator = path.findParent((parentPath) =>
				parentPath.isVariableDeclarator(),
			);
			if (
				!variableDeclarator ||
				!t.isVariableDeclarator(variableDeclarator.node) ||
				variableDeclarator.node.init !== path.node ||
				!t.isObjectPattern(variableDeclarator.node.id)
			) {
				return;
			}

			const normalizedEditsBindingName = getObjectPatternBindingName(
				variableDeclarator.node.id,
				"edits",
			);
			if (!normalizedEditsBindingName) return;

			const normalizedEditsProperty = inputArg.properties.find(
				(prop): prop is t.ObjectProperty =>
					t.isObjectProperty(prop) &&
					hasObjectKeyName(prop, "edits") &&
					t.isExpression(prop.value) &&
					!!getLegacyParsedEditArrayInputName(prop.value),
			);
			if (!normalizedEditsProperty) return;

			if (!t.isExpression(normalizedEditsProperty.value)) return;
			const legacyParsedEditArray = getLegacyParsedEditArrayInputName(
				normalizedEditsProperty.value,
			);
			if (!legacyParsedEditArray) return;

			const parsedInputName = legacyParsedEditArray.inputName;

			let foundReturnObject: t.ObjectExpression | null = null;
			switchCase.traverse({
				ReturnStatement(returnPath) {
					if (!t.isObjectExpression(returnPath.node.argument)) return;
					foundReturnObject = returnPath.node.argument;
					returnPath.stop();
				},
			});
			if (!foundReturnObject) return;
			const returnObject: t.ObjectExpression = foundReturnObject;

			if (
				t.isConditionalExpression(normalizedEditsProperty.value) &&
				t.isCallExpression(normalizedEditsProperty.value.test) &&
				t.isIdentifier(normalizedEditsProperty.value.test.callee, {
					name: "_claudeEditHasExtendedFields",
				})
			) {
				return;
			}

			const hasExtendedFieldsCall = buildHasExtendedFieldsCall(parsedInputName);
			const legacyEdits = t.cloneNode(
				normalizedEditsProperty.value,
				true,
			) as t.Expression;

			normalizedEditsProperty.value = t.conditionalExpression(
				hasExtendedFieldsCall,
				t.memberExpression(
					t.identifier(parsedInputName),
					t.identifier("edits"),
				),
				legacyEdits,
			);

			const alreadyReturnsEdits = returnObject.properties.some(
				(prop) => t.isObjectProperty(prop) && hasObjectKeyName(prop, "edits"),
			);
			if (alreadyReturnsEdits) return;

			returnObject.properties.push(
				t.spreadElement(
					t.conditionalExpression(
						buildHasExtendedFieldsCall(parsedInputName),
						t.objectExpression([
							t.objectProperty(
								t.identifier("edits"),
								t.identifier(normalizedEditsBindingName),
							),
						]),
						t.objectExpression([]),
					),
				),
			);
		},
	});
}

function patchEditAutoClassifierInput(editToolObj: t.ObjectExpression): void {
	const classifierMethod = editToolObj.properties.find(
		(prop): prop is t.ObjectMethod =>
			t.isObjectMethod(prop) &&
			getObjectKeyName(prop.key) === "toAutoClassifierInput",
	);
	if (!classifierMethod || classifierMethod.params.length < 1) return;
	if (!t.isIdentifier(classifierMethod.params[0])) return;

	const inputName = classifierMethod.params[0].name;
	if (
		classifierMethod.body.body.some(
			(stmt) =>
				t.isIfStatement(stmt) &&
				t.isCallExpression(stmt.test) &&
				t.isIdentifier(stmt.test.callee, {
					name: "_claudeEditHasExtendedFields",
				}),
		)
	) {
		return;
	}

	const classifierLogic = template.default.statements(
		`
            if (_claudeEditHasExtendedFields(INPUT)) {
                const _normalized = _claudeEditNormalizeEdits(INPUT);
                if (!_normalized.error) {
                    return \`\${INPUT.file_path}: \${_normalized.edits.map((edit) => edit.newString).join("\\n")}\`;
                }
            }
        `,
		{ placeholderPattern: /^INPUT$/ },
	)({
		INPUT: t.identifier(inputName),
	});

	classifierMethod.body.body.unshift(...classifierLogic);
}

const _appliedAsts = new WeakSet<t.File>();

function runEditToolPatch(ast: t.File): void {
	// Prevent double-injection if called multiple times on same AST
	if (_appliedAsts.has(ast)) return;
	_appliedAsts.add(ast);

	let toolVarName: string | null = null;
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
                        if (obj.replaceAll !== undefined && obj.replace_all === undefined) obj.replace_all = obj.replaceAll;
                        if (obj.oldString !== undefined && obj.old_string === undefined) obj.old_string = obj.oldString;
                        if (obj.newString !== undefined && obj.new_string === undefined) obj.new_string = obj.newString;
                        return obj;
                    };
                    _input = ${EXTENDED_EDIT_TRANSPORT_DECODE}(_input);
                    _input = _normalizeKeys(_input);
                    if (Array.isArray(_input.edits)) {
                        _input.edits = _input.edits.map(_normalizeKeys);
                    }

                    if (!(Array.isArray(_input.edits) && _input.edits.length > 0)) {
                        _input.old_string = typeof _input.old_string === "string" ? _input.old_string : (_input.old_string ?? "");
                        _input.new_string = typeof _input.new_string === "string" ? _input.new_string : (_input.new_string ?? "");
                    }
                    if (_claudeEditHasExtendedFields(_input)) {
                        if (!_context) {
                            return { result: false, behavior: "ask", message: "Read-state validation failed", errorCode: 5 };
                        }
                        let Q = _claudeEditNormalizeEdits(_input);
                        if (Q.error) return Q.error;
                        const _canonical = _claudeEditCanonicalizeInput(_input, Q.edits);
                        if (_canonical.error) return _canonical.error;
                        _input.old_string = _canonical.oldString;
                        _input.new_string = _canonical.newString;
                        _input.replace_all = false;
                    }
                }`;

			const callLogic = `
                {
                    const _normalizeKeys = (obj) => {
                        if (!obj || typeof obj !== "object") return obj;
                        if (obj.replaceAll !== undefined && obj.replace_all === undefined) obj.replace_all = obj.replaceAll;
                        if (obj.oldString !== undefined && obj.old_string === undefined) obj.old_string = obj.oldString;
                        if (obj.newString !== undefined && obj.new_string === undefined) obj.new_string = obj.newString;
                        return obj;
                    };
                    _input = ${EXTENDED_EDIT_TRANSPORT_DECODE}(_input);
                    _input = _normalizeKeys(_input);
                    if (Array.isArray(_input.edits)) {
                        _input.edits = _input.edits.map(_normalizeKeys);
                    }

                    if (!(Array.isArray(_input.edits) && _input.edits.length > 0)) {
                        _input.old_string = typeof _input.old_string === "string" ? _input.old_string : (_input.old_string ?? "");
                        _input.new_string = typeof _input.new_string === "string" ? _input.new_string : (_input.new_string ?? "");
                    }
                    if (_claudeEditHasExtendedFields(_input)) {
                        let Z = _claudeEditNormalizeEdits(_input);
                        if (Z.error) throw Error(Z.error.message);
                        let L = _claudeEditCanonicalizeInput(_input, Z.edits);
                        if (L.error) throw Error(L.error.message);
                        _input.old_string = L.oldString;
                        _input.new_string = L.newString;
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
                        const _leftInput = ${EXTENDED_EDIT_TRANSPORT_DECODE}(${arg1});
                        const _rightInput = ${EXTENDED_EDIT_TRANSPORT_DECODE}(${arg2});
                        if (_claudeEditHasExtendedFields(_leftInput) || _claudeEditHasExtendedFields(_rightInput)) {
                            return _claudeEditInputsEquivalent(_leftInput, _rightInput);
                        }
                    }`;
				const logicAst = template.default.statements(eqLogic, {
					placeholderPattern: false,
				})();
				eqMethod.body.body.unshift(...logicAst);
			}

			patchEditAutoClassifierInput(editToolObj);
		}
	}

	if (toolVarName) {
		injectExtendedEditTransportHelpers(ast);
		patchEditSchemaForBatchEdits(ast);
		patchStructuredEditInputNormalization(ast, toolVarName);
	}

	const newPrompt = `Edit files using string replace or batch mode.

Usage:
- The file_path parameter must be an absolute path, not relative
- Use Read when helpful to verify exact file context before editing
- Preserve indentation exactly as shown after Read line-number prefixes
- Prefer editing existing files; do not create new files unless explicitly requested
- Only use emojis if the user explicitly requests them
- File encoding (UTF-8/UTF-16) and line endings (LF/CRLF) are preserved automatically

**String replace** (old_string/new_string):
- Best when you can provide unique surrounding context
- Fuzzy matching normalizes smart quotes and trailing whitespace
- Use replace_all:true only for intentional bulk changes
- If old_string is not unique, add surrounding context or use replace_all intentionally
- Empty old_string with non-empty new_string appends content

**Batch edits** (edits[]):
- Multiple string replace operations in one call
- Each entry: { old_string, new_string, replace_all }
- Edits run in the order provided against the cumulative result
- Use for related changes that should be atomic (renames, refactors)
- Prefer one batch call over multiple separate Edit calls

For regex/pattern replacement, use Bash: \`sd 'pattern' 'replacement' file.ts\`
For structural code transforms, use Bash: \`sg -p 'old($A)' -r 'new($A)' -U src/\`
For large multi-file refactoring, use Bash with sg rules or jscodeshift

Examples:
- String replace: \`{ file_path: "/abs/path/file.ts", old_string: "const x = 1;", new_string: "const x = 2;" }\`
- Bulk rename: \`{ file_path: "/abs/path/file.ts", old_string: "oldName", new_string: "newName", replace_all: true }\`
- Append content: \`{ file_path: "/abs/path/file.ts", old_string: "", new_string: "// appended content" }\`
- Batch edits: \`{ file_path: "/abs/path/file.ts", edits: [{ old_string: "foo", new_string: "bar" }, { old_string: "baz", new_string: "qux" }] }\`

Error recovery:
- "old_string matches N locations": add surrounding context or use replace_all:true
- "String not found": re-read file and copy exact text
- "File modified since read": run Read again, then retry Edit
- For large multi-site changes, prefer batch edits or multiple targeted calls`;

	patchApprovalDialog(ast);
	patchReadStateGuards(ast);
	patchIdeDiffConfigGuards(ast);

	traverse.default(ast, {
		StringLiteral(path: any) {
			if (
				path.node.value.startsWith(
					"Performs exact string replacements in files",
				)
			) {
				path.node.value = newPrompt;
			} else if (path.node.value === "A tool for editing files") {
				path.node.value = "Edit files (string replace, batch edits)";
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

	patchEditRenderToolUseMessage(ast);
}

// Append "· batch(N)" / "· replace_all" suffix to the Edit tool-use chip when
// the agent passes edits or replace_all. Stock renders only the file path, so
// batch ops and global replaces are indistinguishable from single targeted edits.
function patchEditRenderToolUseMessage(ast: t.File): void {
	let patched = false;
	const EDITS_BINDING = "_claudeEditEdits";
	const REPLACE_ALL_BINDING = "_claudeEditReplaceAll";

	traverse.default(ast, {
		FunctionDeclaration(path) {
			if (patched) return;
			const node = path.node;
			if (node.params.length !== 2) return;
			const firstParam = node.params[0];
			const secondParam = node.params[1];
			if (!t.isObjectPattern(firstParam)) return;
			if (!t.isObjectPattern(secondParam)) return;

			const firstKeys = new Set<string>();
			for (const prop of firstParam.properties) {
				if (!t.isObjectProperty(prop)) continue;
				const keyName = getObjectKeyName(prop.key);
				if (keyName) firstKeys.add(keyName);
			}
			const secondKeys = new Set<string>();
			for (const prop of secondParam.properties) {
				if (!t.isObjectProperty(prop)) continue;
				const keyName = getObjectKeyName(prop.key);
				if (keyName) secondKeys.add(keyName);
			}

			if (!firstKeys.has("file_path")) return;
			if (!secondKeys.has("verbose")) return;
			if (
				firstKeys.has("range") ||
				firstKeys.has("show_whitespace") ||
				firstKeys.has("pages") ||
				firstKeys.has("offset") ||
				firstKeys.has("limit")
			)
				return;
			if (firstKeys.has("edits") || firstKeys.has("replace_all")) return;

			let filePathBinding: string | null = null;
			for (const prop of firstParam.properties) {
				if (!t.isObjectProperty(prop)) continue;
				if (getObjectKeyName(prop.key) !== "file_path") continue;
				if (t.isIdentifier(prop.value)) filePathBinding = prop.value.name;
				else if (
					t.isAssignmentPattern(prop.value) &&
					t.isIdentifier(prop.value.left)
				) {
					filePathBinding = prop.value.left.name;
				}
			}
			if (!filePathBinding) return;

			// Discriminate Edit's renderer from other 2-param {file_path}/{verbose}
			// renderers (e.g. the operation-summary renderer) by the unique early
			// guard `if (!<filePath>) return null;` followed by a second guard that
			// returns "" for the plan-preview path. The second guard may be rewritten
			// to `if (false)` by plan-diff-ui; we check for either shape.
			const isReturnNull = (s: t.Statement): boolean =>
				(t.isReturnStatement(s) && t.isNullLiteral(s.argument)) ||
				(t.isBlockStatement(s) &&
					s.body.length === 1 &&
					t.isReturnStatement(s.body[0]) &&
					t.isNullLiteral(s.body[0].argument));
			const isReturnEmptyString = (s: t.Statement): boolean =>
				(t.isReturnStatement(s) &&
					t.isStringLiteral(s.argument, { value: "" })) ||
				(t.isBlockStatement(s) &&
					s.body.length === 1 &&
					t.isReturnStatement(s.body[0]) &&
					t.isStringLiteral(s.body[0].argument, { value: "" }));
			const body = node.body.body;
			const hasNullGuard =
				body.length >= 1 &&
				t.isIfStatement(body[0]) &&
				t.isUnaryExpression(body[0].test, { operator: "!" }) &&
				t.isIdentifier(body[0].test.argument, { name: filePathBinding }) &&
				isReturnNull(body[0].consequent);
			const hasEmptyStringGuard =
				body.length >= 2 &&
				t.isIfStatement(body[1]) &&
				isReturnEmptyString(body[1].consequent);
			if (!hasNullGuard || !hasEmptyStringGuard) return;

			firstParam.properties.push(
				t.objectProperty(t.identifier("edits"), t.identifier(EDITS_BINDING)),
				t.objectProperty(
					t.identifier("replace_all"),
					t.identifier(REPLACE_ALL_BINDING),
				),
			);

			path.traverse({
				Function(innerPath) {
					innerPath.skip();
				},
				ReturnStatement(retPath) {
					if (!retPath.node.argument) return;
					const arg = retPath.node.argument;
					if (
						t.isCallExpression(arg) &&
						t.isIdentifier(arg.callee, { name: "_editAppendOpts" })
					)
						return;
					retPath.node.argument = t.callExpression(
						t.identifier("_editAppendOpts"),
						[arg],
					);
				},
			});

			const injected = template.default.statements(
				`
				var _editOptsRaw = [];
				if (Array.isArray(${EDITS_BINDING}) && ${EDITS_BINDING}.length > 0) {
					_editOptsRaw.push("batch(" + ${EDITS_BINDING}.length + ")");
				}
				if (${REPLACE_ALL_BINDING}) {
					_editOptsRaw.push("replace_all");
				}
				var _editOptsSuffix = _editOptsRaw.length > 0
					? " · " + _editOptsRaw.join(", ")
					: "";
				function _editAppendOpts(_editResult) {
					if (!_editOptsSuffix || _editResult == null || _editResult === "") return _editResult;
					if (typeof _editResult === "string") return _editResult + _editOptsSuffix;
					if (_editResult && typeof _editResult === "object" && _editResult.props) {
						var _editChildren = _editResult.props.children;
						var _editArr = _editChildren == null
							? []
							: (Array.isArray(_editChildren) ? _editChildren.slice() : [_editChildren]);
						_editArr.push(_editOptsSuffix);
						return Object.assign({}, _editResult, {
							props: Object.assign({}, _editResult.props, { children: _editArr }),
						});
					}
					return _editResult;
				}
			`,
				{ placeholderPattern: false },
			)();

			node.body.body.unshift(...injected);
			patched = true;
		},
	});
}

interface EditVerifyContext {
	code: string;
	ast: t.File;
	editToolObject: t.ObjectExpression;
	validateMethod: t.ObjectMethod | null;
	callMethod: t.ObjectMethod | null;
}

function hasEscapedOrLiteralSnippet(code: string, snippet: string): boolean {
	return (
		code.includes(snippet) || code.includes(snippet.replaceAll("'", "\\'"))
	);
}

function verifyEditPromptAndHook(ctx: EditVerifyContext): string | null {
	const { code } = ctx;
	if (!code.includes("EXTENDED_EDIT_PREVIEW_v1")) {
		return "Missing Edit approval preview marker injection";
	}
	if (!code.includes("Edit files using string replace or batch")) {
		return "Missing updated Edit tool description";
	}
	if (!code.includes("Error recovery")) {
		return "Missing error recovery guidance";
	}
	if (!code.includes("Fuzzy matching")) {
		return "Missing fuzzy matching documentation";
	}
	if (!code.includes("Only use emojis if the user explicitly requests")) {
		return "Missing emoji usage constraint";
	}
	if (!code.includes("_claudeApplyExtendedFileEdits")) {
		return "Missing injected edit hook (edit_hook.js not appended to AST)";
	}
	if (!code.includes("_previewResult")) {
		return "Preview block does not use unified normalize+apply pipeline";
	}
	if (
		!hasEscapedOrLiteralSnippet(code, "sd 'pattern' 'replacement'") ||
		!code.includes("sg -p")
	) {
		return "Missing Bash alternative guidance for regex/structural transforms";
	}
	return null;
}

function verifyEditValidateAndCallFlow(ctx: EditVerifyContext): string | null {
	const { code, validateMethod } = ctx;
	if (!code.includes("old_string and new_string cannot both be empty.")) {
		return "Missing empty-string no-op guard";
	}

	const validateFlow = inspectValidateExtendedFlow(validateMethod);
	if (!validateFlow.hasCanonicalization) {
		return "validateInput does not canonicalize extended edits before legacy validation";
	}
	if (validateFlow.hasEarlyReturnTrue) {
		return "validateInput still bypasses legacy string-mode checks for extended edit modes";
	}
	if (
		!code.includes("_claudeEditCanonicalizeInput") ||
		!code.includes(".ipynb") ||
		!code.includes("NotebookEdit")
	) {
		return "Extended edit canonicalization does not preserve structural notebook edit rejection";
	}
	if (!code.includes("_input.old_string = _canonical.oldString;")) {
		return "Extended call path does not canonicalize old_string from current file";
	}
	if (!code.includes("_input.new_string = _canonical.newString;")) {
		return "Extended validate path does not feed canonicalized new_string into legacy validation";
	}
	if (!code.includes("_input.old_string = L.oldString;")) {
		return "Extended call path does not canonicalize old_string from current file";
	}
	if (!code.includes("_input.new_string = L.newString;")) {
		return "Extended call path does not canonicalize new_string from transformed content";
	}
	if (!code.includes("_args[0] = _input;")) {
		return "Extended call preprocess does not propagate normalized input back into call arguments";
	}
	return null;
}

function verifyEditAliasNormalization(ctx: EditVerifyContext): string | null {
	const { code } = ctx;
	if (!code.includes("oldString !== undefined")) {
		return "Edit alias normalization is missing oldString -> old_string support";
	}
	if (!code.includes("newString !== undefined")) {
		return "Edit alias normalization is missing newString -> new_string support";
	}
	return null;
}

function hasFunctionDeclaration(ast: t.File, name: string): boolean {
	let found = false;
	traverse.default(ast, {
		FunctionDeclaration(path) {
			if (t.isIdentifier(path.node.id, { name })) {
				found = true;
				path.stop();
			}
		},
	});
	return found;
}

function hasIdeDiffConfigGuard(ast: t.File): boolean {
	let found = false;

	traverse.default(ast, {
		ConditionalExpression(path) {
			if (found) {
				path.stop();
				return;
			}
			if (!t.isNullLiteral(path.node.alternate)) return;
			if (!t.isConditionalExpression(path.node.consequent)) return;

			const nested = path.node.consequent;
			if (!t.isCallExpression(nested.test)) return;
			if (
				!t.isIdentifier(nested.test.callee, {
					name: "_claudeEditHasExtendedFields",
				})
			) {
				return;
			}
			if (nested.test.arguments.length !== 1) return;
			const [guardArg] = nested.test.arguments;
			// Guard arg must wrap DECODE (or be a direct identifier for legacy)
			let hasDecodeWrapper = false;
			if (t.isIdentifier(guardArg)) {
				hasDecodeWrapper = true;
			} else if (
				t.isCallExpression(guardArg) &&
				t.isIdentifier(guardArg.callee, {
					name: EXTENDED_EDIT_TRANSPORT_DECODE,
				}) &&
				guardArg.arguments.length === 1
			) {
				hasDecodeWrapper = true;
			}
			if (!hasDecodeWrapper) return;
			if (!t.isNullLiteral(nested.consequent)) return;
			if (!t.isCallExpression(nested.alternate)) return;
			if (!t.isMemberExpression(nested.alternate.callee)) return;
			if (
				!t.isIdentifier(nested.alternate.callee.property, {
					name: "getConfig",
				})
			) {
				return;
			}
			if (nested.alternate.arguments.length !== 1) return;

			found = true;
			path.stop();
		},
	});

	return found;
}

function hasStructuredEditInputNormalization(ast: t.File): {
	prefersParsedEdits: boolean;
	returnsStructuredEdits: boolean;
} {
	let prefersParsedEdits = false;
	let returnsStructuredEdits = false;

	traverse.default(ast, {
		ConditionalExpression(path) {
			const test = path.node.test;
			if (
				!t.isCallExpression(test) ||
				!t.isIdentifier(test.callee, {
					name: "_claudeEditHasExtendedFields",
				})
			) {
				return;
			}

			if (
				t.isMemberExpression(path.node.consequent) &&
				isMemberPropertyName(path.node.consequent, "edits")
			) {
				prefersParsedEdits = true;
			}
		},
		SpreadElement(path) {
			const arg = path.node.argument;
			if (!t.isConditionalExpression(arg)) return;
			if (
				!t.isCallExpression(arg.test) ||
				!t.isIdentifier(arg.test.callee, {
					name: "_claudeEditHasExtendedFields",
				})
			) {
				return;
			}
			if (
				t.isObjectExpression(arg.consequent) &&
				arg.consequent.properties.some(
					(prop) => t.isObjectProperty(prop) && hasObjectKeyName(prop, "edits"),
				)
			) {
				returnsStructuredEdits = true;
			}
		},
	});

	return { prefersParsedEdits, returnsStructuredEdits };
}

function methodCallsHelper(
	method: t.ObjectMethod | null,
	helperName: string,
): boolean {
	if (!method) return false;
	let found = false;
	const wrapper = t.file(
		t.program([t.functionDeclaration(null, [], method.body)]),
	);
	traverse.default(wrapper, {
		CallExpression(path) {
			if (t.isIdentifier(path.node.callee, { name: helperName })) {
				found = true;
				path.stop();
			}
		},
	});
	return found;
}

function verifyStructuredEditInputWiring(
	ctx: EditVerifyContext,
): string | null {
	if (!hasFunctionDeclaration(ctx.ast, EXTENDED_EDIT_TRANSPORT_DECODE)) {
		return "Missing extended Edit transport decode helper";
	}
	if (hasFunctionDeclaration(ctx.ast, "_claudeEncodeExtendedEditTransport")) {
		return "Extended Edit still injects transport encode helper";
	}
	if (ctx.code.includes("_claudeGetExtendedEditToolSchema")) {
		return "Extended Edit still injects schema replacement helpers instead of transport-only wiring";
	}
	if (ctx.code.includes("_claudeGetExtendedEditTool")) {
		return "Extended Edit still injects replacement tool helpers instead of transport-only wiring";
	}
	if (
		ctx.code.includes("inputSchema.parse(_claudeEncodeExtendedEditTransport(")
	) {
		return "Extended Edit still rewrites Edit.inputSchema.parse inputs through transport encoding";
	}
	if (!ctx.code.includes(`${EXTENDED_EDIT_TRANSPORT_DECODE}(_input);`)) {
		return "Extended Edit transport does not decode structured payloads before validate/call handling";
	}
	const structuredInput = hasStructuredEditInputNormalization(ctx.ast);
	if (!structuredInput.prefersParsedEdits) {
		return "Extended Edit input normalization does not preserve parsed edits[] payloads";
	}
	if (!structuredInput.returnsStructuredEdits) {
		return "Extended Edit normalized tool input does not retain edits[] for transcript cleanup";
	}
	const autoClassifierMethod = getToolObjectMethod(
		ctx.editToolObject,
		"toAutoClassifierInput",
	);
	if (!methodCallsHelper(autoClassifierMethod, "_claudeEditNormalizeEdits")) {
		return "Edit.toAutoClassifierInput does not handle structured edits";
	}
	return null;
}

function verifyIdeDiffConfigGuard(ctx: EditVerifyContext): string | null {
	if (!hasIdeDiffConfigGuard(ctx.ast)) {
		return "Extended edit confirmation still routes structured payloads through ideDiffSupport.getConfig";
	}
	return null;
}

function verifyEditRenderOpts(ctx: EditVerifyContext): string | null {
	let hasHelper = false;
	let hasCall = false;
	traverse.default(ctx.ast, {
		Identifier(path) {
			if (path.node.name !== "_editAppendOpts") return;
			const parent = path.parent;
			if (t.isFunctionDeclaration(parent) && parent.id === path.node) {
				hasHelper = true;
			}
			if (t.isCallExpression(parent) && parent.callee === path.node) {
				hasCall = true;
			}
		},
	});
	if (!hasHelper)
		return "Missing _editAppendOpts helper in Edit renderToolUseMessage";
	if (!hasCall)
		return "Missing _editAppendOpts call-site in Edit renderToolUseMessage";
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
		const editToolPath = findNamedToolObjectPath(verifyAst, "Edit");
		if (!editToolPath) {
			return "Unable to resolve Edit tool object for verification";
		}
		const context: EditVerifyContext = {
			code,
			ast: verifyAst,
			editToolObject: editToolPath.node,
			validateMethod: getToolObjectMethod(editToolPath.node, "validateInput"),
			callMethod: getToolObjectMethod(editToolPath.node, "call"),
		};
		const validators = [
			verifyEditPromptAndHook,
			verifyStructuredEditInputWiring,
			verifyEditValidateAndCallFlow,
			verifyEditAliasNormalization,
			verifyIdeDiffConfigGuard,
			verifyEditRenderOpts,
		];
		for (const validator of validators) {
			const result = validator(context);
			if (result) return result;
		}
		return true;
	},
};
