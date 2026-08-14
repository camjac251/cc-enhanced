import * as t from "@babel/types";
import { traverse, type Visitor } from "../babel.js";
import type { Patch } from "../types.js";
import {
	findToolObject,
	getObjectKeyName,
	getVerifyAst,
	hasObjectKeyName,
	isFalseLike,
	isMemberPropertyName,
	isTrueLike,
	resolveStringValue,
} from "./ast-helpers.js";
import {
	BACKGROUND_TASK_POLICY,
	BACKGROUND_TASK_POLICY_LINES,
} from "./prompt-policy.js";

/**
 * Enhance TaskOutput tool response with structured file metadata.
 *
 * Stock behavior: task output is truncated (tail, 32K default)
 * with the file path buried in prose. No structured output_file tag.
 * The model often misses the file path and can't read the full output.
 *
 * This patch adds:
 * - output_file / output_filename to the task serializer object
 * - <output_file> / <output_filename> tags to the XML response
 * - Prompt guidance about using Read tool for large output
 */

// --- Helpers ---

function nodeContainsText(
	node: t.Node | null | undefined,
	text: string,
): boolean {
	const visit = (value: unknown): boolean => {
		if (!value) return false;
		if (Array.isArray(value)) return value.some((item) => visit(item));
		if (typeof value !== "object") return false;
		const maybeNode = value as t.Node;
		if (typeof (maybeNode as { type?: unknown }).type !== "string")
			return false;
		if (t.isStringLiteral(maybeNode)) return maybeNode.value.includes(text);
		if (t.isTemplateElement(maybeNode)) {
			return (
				maybeNode.value.raw.includes(text) ||
				maybeNode.value.cooked?.includes(text) === true
			);
		}
		return Object.values(maybeNode as unknown as Record<string, unknown>).some(
			(child) => visit(child),
		);
	};
	return visit(node);
}

function isTaskSerializerObject(obj: t.ObjectExpression): boolean {
	const type = findObjectProperty(obj, "type");
	const subtype = findObjectProperty(obj, "subtype");
	return (
		!!type &&
		t.isStringLiteral(type.value, { value: "system" }) &&
		!!subtype &&
		t.isStringLiteral(subtype.value, { value: "task_notification" }) &&
		findObjectProperty(obj, "task_id") !== null &&
		findObjectProperty(obj, "status") !== null &&
		findObjectProperty(obj, "output_file") !== null &&
		findObjectProperty(obj, "summary") !== null
	);
}

function findObjectProperty(
	obj: t.ObjectExpression,
	key: string,
): t.ObjectProperty | null {
	return (
		obj.properties.find(
			(property): property is t.ObjectProperty =>
				t.isObjectProperty(property) && getObjectKeyName(property.key) === key,
		) ?? null
	);
}

function isTaskOutputSchemaObject(obj: t.ObjectExpression): boolean {
	const taskId = findObjectProperty(obj, "task_id");
	const block = findObjectProperty(obj, "block");
	const timeout = findObjectProperty(obj, "timeout");
	return (
		taskId !== null &&
		block !== null &&
		timeout !== null &&
		nodeContainsText(taskId.value, "The task ID to get output from") &&
		nodeContainsText(block.value, "Whether to wait for completion") &&
		nodeContainsText(timeout.value, "Max wait time in ms")
	);
}

function findDefaultCall(node: t.Node): t.CallExpression | null {
	let result: t.CallExpression | null = null;
	const visit = (value: unknown): void => {
		if (result || !value) return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (typeof value !== "object") return;
		const maybeNode = value as t.Node;
		if (typeof (maybeNode as { type?: unknown }).type !== "string") return;
		if (
			t.isCallExpression(maybeNode) &&
			t.isMemberExpression(maybeNode.callee) &&
			isMemberPropertyName(maybeNode.callee, "default") &&
			maybeNode.arguments.length === 1 &&
			!t.isSpreadElement(maybeNode.arguments[0])
		) {
			result = maybeNode;
			return;
		}
		for (const child of Object.values(
			maybeNode as unknown as Record<string, unknown>,
		)) {
			visit(child);
		}
	};
	visit(node);
	return result;
}

function findTaskOutputBlockDefault(
	obj: t.ObjectExpression,
): t.CallExpression | null {
	const block = findObjectProperty(obj, "block");
	return block ? findDefaultCall(block.value) : null;
}

function findOutputFileMember(
	node: t.Node,
): t.MemberExpression | t.OptionalMemberExpression | null {
	let result: t.MemberExpression | t.OptionalMemberExpression | null = null;
	const visit = (value: unknown): void => {
		if (result || !value) return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (typeof value !== "object") return;
		const maybeNode = value as t.Node;
		if (typeof (maybeNode as { type?: unknown }).type !== "string") return;
		if (
			(t.isMemberExpression(maybeNode) ||
				t.isOptionalMemberExpression(maybeNode)) &&
			isMemberPropertyName(maybeNode, "outputFile")
		) {
			result = maybeNode;
			return;
		}
		for (const child of Object.values(
			maybeNode as unknown as Record<string, unknown>,
		)) {
			visit(child);
		}
	};
	visit(node);
	return result;
}

function nodeContainsTaskErrorRef(
	node: t.Node | null | undefined,
	resultVar: string,
): boolean {
	const visit = (value: unknown): boolean => {
		if (!value) return false;
		if (Array.isArray(value)) return value.some((item) => visit(item));
		if (typeof value !== "object") return false;
		const maybeNode = value as t.Node;
		if (typeof (maybeNode as { type?: unknown }).type !== "string")
			return false;
		if (
			t.isMemberExpression(maybeNode) &&
			isMemberPropertyName(maybeNode, "error") &&
			t.isMemberExpression(maybeNode.object) &&
			isMemberPropertyName(maybeNode.object, "task") &&
			t.isIdentifier(maybeNode.object.object, { name: resultVar })
		) {
			return true;
		}
		return Object.values(maybeNode as unknown as Record<string, unknown>).some(
			(child) => visit(child),
		);
	};
	return visit(node);
}

function buildBasenameExpr(fileExpr: t.Expression): t.LogicalExpression {
	return t.logicalExpression(
		"&&",
		t.cloneNode(fileExpr),
		t.callExpression(
			t.memberExpression(t.cloneNode(fileExpr), t.identifier("replace")),
			[t.regExpLiteral("^.*[\\\\/]", ""), t.stringLiteral("")],
		),
	);
}

// --- Mutator ---

function createTaskOutputExtMutator(): Visitor {
	let schemaPatched = false;
	let serializerPatched = false;
	let responsePatched = false;

	return {
		// 1. Add output_filename to the task notification serializer
		ObjectExpression(path) {
			if (!schemaPatched && isTaskOutputSchemaObject(path.node)) {
				const defaultCall = findTaskOutputBlockDefault(path.node);
				const defaultValue = defaultCall?.arguments[0];
				if (defaultCall && defaultValue && !t.isSpreadElement(defaultValue)) {
					if (isTrueLike(defaultValue)) {
						defaultCall.arguments[0] = t.booleanLiteral(false);
						schemaPatched = true;
					} else if (isFalseLike(defaultValue)) {
						schemaPatched = true;
					}
				}
			}

			if (serializerPatched) return;
			if (!isTaskSerializerObject(path.node)) return;
			if (
				path.node.properties.some((p) => hasObjectKeyName(p, "output_filename"))
			) {
				serializerPatched = true;
				return;
			}

			const outputFileProp = findObjectProperty(path.node, "output_file");
			if (!outputFileProp) return;
			const outputFileExpr = findOutputFileMember(outputFileProp.value);
			if (!outputFileExpr) return;

			path.node.properties.push(
				t.objectProperty(
					t.identifier("output_filename"),
					buildBasenameExpr(outputFileExpr),
				),
			);
			serializerPatched = true;
		},

		// 2. Add <output_file> / <output_filename> tags to XML response
		ObjectMethod(path) {
			if (responsePatched) return;
			if (
				getObjectKeyName(path.node.key) !==
				"mapToolResultToToolResultBlockParam"
			)
				return;
			if (!t.isIdentifier(path.node.params[0])) return;

			// Confirm this is the TaskOutput tool's method (has <task_id> and <status>)
			if (
				!nodeContainsText(path.node.body, "<task_id>") ||
				!nodeContainsText(path.node.body, "<status>")
			)
				return;

			// Skip if Bash tool's method (has ObjectPattern first param with stdout)
			if (t.isObjectPattern(path.node.params[0])) return;

			// Already patched?
			if (nodeContainsText(path.node.body, "<output_file>")) return;

			const resultVar = (path.node.params[0] as t.Identifier).name;

			// Find the output array variable
			let outputArrayVar: string | null = null;
			for (const stmt of path.node.body.body) {
				if (!t.isVariableDeclaration(stmt)) continue;
				for (const decl of stmt.declarations) {
					if (
						t.isIdentifier(decl.id) &&
						t.isArrayExpression(decl.init) &&
						decl.init.elements.length === 0
					) {
						outputArrayVar = decl.id.name;
					}
				}
			}
			if (!outputArrayVar) return;

			// Find the if-block containing <task_id>/<status> pushes
			for (const stmt of path.node.body.body) {
				if (!t.isIfStatement(stmt)) continue;
				if (!t.isBlockStatement(stmt.consequent)) continue;

				const block = stmt.consequent;
				if (
					!nodeContainsText(block, "<task_id>") ||
					!nodeContainsText(block, "<status>")
				)
					continue;

				// Build: if (H.task.output_file) A.push(`<output_file>${H.task.output_file}</output_file>`);
				const outputFileExpr = t.memberExpression(
					t.memberExpression(t.identifier(resultVar), t.identifier("task")),
					t.identifier("output_file"),
				);

				const pushOutputFile = t.ifStatement(
					t.cloneNode(outputFileExpr),
					t.expressionStatement(
						t.callExpression(
							t.memberExpression(
								t.identifier(outputArrayVar),
								t.identifier("push"),
							),
							[
								t.templateLiteral(
									[
										t.templateElement({
											raw: "<output_file>",
											cooked: "<output_file>",
										}),
										t.templateElement(
											{
												raw: "</output_file>",
												cooked: "</output_file>",
											},
											true,
										),
									],
									[t.cloneNode(outputFileExpr)],
								),
							],
						),
					),
				);

				const outputFilenameExpr = t.logicalExpression(
					"||",
					t.memberExpression(
						t.memberExpression(t.identifier(resultVar), t.identifier("task")),
						t.identifier("output_filename"),
					),
					buildBasenameExpr(t.cloneNode(outputFileExpr)),
				);

				const pushOutputFilename = t.ifStatement(
					t.cloneNode(outputFileExpr),
					t.expressionStatement(
						t.callExpression(
							t.memberExpression(
								t.identifier(outputArrayVar),
								t.identifier("push"),
							),
							[
								t.templateLiteral(
									[
										t.templateElement({
											raw: "<output_filename>",
											cooked: "<output_filename>",
										}),
										t.templateElement(
											{
												raw: "</output_filename>",
												cooked: "</output_filename>",
											},
											true,
										),
									],
									[t.cloneNode(outputFilenameExpr)],
								),
							],
						),
					),
				);

				// Insert before error check or at end of block
				const errorIdx = block.body.findIndex((s) =>
					nodeContainsTaskErrorRef(s, resultVar),
				);
				const insertIdx = errorIdx >= 0 ? errorIdx : block.body.length;
				block.body.splice(insertIdx, 0, pushOutputFile, pushOutputFilename);
				responsePatched = true;
				break;
			}
		},
	};
}

// --- Patch ---

const OLD_PROMPT = `- Retrieves output from a running or completed task (background shell, agent, or remote session)
- Takes a task_id parameter identifying the task
- Returns the task output along with status information
- Use block=true (default) to wait for task completion
- Use block=false for non-blocking check of current status
- Task IDs can be found using the /tasks command
- Works with all task types: background shells, async agents, and remote sessions`;

const NEW_PROMPT = `- Retrieves output from a running or completed task (background shell, agent, or remote session)
- Takes a task_id parameter identifying the task
- Returns: status, exit_code, error, output, output_file, output_filename
${BACKGROUND_TASK_POLICY}
- Task IDs can be found using the /tasks command
- Works with all task types: background shells, async agents, and remote sessions
- Use the output_file path from the original background-task result or completion notification; do not call TaskOutput only to rediscover it
- TaskOutput returns accumulated output, not an unread-output delta
- Do not repeatedly call TaskOutput to follow logs; rely on completion notifications or Monitor
- Do not re-read a tail that TaskOutput already returned
- Read persisted output with explicit non-overlapping ranges such as "1:2000", then "2001:4000"
- Use output_filename for display labels; always use output_file as the Read path`;

function findTaskOutputPrompt(ast: t.File): string | null {
	let prompt: string | null = null;
	traverse(ast, {
		ObjectExpression(path) {
			if (prompt !== null || !findToolObject(path, "TaskOutput")) return;
			for (const property of path.node.properties) {
				if (
					t.isObjectMethod(property) &&
					hasObjectKeyName(property, "prompt")
				) {
					for (const statement of property.body.body) {
						if (!t.isReturnStatement(statement) || !statement.argument)
							continue;
						prompt = resolveStringValue(path, statement.argument);
						break;
					}
				}
				if (
					t.isObjectProperty(property) &&
					hasObjectKeyName(property, "prompt") &&
					t.isExpression(property.value)
				) {
					prompt = resolveStringValue(path, property.value);
				}
				if (prompt !== null) break;
			}
		},
	});
	return prompt;
}

export const taskOutputExt: Patch = {
	tag: "taskout-ext",

	string: (code) => {
		// Replace the stock TaskOutput prompt body with enhanced version.
		// Preserve the deprecation notice that can precede the prompt body.
		return code.replace(OLD_PROMPT, NEW_PROMPT);
	},

	astPasses: () => [{ pass: "mutate", visitor: createTaskOutputExtMutator() }],

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) return "Unable to parse AST for taskout-ext verification";
		if (code.includes(OLD_PROMPT)) {
			return "A stock TaskOutput prompt body survived replacement";
		}
		const taskOutputPrompt = findTaskOutputPrompt(verifyAst);
		if (taskOutputPrompt === null) {
			return "Missing named TaskOutput tool with a statically resolved prompt";
		}
		if (
			BACKGROUND_TASK_POLICY_LINES.some(
				(line) => !taskOutputPrompt.includes(line),
			)
		) {
			return "TaskOutput prompt is missing the shared background execution policy";
		}
		if (
			taskOutputPrompt.includes(
				"Use block=true only when deliberately waiting for task completion",
			)
		) {
			return "TaskOutput prompt still contains ambiguous blocking-wait guidance";
		}

		const schemaResult = verifyTaskOutputSchema(verifyAst);
		if (schemaResult !== true) return schemaResult;

		const serializerResult = verifyTaskSerializer(verifyAst);
		if (serializerResult !== true) return serializerResult;

		const responseResult = verifyResponseMethod(verifyAst);
		if (responseResult !== true) return responseResult;

		// Prompt checks
		if (
			!taskOutputPrompt.includes(
				"Use the output_file path from the original background-task result or completion notification",
			)
		)
			return "Missing original output_file guidance in prompt";
		if (
			!taskOutputPrompt.includes(
				"TaskOutput returns accumulated output, not an unread-output delta",
			)
		)
			return "Missing accumulated-output guidance in prompt";
		if (
			!taskOutputPrompt.includes(
				"Do not repeatedly call TaskOutput to follow logs",
			)
		)
			return "Missing TaskOutput polling guidance in prompt";
		if (
			!taskOutputPrompt.includes(
				"Read persisted output with explicit non-overlapping ranges",
			)
		)
			return "Missing non-overlapping range guidance in prompt";
		if (!taskOutputPrompt.includes("output_filename for display labels"))
			return "Missing output_filename guidance in prompt";

		return true;
	},
};

function verifyTaskOutputSchema(ast: t.File | t.Program): true | string {
	let matches = 0;
	let defaultIsFalse = false;
	traverse(ast, {
		ObjectExpression(path) {
			if (!isTaskOutputSchemaObject(path.node)) return;
			matches += 1;
			const defaultValue = findTaskOutputBlockDefault(path.node)?.arguments[0];
			if (defaultValue && !t.isSpreadElement(defaultValue)) {
				defaultIsFalse = isFalseLike(defaultValue);
			}
		},
	});
	if (matches !== 1) {
		return `Expected exactly one TaskOutput input schema, found ${matches}`;
	}
	if (!defaultIsFalse) {
		return "TaskOutput block must default to false";
	}
	return true;
}

function verifyTaskSerializer(ast: t.File | t.Program): true | string {
	let taskSerializerFound = false;
	let serializerError: string | null = null;

	const visit = (path: any) => {
		if (!isTaskSerializerObject(path.node)) return;
		taskSerializerFound = true;

		const outputFileProp = path.node.properties.find((p: any) =>
			hasObjectKeyName(p, "output_file"),
		) as t.ObjectProperty | undefined;
		if (!outputFileProp) {
			serializerError = "Missing output_file in task serializer";
			return;
		}

		const outputFilenameProp = path.node.properties.find((p: any) =>
			hasObjectKeyName(p, "output_filename"),
		) as t.ObjectProperty | undefined;
		if (!outputFilenameProp) {
			serializerError = "Missing output_filename in task serializer";
			return;
		}

		// output_file must contain a .outputFile read rooted at an identifier
		// parameter of the enclosing serializer function.
		const enclosingFn = path.findParent(
			(p: any) =>
				p.isFunctionDeclaration() ||
				p.isFunctionExpression() ||
				p.isArrowFunctionExpression(),
		);
		if (!enclosingFn || !("params" in enclosingFn.node)) return;

		const outputFileMember = findOutputFileMember(outputFileProp.value);
		const outputFileObject = outputFileMember?.object;
		if (!t.isIdentifier(outputFileObject)) {
			serializerError =
				"output_file does not reference an enclosing serializer param's .outputFile";
			return;
		}
		const taskParam = outputFileObject.name;
		if (
			!enclosingFn.node.params.some((param: t.Node) =>
				t.isIdentifier(param, { name: taskParam }),
			)
		) {
			serializerError =
				"output_file does not reference an enclosing serializer param's .outputFile";
			return;
		}

		// output_filename value must be the basename derivation: a logical-and
		// whose left reads the same <taskParam>.outputFile and whose right is a
		// .replace() call stripping the path prefix off that same member. A bare
		// key presence check would pass even if the value were wrong or empty.
		const filenameValue = outputFilenameProp.value;
		const isOutputFileMember = (node: t.Node | null | undefined): boolean =>
			!!node &&
			(t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) &&
			t.isIdentifier(node.object, { name: taskParam }) &&
			isMemberPropertyName(node, "outputFile");
		const isBasenameDerivation =
			t.isLogicalExpression(filenameValue, { operator: "&&" }) &&
			isOutputFileMember(filenameValue.left) &&
			t.isCallExpression(filenameValue.right) &&
			t.isMemberExpression(filenameValue.right.callee) &&
			isOutputFileMember(filenameValue.right.callee.object) &&
			isMemberPropertyName(filenameValue.right.callee, "replace");
		if (!isBasenameDerivation) {
			serializerError =
				"output_filename does not derive the basename from the task param's .outputFile";
		}
	};

	const root = t.isFile(ast) ? ast : t.file(ast as t.Program);
	traverse(root, {
		ObjectExpression: visit,
	});

	if (!taskSerializerFound) return "Task serializer object not found";
	if (serializerError) return serializerError;
	return true;
}

function verifyResponseMethod(ast: t.File | t.Program): true | string {
	let methodFound = false;
	let error: string | null = null;
	let hasOutputFileTag = false;
	let hasOutputFilenameTag = false;
	let orderingOk = true;

	const root = t.isFile(ast) ? ast : t.file(ast as t.Program);
	traverse(root, {
		ObjectMethod(path) {
			if (
				getObjectKeyName(path.node.key) !==
				"mapToolResultToToolResultBlockParam"
			)
				return;
			if (
				!nodeContainsText(path.node.body, "<task_id>") ||
				!nodeContainsText(path.node.body, "<status>")
			)
				return;
			// Skip Bash tool's method (ObjectPattern first param)
			if (path.node.params.length === 0) return;
			if (t.isObjectPattern(path.node.params[0])) return;
			if (!t.isIdentifier(path.node.params[0])) return;

			methodFound = true;
			const resultVar = (path.node.params[0] as t.Identifier).name;

			// Tags must appear INSIDE this method body, not anywhere in the bundle.
			const bodyHasFileTag = nodeContainsText(path.node.body, "<output_file>");
			const bodyHasFilenameTag = nodeContainsText(
				path.node.body,
				"<output_filename>",
			);
			if (bodyHasFileTag) hasOutputFileTag = true;
			if (bodyHasFilenameTag) hasOutputFilenameTag = true;

			// Validate push order: every push containing the new tags must precede
			// any statement referencing result.task.error in the same block.
			let foundErrorBeforePush = false;
			let foundTagPush = false;
			const checkBlock = (block: t.BlockStatement) => {
				let firstErrorIdx = -1;
				let lastTagPushIdx = -1;
				for (let i = 0; i < block.body.length; i++) {
					const stmt = block.body[i];
					if (nodeContainsTaskErrorRef(stmt, resultVar) && firstErrorIdx === -1)
						firstErrorIdx = i;
					if (
						nodeContainsText(stmt, "<output_file>") ||
						nodeContainsText(stmt, "<output_filename>")
					) {
						lastTagPushIdx = i;
						foundTagPush = true;
					}
				}
				if (
					firstErrorIdx >= 0 &&
					lastTagPushIdx >= 0 &&
					lastTagPushIdx > firstErrorIdx
				)
					foundErrorBeforePush = true;
			};

			for (const stmt of path.node.body.body) {
				if (t.isIfStatement(stmt) && t.isBlockStatement(stmt.consequent)) {
					checkBlock(stmt.consequent);
				}
			}
			checkBlock(path.node.body);
			if (foundErrorBeforePush) {
				orderingOk = false;
				error =
					"<output_file>/<output_filename> pushes must precede task.error handling";
				return;
			}
			if (!foundTagPush && (bodyHasFileTag || bodyHasFilenameTag)) {
				// Tags exist in the method body but not via a push() call.
				error =
					"<output_file>/<output_filename> tags found but not via push() into output array";
				return;
			}
		},
	});

	if (!methodFound)
		return "TaskOutput response method (mapToolResultToToolResultBlockParam) not found";
	if (error) return error;
	if (!orderingOk)
		return "<output_file>/<output_filename> pushes must precede task.error handling";
	if (!hasOutputFileTag)
		return "Missing <output_file> tag in TaskOutput response method body";
	if (!hasOutputFilenameTag)
		return "Missing <output_filename> tag in TaskOutput response method body";
	return true;
}
