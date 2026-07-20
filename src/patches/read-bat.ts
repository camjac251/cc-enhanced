import * as t from "@babel/types";
import { type NodePath, template, traverse } from "../babel.js";
import { print } from "../loader.js";
import type { Patch } from "../types.js";
import {
	findToolMethod,
	getObjectKeyName,
	getObjectPropertyByName,
	getVerifyAst,
	hasObjectKeyName,
	isElementCall,
	isMemberPropertyName,
	resolveStringValue,
} from "./ast-helpers.js";
import { MODERN_READ_CODE_FILE_CAVEAT } from "./prompt-policy.js";

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

// Note: Runtime support is limited to png/jpg/jpeg/gif/webp. Prompt wording
// about BMP/TIFF/HEIC should not be treated as authoritative.
const READ_DESCRIPTION_TEXT = "Read a file from the local filesystem.";
const READ_PROMPT_PATCH_HELPER = "_claudePatchReadPrompt";
const READ_DESCRIPTION_PATCH_HELPER = "_claudePatchReadDescription";

const STATIC_READ_PROMPT = `Read files from the local filesystem.

You can access any file directly by using this tool.
Assume this tool can read all files on the machine.
If a file does not exist, the read will return an error.

Usage:
- The file_path parameter must be an absolute path, not a relative path
- ${MODERN_READ_CODE_FILE_CAVEAT}
- For text files or narrow known code ranges, specify an optional range for partial reads
- You can read multiple files in parallel when needed
- If the user provides a screenshot path, use this tool to view it
- This tool can only read files, not directories. Use Bash with \`eza\` for directory listings or \`fd\` for scoped discovery.
- If a file exists but is empty, the tool may return a warning placeholder instead of file contents.

Supported file types:
- Text files and narrow code ranges: Returns content with line numbers (uses bat internally)
- Images (PNG, JPG, GIF, WebP): Returns base64 image data with dimensions
- PDFs: Processed page by page with text and visual content
- Jupyter notebooks (.ipynb): Returns notebook cells with outputs

Binary files (audio, video, archives, executables, Office docs, fonts) cannot be read.

Range parameter (for text files only, supported bat-style forms):
- \`30:40\` - lines 30 to 40
- \`40:\` - line 40 to end of file
- \`:40\` - start to line 40
- \`-30:\` - last 30 lines
- \`50:+20\` - line 50 plus 20 more lines
- \`100::10\` - line 100 with 10 lines of context each side
- \`30:40:2\` - lines 30-40 with 2 lines of context
- If \`range\` is omitted for \`*.output\` files, Read defaults to \`-500:\` (tail) to avoid oversized reads
- If \`range\` is omitted and the file exceeds the size limit, Read auto-previews the first 200 lines with a truncation notice. Use a range to read further.
- For large background task output, use TaskOutput to get the \`output_file\` path, then read chunk ranges (e.g. \`1:2000\`, then \`2001:4000\`)

Optional parameters:
- \`pages: "1-5"\` - For PDF files only. Required for large PDFs; max 20 pages per request.
- \`show_whitespace: true\` - Reveal invisible characters (tabs→, spaces·, newlines␊). Use to debug indentation issues.

Examples:
- Read entire file: \`{ file_path: "/path/to/file.ts" }\`
- Read lines 100-200: \`{ file_path: "/path/to/file.ts", range: "100:200" }\`
- Read last 50 lines: \`{ file_path: "/path/to/file.ts", range: "-50:" }\`
- Read PDF pages 1-5: \`{ file_path: "/path/to/doc.pdf", pages: "1-5" }\`
- Debug whitespace: \`{ file_path: "/path/to/file.ts", show_whitespace: true }\``;

const DYNAMIC_READ_PROMPT_APPENDIX = `Range parameter (for text files only, supported bat-style forms):
- \`30:40\` - lines 30 to 40
- \`40:\` - line 40 to end of file
- \`:40\` - start to line 40
- \`-30:\` - last 30 lines
- \`50:+20\` - line 50 plus 20 more lines
- \`100::10\` - line 100 with 10 lines of context each side
- \`30:40:2\` - lines 30-40 with 2 lines of context
- If \`range\` is omitted for \`*.output\` files, Read defaults to \`-500:\` (tail) to avoid oversized reads
- If \`range\` is omitted and the file exceeds the size limit, Read auto-previews the first 200 lines with a truncation notice. Use a range to read further.
- For large background task output, use TaskOutput to get the \`output_file\` path, then read chunk ranges (e.g. \`1:2000\`, then \`2001:4000\`)

Optional parameters:
- \`show_whitespace: true\` - Reveal invisible characters (tabs→, spaces·, newlines␊). Use to debug indentation issues.

Examples:
- Read lines 100-200: \`{ file_path: "/path/to/file.ts", range: "100:200" }\`
- Read last 50 lines: \`{ file_path: "/path/to/file.ts", range: "-50:" }\`
- Read PDF pages 1-5: \`{ file_path: "/path/to/doc.pdf", pages: "1-5" }\`
- Debug whitespace: \`{ file_path: "/path/to/file.ts", show_whitespace: true }\``;

function findReadToolObjectPath(
	ast: t.File,
): NodePath<t.ObjectExpression> | null {
	let found: NodePath<t.ObjectExpression> | null = null;
	traverse(ast, {
		ObjectExpression(path) {
			if (found) return;
			const nameProp = getObjectPropertyByName(path.node, "name");
			if (!nameProp || !t.isExpression(nameProp.value)) return;
			const toolName = resolveStringValue(path, nameProp.value);
			if (toolName !== "Read") return;
			const hasReadToolShape = path.node.properties.some(
				(prop) =>
					(t.isObjectMethod(prop) || t.isObjectProperty(prop)) &&
					[
						"prompt",
						"validateInput",
						"call",
						"inputSchema",
						"input_schema",
					].includes(getObjectKeyName(prop.key) ?? ""),
			);
			if (!hasReadToolShape) return;
			found = path;
			path.stop();
		},
	});
	return found;
}

interface ReadCoerceShape {
	body: t.BlockStatement;
	normalizedInputName: string;
	repairListName: string;
	insertAfterIndex: number;
}

function getReadCoerceFunction(
	readToolPath: NodePath<t.ObjectExpression>,
): t.FunctionDeclaration | null {
	const property = readToolPath.node.properties.find(
		(candidate): candidate is t.ObjectProperty =>
			t.isObjectProperty(candidate) &&
			hasObjectKeyName(candidate, "coerceInput"),
	);
	if (!property || !t.isIdentifier(property.value)) return null;
	const binding = readToolPath.scope.getBinding(property.value.name);
	const bindingNode = binding?.path.node;
	return t.isFunctionDeclaration(bindingNode) ? bindingNode : null;
}

function getReadCoerceReturnNames(
	body: t.BlockStatement,
): { normalizedInputName: string; repairListName: string } | null {
	for (const statement of body.body) {
		if (
			!t.isReturnStatement(statement) ||
			!t.isConditionalExpression(statement.argument) ||
			!t.isMemberExpression(statement.argument.test) ||
			!isMemberPropertyName(statement.argument.test, "length") ||
			!t.isIdentifier(statement.argument.test.object) ||
			!t.isObjectExpression(statement.argument.consequent) ||
			!t.isNullLiteral(statement.argument.alternate)
		) {
			continue;
		}
		const repairListName = statement.argument.test.object.name;
		const inputProperty = statement.argument.consequent.properties.find(
			(property): property is t.ObjectProperty =>
				t.isObjectProperty(property) && hasObjectKeyName(property, "input"),
		);
		const shapeProperty = statement.argument.consequent.properties.find(
			(property): property is t.ObjectProperty =>
				t.isObjectProperty(property) &&
				hasObjectKeyName(property, "shapeClass"),
		);
		const joinCall =
			shapeProperty &&
			t.isCallExpression(shapeProperty.value) &&
			t.isMemberExpression(shapeProperty.value.callee) &&
			isMemberPropertyName(shapeProperty.value.callee, "join")
				? shapeProperty.value
				: null;
		if (
			!inputProperty ||
			!t.isIdentifier(inputProperty.value) ||
			!joinCall ||
			!t.isMemberExpression(joinCall.callee) ||
			!t.isIdentifier(joinCall.callee.object, { name: repairListName }) ||
			joinCall.arguments.length !== 1 ||
			!t.isStringLiteral(joinCall.arguments[0], { value: "," })
		) {
			continue;
		}
		return {
			normalizedInputName: inputProperty.value.name,
			repairListName,
		};
	}
	return null;
}

function getReadCoerceShape(
	readToolPath: NodePath<t.ObjectExpression>,
): ReadCoerceShape | null {
	const functionNode = getReadCoerceFunction(readToolPath);
	if (!functionNode) return null;
	const firstParam = functionNode.params[0];
	if (!t.isIdentifier(firstParam)) return null;
	const returnNames = getReadCoerceReturnNames(functionNode.body);
	if (!returnNames) return null;
	let normalizedStatementIndex = -1;
	let repairListStatementIndex = -1;
	for (const [statementIndex, statement] of functionNode.body.body.entries()) {
		if (!t.isVariableDeclaration(statement)) continue;
		for (const declarator of statement.declarations) {
			if (!t.isIdentifier(declarator.id)) continue;
			if (
				declarator.id.name === returnNames.normalizedInputName &&
				t.isObjectExpression(declarator.init) &&
				declarator.init.properties.some(
					(property) =>
						t.isSpreadElement(property) &&
						t.isIdentifier(property.argument, { name: firstParam.name }),
				)
			) {
				normalizedStatementIndex = statementIndex;
			}
			if (
				declarator.id.name === returnNames.repairListName &&
				t.isArrayExpression(declarator.init) &&
				declarator.init.elements.length === 0
			) {
				repairListStatementIndex = statementIndex;
			}
		}
	}
	if (normalizedStatementIndex < 0 || repairListStatementIndex < 0) {
		return null;
	}
	return {
		body: functionNode.body,
		...returnNames,
		insertAfterIndex: Math.max(
			normalizedStatementIndex,
			repairListStatementIndex,
		),
	};
}

function isNamedMember(
	node: t.Node | null | undefined,
	objectName: string,
	propertyName: string,
): node is t.MemberExpression {
	return (
		t.isMemberExpression(node) &&
		!node.computed &&
		t.isIdentifier(node.object, { name: objectName }) &&
		t.isIdentifier(node.property, { name: propertyName })
	);
}

function isBlankOptionalInputRepair(
	statement: t.Statement,
	normalizedInputName: string,
	repairListName: string,
	fieldName: string,
	marker: string,
): boolean {
	if (
		!t.isIfStatement(statement) ||
		!t.isLogicalExpression(statement.test, { operator: "&&" }) ||
		!t.isBlockStatement(statement.consequent)
	) {
		return false;
	}
	const typeCheck = statement.test.left;
	const blankCheck = statement.test.right;
	if (
		!t.isBinaryExpression(typeCheck, { operator: "===" }) ||
		!t.isUnaryExpression(typeCheck.left, { operator: "typeof" }) ||
		!isNamedMember(typeCheck.left.argument, normalizedInputName, fieldName) ||
		!t.isStringLiteral(typeCheck.right, { value: "string" })
	) {
		return false;
	}
	if (
		!t.isBinaryExpression(blankCheck, { operator: "===" }) ||
		!t.isCallExpression(blankCheck.left) ||
		!t.isMemberExpression(blankCheck.left.callee) ||
		!isMemberPropertyName(blankCheck.left.callee, "trim") ||
		!isNamedMember(
			blankCheck.left.callee.object,
			normalizedInputName,
			fieldName,
		) ||
		blankCheck.left.arguments.length !== 0 ||
		!t.isStringLiteral(blankCheck.right, { value: "" })
	) {
		return false;
	}

	let deletesField = false;
	let recordsRepair = false;
	for (const bodyStatement of statement.consequent.body) {
		if (
			t.isExpressionStatement(bodyStatement) &&
			t.isUnaryExpression(bodyStatement.expression, { operator: "delete" }) &&
			isNamedMember(
				bodyStatement.expression.argument,
				normalizedInputName,
				fieldName,
			)
		) {
			deletesField = true;
		}
		if (
			t.isExpressionStatement(bodyStatement) &&
			t.isCallExpression(bodyStatement.expression) &&
			isNamedMember(bodyStatement.expression.callee, repairListName, "push") &&
			bodyStatement.expression.arguments.length === 1 &&
			t.isStringLiteral(bodyStatement.expression.arguments[0], {
				value: marker,
			})
		) {
			recordsRepair = true;
		}
	}
	return deletesField && recordsRepair;
}

function buildBlankOptionalInputRepair(
	normalizedInputName: string,
	repairListName: string,
	fieldName: string,
	marker: string,
): t.IfStatement {
	const inputField = () =>
		t.memberExpression(
			t.identifier(normalizedInputName),
			t.identifier(fieldName),
		);
	return t.ifStatement(
		t.logicalExpression(
			"&&",
			t.binaryExpression(
				"===",
				t.unaryExpression("typeof", inputField()),
				t.stringLiteral("string"),
			),
			t.binaryExpression(
				"===",
				t.callExpression(
					t.memberExpression(inputField(), t.identifier("trim")),
					[],
				),
				t.stringLiteral(""),
			),
		),
		t.blockStatement([
			t.expressionStatement(t.unaryExpression("delete", inputField())),
			t.expressionStatement(
				t.callExpression(
					t.memberExpression(
						t.identifier(repairListName),
						t.identifier("push"),
					),
					[t.stringLiteral(marker)],
				),
			),
		]),
	);
}

function patchBlankOptionalReadInputs(
	readToolPath: NodePath<t.ObjectExpression>,
): boolean {
	const shape = getReadCoerceShape(readToolPath);
	if (!shape) return false;
	const repairs = [
		{ fieldName: "pages", marker: "pages_empty" },
		{ fieldName: "range", marker: "range_empty" },
	] as const;
	const states = repairs.map(({ fieldName, marker }) =>
		shape.body.body.some((statement) =>
			isBlankOptionalInputRepair(
				statement,
				shape.normalizedInputName,
				shape.repairListName,
				fieldName,
				marker,
			),
		),
	);
	if (states.every(Boolean)) return true;
	if (states.some(Boolean)) return false;
	shape.body.body.splice(
		shape.insertAfterIndex + 1,
		0,
		...repairs.map(({ fieldName, marker }) =>
			buildBlankOptionalInputRepair(
				shape.normalizedInputName,
				shape.repairListName,
				fieldName,
				marker,
			),
		),
	);
	return true;
}

function getReadToolPromptText(ast: t.File): string | null {
	const readToolPath = findReadToolObjectPath(ast);
	if (!readToolPath) return null;
	for (const prop of readToolPath.node.properties) {
		if (t.isObjectMethod(prop) && hasObjectKeyName(prop, "prompt")) {
			for (const stmt of prop.body.body) {
				if (!t.isReturnStatement(stmt) || !stmt.argument) continue;
				return resolveStringValue(readToolPath, stmt.argument);
			}
		}
		if (
			t.isObjectProperty(prop) &&
			hasObjectKeyName(prop, "prompt") &&
			t.isExpression(prop.value)
		) {
			return resolveStringValue(readToolPath, prop.value);
		}
	}
	return null;
}

function getReadToolDescriptionText(ast: t.File): string | null {
	const readToolPath = findReadToolObjectPath(ast);
	if (!readToolPath) return null;
	for (const prop of readToolPath.node.properties) {
		if (t.isObjectMethod(prop) && hasObjectKeyName(prop, "description")) {
			for (const stmt of prop.body.body) {
				if (!t.isReturnStatement(stmt) || !stmt.argument) continue;
				return resolveStringValue(readToolPath, stmt.argument);
			}
		}
		if (
			t.isObjectProperty(prop) &&
			hasObjectKeyName(prop, "description") &&
			t.isExpression(prop.value)
		) {
			return resolveStringValue(readToolPath, prop.value);
		}
	}
	return null;
}

function isHelperWrappedCall(
	expr: t.Expression,
	helperName: string,
): expr is t.CallExpression {
	return (
		t.isCallExpression(expr) &&
		t.isIdentifier(expr.callee, { name: helperName }) &&
		expr.arguments.length >= 1 &&
		t.isExpression(expr.arguments[0])
	);
}

function hasNotebookSupportNote(promptSurface: string): boolean {
	return promptSurface.includes("Jupyter notebooks (.ipynb");
}

function hasFileOnlyConstraint(promptSurface: string): boolean {
	return promptSurface.includes("only read files, not directories");
}

function hasMissingFileNote(promptSurface: string): boolean {
	return (
		promptSurface.includes(
			"If a file does not exist, the read will return an error",
		) ||
		(promptSurface.includes("does not exist") &&
			promptSurface.includes("return an error"))
	);
}

function ensureReadPromptPatchHelpers(ast: t.File): void {
	let hasPromptHelper = false;
	let hasDescriptionHelper = false;

	traverse(ast, {
		FunctionDeclaration(path) {
			if (t.isIdentifier(path.node.id, { name: READ_PROMPT_PATCH_HELPER })) {
				hasPromptHelper = true;
			}
			if (
				t.isIdentifier(path.node.id, { name: READ_DESCRIPTION_PATCH_HELPER })
			) {
				hasDescriptionHelper = true;
			}
			if (hasPromptHelper && hasDescriptionHelper) {
				path.stop();
			}
		},
	});

	if (hasPromptHelper && hasDescriptionHelper) {
		return;
	}

	const helpers = template.statements(
		`
function ${READ_DESCRIPTION_PATCH_HELPER}(description) {
  const canonical = ${JSON.stringify(READ_DESCRIPTION_TEXT)};
  if (description === void 0 || description === null) return canonical;
  const text = String(description);
  if (text === canonical) return text;
  if (text === "A tool for reading files") return canonical;
  return canonical;
}

function ${READ_PROMPT_PATCH_HELPER}(prompt) {
  if (prompt === void 0 || prompt === null) return prompt;
  let updated = String(prompt);
  updated = updated.replace(
    /- You can optionally specify a line offset and limit[^\\n]*/g,
    "- Use the range parameter with supported bat-style forms when you only need part of a file.",
  );
  updated = updated.replace(
    /- When you already know which part of the file you need,[^\\n]*/g,
    "- When you already know which part of the file you need, prefer the range parameter over full-file reads.",
  );
  updated = updated.replace(
    /- Results are returned using cat -n format, with line numbers starting at 1/g,
    "- Results are returned with line numbers starting at 1.",
  );
  updated = updated.replace(
    /To read a directory, use an ls command via the .*? tool\\./g,
    "To inspect directories, use Bash with eza or fd rather than Read.",
  );
  if (!updated.includes("Range parameter (for text files only, supported bat-style forms):")) {
    updated += (updated.endsWith("\\n") ? "\\n" : "\\n\\n") + ${JSON.stringify(DYNAMIC_READ_PROMPT_APPENDIX)};
  }
  const missingNotes = [];
  if (!updated.includes("Jupyter notebooks (.ipynb")) {
    missingNotes.push(${JSON.stringify("- This tool can read Jupyter notebooks (.ipynb files) and returns all cells with their outputs, combining code, text, and visualizations.")});
  }
  if (!updated.includes("can only read files, not directories")) {
    missingNotes.push(${JSON.stringify("- This tool can only read files, not directories. Use Bash with `eza` for directory listings or `fd` for scoped discovery.")});
  }
  if (!updated.includes("does not exist")) {
    missingNotes.push(${JSON.stringify("- If a file does not exist, the read will return an error.")});
  }
  if (!updated.includes(${JSON.stringify(MODERN_READ_CODE_FILE_CAVEAT)})) {
    missingNotes.push(${JSON.stringify(`- ${MODERN_READ_CODE_FILE_CAVEAT}`)});
  }
  if (missingNotes.length > 0) {
    updated += (updated.endsWith("\\n") ? "\\n" : "\\n\\n") + missingNotes.join("\\n");
  }
  return updated;
}
`,
		{
			placeholderPattern: false,
		},
	)();

	ast.program.body.unshift(...helpers);
}

function wrapReadPromptExpression(
	expr: t.Expression,
	helperName: string,
): t.Expression {
	return isHelperWrappedCall(expr, helperName)
		? expr
		: t.callExpression(t.identifier(helperName), [expr]);
}

function isReadFilePathSchemaDescription(expr: t.Expression): boolean {
	if (!t.isCallExpression(expr)) return false;
	if (!t.isMemberExpression(expr.callee)) return false;
	if (!isMemberPropertyName(expr.callee, "describe")) return false;
	if (expr.arguments.length < 1) return false;
	const [arg0] = expr.arguments;
	return (
		t.isStringLiteral(arg0) &&
		arg0.value.includes("absolute path to the file to read")
	);
}

function hasReadFilePathSchemaField(schemaObject: t.ObjectExpression): boolean {
	for (const prop of schemaObject.properties) {
		if (!t.isObjectProperty(prop)) continue;
		if (getObjectKeyName(prop.key) !== "file_path") continue;
		if (!t.isExpression(prop.value)) continue;
		return isReadFilePathSchemaDescription(prop.value);
	}
	return false;
}

function getReadInputSchemaObject(
	ast: t.File,
	readToolPath: NodePath<t.ObjectExpression>,
): t.ObjectExpression | null {
	const readToolObject = readToolPath.node;
	const schemaProp = getObjectPropertyByName(readToolObject, "input_schema");
	if (schemaProp && t.isCallExpression(schemaProp.value)) {
		if (
			t.isMemberExpression(schemaProp.value.callee) &&
			isMemberPropertyName(schemaProp.value.callee, "strictObject")
		) {
			const arg0 = schemaProp.value.arguments[0];
			if (arg0 && t.isObjectExpression(arg0)) return arg0;
		}
	}
	const inputSchemaMethod = findToolMethod(readToolObject, "inputSchema");
	if (inputSchemaMethod) {
		if (
			t.isObjectProperty(inputSchemaMethod) &&
			t.isExpression(inputSchemaMethod.value) &&
			t.isCallExpression(inputSchemaMethod.value) &&
			t.isMemberExpression(inputSchemaMethod.value.callee) &&
			isMemberPropertyName(inputSchemaMethod.value.callee, "strictObject")
		) {
			const arg0 = inputSchemaMethod.value.arguments[0];
			if (arg0 && t.isObjectExpression(arg0)) return arg0;
		}
		if (t.isObjectMethod(inputSchemaMethod)) {
			for (const stmt of inputSchemaMethod.body.body) {
				if (!t.isReturnStatement(stmt) || !stmt.argument) continue;
				if (!t.isCallExpression(stmt.argument)) continue;
				if (!t.isMemberExpression(stmt.argument.callee)) continue;
				if (!isMemberPropertyName(stmt.argument.callee, "strictObject"))
					continue;
				const arg0 = stmt.argument.arguments[0];
				if (arg0 && t.isObjectExpression(arg0)) return arg0;
			}
		}
	}

	const schemaGetter = findToolMethod(readToolObject, "inputSchema");
	if (schemaGetter && t.isObjectMethod(schemaGetter)) {
		for (const stmt of schemaGetter.body.body) {
			if (!t.isReturnStatement(stmt) || !stmt.argument) continue;
			if (
				!t.isCallExpression(stmt.argument) ||
				!t.isIdentifier(stmt.argument.callee) ||
				stmt.argument.arguments.length !== 0
			) {
				continue;
			}

			const binding = readToolPath.scope.getBinding(stmt.argument.callee.name);
			const init = binding?.path.node;
			if (
				!init ||
				!t.isVariableDeclarator(init) ||
				!t.isCallExpression(init.init)
			) {
				continue;
			}

			for (const arg of init.init.arguments) {
				const body = t.isArrowFunctionExpression(arg)
					? arg.body
					: t.isFunctionExpression(arg)
						? arg.body
						: null;
				const returnedExpr =
					body && t.isBlockStatement(body)
						? body.body.find((innerStmt): innerStmt is t.ReturnStatement =>
								t.isReturnStatement(innerStmt),
							)?.argument
						: body && t.isExpression(body)
							? body
							: null;
				if (
					returnedExpr &&
					t.isCallExpression(returnedExpr) &&
					t.isMemberExpression(returnedExpr.callee) &&
					isMemberPropertyName(returnedExpr.callee, "strictObject")
				) {
					const arg0 = returnedExpr.arguments[0];
					if (arg0 && t.isObjectExpression(arg0)) return arg0;
				}
			}
		}
	}

	let found: t.ObjectExpression | null = null;
	traverse(ast, {
		CallExpression(path) {
			if (found) return;
			if (!t.isMemberExpression(path.node.callee)) return;
			if (!isMemberPropertyName(path.node.callee, "strictObject")) return;
			const arg0 = path.node.arguments[0];
			if (!arg0 || !t.isObjectExpression(arg0)) return;
			if (!hasReadFilePathSchemaField(arg0)) return;
			found = arg0;
			path.stop();
		},
	});
	return found;
}

function expressionCode(expr: t.Expression): string {
	const file = t.file(
		t.program([t.expressionStatement(t.cloneNode(expr, true) as t.Expression)]),
	);
	return print(file);
}

function expressionHasMethodCall(
	expr: t.Expression,
	methodName: "string" | "boolean",
): boolean {
	let found = false;
	const file = t.file(
		t.program([t.expressionStatement(t.cloneNode(expr, true) as t.Expression)]),
	);
	traverse(file, {
		CallExpression(path) {
			if (found) {
				path.stop();
				return;
			}
			if (!t.isMemberExpression(path.node.callee)) return;
			if (!isMemberPropertyName(path.node.callee, methodName)) return;
			found = true;
			path.stop();
		},
	});
	return found;
}

function schemaFieldHasMethodCall(
	schemaObject: t.ObjectExpression,
	fieldName: string,
	methodName: "string" | "boolean",
): boolean {
	const fieldProp = getObjectPropertyByName(schemaObject, fieldName);
	if (!fieldProp || !t.isExpression(fieldProp.value)) return false;
	return expressionHasMethodCall(fieldProp.value, methodName);
}

function getFirstObjectPatternParam(
	method: t.ObjectMethod | t.ObjectProperty | null,
): t.ObjectPattern | null {
	if (!method) return null;
	const params = t.isObjectMethod(method)
		? method.params
		: t.isFunctionExpression(method.value) ||
				t.isArrowFunctionExpression(method.value)
			? method.value.params
			: [];
	if (params.length === 0) return null;
	const firstParam = params[0];
	return t.isObjectPattern(firstParam) ? firstParam : null;
}

function getObjectPatternKeys(pattern: t.ObjectPattern): Set<string> {
	const keys = new Set<string>();
	for (const prop of pattern.properties) {
		if (!t.isObjectProperty(prop)) continue;
		const keyName = getObjectKeyName(prop.key);
		if (keyName) keys.add(keyName);
	}
	return keys;
}

function getBindingNames(node: t.Node | null | undefined): Set<string> {
	const names = new Set<string>();
	if (!node) return names;

	const addPatternNames = (pattern: t.Node | null | undefined) => {
		if (!pattern) return;
		for (const name of Object.keys(t.getBindingIdentifiers(pattern))) {
			names.add(name);
		}
	};

	const visit = (current: t.Node | null | undefined) => {
		if (!current) return;
		if (t.isVariableDeclarator(current)) addPatternNames(current.id);
		if (t.isFunctionDeclaration(current) && current.id)
			names.add(current.id.name);
		if (t.isClassDeclaration(current) && current.id) names.add(current.id.name);
		if (t.isFunction(current)) {
			for (const param of current.params) addPatternNames(param);
		}
		if (t.isCatchClause(current)) addPatternNames(current.param);

		for (const key of t.VISITOR_KEYS[current.type] ?? []) {
			const child = (current as any)[key];
			if (Array.isArray(child)) {
				for (const item of child) {
					if (item && typeof item.type === "string") visit(item);
				}
				continue;
			}
			if (child && typeof child.type === "string") visit(child);
		}
	};

	visit(node);
	return names;
}

function freshIdentifierName(
	preferred: string,
	reservedNames: Set<string>,
): string {
	if (!reservedNames.has(preferred)) return preferred;
	for (let index = 2; ; index++) {
		const candidate = `${preferred}_${index}`;
		if (!reservedNames.has(candidate)) return candidate;
	}
}

function isVoidZeroExpression(expr: t.Expression): boolean {
	return (
		t.isUnaryExpression(expr, { operator: "void" }) &&
		t.isNumericLiteral(expr.argument, { value: 0 })
	);
}

function objectPatternPropertyHasVoidZeroDefault(
	pattern: t.ObjectPattern,
	keyName: string,
): boolean {
	for (const prop of pattern.properties) {
		if (!t.isObjectProperty(prop)) continue;
		if (getObjectKeyName(prop.key) !== keyName) continue;
		if (!t.isAssignmentPattern(prop.value)) return false;
		return isVoidZeroExpression(prop.value.right);
	}
	return false;
}

function hasFallbackFnBoundedArgs(ast: t.File): boolean {
	let found = false;
	traverse(ast, {
		CallExpression(path) {
			if (!t.isIdentifier(path.node.callee, { name: "fallbackFn" })) return;
			const args = path.node.arguments;
			if (args.length < 5) return;
			const expected = [
				"filePath",
				"fallbackOffset",
				"fallbackLimit",
				"fallbackSizeLimit",
				"fallbackSignal",
			];
			const matches = expected.every(
				(name, idx) => t.isIdentifier(args[idx]) && args[idx].name === name,
			);
			if (!matches) return;
			found = true;
			path.stop();
		},
	});
	return found;
}

function isVoidZeroMemberComparison(
	expr: t.Expression,
	propertyName: string,
): boolean {
	if (!t.isBinaryExpression(expr, { operator: "!==" })) return false;
	if (!isVoidZeroExpression(expr.right)) return false;
	const left = expr.left;
	if (t.isMemberExpression(left)) {
		return !left.computed && isMemberPropertyName(left, propertyName);
	}
	if (t.isOptionalMemberExpression(left)) {
		return !left.computed && isMemberPropertyName(left, propertyName);
	}
	return false;
}

function flattenLogicalAndTerms(expr: t.Expression): t.Expression[] {
	if (t.isLogicalExpression(expr, { operator: "&&" })) {
		return [
			...flattenLogicalAndTerms(expr.left as t.Expression),
			...flattenLogicalAndTerms(expr.right as t.Expression),
		];
	}
	return [expr];
}

function getObjectPatternBindingName(
	pattern: t.ObjectPattern,
	keyName: string,
): string | null {
	for (const prop of pattern.properties) {
		if (!t.isObjectProperty(prop)) continue;
		if (getObjectKeyName(prop.key) !== keyName) continue;
		if (t.isIdentifier(prop.value)) return prop.value.name;
		if (t.isAssignmentPattern(prop.value) && t.isIdentifier(prop.value.left)) {
			return prop.value.left.name;
		}
	}
	return null;
}

function setBindingStringValue(
	path: NodePath<t.ObjectExpression>,
	valueNode: t.Expression,
	nextValue: string,
): boolean {
	if (t.isStringLiteral(valueNode)) {
		valueNode.value = nextValue;
		return true;
	}
	if (!t.isIdentifier(valueNode)) return false;
	const binding = path.scope.getBinding(valueNode.name);
	const declarator = binding?.path.node;
	if (
		!binding ||
		!t.isVariableDeclarator(declarator) ||
		binding.referencePaths.length !== 1 ||
		!declarator.init ||
		(!t.isStringLiteral(declarator.init) &&
			!t.isTemplateLiteral(declarator.init))
	) {
		return false;
	}
	declarator.init = t.stringLiteral(nextValue);
	return true;
}

function setOrReplaceObjectPropertyStringValue(
	path: NodePath<t.ObjectExpression>,
	property: t.ObjectProperty,
	nextValue: string,
): void {
	if (
		t.isExpression(property.value) &&
		setBindingStringValue(path, property.value, nextValue)
	) {
		return;
	}
	property.value = t.stringLiteral(nextValue);
}

function containsRangeVoidGuard(
	expr: t.Expression,
	rangeVarName: string,
): boolean {
	if (
		t.isBinaryExpression(expr, { operator: "===" }) &&
		t.isIdentifier(expr.left, { name: rangeVarName }) &&
		isVoidZeroExpression(expr.right)
	) {
		return true;
	}
	if (t.isLogicalExpression(expr)) {
		return (
			containsRangeVoidGuard(expr.left as t.Expression, rangeVarName) ||
			containsRangeVoidGuard(expr.right as t.Expression, rangeVarName)
		);
	}
	return false;
}

function containsVoidZeroMemberComparison(
	expr: t.Expression,
	propertyName: string,
): boolean {
	if (isVoidZeroMemberComparison(expr, propertyName)) return true;
	if (t.isLogicalExpression(expr)) {
		return (
			containsVoidZeroMemberComparison(
				expr.left as t.Expression,
				propertyName,
			) ||
			containsVoidZeroMemberComparison(expr.right as t.Expression, propertyName)
		);
	}
	return false;
}

function hasCallCompatRangeBridge(ast: t.File, rangeVarName: string): boolean {
	let found = false;

	traverse(ast, {
		ObjectMethod(path) {
			if (getObjectKeyName(path.node.key) !== "call") return;
			traverse(
				path.node.body,
				{
					IfStatement(ifPath) {
						if (!t.isExpression(ifPath.node.test)) return;
						const hasRangeVoidGuard = containsRangeVoidGuard(
							ifPath.node.test,
							rangeVarName,
						);
						const hasOffsetGuard = containsVoidZeroMemberComparison(
							ifPath.node.test,
							"offset",
						);
						const hasLimitGuard = containsVoidZeroMemberComparison(
							ifPath.node.test,
							"limit",
						);
						if (!hasRangeVoidGuard || (!hasOffsetGuard && !hasLimitGuard)) {
							return;
						}

						let hasRangeAssignment = false;
						traverse(
							ifPath.node.consequent,
							{
								AssignmentExpression(assignPath) {
									if (assignPath.node.operator !== "=") return;
									if (
										!t.isIdentifier(assignPath.node.left, {
											name: rangeVarName,
										})
									) {
										return;
									}
									const rhsCode = expressionCode(
										assignPath.node.right as t.Expression,
									);
									if (rhsCode.includes(' + ":"') || rhsCode.includes('+ ":"')) {
										hasRangeAssignment = true;
									}
								},
							},
							ifPath.scope,
							ifPath,
						);
						if (!hasRangeAssignment) return;

						found = true;
						ifPath.stop();
					},
				},
				path.scope,
				path,
			);
			if (found) path.stop();
		},
	});

	return found;
}

function hasEnsureTotalLinesHelper(ast: t.File): boolean {
	let found = false;
	traverse(ast, {
		VariableDeclarator(path) {
			if (!t.isIdentifier(path.node.id, { name: "ensureTotalLines" })) return;
			if (
				t.isFunctionExpression(path.node.init) ||
				t.isArrowFunctionExpression(path.node.init)
			) {
				found = true;
				path.stop();
			}
		},
	});
	return found;
}

function hasNormalizedRangeTotalLinesRefresh(ast: t.File): boolean {
	let found = false;
	traverse(ast, {
		IfStatement(path) {
			if (!t.isLogicalExpression(path.node.test, { operator: "&&" })) return;
			const terms = flattenLogicalAndTerms(path.node.test);
			const hasNormalizedRange = terms.some((term) =>
				t.isIdentifier(term, { name: "normalizedRange" }),
			);
			const hasFileTotalLinesNull = terms.some(
				(term) =>
					t.isBinaryExpression(term, { operator: "==" }) &&
					t.isIdentifier(term.left, { name: "fileTotalLines" }) &&
					t.isNullLiteral(term.right),
			);
			if (!hasNormalizedRange || !hasFileTotalLinesNull) return;
			found = true;
			path.stop();
		},
	});
	return found;
}

function schemaHasLegacyOffsetOrLimit(
	schemaObject: t.ObjectExpression,
): boolean {
	return schemaObject.properties.some(
		(prop) =>
			t.isObjectProperty(prop) &&
			(getObjectKeyName(prop.key) === "offset" ||
				getObjectKeyName(prop.key) === "limit"),
	);
}

function hasReadFileStateCompatMarkers(ast: t.File): {
	hasRange: boolean;
	hasOffsetCompat: boolean;
	hasLimitCompat: boolean;
} {
	let hasRange = false;
	let hasOffsetCompat = false;
	let hasLimitCompat = false;

	traverse(ast, {
		CallExpression(path) {
			const callee = path.node.callee;
			if (!t.isMemberExpression(callee)) return;
			if (!isMemberPropertyName(callee, "set")) return;
			if (path.node.arguments.length < 2) return;
			const secondArg = path.node.arguments[1];
			if (!t.isObjectExpression(secondArg)) return;

			for (const prop of secondArg.properties) {
				if (!t.isObjectProperty(prop)) continue;
				const key = getObjectKeyName(prop.key);
				if (key === "range") {
					hasRange = true;
				}
				if (key === "offset") {
					if (
						t.isConditionalExpression(prop.value) &&
						t.isNumericLiteral(prop.value.consequent, { value: 1 }) &&
						isVoidZeroExpression(prop.value.alternate)
					) {
						hasOffsetCompat = true;
					}
				}
				if (key === "limit") {
					if (
						t.isConditionalExpression(prop.value) &&
						t.isNumericLiteral(prop.value.consequent, { value: 1 }) &&
						isVoidZeroExpression(prop.value.alternate)
					) {
						hasLimitCompat = true;
					}
				}
			}
		},
	});

	return { hasRange, hasOffsetCompat, hasLimitCompat };
}

function nodeContains(
	node: t.Node | null | undefined,
	predicate: (value: t.Node) => boolean,
): boolean {
	if (!node) return false;
	if (predicate(node)) return true;
	let found = false;
	t.traverseFast(node, (child) => {
		if (!found && predicate(child)) found = true;
	});
	return found;
}

function getTypeofStringMemberObjectName(
	expr: t.Expression,
	propertyName: string,
): string | null {
	if (
		!t.isBinaryExpression(expr, { operator: "===" }) ||
		!t.isStringLiteral(expr.right, { value: "string" }) ||
		!t.isUnaryExpression(expr.left, { operator: "typeof" })
	) {
		return null;
	}
	const member = expr.left.argument;
	if (
		(t.isOptionalMemberExpression(member) || t.isMemberExpression(member)) &&
		!member.computed &&
		isMemberPropertyName(member, propertyName) &&
		t.isIdentifier(member.object)
	) {
		return member.object.name;
	}
	return null;
}

function getVoidZeroMemberObjectName(
	expr: t.Expression,
	propertyName: string,
): string | null {
	if (
		!t.isBinaryExpression(expr, { operator: "===" }) ||
		!isVoidZeroExpression(expr.right)
	) {
		return null;
	}
	const member = expr.left;
	if (
		(t.isOptionalMemberExpression(member) || t.isMemberExpression(member)) &&
		!member.computed &&
		isMemberPropertyName(member, propertyName) &&
		t.isIdentifier(member.object)
	) {
		return member.object.name;
	}
	return null;
}

function containsMemberForObject(
	node: t.Node,
	objectName: string,
	propertyName: string,
): boolean {
	return nodeContains(
		node,
		(child) =>
			(t.isOptionalMemberExpression(child) || t.isMemberExpression(child)) &&
			!child.computed &&
			isMemberPropertyName(child, propertyName) &&
			t.isIdentifier(child.object, { name: objectName }),
	);
}

function isReadStateRebuildSet(node: t.Node, inputName: string): boolean {
	if (!t.isCallExpression(node) || !t.isMemberExpression(node.callee)) {
		return false;
	}
	if (!isMemberPropertyName(node.callee, "set")) return false;
	const state = node.arguments[1];
	if (!t.isObjectExpression(state)) return false;
	const filePath = getObjectPropertyByName(state, "filePath");
	if (
		!filePath ||
		!getObjectPropertyByName(state, "offset") ||
		!getObjectPropertyByName(state, "limit")
	) {
		return false;
	}
	return containsMemberForObject(filePath.value, inputName, "file_path");
}

function isImplicitOutputTailExclusion(
	term: t.Expression,
	inputName: string,
): boolean {
	if (!t.isUnaryExpression(term, { operator: "!" })) return false;
	const call = term.argument;
	if (!t.isCallExpression(call)) return false;
	if (!t.isMemberExpression(call.callee)) return false;
	if (!isMemberPropertyName(call.callee, "endsWith")) return false;
	if (
		call.arguments.length !== 1 ||
		!t.isStringLiteral(call.arguments[0], { value: ".output" })
	) {
		return false;
	}
	if (!t.isCallExpression(call.callee.object)) return false;
	if (!t.isIdentifier(call.callee.object.callee, { name: "String" }))
		return false;
	const source = call.callee.object.arguments[0];
	return (
		t.isExpression(source) &&
		containsMemberForObject(source, inputName, "file_path")
	);
}

interface ReadStateRebuildCandidate {
	path: NodePath<t.IfStatement>;
	inputName: string;
	state: "patched" | "unpatched" | "other";
}

function classifyReadStateRebuildGuard(
	path: NodePath<t.IfStatement>,
): ReadStateRebuildCandidate | null {
	if (!t.isExpression(path.node.test)) return null;
	const terms = flattenLogicalAndTerms(path.node.test);
	const inputNames = new Set(
		terms
			.map((term) => getTypeofStringMemberObjectName(term, "file_path"))
			.filter((value): value is string => value !== null),
	);
	if (inputNames.size !== 1) return null;
	const inputName = [...inputNames][0];
	if (
		!nodeContains(path.node.consequent, (node) =>
			isReadStateRebuildSet(node, inputName),
		)
	) {
		return null;
	}
	const hasRangeVoid = terms.some(
		(term) => getVoidZeroMemberObjectName(term, "range") === inputName,
	);
	const hasOutputExclusion = terms.some((term) =>
		isImplicitOutputTailExclusion(term, inputName),
	);
	return {
		path,
		inputName,
		state:
			hasRangeVoid && hasOutputExclusion
				? "patched"
				: !hasRangeVoid && !hasOutputExclusion
					? "unpatched"
					: "other",
	};
}

export function hasReadStateRebuildRangeGuard(ast: t.File): boolean {
	const candidates: ReadStateRebuildCandidate[] = [];
	traverse(ast, {
		IfStatement(path) {
			const candidate = classifyReadStateRebuildGuard(path);
			if (candidate) candidates.push(candidate);
		},
	});
	return candidates.length === 1 && candidates[0].state === "patched";
}

function hasChangedSnippetCap8000(ast: t.File): boolean {
	let found = false;
	traverse(ast, {
		VariableDeclarator(path) {
			if (!t.isIdentifier(path.node.id, { name: "maxChangedSnippetChars" })) {
				return;
			}
			if (t.isNumericLiteral(path.node.init, { value: 8000 })) {
				found = true;
				path.stop();
			}
		},
	});
	return found;
}

function hasAutoRangeTokenBudget50000(ast: t.File): boolean {
	let found = false;
	traverse(ast, {
		VariableDeclarator(path) {
			if (!t.isIdentifier(path.node.id, { name: "autoRangeTokenBudget" })) {
				return;
			}
			if (t.isNumericLiteral(path.node.init, { value: 50000 })) {
				found = true;
				path.stop();
			}
		},
	});
	return found;
}

function hasChangedHeadBudgetMultiplier(ast: t.File): boolean {
	// The head-budget split is `Math.floor(changedSnippetBudget * 0.65)`. Pin the
	// 0.65 multiplier so a silent retune of the head/tail balance is caught.
	let found = false;
	traverse(ast, {
		BinaryExpression(path) {
			if (path.node.operator !== "*") return;
			if (!t.isIdentifier(path.node.left, { name: "changedSnippetBudget" })) {
				return;
			}
			if (t.isNumericLiteral(path.node.right, { value: 0.65 })) {
				found = true;
				path.stop();
			}
		},
	});
	return found;
}

function hasSnippetSourceCall(ast: t.File): boolean {
	let found = false;
	traverse(ast, {
		VariableDeclarator(path) {
			if (!t.isIdentifier(path.node.id, { name: "changedSnippetRaw" })) return;
			if (t.isCallExpression(path.node.init)) {
				found = true;
				path.stop();
			}
		},
	});
	return found;
}

function hasChangedSnippetReturnBinding(ast: t.File): boolean {
	let found = false;
	traverse(ast, {
		ObjectProperty(path) {
			if (getObjectKeyName(path.node.key) !== "snippet") return;
			if (t.isIdentifier(path.node.value, { name: "changedSnippet" })) {
				found = true;
				path.stop();
			}
		},
	});
	return found;
}

function hasChangedFileSeenTimestampBump(ast: t.File): boolean {
	let hoistedMtimeDecl = false;
	let bumpAssignsHoistedMtime = false;
	traverse(ast, {
		VariableDeclarator(path) {
			if (!t.isIdentifier(path.node.id, { name: "__ccChangedFileMtime" }))
				return;
			if (!t.isAwaitExpression(path.node.init)) return;
			if (!t.isCallExpression(path.node.init.argument)) return;
			hoistedMtimeDecl = true;
		},
		IfStatement(path) {
			const { test, consequent } = path.node;
			if (!t.isCallExpression(test)) return;
			if (test.arguments.length !== 2) return;
			const [stateArg, contentArg] = test.arguments;
			if (!t.isIdentifier(stateArg)) return;
			if (
				!t.isMemberExpression(contentArg) ||
				contentArg.computed ||
				!isMemberPropertyName(contentArg, "content")
			) {
				return;
			}
			if (!t.isBlockStatement(consequent)) return;
			const bumpsToHoistedMtime = consequent.body.some(
				(st) =>
					t.isExpressionStatement(st) &&
					t.isAssignmentExpression(st.expression, { operator: "=" }) &&
					t.isMemberExpression(st.expression.left) &&
					isMemberPropertyName(st.expression.left, "timestamp") &&
					t.isIdentifier(st.expression.right, {
						name: "__ccChangedFileMtime",
					}),
			);
			const returnsNull = consequent.body.some(
				(st) => t.isReturnStatement(st) && t.isNullLiteral(st.argument),
			);
			if (bumpsToHoistedMtime && returnsNull) {
				bumpAssignsHoistedMtime = true;
			}
		},
	});
	return hoistedMtimeDecl && bumpAssignsHoistedMtime;
}

function hasRegexLiteral(ast: t.File, pattern: string, flags = ""): boolean {
	let found = false;
	traverse(ast, {
		RegExpLiteral(path) {
			if (path.node.pattern !== pattern) return;
			if (path.node.flags !== flags) return;
			found = true;
			path.stop();
		},
	});
	return found;
}

function hasFallbackSingleLineLimit(ast: t.File): boolean {
	let found = false;
	traverse(ast, {
		AssignmentExpression(path) {
			if (path.node.operator !== "=") return;
			if (!t.isIdentifier(path.node.left, { name: "fallbackLimit" })) return;
			if (!t.isNumericLiteral(path.node.right, { value: 1 })) return;
			found = true;
			path.stop();
		},
	});
	return found;
}

function hasFallbackSizeLimitBinding(ast: t.File): boolean {
	let found = false;
	traverse(ast, {
		VariableDeclarator(path) {
			if (!t.isIdentifier(path.node.id, { name: "fallbackSizeLimit" })) return;
			found = true;
			path.stop();
		},
	});
	return found;
}

interface ReadVerifyContext {
	code: string;
	ast: t.File;
	schemaObject: t.ObjectExpression;
	callParam: t.ObjectPattern;
	callKeys: Set<string>;
	rangeBindingName: string;
	validateKeys: Set<string>;
	callMethod: t.ObjectMethod | t.ObjectProperty | null;
}

function verifyReadSchemaAndPrompt(ctx: ReadVerifyContext): string | null {
	const { ast, schemaObject } = ctx;
	const promptText = getReadToolPromptText(ast);
	const hasPromptHelper =
		ctx.code.includes(`function ${READ_PROMPT_PATCH_HELPER}`) &&
		ctx.code.includes(`function ${READ_DESCRIPTION_PATCH_HELPER}`);
	if (promptText == null && !hasPromptHelper) {
		return "Unable to resolve Read prompt text after patching";
	}
	const descriptionText = getReadToolDescriptionText(ast);
	if (descriptionText !== null && descriptionText !== READ_DESCRIPTION_TEXT) {
		return "Read description was not rewritten to the expected text";
	}
	const promptSurface = promptText ?? ctx.code;
	if (
		!promptSurface.includes(
			"Range parameter (for text files only, supported bat-style forms):",
		)
	) {
		return "Missing range parameter description";
	}
	if (!promptSurface.includes("-30:")) {
		return "Missing negative range example in description";
	}
	if (!promptSurface.includes("30:40:2")) {
		return "Missing range-with-context example in description";
	}
	if (!promptSurface.includes("show_whitespace: true")) {
		return "Missing show_whitespace parameter description";
	}
	if (!promptSurface.includes('pages: "1-5"')) {
		return "Missing pages parameter documentation/example";
	}
	if (!hasNotebookSupportNote(promptSurface)) {
		return "Missing notebook support note in Read prompt";
	}
	if (!hasFileOnlyConstraint(promptSurface)) {
		return "Missing file-only constraint in Read prompt";
	}
	if (!hasMissingFileNote(promptSurface)) {
		return "Missing non-existent file behavior note in Read prompt";
	}
	if (!promptSurface.includes(MODERN_READ_CODE_FILE_CAVEAT)) {
		return "Missing code-file tool-choice caveat in Read prompt";
	}
	if (!schemaFieldHasMethodCall(schemaObject, "range", "string")) {
		return "Missing range parameter in schema";
	}
	if (!schemaFieldHasMethodCall(schemaObject, "show_whitespace", "boolean")) {
		return "Missing show_whitespace parameter in schema";
	}
	if (schemaHasLegacyOffsetOrLimit(schemaObject)) {
		return "Offset/limit parameters still present in Read schema";
	}
	if (
		promptText != null &&
		(promptText.includes("offset and limit parameters") ||
			promptText.includes("line offset and limit"))
	) {
		return "Offset/limit guidance still present in Read prompt";
	}
	if (promptText?.includes("cat -n format")) {
		return "Read prompt still references cat -n formatting";
	}
	if (
		ctx.code.includes("sections you need.") &&
		!ctx.code.includes(
			"Use the range parameter to read only the sections you need.",
		)
	) {
		return "Context suggestion guidance was not updated to range language";
	}
	return null;
}

function verifyReadBatCore(ctx: ReadVerifyContext): string | null {
	const { code, ast } = ctx;
	if (!code.includes("execFileSync")) {
		return "Missing bat integration in text reading";
	}
	// Structural: require an actual execFileSync("bat", ...) CallExpression
	// somewhere in the AST. A substring "execFileSync" appearing only inside
	// a docstring, comment, or unrelated runtime feature should not satisfy
	// the verifier. The bat call may live in the Read tool's call() body or
	// in a helper function it delegates to, so this is a global AST scan.
	let foundBatCall = false;
	traverse(ast, {
		CallExpression(path) {
			const callee = path.node.callee;
			const isExecFileSync =
				t.isIdentifier(callee, { name: "execFileSync" }) ||
				(t.isMemberExpression(callee) &&
					isMemberPropertyName(callee, "execFileSync"));
			if (!isExecFileSync) return;
			if (path.node.arguments.length < 1) return;
			const arg0 = path.node.arguments[0];
			if (t.isStringLiteral(arg0) && arg0.value === "bat") {
				foundBatCall = true;
				path.stop();
			}
		},
	});
	if (!foundBatCall) {
		return 'No execFileSync("bat", ...) CallExpression found in AST';
	}
	if (!code.includes("normalizedRange")) {
		return "Bat IIFE not injected (D2I call site not found in call body or helper)";
	}
	if (!code.includes('var style = "numbers"')) {
		return "Bat success path is not configured to emit numbered lines";
	}
	if (code.includes("offsetLegacy") || code.includes("limitLegacy")) {
		return "Unexpected offsetLegacy/limitLegacy marker names still present";
	}
	if (
		!code.includes("...await fallbackFn(") &&
		!code.includes("...(await fallbackFn(")
	) {
		return "Missing awaited fallback in bat reader catch path";
	}
	if (!hasFallbackFnBoundedArgs(ast)) {
		return "Fallback call does not preserve bounded read arguments";
	}
	if (!code.includes("fallbackLimit === void 0 ? fallbackMaxBytes : void 0")) {
		return "Fallback call missing size-limit guard for unbounded ranges";
	}
	const hasRangeValidation = code.includes(
		"Invalid range format. Use supported bat-style forms",
	);
	const hasRangeNormalization =
		code.includes("while (rawRange.length >= 2)") &&
		code.includes("rawRange.slice(1, -1).trim()");
	const hasRangeArg = code.includes('args.push("-r", normalizedRange)');
	const hasOutputTailDefault = code.includes('filePath.endsWith(".output")');
	const hasRawRangePass = code.includes('args.push("-r", range)');
	const hasWhitespaceFlag = code.includes('args.push("-A")');
	if (!hasRangeValidation) {
		return "Missing range validation for supported bat-style forms";
	}
	if (!hasRangeNormalization) {
		return "Missing wrapper-quote normalization for range values";
	}
	if (!hasRangeArg) {
		return "Read command not using normalized range for bat";
	}
	if (!hasOutputTailDefault) {
		return "Missing default .output tail fallback";
	}
	if (code.includes("stat.size > 102400")) {
		return "Unexpected generic size-based auto-tail remains; full-file reads should be allowed";
	}
	if (!code.includes("autoRanged")) {
		return "Missing auto-range for oversized files without explicit range";
	}
	if (!hasAutoRangeTokenBudget50000(ast)) {
		return "Auto-range token budget is not tuned to 50000";
	}
	if (!code.includes("FILE TRUNCATED")) {
		return "Missing auto-range truncation notice in output";
	}
	if (hasRawRangePass) {
		return "Read command still passes raw range directly to bat";
	}
	if (!hasWhitespaceFlag) {
		return "Missing show_whitespace flag in bat command";
	}
	if (!code.includes("isDirectory()")) {
		return "Missing directory check before bat read";
	}
	return null;
}

function verifyReadCallSignature(ctx: ReadVerifyContext): string | null {
	const { ast, callKeys, callParam, rangeBindingName } = ctx;
	if (!callKeys.has("range")) {
		return "Call signature not updated to use range";
	}
	if (!callKeys.has("show_whitespace")) {
		return "Call signature not updated to use show_whitespace";
	}
	if (!objectPatternPropertyHasVoidZeroDefault(callParam, "range")) {
		return "Call signature range parameter missing void 0 default";
	}
	if (!objectPatternPropertyHasVoidZeroDefault(callParam, "show_whitespace")) {
		return "Call signature show_whitespace parameter missing void 0 default";
	}
	if (callKeys.has("offset")) {
		return "Call signature still destructures offset";
	}
	if (callKeys.has("limit")) {
		return "Call signature still destructures limit";
	}
	if (!hasCallCompatRangeBridge(ast, rangeBindingName)) {
		return "Missing offset/limit -> range compatibility bridge in call()";
	}
	if (callKeys.has("diff")) {
		return "Call signature still includes diff";
	}
	return null;
}

function verifyReadLineAccounting(ctx: ReadVerifyContext): string | null {
	const { code, ast } = ctx;
	if (!code.includes("normalizedOutput")) {
		return "Missing normalizedOutput line count normalization";
	}
	if (!code.includes('output.endsWith("\\n")')) {
		return "Missing trailing-newline line count guard";
	}
	if (!code.includes("startLine: START_LINE")) {
		return "Read result startLine not updated to use range";
	}
	if (!code.includes("var fileTotalLines = null")) {
		return "Missing fileTotalLines tracking for negative ranges";
	}
	if (!hasEnsureTotalLinesHelper(ast)) {
		return "Missing shared total-line counter helper for ranged reads";
	}
	if (!code.includes("fs.openSync(filePath")) {
		return "ensureTotalLines missing fd-based line counting";
	}
	if (!hasNormalizedRangeTotalLinesRefresh(ast)) {
		return "Missing full-file line count refresh for positive ranges";
	}
	if (!code.includes("lastByte === 10 ? 0 : 1")) {
		return "Missing trailing-newline-aware total line calculation for negative ranges";
	}
	if (code.includes("fileTotalLines = newlines + 1")) {
		return "Negative range total line calculation is off by one for trailing-newline files";
	}
	if (
		code.includes(
			"normalizedRange ? Math.max(0, startLine + lineCount - 1) : lineCount",
		)
	) {
		return "totalLines still uses range-end estimate instead of real file total";
	}
	return null;
}

function hasMiddleDotLabel(code: string, label: string): boolean {
	return (
		code.includes(` · ${label}`) ||
		code.includes(`\\xB7 ${label}`) ||
		code.includes(`\\u00b7 ${label}`)
	);
}

function verifyReadExamplesAndValidate(ctx: ReadVerifyContext): string | null {
	const { code, validateKeys } = ctx;
	const readToolPath = findReadToolObjectPath(ctx.ast);
	const coerceShape = readToolPath ? getReadCoerceShape(readToolPath) : null;
	if (!coerceShape) {
		return "Unable to resolve Read.coerceInput normalization shape";
	}
	for (const { fieldName, marker } of [
		{ fieldName: "pages", marker: "pages_empty" },
		{ fieldName: "range", marker: "range_empty" },
	]) {
		if (
			!coerceShape.body.body.some((statement) =>
				isBlankOptionalInputRepair(
					statement,
					coerceShape.normalizedInputName,
					coerceShape.repairListName,
					fieldName,
					marker,
				),
			)
		) {
			return `Read.coerceInput does not drop blank ${fieldName} values`;
		}
	}
	// input_examples may be absent in newer bundles. Skip checks when absent.
	if (code.includes("input_examples")) {
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
	}
	if (
		code.includes(
			'{ file_path: "/Users/username/project/README.md", limit: 100, offset: 50 }',
		)
	) {
		return "Read input_examples still use offset/limit";
	}
	if (validateKeys.has("offset")) {
		return "validateInput still destructures offset (range bypass missing)";
	}
	if (
		code.includes("Use the pages parameter to read specific page ranges") &&
		!validateKeys.has("pages")
	) {
		return "validateInput missing pages parameter (would crash)";
	}
	if (!code.includes('opts.push("whitespace")')) {
		return "renderToolUseMessage not showing whitespace option";
	}
	if (!hasMiddleDotLabel(code, "pages ")) {
		return "renderToolUseMessage missing pages display";
	}
	if (!hasMiddleDotLabel(code, "range: ")) {
		return "renderToolUseMessage not showing range on agent-output reads";
	}
	return null;
}

function verifyReadStateAndSnippetGuards(
	ctx: ReadVerifyContext,
): string | null {
	const { code, ast } = ctx;
	const readFileStateMarkers = hasReadFileStateCompatMarkers(ast);
	if (!readFileStateMarkers.hasRange) {
		return "readFileState.set missing range field";
	}
	if (!readFileStateMarkers.hasOffsetCompat) {
		return "readFileState.set missing offset compatibility marker for ranged reads";
	}
	if (!readFileStateMarkers.hasLimitCompat) {
		return "readFileState.set missing limit compatibility marker for ranged reads";
	}
	if (!code.includes('endsWith(".output")')) {
		return "readFileState compatibility markers missing implicit .output tail handling";
	}
	if (!hasReadStateRebuildRangeGuard(ast)) {
		return "read-state rebuild guard missing range-aware partial-read check";
	}
	if (!code.includes("changedSnippetRaw")) {
		return "changed-file watcher still computes diff inline (missing single-call memoization)";
	}
	if (!code.includes("maxChangedSnippetChars")) {
		return "changed-file watcher missing snippet cap variable";
	}
	if (!hasChangedSnippetCap8000(ast)) {
		return "changed-file watcher snippet cap is not tuned to 8000 chars";
	}
	if (!hasSnippetSourceCall(ast)) {
		return "changedSnippetRaw is not assigned from a CallExpression (expected diff source call)";
	}
	if (!code.includes("changedSnippetTruncMarker")) {
		return "changed-file watcher missing truncation marker binding";
	}
	if (!code.includes("changedSnippetBudget")) {
		return "changed-file watcher missing truncation budget computation";
	}
	if (!code.includes("changedHeadBudget")) {
		return "changed-file watcher missing head budget computation";
	}
	if (!hasChangedHeadBudgetMultiplier(ast)) {
		return "changed-file watcher head budget multiplier drifted from 0.65";
	}
	if (!code.includes("changedTailBudget")) {
		return "changed-file watcher missing tail budget computation";
	}
	if (!code.includes("[TRUNCATED - changed-file diff head+tail summary]")) {
		return "changed-file watcher missing head+tail truncation marker";
	}
	if (!hasChangedSnippetReturnBinding(ast)) {
		return "changed-file watcher return payload missing capped snippet binding";
	}
	if (!hasChangedFileSeenTimestampBump(ast)) {
		return "changed-file watcher does not mark content-identical re-reads as seen";
	}
	if (code.includes("provided offset (")) {
		return "Read short-file warning still references offset instead of range start line";
	}
	return null;
}

function verifyReadRangeRegexAndFallbackMarkers(
	ctx: ReadVerifyContext,
): string | null {
	const { ast } = ctx;
	if (
		!hasRegexLiteral(
			ast,
			"^(?:[1-9]\\d*)(?::(?:\\+[1-9]\\d*|[1-9]\\d*(?::[1-9]\\d*)?|)|::[1-9]\\d*)?$",
		)
	) {
		return "Missing numericRange validation regex";
	}
	if (!hasRegexLiteral(ast, "^:[1-9]\\d*$")) {
		return "Missing fromStart validation regex";
	}
	if (!hasRegexLiteral(ast, "^-[1-9]\\d*:$")) {
		return "Missing negative-tail range validation regex";
	}
	if (!hasFallbackSingleLineLimit(ast)) {
		return "Missing single-line fallback limit for plain 'N' bat ranges";
	}
	if (!hasFallbackSizeLimitBinding(ast)) {
		return "Missing fallbackSizeLimit guard in fallback path";
	}
	return null;
}

export const readWithBat: Patch = {
	tag: "read-bat",

	// Patch error messages outside Read tool scope to reference range instead of
	// offset/limit wording.
	// These live in FileTooLargeError / MaxFileReadTokenExceededError classes and other prompt
	// strings that the scoped readToolPath.traverse() in astPasses does not reach.
	string: (code) =>
		code
			.replace(
				/Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file\./g,
				"Use the range parameter to read specific portions of the file, or use Bash text-search tooling to search for specific content.",
			)
			.replace(
				/use offset and limit for larger files/g,
				"use the range parameter for larger files",
			)
			.replace(
				/Use offset and limit parameters to read specific portions of the file, search within it for specific content, and jq to make structured queries\./g,
				"Use the range parameter to read specific portions of the file, or use Bash text-search tooling to search for specific content.",
			)
			.replace(
				/Use offset and limit parameters to read only the sections you need\./g,
				"Use the range parameter to read only the sections you need.",
			),

	// AST patches for structural changes (robust against minified names)
	astPasses: (ast) => [
		{
			pass: "mutate",
			visitor: {
				Program: {
					exit() {
						const tplExpression = (code: string): t.Expression =>
							template.expression(code, {
								placeholderPattern: false,
							})() as t.Expression;

						const patchText = (text: string): string => {
							let updated = text;

							// Two compile-time patterns audited against clean 2.1.148:
							// - "Use offset and limit parameters..." (3 hits in bundle) and
							//   "shorter than the provided offset" (1 hit) remain LIVE.
							// - The earlier "Please use offset and limit..." / GrepTool /
							//   " tool to search for specific content" patterns no longer
							//   match upstream (0 hits) and have been removed; the runtime
							//   `_claudePatchReadPrompt` helper still handles dynamic
							//   prompt rewrites for surfaces that aren't in the bundle.
							updated = updated.replace(
								/Use offset and limit parameters to read specific portions of the file,/g,
								"Use the range parameter (supported bat-style forms) to read specific portions of the file,",
							);
							updated = updated.replace(
								/shorter than the provided offset/g,
								"shorter than the provided range start line",
							);

							return updated;
						};

						ensureReadPromptPatchHelpers(ast);

						// 0. Replace remaining offset/limit guidance strings only within the
						// Read tool surface.
						const readToolPath = findReadToolObjectPath(ast);
						if (readToolPath) {
							readToolPath.traverse({
								StringLiteral(path) {
									const updated = patchText(path.node.value);
									if (updated !== path.node.value) path.node.value = updated;
								},
								TemplateLiteral(path) {
									for (const quasi of path.node.quasis) {
										const rawUpdated = patchText(quasi.value.raw);
										if (rawUpdated !== quasi.value.raw) {
											quasi.value.raw = rawUpdated;
										}

										if (typeof quasi.value.cooked === "string") {
											const cookedUpdated = patchText(quasi.value.cooked);
											if (cookedUpdated !== quasi.value.cooked) {
												quasi.value.cooked = cookedUpdated;
											}
										}
									}
								},
							});
						}

						// 0b. Patch the Read tool schema from offset/limit to
						// range/show_whitespace.
						traverse(ast, {
							CallExpression(path) {
								const callee = path.node.callee;
								if (!t.isMemberExpression(callee)) return;
								if (!isMemberPropertyName(callee, "strictObject")) return;
								if (!t.isIdentifier(callee.object)) return;
								if (path.node.arguments.length < 1) return;

								const arg0 = path.node.arguments[0];
								if (!t.isObjectExpression(arg0)) return;

								const hasFilePath = arg0.properties.some((p) =>
									hasObjectKeyName(p, "file_path"),
								);
								if (!hasFilePath) return;

								// Match the Read schema by file_path description string.
								const filePathProp = arg0.properties.find(
									(p): p is t.ObjectProperty =>
										t.isObjectProperty(p) &&
										hasObjectKeyName(p, "file_path") &&
										t.isExpression(p.value) &&
										t.isCallExpression(p.value) &&
										t.isMemberExpression(p.value.callee) &&
										isMemberPropertyName(p.value.callee, "describe") &&
										p.value.arguments.length >= 1 &&
										t.isStringLiteral(p.value.arguments[0], {
											value: "The absolute path to the file to read",
										}),
								);
								if (!filePathProp) return;

								const hasRange = arg0.properties.some((p) =>
									hasObjectKeyName(p, "range"),
								);
								if (hasRange) return;

								const zodVarName = callee.object.name;
								const rangeDesc =
									"Line range using supported bat-style forms: '30:40', '-30:', ':50', '100::10', '30:40:2'. Omit to read entire file.";
								const wsDesc =
									"Reveal invisible characters: tabs (→), spaces (·), newlines (␊). Use to debug indentation issues.";

								const rangeExpr = tplExpression(
									`${zodVarName}.string().optional().describe(${JSON.stringify(rangeDesc)})`,
								);
								const wsExpr = tplExpression(
									`${zodVarName}.boolean().optional().describe(${JSON.stringify(wsDesc)})`,
								);

								const rangeProp = t.objectProperty(
									t.identifier("range"),
									rangeExpr,
								);
								const wsProp = t.objectProperty(
									t.identifier("show_whitespace"),
									wsExpr,
								);

								const newProps: typeof arg0.properties = [];
								for (const prop of arg0.properties) {
									if (
										t.isObjectProperty(prop) &&
										(hasObjectKeyName(prop, "offset") ||
											hasObjectKeyName(prop, "limit"))
									) {
										continue;
									}

									newProps.push(prop);

									if (
										t.isObjectProperty(prop) &&
										hasObjectKeyName(prop, "file_path")
									) {
										newProps.push(rangeProp, wsProp);
									}
								}
								arg0.properties = newProps;
							},
						});

						// Track the range parameter variable name we create
						let rangeVarName: string | null = null;
						let whitespaceVarName: string | null = null;
						let targetRangeVarName: string | null = null;
						let targetWhitespaceVarName: string | null = null;
						let callCompatRestVarName: string | null = null;
						// Track the original read function identifier
						let originalReadFn: string | null = null;
						// Track the file path variable
						let _filePathVar: string | null = null;
						// Track removed call() vars (offset/limit) so delegated helper calls
						// can be rewritten to pass void 0 instead of dangling identifiers.
						const removedCallCompatVars = new Set<string>();

						// Helpers shared between the inline probe and section 2 (D2I replacement).
						const isD2IDestructuring = (id: t.ObjectPattern): boolean =>
							["content", "lineCount", "totalLines"].every((name) =>
								id.properties.some((p) => hasObjectKeyName(p, name)),
							);
						const unwrapAwait = (
							node: t.Expression | null | undefined,
						): t.Expression | null | undefined =>
							t.isAwaitExpression(node) ? node.argument : node;
						const flattenLogicalAndTerms = (
							expr: t.Expression,
						): t.Expression[] => {
							if (t.isLogicalExpression(expr, { operator: "&&" })) {
								return [
									...flattenLogicalAndTerms(expr.left as t.Expression),
									...flattenLogicalAndTerms(expr.right as t.Expression),
								];
							}
							return [expr];
						};

						traverse(ast, {
							ObjectExpression(path) {
								// Find Read tool by name property
								const nameProp = path.node.properties.find(
									(p): p is t.ObjectProperty =>
										t.isObjectProperty(p) && hasObjectKeyName(p, "name"),
								);
								if (!nameProp) return;

								// Resolve the name value (could be string literal or variable reference)
								let nameVal: string | null = null;
								if (t.isStringLiteral(nameProp.value)) {
									nameVal = nameProp.value.value;
								} else if (t.isIdentifier(nameProp.value)) {
									const binding = path.scope.getBinding(nameProp.value.name);
									const init = binding?.path.node;
									if (
										t.isVariableDeclarator(init) &&
										t.isStringLiteral(init.init)
									) {
										nameVal = init.init.value;
									}
								}
								if (nameVal !== "Read") return;

								// 1. Replace Read tool prompt/description strings (AST-only, avoids brittle string matching)
								const promptProp = path.node.properties.find(
									(p): p is t.ObjectMethod | t.ObjectProperty =>
										(t.isObjectMethod(p) || t.isObjectProperty(p)) &&
										hasObjectKeyName(p, "prompt"),
								);
								if (promptProp) {
									if (t.isObjectMethod(promptProp)) {
										for (const stmt of promptProp.body.body) {
											if (!t.isReturnStatement(stmt) || !stmt.argument)
												continue;
											stmt.argument = t.stringLiteral(STATIC_READ_PROMPT);
										}
									} else if (t.isExpression(promptProp.value)) {
										const resolvedPrompt = resolveStringValue(
											path,
											promptProp.value,
										);
										if (resolvedPrompt != null) {
											setOrReplaceObjectPropertyStringValue(
												path,
												promptProp,
												STATIC_READ_PROMPT,
											);
										} else {
											promptProp.value = wrapReadPromptExpression(
												promptProp.value,
												READ_PROMPT_PATCH_HELPER,
											);
										}
									}
								}

								const descProp = path.node.properties.find(
									(p): p is t.ObjectMethod | t.ObjectProperty =>
										(t.isObjectMethod(p) || t.isObjectProperty(p)) &&
										hasObjectKeyName(p, "description"),
								);
								if (descProp) {
									if (t.isObjectMethod(descProp)) {
										for (const stmt of descProp.body.body) {
											if (!t.isReturnStatement(stmt) || !stmt.argument)
												continue;
											const resolvedDescription = resolveStringValue(
												path,
												stmt.argument,
											);
											stmt.argument =
												resolvedDescription == null
													? wrapReadPromptExpression(
															stmt.argument,
															READ_DESCRIPTION_PATCH_HELPER,
														)
													: t.stringLiteral(READ_DESCRIPTION_TEXT);
										}
									} else if (
										t.isObjectProperty(descProp) &&
										t.isExpression(descProp.value)
									) {
										const resolvedDescription = resolveStringValue(
											path,
											descProp.value,
										);
										if (resolvedDescription != null) {
											setOrReplaceObjectPropertyStringValue(
												path,
												descProp,
												READ_DESCRIPTION_TEXT,
											);
										} else {
											descProp.value = wrapReadPromptExpression(
												descProp.value,
												READ_DESCRIPTION_PATCH_HELPER,
											);
										}
									}
								}

								// Keep Read examples aligned with range/pages semantics and avoid
								// stale offset/limit examples.
								const inputExamplesProp = path.node.properties.find(
									(p): p is t.ObjectProperty =>
										t.isObjectProperty(p) &&
										hasObjectKeyName(p, "input_examples") &&
										t.isArrayExpression(p.value),
								);
								if (
									inputExamplesProp &&
									t.isArrayExpression(inputExamplesProp.value)
								) {
									const newInputExamples = tplExpression(`
						[
							{ file_path: "/Users/username/project/src/index.ts" },
							{ file_path: "/Users/username/project/README.md", range: "50:+100" },
							{ file_path: "/Users/username/project/design-doc.pdf", pages: "1-5" }
						]
					`) as t.ArrayExpression;
									inputExamplesProp.value = newInputExamples;
								}

								// Find the call method
								const methodPaths = path.get("properties");
								const findMethodPath = (
									methodName: string,
								): NodePath<t.ObjectMethod | t.ObjectProperty> | null => {
									for (const propPath of methodPaths) {
										if (
											(propPath.isObjectMethod() ||
												propPath.isObjectProperty()) &&
											hasObjectKeyName(propPath.node, methodName)
										) {
											return propPath as NodePath<
												t.ObjectMethod | t.ObjectProperty
											>;
										}
									}
									return null;
								};

								const callMethodPath = findMethodPath("call");
								patchBlankOptionalReadInputs(path);
								if (!callMethodPath?.isObjectMethod()) return;
								const callMethod = callMethodPath.node;
								const callBodyPath = callMethodPath.get(
									"body",
								) as NodePath<t.BlockStatement>;

								// Check if already patched (look for our bat args)
								const bodyStr = JSON.stringify(callMethod.body);
								if (bodyStr.includes("START_LINE")) return;

								const foundValidateMethodPath = findMethodPath("validateInput");
								const validateMethodPath =
									foundValidateMethodPath?.isObjectMethod()
										? foundValidateMethodPath
										: null;
								const validateMethod = validateMethodPath?.node ?? null;
								const validateBodyPath = validateMethodPath?.get("body") as
									| NodePath<t.BlockStatement>
									| undefined;

								// === 1. Modify call signature ===
								// Original: async call({ file_path: A, offset: Q = 1, limit: B = void 0 }, G)
								// New: async call({ file_path: A, range: R = void 0 }, G)
								const params = callMethod.params;
								if (params.length >= 1 && t.isObjectPattern(params[0])) {
									const objPattern = params[0];
									const newProps: (t.ObjectProperty | t.RestElement)[] = [];
									let existingRest: t.RestElement | null = null;

									for (const prop of objPattern.properties) {
										if (t.isRestElement(prop)) {
											existingRest = prop;
											if (t.isIdentifier(prop.argument)) {
												callCompatRestVarName = prop.argument.name;
											}
											continue;
										}
										if (!t.isObjectProperty(prop)) continue;

										const keyName = getObjectKeyName(prop.key);

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
											if (t.isIdentifier(prop.value)) {
												removedCallCompatVars.add(prop.value.name);
											} else if (
												t.isAssignmentPattern(prop.value) &&
												t.isIdentifier(prop.value.left)
											) {
												removedCallCompatVars.add(prop.value.left.name);
											}
										} else {
											newProps.push(prop);
										}
									}

									// Add range parameter: range: R = void 0
									const callReservedNames = getBindingNames(callMethod);
									if (validateMethod) {
										for (const name of getBindingNames(validateMethod)) {
											callReservedNames.add(name);
										}
									}
									rangeVarName = freshIdentifierName("R", callReservedNames);
									callReservedNames.add(rangeVarName);
									whitespaceVarName = freshIdentifierName(
										"WSPC",
										callReservedNames,
									);
									targetRangeVarName = rangeVarName;
									targetWhitespaceVarName = whitespaceVarName;
									const rangeProp = t.objectProperty(
										t.identifier("range"),
										t.assignmentPattern(
											t.identifier(rangeVarName),
											t.unaryExpression("void", t.numericLiteral(0)),
										),
									);
									newProps.push(rangeProp);

									// Add show_whitespace parameter: show_whitespace: WSPC = void 0
									const wsProp = t.objectProperty(
										t.identifier("show_whitespace"),
										t.assignmentPattern(
											t.identifier(whitespaceVarName),
											t.unaryExpression("void", t.numericLiteral(0)),
										),
									);
									newProps.push(wsProp);
									if (!existingRest) {
										callCompatRestVarName = "READ_COMPAT";
										existingRest = t.restElement(
											t.identifier(callCompatRestVarName),
										);
									} else if (!callCompatRestVarName) {
										callCompatRestVarName = "READ_COMPAT";
										existingRest.argument = t.identifier(callCompatRestVarName);
									}
									newProps.push(existingRest);

									objPattern.properties = newProps;
								}

								// === 1b. Modify validateInput signature and range bypass ===
								// Original: async validateInput({ file_path: A, offset: Q, limit: B, pages: Y }, G)
								// New: async validateInput({ file_path: A, pages: Y, range: R }, G)
								if (validateMethod) {
									const rangeId = t.identifier(rangeVarName || "R");
									const params = validateMethod.params;
									if (params.length >= 1 && t.isObjectPattern(params[0])) {
										const objPattern = params[0];
										let offsetVar: string | null = null;
										let limitVar: string | null = null;
										let filePathVar: string | null = null;

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
											if (keyName === "file_path") {
												if (t.isIdentifier(prop.value))
													filePathVar = prop.value.name;
												else if (t.isAssignmentPattern(prop.value)) {
													if (t.isIdentifier(prop.value.left))
														filePathVar = prop.value.left.name;
												}
											}
											if (keyName === "offset") {
												if (t.isIdentifier(prop.value))
													offsetVar = prop.value.name;
												else if (t.isAssignmentPattern(prop.value)) {
													if (t.isIdentifier(prop.value.left))
														offsetVar = prop.value.left.name;
												}
												continue;
											}
											if (keyName === "limit") {
												if (t.isIdentifier(prop.value))
													limitVar = prop.value.name;
												else if (t.isAssignmentPattern(prop.value)) {
													if (t.isIdentifier(prop.value.left))
														limitVar = prop.value.left.name;
												}
												continue;
											}
											// Preserve everything else (e.g. pages param, future options)
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
											newProps.push(
												t.objectProperty(t.identifier("range"), rangeId),
											);
										objPattern.properties = newProps;

										// Update large-file guard to honor range
										// Find: if (!eG1(Y) && !Q && !B) return ...
										const hasNegatedIdentifier = (
											node: any,
											name: string,
										): boolean => {
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
										const isNegatedIdentifierTerm = (
											node: t.Expression,
											name: string,
										): boolean =>
											t.isUnaryExpression(node, { operator: "!" }) &&
											t.isIdentifier(node.argument, { name });
										const joinLogicalAndTerms = (
											terms: t.Expression[],
										): t.Expression => {
											let acc = t.cloneNode(terms[0], true) as t.Expression;
											for (let i = 1; i < terms.length; i += 1) {
												acc = t.logicalExpression(
													"&&",
													acc,
													t.cloneNode(terms[i], true) as t.Expression,
												);
											}
											return acc;
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

										validateBodyPath?.traverse({
											IfStatement(ifPath) {
												const test = ifPath.node.test;

												// Must have both negated offset AND negated limit vars to be the right condition
												// This is the file size guard: if (!sizeCheck(w) && !K && !q)
												if (!offsetVar || !limitVar) return;
												if (!hasNegatedIdentifier(test, offsetVar)) return;
												if (!hasNegatedIdentifier(test, limitVar)) return;

												// Find the negated function call (the size check) so we only
												// patch the intended large-file guard.
												if (!findNegatedFunctionCall(test)) return;

												// Replace: !sizeCheck(w) && !K && !q
												// With: !sizeCheck(w) && !R && !(typeof file_path==="string" && file_path.endsWith(".output"))
												const notRangeExpr = t.unaryExpression("!", rangeId);
												let rangeGateExpr: t.Expression = notRangeExpr;
												if (filePathVar) {
													const filePathId = t.identifier(filePathVar);
													const outputPathExpr = t.logicalExpression(
														"&&",
														t.binaryExpression(
															"===",
															t.unaryExpression(
																"typeof",
																t.cloneNode(filePathId, true),
															),
															t.stringLiteral("string"),
														),
														t.callExpression(
															t.memberExpression(
																t.cloneNode(filePathId, true),
																t.identifier("endsWith"),
															),
															[t.stringLiteral(".output")],
														),
													);
													rangeGateExpr = t.logicalExpression(
														"&&",
														notRangeExpr,
														t.unaryExpression("!", outputPathExpr),
													);
												}
												const terms = flattenLogicalAndTerms(test);
												const preservedTerms: t.Expression[] = [];
												let removedOffsetGuard = false;
												let removedLimitGuard = false;
												for (const term of terms) {
													if (isNegatedIdentifierTerm(term, offsetVar)) {
														removedOffsetGuard = true;
														continue;
													}
													if (isNegatedIdentifierTerm(term, limitVar)) {
														removedLimitGuard = true;
														continue;
													}
													preservedTerms.push(
														t.cloneNode(term, true) as t.Expression,
													);
												}
												if (!removedOffsetGuard || !removedLimitGuard) return;
												preservedTerms.push(rangeGateExpr);
												ifPath.node.test = joinLogicalAndTerms(preservedTerms);
												ifPath.stop();
											},
										});
									}
								}

								// === 1c. Patch dedup check in call body ===
								// Upstream: if (J && !J.isPartialView && J.offset !== void 0) {
								//             if (J.offset === $ && J.limit === q) ...
								// The removed vars ($ for offset, q for limit) cause ReferenceError
								// on the second read of any file. Rewrite to compare range instead.
								if (removedCallCompatVars.size > 0) {
									callBodyPath.traverse({
										IfStatement(ifPath) {
											const { test } = ifPath.node;
											if (!t.isLogicalExpression(test, { operator: "&&" }))
												return;

											// Match: ... && J.offset !== void 0
											const outerTerms = flattenLogicalAndTerms(
												test as t.Expression,
											);
											let dedupObjName: string | null = null;
											let offsetGuardIdx = -1;
											for (let i = 0; i < outerTerms.length; i++) {
												const term = outerTerms[i];
												if (
													!t.isBinaryExpression(term, {
														operator: "!==",
													})
												)
													continue;
												if (!isVoidZeroExpression(term.right)) continue;
												if (
													t.isMemberExpression(term.left) &&
													!term.left.computed &&
													isMemberPropertyName(term.left, "offset") &&
													t.isIdentifier(term.left.object)
												) {
													dedupObjName = term.left.object.name;
													offsetGuardIdx = i;
													break;
												}
											}
											if (!dedupObjName || offsetGuardIdx < 0) return;

											// Verify inner if compares removed vars
											const consequent = ifPath.node.consequent;
											const innerBlock = t.isBlockStatement(consequent)
												? consequent.body
												: [consequent];
											const innerIf = innerBlock.find((s): s is t.IfStatement =>
												t.isIfStatement(s),
											);
											if (!innerIf) return;

											const innerTerms = flattenLogicalAndTerms(
												innerIf.test as t.Expression,
											);
											const refsRemovedVars = innerTerms.some((term) => {
												if (!t.isBinaryExpression(term, { operator: "===" }))
													return false;
												return (
													(t.isIdentifier(term.right) &&
														removedCallCompatVars.has(term.right.name)) ||
													(t.isIdentifier(term.left) &&
														removedCallCompatVars.has(
															(term.left as t.Identifier).name,
														))
												);
											});
											if (!refsRemovedVars) return;

											// Rewrite outer guard: J.offset !== void 0 -> J.range !== void 0
											outerTerms[offsetGuardIdx] = t.binaryExpression(
												"!==",
												t.memberExpression(
													t.identifier(dedupObjName),
													t.identifier("range"),
												),
												t.unaryExpression("void", t.numericLiteral(0)),
											);
											// Rebuild the && chain
											let newOuterTest = outerTerms[0];
											for (let i = 1; i < outerTerms.length; i++) {
												newOuterTest = t.logicalExpression(
													"&&",
													newOuterTest as t.Expression,
													outerTerms[i],
												);
											}
											ifPath.node.test = newOuterTest;

											// Rewrite inner comparison: J.offset === $ && J.limit === q -> J.range === R
											innerIf.test = t.binaryExpression(
												"===",
												t.memberExpression(
													t.identifier(dedupObjName),
													t.identifier("range"),
												),
												t.identifier(rangeVarName || "R"),
											);

											ifPath.stop();
										},
									});

									callBodyPath.traverse({
										IfStatement(ifPath) {
											const { test } = ifPath.node;
											if (!t.isLogicalExpression(test, { operator: "&&" }))
												return;

											const terms = flattenLogicalAndTerms(
												test as t.Expression,
											);
											let removedOffsetFullReadTerm = false;
											let removedLimitFullReadTerm = false;
											const preservedTerms: t.Expression[] = [];

											for (const term of terms) {
												if (
													t.isBinaryExpression(term, { operator: "===" }) &&
													t.isIdentifier(term.left) &&
													removedCallCompatVars.has(term.left.name) &&
													t.isNumericLiteral(term.right, { value: 1 })
												) {
													removedOffsetFullReadTerm = true;
													continue;
												}
												if (
													t.isBinaryExpression(term, { operator: "===" }) &&
													t.isIdentifier(term.left) &&
													removedCallCompatVars.has(term.left.name) &&
													isVoidZeroExpression(term.right)
												) {
													removedLimitFullReadTerm = true;
													continue;
												}
												preservedTerms.push(term);
											}

											if (
												!removedOffsetFullReadTerm ||
												!removedLimitFullReadTerm
											) {
												return;
											}

											const rangeId = t.identifier(rangeVarName || "R");
											let fullReadRangeGate: t.Expression = t.binaryExpression(
												"===",
												t.cloneNode(rangeId, true),
												t.unaryExpression("void", t.numericLiteral(0)),
											);
											if (_filePathVar) {
												const filePathId = t.identifier(_filePathVar);
												const outputPathExpr = t.logicalExpression(
													"&&",
													t.binaryExpression(
														"===",
														t.unaryExpression(
															"typeof",
															t.cloneNode(filePathId, true),
														),
														t.stringLiteral("string"),
													),
													t.callExpression(
														t.memberExpression(
															t.cloneNode(filePathId, true),
															t.identifier("endsWith"),
														),
														[t.stringLiteral(".output")],
													),
												);
												fullReadRangeGate = t.logicalExpression(
													"&&",
													fullReadRangeGate,
													t.unaryExpression("!", outputPathExpr),
												);
											}
											preservedTerms.push(fullReadRangeGate);

											let rebuiltTest = preservedTerms[0];
											for (let i = 1; i < preservedTerms.length; i++) {
												rebuiltTest = t.logicalExpression(
													"&&",
													rebuiltTest as t.Expression,
													preservedTerms[i],
												);
											}
											ifPath.node.test = rebuiltTest;
											ifPath.stop();
										},
									});
								}

								// === Probe for inline vs delegation ===
								// Detect whether the text-reading call is inline or delegated
								// to a helper function, then patch the body that owns the read.
								let targetBodyPath = callBodyPath;

								{
									let foundInline = false;
									callBodyPath.traverse({
										VariableDeclarator(probePath) {
											const id = probePath.node.id;
											if (!t.isObjectPattern(id)) return;
											if (!t.isCallExpression(unwrapAwait(probePath.node.init)))
												return;
											if (isD2IDestructuring(id)) {
												foundInline = true;
												probePath.stop();
											}
										},
									});

									if (!foundInline) {
										// Delegation detected: the call method delegates to a
										// helper function with several arguments. Thread our new params
										// through every delegation call and patch the helper body instead.
										// Collect delegation call candidates (8+ args, lowered from 11
										// for resilience). Verify the resolved helper contains the D2I
										// destructuring before patching, which avoids false positives if
										// the bundle changes argument counts.
										let helperName: string | null = null;
										const delegationCalls: t.CallExpression[] = [];
										let patchedDelegatedHelper = false;
										callBodyPath.traverse({
											AwaitExpression(awaitPath) {
												const arg = awaitPath.node.argument;
												if (!t.isCallExpression(arg)) return;
												if (!t.isIdentifier(arg.callee)) return;
												if (arg.arguments.length < 8) return;
												delegationCalls.push(arg);
												if (!helperName) helperName = arg.callee.name;
											},
										});

										if (helperName) {
											const helperBinding = path.scope.getBinding(helperName);
											if (helperBinding) {
												let helperFnPath: NodePath<t.Function> | null = null;
												if (helperBinding.path.isFunctionDeclaration()) {
													helperFnPath =
														helperBinding.path as NodePath<t.Function>;
												} else if (helperBinding.path.isVariableDeclarator()) {
													const initPath = helperBinding.path.get("init");
													if (
														!Array.isArray(initPath) &&
														(initPath.isFunctionExpression() ||
															initPath.isArrowFunctionExpression())
													) {
														helperFnPath = initPath as NodePath<t.Function>;
													}
												}
												const helperFn = helperFnPath?.node ?? null;
												if (
													helperFnPath &&
													helperFn &&
													t.isBlockStatement(helperFn.body)
												) {
													const helperBodyPath = helperFnPath.get(
														"body",
													) as NodePath<t.BlockStatement>;
													// Verify helper contains D2I destructuring (content/lineCount/totalLines)
													let hasD2I = false;
													helperBodyPath.traverse({
														ObjectPattern(patternPath) {
															if (isD2IDestructuring(patternPath.node)) {
																hasD2I = true;
																patternPath.stop();
															}
														},
													});
													if (hasD2I) {
														for (const call of delegationCalls) {
															call.arguments = call.arguments.map((arg) => {
																if (
																	t.isIdentifier(arg) &&
																	removedCallCompatVars.has(arg.name)
																) {
																	return t.unaryExpression(
																		"void",
																		t.numericLiteral(0),
																	);
																}
																return arg;
															});
															call.arguments.push(
																t.identifier(rangeVarName || "R"),
																t.identifier(whitespaceVarName || "WSPC"),
															);
														}
														const helperReservedNames =
															getBindingNames(helperFn);
														const helperRangeVarName = freshIdentifierName(
															rangeVarName || "R",
															helperReservedNames,
														);
														helperReservedNames.add(helperRangeVarName);
														const helperWhitespaceVarName = freshIdentifierName(
															whitespaceVarName || "WSPC",
															helperReservedNames,
														);
														helperFn.params.push(
															t.identifier(helperRangeVarName),
															t.identifier(helperWhitespaceVarName),
														);
														targetRangeVarName = helperRangeVarName;
														targetWhitespaceVarName = helperWhitespaceVarName;
														targetBodyPath = helperBodyPath;
														patchedDelegatedHelper = true;
													} else {
														console.warn(
															"read-with-bat: delegation candidate found but missing D2I pattern, skipping",
														);
													}
												}
											}
										}
										if (!patchedDelegatedHelper) {
											let objectHelperName: string | null = null;
											let objectHelperFnPath: NodePath<t.Function> | null =
												null;
											const objectDelegateCalls: t.CallExpression[] = [];

											callBodyPath.traverse({
												AwaitExpression(awaitPath) {
													const arg = awaitPath.node.argument;
													if (!t.isCallExpression(arg)) return;
													if (!t.isIdentifier(arg.callee)) return;
													if (arg.arguments.length !== 1) return;
													const [payload] = arg.arguments;
													if (!t.isObjectExpression(payload)) return;
													const hasResolvedPath = payload.properties.some((p) =>
														hasObjectKeyName(p, "resolvedFilePath"),
													);
													if (!hasResolvedPath) return;
													objectHelperName ??= arg.callee.name;
													if (arg.callee.name === objectHelperName) {
														objectDelegateCalls.push(arg);
													}
												},
											});

											if (objectHelperName) {
												const helperBinding =
													path.scope.getBinding(objectHelperName);
												if (helperBinding?.path.isFunctionDeclaration()) {
													objectHelperFnPath =
														helperBinding.path as NodePath<t.Function>;
												} else if (helperBinding?.path.isVariableDeclarator()) {
													const initPath = helperBinding.path.get("init");
													if (
														!Array.isArray(initPath) &&
														(initPath.isFunctionExpression() ||
															initPath.isArrowFunctionExpression())
													) {
														objectHelperFnPath =
															initPath as NodePath<t.Function>;
													}
												}
											}

											const helperFn = objectHelperFnPath?.node ?? null;
											if (
												objectHelperFnPath &&
												helperFn &&
												t.isBlockStatement(helperFn.body)
											) {
												const helperBodyPath = objectHelperFnPath.get(
													"body",
												) as NodePath<t.BlockStatement>;
												let d2iFound = false;
												helperBodyPath.traverse({
													ObjectPattern(patternPath) {
														if (isD2IDestructuring(patternPath.node)) {
															d2iFound = true;
															patternPath.stop();
														}
													},
												});

												if (d2iFound) {
													const helperReservedNames = getBindingNames(helperFn);
													const helperRangeVarName = freshIdentifierName(
														rangeVarName || "R",
														helperReservedNames,
													);
													helperReservedNames.add(helperRangeVarName);
													const helperWhitespaceVarName = freshIdentifierName(
														whitespaceVarName || "WSPC",
														helperReservedNames,
													);

													callBodyPath.traverse({
														ObjectExpression(objectPath) {
															const props = objectPath.node.properties;
															const hasFilePath = props.some((p) =>
																hasObjectKeyName(p, "file_path"),
															);
															const hasFullFilePath = props.some((p) =>
																hasObjectKeyName(p, "fullFilePath"),
															);
															const hasMaxTokens = props.some((p) =>
																hasObjectKeyName(p, "maxTokens"),
															);
															if (
																!hasFilePath ||
																!hasFullFilePath ||
																!hasMaxTokens
															) {
																return;
															}

															let hasRange = false;
															let hasShowWhitespace = false;
															objectPath.node.properties = props.map((p) => {
																if (
																	t.isObjectProperty(p) &&
																	hasObjectKeyName(p, "offset")
																) {
																	return t.objectProperty(
																		t.identifier("offset"),
																		t.numericLiteral(1),
																	);
																}
																if (
																	t.isObjectProperty(p) &&
																	hasObjectKeyName(p, "limit")
																) {
																	return t.objectProperty(
																		t.identifier("limit"),
																		t.unaryExpression(
																			"void",
																			t.numericLiteral(0),
																		),
																	);
																}
																if (
																	t.isObjectProperty(p) &&
																	hasObjectKeyName(p, "range")
																) {
																	hasRange = true;
																	return t.objectProperty(
																		t.identifier("range"),
																		t.identifier(rangeVarName || "R"),
																	);
																}
																if (
																	t.isObjectProperty(p) &&
																	hasObjectKeyName(p, "show_whitespace")
																) {
																	hasShowWhitespace = true;
																	return t.objectProperty(
																		t.identifier("show_whitespace"),
																		t.identifier(whitespaceVarName || "WSPC"),
																	);
																}
																return p;
															});
															if (!hasRange) {
																objectPath.node.properties.push(
																	t.objectProperty(
																		t.identifier("range"),
																		t.identifier(rangeVarName || "R"),
																	),
																);
															}
															if (!hasShowWhitespace) {
																objectPath.node.properties.push(
																	t.objectProperty(
																		t.identifier("show_whitespace"),
																		t.identifier(whitespaceVarName || "WSPC"),
																	),
																);
															}
														},
													});

													for (const call of objectDelegateCalls) {
														const [payload] = call.arguments;
														if (!t.isObjectExpression(payload)) continue;
														const hasRange = payload.properties.some((p) =>
															hasObjectKeyName(p, "range"),
														);
														const hasShowWhitespace = payload.properties.some(
															(p) => hasObjectKeyName(p, "show_whitespace"),
														);
														if (!hasRange) {
															payload.properties.push(
																t.objectProperty(
																	t.identifier("range"),
																	t.identifier(rangeVarName || "R"),
																),
															);
														}
														if (!hasShowWhitespace) {
															payload.properties.push(
																t.objectProperty(
																	t.identifier("show_whitespace"),
																	t.identifier(whitespaceVarName || "WSPC"),
																),
															);
														}
													}

													let helperPatternPatched = false;
													helperBodyPath.traverse({
														VariableDeclarator(declPath) {
															if (!t.isObjectPattern(declPath.node.id)) return;
															const pattern = declPath.node.id;
															const hasRange = pattern.properties.some((p) =>
																hasObjectKeyName(p, "range"),
															);
															const hasShowWhitespace = pattern.properties.some(
																(p) => hasObjectKeyName(p, "show_whitespace"),
															);
															if (!hasRange) {
																pattern.properties.push(
																	t.objectProperty(
																		t.identifier("range"),
																		t.identifier(helperRangeVarName),
																	),
																);
															}
															if (!hasShowWhitespace) {
																pattern.properties.push(
																	t.objectProperty(
																		t.identifier("show_whitespace"),
																		t.identifier(helperWhitespaceVarName),
																	),
																);
															}
															helperPatternPatched = true;
															declPath.stop();
														},
													});

													if (helperPatternPatched) {
														targetRangeVarName = helperRangeVarName;
														targetWhitespaceVarName = helperWhitespaceVarName;
														targetBodyPath = helperBodyPath;
													}
												}
											}
										}
									}
								}

								// Preserve internal compatibility for callers that still pass
								// offset/limit (for example at-mention attachment flows). When
								// range is absent, synthesize an equivalent range.
								if (callCompatRestVarName) {
									const compatGuard = template.statement(
										`if (RVAR === void 0 && COMPAT && (COMPAT.offset !== void 0 || COMPAT.limit !== void 0)) {
  var __compatReadOffset = Number(COMPAT.offset);
  var __compatReadLimit = Number(COMPAT.limit);
  var __compatReadStart = Number.isFinite(__compatReadOffset) ? Math.max(1, Math.floor(__compatReadOffset)) : 1;
  if (Number.isFinite(__compatReadLimit) && __compatReadLimit > 0) {
    var __compatReadEnd = __compatReadStart + Math.floor(__compatReadLimit) - 1;
    RVAR = String(__compatReadStart) + ":" + String(__compatReadEnd);
  } else {
    RVAR = String(__compatReadStart) + ":";
  }
}`,
									)({
										RVAR: t.identifier(rangeVarName || "R"),
										COMPAT: t.identifier(callCompatRestVarName),
									}) as t.Statement;
									callMethod.body.body.unshift(compatGuard);
								}

								// === 2. Find and replace text reading logic ===
								// Look for: { content: X, lineCount: Y, totalLines: Z } = someFunc(path, offset, limit)
								targetBodyPath.traverse({
									VariableDeclarator(declPath) {
										const id = declPath.node.id;

										// Must be ObjectPattern = CallExpression (or await CallExpression)
										if (!t.isObjectPattern(id)) return;
										const callExpr = unwrapAwait(declPath.node.init);
										if (!t.isCallExpression(callExpr)) return;
										if (!isD2IDestructuring(id)) return;

										// Get original function and file path argument
										if (!t.isIdentifier(callExpr.callee)) return;
										originalReadFn = callExpr.callee.name;
										const fileArg = callExpr.arguments[0];
										if (!t.isIdentifier(fileArg)) return;
										const getCallArgOrVoid = (
											arg:
												| t.Expression
												| t.SpreadElement
												| t.ArgumentPlaceholder
												| undefined,
										): t.Expression => {
											if (
												!arg ||
												t.isSpreadElement(arg) ||
												t.isArgumentPlaceholder(arg)
											) {
												return t.unaryExpression("void", t.numericLiteral(0));
											}
											return t.cloneNode(arg, true) as t.Expression;
										};
										const fallbackMaxBytesArg = getCallArgOrVoid(
											callExpr.arguments[3],
										);
										const fallbackSignalArg = getCallArgOrVoid(
											callExpr.arguments[4],
										);

										// Build bat reading async IIFE. All runtime code is self-contained
										// (async function(filePath, range, showWs, fallbackFn, fallbackMaxBytes, fallbackSignal) { ... })(D, R, WSPC, KtB, MAX, SIGNAL)
										const batFn = template.expression(
											`async function(filePath, range, showWs, fallbackFn, fallbackMaxBytes, fallbackSignal) {
  var fs = await import("fs");
  var stat = fs.statSync(filePath);
  if (stat.isDirectory()) throw new Error("EISDIR: Cannot read a directory. Use Bash with eza or fd to list directory contents: " + filePath);
  if (stat.size === 0) {
    return { content: "", lineCount: 0, totalLines: 0, startLine: 1 };
  }

  var startLine = 1;
  var fallbackOffset = 0;
  var fallbackLimit = void 0;
  var fileTotalLines = null;
  var ensureTotalLines = function() {
    if (fileTotalLines != null) return fileTotalLines;
    var fd = fs.openSync(filePath, "r");
    try {
      var buf = Buffer.allocUnsafe(65536);
      var bytesRead = 0;
      var newlines = 0;
      var lastByte = -1;
      while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
        lastByte = buf[bytesRead - 1];
        for (var i = 0; i < bytesRead; i++) if (buf[i] === 10) newlines++;
      }
      fileTotalLines = newlines + (lastByte === 10 ? 0 : 1);
    } finally {
      fs.closeSync(fd);
    }
    return fileTotalLines;
  };
  var normalizedRange = null;
  if (range !== void 0 && range !== null) {
    var rawRange = String(range).trim();
    var stripBalancedQuotes = function(value) {
      while (value.length >= 2) {
        var firstChar = value[0];
        var lastChar = value[value.length - 1];
        var isDoubleQuoted = firstChar === '"' && lastChar === '"';
        var isSingleQuoted = firstChar === "'" && lastChar === "'";
        if (!isDoubleQuoted && !isSingleQuoted) break;
        value = value.slice(1, -1).trim();
      }
      return value;
    };
    while (rawRange.length >= 2) {
      var firstChar = rawRange[0];
      var lastChar = rawRange[rawRange.length - 1];
      var isDoubleQuoted = firstChar === '"' && lastChar === '"';
      var isSingleQuoted = firstChar === "'" && lastChar === "'";
      if (!isDoubleQuoted && !isSingleQuoted) break;
      rawRange = rawRange.slice(1, -1).trim();
    }
    if (rawRange.length > 0) {
      var numericRange = /^(?:[1-9]\\d*)(?::(?:\\+[1-9]\\d*|[1-9]\\d*(?::[1-9]\\d*)?|)|::[1-9]\\d*)?$/;
      var fromStart = /^:[1-9]\\d*$/;
      var tailRange = /^-[1-9]\\d*:$/;
      var isSupportedRange = function(value) {
        return numericRange.test(value) || fromStart.test(value) || tailRange.test(value);
      };
      if (!isSupportedRange(rawRange)) {
        var repairedRange = rawRange;
        while (repairedRange.length > 0) {
          var changed = false;
          var leadingChar = repairedRange[0];
          if (leadingChar === "(" || leadingChar === "[" || leadingChar === "{") {
            repairedRange = repairedRange.slice(1).trim();
            changed = true;
          }
          var trailingChar = repairedRange[repairedRange.length - 1];
          if (
            trailingChar === '"' ||
            trailingChar === "'" ||
            trailingChar === ")" ||
            trailingChar === "]" ||
            trailingChar === "}" ||
            trailingChar === "," ||
            trailingChar === ";"
          ) {
            repairedRange = repairedRange.slice(0, -1).trim();
            changed = true;
          }
          var unwrappedRange = stripBalancedQuotes(repairedRange);
          if (unwrappedRange !== repairedRange) {
            repairedRange = unwrappedRange;
            changed = true;
          }
          if (!changed) break;
          if (isSupportedRange(repairedRange)) {
            rawRange = repairedRange;
            break;
          }
        }
      }
      if (!isSupportedRange(rawRange)) {
        throw new Error(
          "Invalid range format. Use supported bat-style forms like '30:40', ':40', '-30:', '50:+20', '100::10', or '30:40:2'."
        );
      }
      normalizedRange = rawRange;
    }
  }
  if (!normalizedRange && typeof filePath === "string" && filePath.endsWith(".output")) {
    normalizedRange = "-500:";
  }

  var autoRanged = false;
  var autoRangeLines = 0;
  var autoRangeTokenEstimate = Math.ceil(stat.size / 4);
  var autoRangeTokenBudget = 50000;
  if (!normalizedRange && (
    (fallbackMaxBytes !== void 0 && stat.size > fallbackMaxBytes) ||
    autoRangeTokenEstimate > autoRangeTokenBudget
  )) {
    fileTotalLines = ensureTotalLines();
    autoRangeLines = Math.min(200, fileTotalLines);
    normalizedRange = ":" + String(autoRangeLines);
    autoRanged = true;
  }

  if (normalizedRange) {
    var r = normalizedRange;
    if (r.indexOf("::") !== -1) {
      var parts = r.split("::");
      var line = parseInt(parts[0], 10) || 1;
      var ctx = parseInt(parts[1], 10) || 0;
      var centeredStart = Math.max(1, line - ctx);
      var centeredEnd = Math.max(centeredStart, line + ctx);
      startLine = centeredStart;
      fallbackOffset = centeredStart - 1;
      fallbackLimit = centeredEnd - centeredStart + 1;
    } else if (r[0] === ":") {
      var fromStartParts = r.split(":");
      var endLine = parseInt(fromStartParts[1], 10) || 1;
      var fromStartRangeStart = 1;
      var fromStartRangeEnd = Math.max(fromStartRangeStart, endLine);
      startLine = fromStartRangeStart;
      fallbackOffset = 0;
      fallbackLimit = fromStartRangeEnd - fromStartRangeStart + 1;
    } else if (r[0] === "-") {
      var m = r.match(/^(-\\d+)(?::|$)/);
      if (m) {
        var neg = parseInt(m[1], 10);
        if (!isNaN(neg)) {
          var absLines = Math.max(1, Math.abs(neg));
          fileTotalLines = ensureTotalLines();
          startLine = Math.max(1, fileTotalLines - absLines + 1);
          fallbackOffset = Math.max(0, startLine - 1);
          fallbackLimit = absLines;
        }
      } else {
        startLine = 1;
        fallbackOffset = 0;
        fallbackLimit = void 0;
      }
    } else {
      var segments = r.split(":");
      var base = parseInt(segments[0], 10) || 1;
      var tail = segments.length > 1 ? segments[1] : "";
      var trailingCtx = segments.length > 2 ? parseInt(segments[2], 10) || 0 : 0;
      if (segments.length === 1) {
        startLine = Math.max(1, base);
        fallbackOffset = Math.max(0, startLine - 1);
        fallbackLimit = 1;
      } else if (tail === "") {
        startLine = Math.max(1, base);
        fallbackOffset = Math.max(0, startLine - 1);
        fallbackLimit = void 0;
      } else if (tail[0] === "+") {
        var plusLen = parseInt(tail.slice(1), 10) || 0;
        var plusStart = Math.max(1, base - trailingCtx);
        var plusEnd = Math.max(plusStart, base + plusLen + trailingCtx);
        startLine = plusStart;
        fallbackOffset = plusStart - 1;
        fallbackLimit = plusEnd - plusStart + 1;
      } else {
        var end = parseInt(tail, 10);
        if (isNaN(end)) end = base;
        var boundedStart = Math.min(base, end);
        var boundedEnd = Math.max(base, end);
        var rangedStart = Math.max(1, boundedStart - trailingCtx);
        var rangedEnd = Math.max(rangedStart, boundedEnd + trailingCtx);
        startLine = rangedStart;
        fallbackOffset = rangedStart - 1;
        fallbackLimit = rangedEnd - rangedStart + 1;
      }
    }
  }
  if (normalizedRange && fileTotalLines == null) {
    fileTotalLines = ensureTotalLines();
  }

  var cp = await import("child_process");
  var style = "numbers";
  var args = ["--style=" + style, "--color=never", "--paging=never"];
  if (showWs) args.push("-A");
  if (normalizedRange) args.push("-r", normalizedRange);
  args.push(filePath);
  try {
    var output = cp.execFileSync("bat", args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 30000 });
    if (autoRanged) {
      output += "\\n\\n[FILE TRUNCATED: " + fileTotalLines + " total lines, showing first " + autoRangeLines + ". Use range parameter (e.g. '" + (autoRangeLines + 1) + ":" + Math.min(autoRangeLines + 200, fileTotalLines) + "') to read more.]";
    }
    var normalizedOutput = output.endsWith("\\n") ? output.slice(0, -1) : output;
    var lineCount = normalizedOutput.length === 0 ? 0 : normalizedOutput.split("\\n").length;
    var totalLines = fileTotalLines != null ? fileTotalLines : lineCount;
    return { content: output, lineCount: lineCount, totalLines: totalLines, startLine: startLine };
  } catch (e) {
    var fallbackSizeLimit = fallbackLimit === void 0 ? fallbackMaxBytes : void 0;
    return {
      ...(await fallbackFn(filePath, fallbackOffset, fallbackLimit, fallbackSizeLimit, fallbackSignal)),
      startLine: startLine
    };
  }
}`,
											{ placeholderPattern: false },
										)() as t.FunctionExpression;

										// Replace init with awaited IIFE call
										declPath.node.init = t.awaitExpression(
											t.callExpression(batFn, [
												fileArg,
												t.identifier(targetRangeVarName || rangeVarName || "R"),
												t.identifier(
													targetWhitespaceVarName ||
														whitespaceVarName ||
														"WSPC",
												),
												t.identifier(originalReadFn),
												fallbackMaxBytesArg,
												fallbackSignalArg,
											]),
										);

										// Ensure we also destructure startLine from the bat result
										const hasStartLine = id.properties.some((p) =>
											hasObjectKeyName(p, "startLine"),
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
										if (
											varDeclPath &&
											t.isVariableDeclaration(varDeclPath.node)
										) {
											const decls = varDeclPath.node.declarations;
											// Find and remove the offset calculation declarator
											const offsetIdx = decls.findIndex((d) => {
												// Look for: W = Q === 0 ? 0 : Q - 1
												if (!t.isConditionalExpression(d.init)) return false;
												const cond = d.init;
												return (
													t.isBinaryExpression(cond.test, {
														operator: "===",
													}) &&
													t.isNumericLiteral(cond.consequent, { value: 0 })
												);
											});
											if (offsetIdx >= 0) {
												decls.splice(offsetIdx, 1);
											}
										}

										declPath.stop();
									},
								});

								// === 3. Fix readFileState.set call ===
								// Change: Z.set(D, { content: K, timestamp: ..., offset: Q, limit: B })
								// To: Z.set(D, { content: K, timestamp: ..., range: R,
								// compatibility markers })
								targetBodyPath.traverse({
									CallExpression(callPath) {
										const callee = callPath.node.callee;
										if (!t.isMemberExpression(callee)) return;
										if (!isMemberPropertyName(callee, "set")) return;

										// Check second argument is the state object with offset/limit
										// fields.
										const args = callPath.node.arguments;
										if (args.length < 2) return;
										const objArg = args[1];
										if (!t.isObjectExpression(objArg)) return;

										// Look for offset and limit properties
										const hasOffset = objArg.properties.some((p) =>
											hasObjectKeyName(p, "offset"),
										);
										const hasLimit = objArg.properties.some((p) =>
											hasObjectKeyName(p, "limit"),
										);

										if (!hasOffset || !hasLimit) return;

										// Keep offset/limit as compatibility markers for the
										// changed-files attachment scanner. It skips diff-injection
										// for partial reads when either field is defined.
										const isRangedExpr = t.binaryExpression(
											"!==",
											t.identifier(targetRangeVarName || rangeVarName || "R"),
											t.unaryExpression("void", t.numericLiteral(0)),
										);
										const filePathExpr = t.identifier(_filePathVar || "A");
										const isOutputFileExpr = t.logicalExpression(
											"&&",
											t.binaryExpression(
												"===",
												t.unaryExpression(
													"typeof",
													t.cloneNode(filePathExpr, true),
												),
												t.stringLiteral("string"),
											),
											t.callExpression(
												t.memberExpression(
													t.cloneNode(filePathExpr, true),
													t.identifier("endsWith"),
												),
												[t.stringLiteral(".output")],
											),
										);
										const hasImplicitOutputTailExpr = t.logicalExpression(
											"&&",
											t.binaryExpression(
												"===",
												t.identifier(targetRangeVarName || rangeVarName || "R"),
												t.unaryExpression("void", t.numericLiteral(0)),
											),
											t.cloneNode(isOutputFileExpr, true),
										);
										const isPartialReadExpr = t.logicalExpression(
											"||",
											t.cloneNode(isRangedExpr, true),
											hasImplicitOutputTailExpr,
										);
										const compatMarkerExpr = t.conditionalExpression(
											isPartialReadExpr,
											t.numericLiteral(1),
											t.unaryExpression("void", t.numericLiteral(0)),
										);
										const effectiveRangeExpr = t.conditionalExpression(
											t.cloneNode(isRangedExpr, true),
											t.identifier(targetRangeVarName || rangeVarName || "R"),
											t.conditionalExpression(
												t.cloneNode(isOutputFileExpr, true),
												t.stringLiteral("-500:"),
												t.unaryExpression("void", t.numericLiteral(0)),
											),
										);
										let hasRange = false;
										objArg.properties = objArg.properties.map((p) => {
											if (
												t.isObjectProperty(p) &&
												hasObjectKeyName(p, "offset")
											) {
												return t.objectProperty(
													t.identifier("offset"),
													t.cloneNode(compatMarkerExpr, true),
												);
											}
											if (
												t.isObjectProperty(p) &&
												hasObjectKeyName(p, "limit")
											) {
												return t.objectProperty(
													t.identifier("limit"),
													t.cloneNode(compatMarkerExpr, true),
												);
											}
											if (
												t.isObjectProperty(p) &&
												hasObjectKeyName(p, "range")
											) {
												hasRange = true;
												return t.objectProperty(
													t.identifier("range"),
													t.cloneNode(effectiveRangeExpr, true),
												);
											}
											return p;
										});

										if (!hasRange) {
											objArg.properties.push(
												t.objectProperty(
													t.identifier("range"),
													t.cloneNode(effectiveRangeExpr, true),
												),
											);
										}
									},
								});

								// === 4. Fix startLine in result object ===
								// Change: startLine: Q (where Q was offset) to startLine: START_LINE
								targetBodyPath.traverse({
									ObjectProperty(propPath) {
										if (!hasObjectKeyName(propPath.node, "startLine")) return;

										// Check we're in a file: { ... } object (has numLines,
										// totalLines siblings). Upstream may compute startLine
										// inline, so replace the value rather than requiring an
										// identifier-bound offset.
										const parent = propPath.parent;
										if (!t.isObjectExpression(parent)) return;

										const hasNumLines = parent.properties.some((p) =>
											hasObjectKeyName(p, "numLines"),
										);
										const hasTotalLines = parent.properties.some((p) =>
											hasObjectKeyName(p, "totalLines"),
										);

										if (hasNumLines && hasTotalLines) {
											propPath.node.value = t.identifier("START_LINE");
										}
									},
								});

								path.stop();
							},
						});

						// === 5. Modify renderToolUseMessage to show range instead of
						// offset/limit ===
						// Find: function X({ file_path: A, offset: Q, limit: B }, { verbose: G }) { ... }
						// Change to show range in the UI display
						traverse(ast, {
							FunctionDeclaration(path) {
								const params = path.node.params;
								if (params.length !== 2) return;

								// First param must be ObjectPattern with file_path, offset, limit
								const firstParam = params[0];
								if (!t.isObjectPattern(firstParam)) return;

								const hasFilePath = firstParam.properties.some((p) =>
									hasObjectKeyName(p, "file_path"),
								);
								const hasOffset = firstParam.properties.some((p) =>
									hasObjectKeyName(p, "offset"),
								);
								const hasLimit = firstParam.properties.some((p) =>
									hasObjectKeyName(p, "limit"),
								);

								if (!hasFilePath || !hasOffset || !hasLimit) return;

								// Second param must be ObjectPattern with verbose
								const secondParam = params[1];
								if (!t.isObjectPattern(secondParam)) return;

								const hasVerbose = secondParam.properties.some((p) =>
									hasObjectKeyName(p, "verbose"),
								);
								if (!hasVerbose) return;

								// Found the renderToolUseMessage function!
								// Extract variable names
								let filePathVar = "A";
								let verboseVar = "G";
								let pagesVar = "PAGES";
								const extractBindingName = (
									node: t.LVal | t.Expression,
								): string | null => {
									if (t.isIdentifier(node)) return node.name;
									if (t.isAssignmentPattern(node) && t.isIdentifier(node.left))
										return node.left.name;
									return null;
								};

								for (const prop of firstParam.properties) {
									if (!t.isObjectProperty(prop) || !t.isIdentifier(prop.key))
										continue;
									const bindingName = extractBindingName(
										prop.value as t.LVal | t.Expression,
									);
									if (!bindingName) continue;
									const keyName = getObjectKeyName(prop.key);
									if (keyName === "file_path") {
										filePathVar = bindingName;
									} else if (keyName === "pages") {
										pagesVar = bindingName;
									}
								}

								for (const prop of secondParam.properties) {
									if (!t.isObjectProperty(prop)) continue;
									if (!hasObjectKeyName(prop, "verbose")) continue;
									const bindingName = extractBindingName(
										prop.value as t.LVal | t.Expression,
									);
									if (bindingName) verboseVar = bindingName;
								}

								// Replace first param: remove offset/limit fields and add
								// range/show_whitespace.
								const newFirstParam = t.objectPattern([
									t.objectProperty(
										t.identifier("file_path"),
										t.identifier(filePathVar),
									),
									t.objectProperty(
										t.identifier("pages"),
										t.identifier(pagesVar),
									),
									t.objectProperty(t.identifier("range"), t.identifier("R")),
									t.objectProperty(
										t.identifier("show_whitespace"),
										t.identifier("WSPC"),
									),
								]);

								// Find element factory, abbreviation function, check function,
								// and file-path component by analyzing the function body. Discovery
								// must fully succeed before any mutation: defaulting to stale
								// minified guesses (the old behavior) produced a render that called
								// a non-existent factory and broke the Read tool chip once upstream
								// moved rendering to the JSX runtime.
								let createElementId = "A3";
								let abbrFunc = "j6";
								let checkFunc = "C51";
								let filePathComp = "sk";
								let displayVar = "Z";
								let foundFactory = false;
								let foundDisplay = false;
								let foundCheck = false;

								traverse(
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
												foundDisplay = true;
											}
										},
										// Find: if (C51(A)) return ""
										IfStatement(ifPath) {
											const test = ifPath.node.test;
											if (!t.isCallExpression(test)) return;
											if (!t.isIdentifier(test.callee)) return;
											const consequent = ifPath.node.consequent;
											if (!t.isReturnStatement(consequent)) return;
											if (
												!t.isStringLiteral(consequent.argument, { value: "" })
											)
												return;
											checkFunc = test.callee.name;
											foundCheck = true;
										},
										// Find the file-path component render, runtime-agnostic:
										// X.createElement(sk, { filePath: ... }) or X.jsx(sk, { filePath: ... }).
										CallExpression(callPath) {
											if (foundFactory) return;
											const callee = callPath.node.callee;
											if (!t.isMemberExpression(callee)) return;
											if (!isElementCall(callPath.node)) return;
											if (!t.isIdentifier(callee.object)) return;

											const args = callPath.node.arguments;
											if (args.length >= 2 && t.isIdentifier(args[0])) {
												const objArg = args[1];
												if (
													t.isObjectExpression(objArg) &&
													objArg.properties.some((p) =>
														hasObjectKeyName(p, "filePath"),
													)
												) {
													createElementId = callee.object.name;
													filePathComp = args[0].name;
													foundFactory = true;
												}
											}
										},
									},
									path.scope,
									path,
								);

								// Discovery must have resolved the real factory, component,
								// abbreviation function, and empty-return guard. If any is missing
								// (e.g. an upstream render-shape change), leave the function fully
								// unpatched so the stock chip still renders and verify fails loudly
								// instead of emitting a render that calls a non-existent factory.
								if (!foundFactory || !foundDisplay || !foundCheck) {
									console.warn(
										"Read with bat: renderToolUseMessage factory/component not found; leaving Read render unpatched",
									);
									path.stop();
									return;
								}

								path.node.params[0] = newFirstParam;

								// Build new function body with options display
								const newBody = t.blockStatement(
									template.statements(
										`
					if (!FILE_PATH) return null;
					if (CHECK_FN(FILE_PATH)) return R ? " · range: " + R : "";
					let DISPLAY = VERBOSE ? FILE_PATH : ABBR_FN(FILE_PATH);
					if (PAGES) return CE.jsx(CE.Fragment, { children: [CE.jsx(COMP, { filePath: FILE_PATH, children: DISPLAY }), " · pages " + PAGES] });
					var opts = [];
					if (R) opts.push("range: " + R);
					if (WSPC) opts.push("whitespace");
					if (opts.length > 0) {
						return CE.jsx(CE.Fragment, { children: [CE.jsx(COMP, { filePath: FILE_PATH, children: DISPLAY }), " · " + opts.join(", ")] });
					}
					return CE.jsx(COMP, { filePath: FILE_PATH, children: DISPLAY });
				`,
										{
											placeholderPattern:
												/^(FILE_PATH|CHECK_FN|DISPLAY|VERBOSE|ABBR_FN|PAGES|CE|COMP)$/,
										},
									)({
										FILE_PATH: t.identifier(filePathVar),
										CHECK_FN: t.identifier(checkFunc),
										DISPLAY: t.identifier(displayVar),
										VERBOSE: t.identifier(verboseVar),
										ABBR_FN: t.identifier(abbrFunc),
										PAGES: t.identifier(pagesVar),
										CE: t.identifier(createElementId),
										COMP: t.identifier(filePathComp),
									}),
								);

								path.node.body = newBody;
								path.stop();
							},
						});

						// Section 6 (changed-file watcher range hardening) removed. Redundant:
						// The readFileState.set() compatibility markers (offset: 1, limit: 1
						// for partial reads) already cause the offset/limit guard to fire.

						// === 7. Keep partial range reads out of reconstructed full-file state ===
						const historyReadCandidates: ReadStateRebuildCandidate[] = [];
						traverse(ast, {
							IfStatement(path) {
								const candidate = classifyReadStateRebuildGuard(path);
								if (candidate) historyReadCandidates.push(candidate);
							},
						});
						let patchedHistoryReadGuard = false;
						if (historyReadCandidates.length === 1) {
							const candidate = historyReadCandidates[0];
							if (candidate.state === "unpatched") {
								const rangeCheck = t.binaryExpression(
									"===",
									t.optionalMemberExpression(
										t.identifier(candidate.inputName),
										t.identifier("range"),
										false,
										true,
									),
									t.unaryExpression("void", t.numericLiteral(0)),
								);
								const outputPath = t.optionalMemberExpression(
									t.identifier(candidate.inputName),
									t.identifier("file_path"),
									false,
									true,
								);
								const outputTailCheck = t.unaryExpression(
									"!",
									t.callExpression(
										t.memberExpression(
											t.callExpression(t.identifier("String"), [
												t.logicalExpression(
													"??",
													t.cloneNode(outputPath, true),
													t.stringLiteral(""),
												),
											]),
											t.identifier("endsWith"),
										),
										[t.stringLiteral(".output")],
									),
								);
								candidate.path.node.test = t.logicalExpression(
									"&&",
									t.logicalExpression(
										"&&",
										t.cloneNode(candidate.path.node.test, true),
										rangeCheck,
									),
									outputTailCheck,
								);
								candidate.state = "patched";
							}
							patchedHistoryReadGuard = candidate.state === "patched";
						}
						if (!patchedHistoryReadGuard) {
							console.warn(
								`Read with bat: Could not patch unique read-state reconstruction guard (${historyReadCandidates.length} candidates)`,
							);
						}

						// === 8. Reduce changed-file attachment token spikes ===
						// The changed-file handler computes diffs for edited_text_file attachments.
						// It calls the diff function twice (emptiness check + snippet payload) and emits unbounded snippets.
						// Compute once and cap payload size before it is injected as system-reminder text.
						let patchedChangedFileSnippet = false;
						traverse(ast, {
							IfStatement(path) {
								if (patchedChangedFileSnippet) return;

								const { test, consequent } = path.node;
								if (!t.isBinaryExpression(test, { operator: "===" })) return;
								if (!t.isStringLiteral(test.right, { value: "text" })) return;
								if (!t.isMemberExpression(test.left)) return;
								if (!isMemberPropertyName(test.left, "type")) return;
								if (!t.isBlockStatement(consequent)) return;
								if (consequent.body.length < 2) return;

								const statements = consequent.body;
								let gwACall: t.CallExpression | null = null;
								let rawBindingName: string | null = null;
								let emptyCheckIndex = -1;
								let returnIndex = -1;

								for (let i = 0; i < statements.length - 1; i++) {
									const stmt = statements[i];
									const nextStmt = statements[i + 1];

									if (t.isVariableDeclaration(stmt)) {
										const [decl] = stmt.declarations;
										if (
											!decl ||
											!t.isIdentifier(decl.id) ||
											!t.isCallExpression(decl.init)
										) {
											continue;
										}
										if (!t.isIfStatement(nextStmt)) continue;
										if (
											!t.isBinaryExpression(nextStmt.test, {
												operator: "===",
											})
										) {
											continue;
										}
										if (
											!t.isStringLiteral(nextStmt.test.right, {
												value: "",
											})
										) {
											continue;
										}
										if (
											!t.isIdentifier(nextStmt.test.left, {
												name: decl.id.name,
											})
										) {
											continue;
										}
										gwACall = decl.init;
										rawBindingName = decl.id.name;
										emptyCheckIndex = i + 1;
										returnIndex = i + 2;
										break;
									}

									if (!t.isIfStatement(stmt)) continue;
									if (!t.isBinaryExpression(stmt.test, { operator: "===" })) {
										continue;
									}
									if (
										!t.isStringLiteral(stmt.test.right, {
											value: "",
										})
									) {
										continue;
									}
									if (!t.isCallExpression(stmt.test.left)) continue;
									gwACall = stmt.test.left;
									emptyCheckIndex = i;
									returnIndex = i + 1;
									break;
								}

								if (emptyCheckIndex === -1 || returnIndex === -1 || !gwACall) {
									return;
								}
								const firstStmt = statements[emptyCheckIndex];
								const secondStmt = statements[returnIndex];
								if (!t.isIfStatement(firstStmt) || !secondStmt) return;

								const emptyReturn = firstStmt.consequent;
								if (t.isReturnStatement(emptyReturn)) {
									if (!t.isNullLiteral(emptyReturn.argument)) return;
								} else if (t.isBlockStatement(emptyReturn)) {
									if (emptyReturn.body.length !== 1) return;
									const only = emptyReturn.body[0];
									if (
										!t.isReturnStatement(only) ||
										!t.isNullLiteral(only.argument)
									)
										return;
								} else {
									return;
								}

								if (!t.isReturnStatement(secondStmt)) return;
								if (!t.isObjectExpression(secondStmt.argument)) return;
								const updatedReturn = t.cloneNode(
									secondStmt.argument,
									true,
								) as t.ObjectExpression;

								let hasSnippetProp = false;
								updatedReturn.properties = updatedReturn.properties.map(
									(prop) => {
										if (
											t.isObjectProperty(prop) &&
											hasObjectKeyName(prop, "snippet")
										) {
											hasSnippetProp = true;
											return t.objectProperty(
												t.identifier("snippet"),
												t.identifier("changedSnippet"),
											);
										}
										return prop;
									},
								);
								if (!hasSnippetProp) return;

								const rawName = t.identifier("changedSnippetRaw");
								const capName = t.identifier("maxChangedSnippetChars");
								const snippetName = t.identifier("changedSnippet");
								const truncMarkerName = t.identifier(
									"changedSnippetTruncMarker",
								);
								const budgetName = t.identifier("changedSnippetBudget");
								const headBudgetName = t.identifier("changedHeadBudget");
								const tailBudgetName = t.identifier("changedTailBudget");

								const preservedPrefixStatements = statements
									.slice(0, emptyCheckIndex - (rawBindingName ? 1 : 0))
									.map((stmt) => t.cloneNode(stmt, true) as t.Statement);

								consequent.body = [
									...preservedPrefixStatements,
									t.variableDeclaration("var", [
										t.variableDeclarator(
											rawName,
											t.cloneNode(gwACall, true) as t.Expression,
										),
									]),
									t.ifStatement(
										t.binaryExpression(
											"===",
											t.cloneNode(rawName, true),
											t.stringLiteral(""),
										),
										t.returnStatement(t.nullLiteral()),
									),
									t.variableDeclaration("var", [
										t.variableDeclarator(capName, t.numericLiteral(8000)),
									]),
									t.variableDeclaration("var", [
										t.variableDeclarator(
											snippetName,
											t.cloneNode(rawName, true),
										),
									]),
									t.ifStatement(
										t.binaryExpression(
											">",
											t.memberExpression(
												t.cloneNode(rawName, true),
												t.identifier("length"),
											),
											t.cloneNode(capName, true),
										),
										t.blockStatement([
											t.variableDeclaration("var", [
												t.variableDeclarator(
													truncMarkerName,
													tplExpression(
														[
															'"\\n\\n[TRUNCATED - changed-file diff head+tail summary]\\noriginal_chars=" +',
															"changedSnippetRaw.length +",
															'"\\nUse Read with narrow range(s) to inspect omitted regions.\\n\\n"',
														].join(" "),
													),
												),
											]),
											t.variableDeclaration("var", [
												t.variableDeclarator(
													budgetName,
													tplExpression(
														"Math.max(maxChangedSnippetChars - changedSnippetTruncMarker.length, 0)",
													),
												),
											]),
											t.variableDeclaration("var", [
												t.variableDeclarator(
													headBudgetName,
													tplExpression(
														"Math.floor(changedSnippetBudget * 0.65)",
													),
												),
											]),
											t.variableDeclaration("var", [
												t.variableDeclarator(
													tailBudgetName,
													tplExpression(
														"Math.max(changedSnippetBudget - changedHeadBudget, 0)",
													),
												),
											]),
											t.expressionStatement(
												t.assignmentExpression(
													"=",
													t.cloneNode(snippetName, true),
													tplExpression(
														[
															"changedSnippetRaw.slice(0, changedHeadBudget)",
															"+ changedSnippetTruncMarker +",
															"changedSnippetRaw.slice(Math.max(changedSnippetRaw.length - changedTailBudget, 0))",
														].join(" "),
													),
												),
											),
										]),
									),
									t.returnStatement(updatedReturn),
								];
								patchedChangedFileSnippet = true;
								path.stop();
							},
						});

						// === 9. Mark content-identical changed-file re-reads as seen ===
						// The changed-file scanner re-reads any readFileState entry whose
						// mtime is newer than the recorded timestamp, through the full Read
						// pipeline (including conditional-skill path matching). When the
						// re-read content is identical (mtime-only churn, e.g. from git
						// operations) it returns null WITHOUT updating the recorded
						// timestamp, so the same file is re-read on every attachment cycle
						// for the rest of the session. Hoist the observed mtime out of the
						// staleness gate and record THAT value before returning, so the
						// entry counts as seen. Recording the mtime (not wall-clock time)
						// keeps both sides of the gate's `mtime <= timestamp` comparison on
						// the same clock: it breaks the loop even for future-dated mtimes
						// and does not widen the skip window for past-dated writes from
						// mtime-preserving tools. A later real change still produces a
						// newer mtime and re-fires the scanner.
						const CHANGED_FILE_MTIME_VAR = "__ccChangedFileMtime";
						let patchedChangedFileSeen = false;
						traverse(ast, {
							IfStatement(path) {
								if (patchedChangedFileSeen) return;
								const { test, consequent } = path.node;
								if (!t.isCallExpression(test)) return;
								if (test.arguments.length !== 2) return;
								const [stateArg, contentArg] = test.arguments;
								if (!t.isIdentifier(stateArg)) return;
								if (
									!t.isMemberExpression(contentArg) ||
									contentArg.computed ||
									!isMemberPropertyName(contentArg, "content")
								) {
									return;
								}
								if (
									!t.isReturnStatement(consequent) ||
									!t.isNullLiteral(consequent.argument)
								) {
									return;
								}
								// Anchor on the sibling token-cap gate in the same block so
								// no other two-arg predicate-with-null-return matches.
								const enclosingBlock = path.parentPath?.node;
								if (!t.isBlockStatement(enclosingBlock)) return;
								let blockHasTokenCapGate = false;
								t.traverseFast(enclosingBlock, (node) => {
									if (t.isIdentifier(node, { name: "truncatedByTokenCap" })) {
										blockHasTokenCapGate = true;
									}
								});
								if (!blockHasTokenCapGate) return;

								// Locate the staleness gate in the same function:
								// `if ((await <mtimeOf>(<file>)) <= <state>.timestamp) return null;`
								// The awaited call is cloned, never matched by name, so the
								// mtime helper's minified identity is irrelevant.
								const fnPath = path.getFunctionParent();
								if (!fnPath) return;
								type ChangedFileGate = {
									gatePath: NodePath<t.IfStatement>;
									awaitExpr: t.AwaitExpression;
								};
								let foundGate: ChangedFileGate | null = null;
								fnPath.traverse({
									IfStatement(gatePath) {
										if (foundGate) return;
										if (gatePath.getFunctionParent() !== fnPath) return;
										const gateTest = gatePath.node.test;
										if (!t.isBinaryExpression(gateTest, { operator: "<=" }))
											return;
										if (!t.isAwaitExpression(gateTest.left)) return;
										if (!t.isCallExpression(gateTest.left.argument)) return;
										const gateRight = gateTest.right;
										if (
											!t.isMemberExpression(gateRight) ||
											gateRight.computed ||
											!isMemberPropertyName(gateRight, "timestamp") ||
											!t.isIdentifier(gateRight.object, { name: stateArg.name })
										) {
											return;
										}
										const gateConsequent = gatePath.node.consequent;
										if (
											!t.isReturnStatement(gateConsequent) ||
											!t.isNullLiteral(gateConsequent.argument)
										) {
											return;
										}
										foundGate = { gatePath, awaitExpr: gateTest.left };
									},
								});
								// The narrowing reset is deliberate: foundGate is assigned
								// inside the traversal closure, which TS flow analysis
								// cannot see.
								const gate = foundGate as ChangedFileGate | null;
								if (!gate) return;

								// Drop parenthesization metadata from the clone so the
								// hoisted initializer prints as a plain await expression.
								const hoistedInit = t.cloneNode(gate.awaitExpr, true);
								hoistedInit.extra = undefined;
								gate.gatePath.insertBefore(
									t.variableDeclaration("let", [
										t.variableDeclarator(
											t.identifier(CHANGED_FILE_MTIME_VAR),
											hoistedInit,
										),
									]),
								);
								(gate.gatePath.node.test as t.BinaryExpression).left =
									t.identifier(CHANGED_FILE_MTIME_VAR);

								path.node.consequent = t.blockStatement([
									t.expressionStatement(
										t.assignmentExpression(
											"=",
											t.memberExpression(
												t.cloneNode(stateArg, true),
												t.identifier("timestamp"),
											),
											t.identifier(CHANGED_FILE_MTIME_VAR),
										),
									),
									t.returnStatement(t.nullLiteral()),
								]);
								patchedChangedFileSeen = true;
								path.stop();
							},
						});
					},
				},
			},
		},
	],

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) {
			return "Unable to parse AST during read-bat verification";
		}
		const readToolPath = findReadToolObjectPath(verifyAst);
		if (!readToolPath) {
			return "Unable to resolve Read tool object for verification";
		}
		const readToolObject = readToolPath.node;
		const schemaObject = getReadInputSchemaObject(verifyAst, readToolPath);
		if (!schemaObject) {
			return "Unable to resolve Read input schema for verification";
		}
		const callMethod = findToolMethod(readToolObject, "call");
		const callParam = getFirstObjectPatternParam(callMethod);
		if (!callParam) {
			return "Unable to resolve Read.call object parameter for verification";
		}
		const callKeys = getObjectPatternKeys(callParam);
		const rangeBindingName =
			getObjectPatternBindingName(callParam, "range") ?? "R";
		const validateMethod = findToolMethod(readToolObject, "validateInput");
		const validateParam = getFirstObjectPatternParam(validateMethod);
		if (!validateParam) {
			return "Unable to resolve Read.validateInput object parameter for verification";
		}
		const validateKeys = getObjectPatternKeys(validateParam);

		const context: ReadVerifyContext = {
			code,
			ast: verifyAst,
			schemaObject,
			callParam,
			callKeys,
			rangeBindingName,
			validateKeys,
			callMethod: callMethod ?? null,
		};
		const validators = [
			verifyReadSchemaAndPrompt,
			verifyReadBatCore,
			verifyReadCallSignature,
			verifyReadLineAccounting,
			verifyReadExamplesAndValidate,
			verifyReadStateAndSnippetGuards,
			verifyReadRangeRegexAndFallbackMarkers,
		];
		for (const validator of validators) {
			const result = validator(context);
			if (result) return result;
		}
		return true;
	},
};
