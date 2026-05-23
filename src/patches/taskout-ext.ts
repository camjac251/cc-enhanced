import * as t from "@babel/types";
import { traverse, type Visitor } from "../babel.js";
import type { Patch } from "../types.js";
import {
	getObjectKeyName,
	getVerifyAst,
	hasObjectKeyName,
	isMemberPropertyName,
} from "./ast-helpers.js";

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
	const hasTaskId = obj.properties.some(
		(p) => t.isObjectProperty(p) && getObjectKeyName(p.key) === "task_id",
	);
	const hasStatus = obj.properties.some(
		(p) => t.isObjectProperty(p) && getObjectKeyName(p.key) === "status",
	);
	const hasOutput = obj.properties.some(
		(p) => t.isObjectProperty(p) && getObjectKeyName(p.key) === "output",
	);
	return hasTaskId && hasStatus && hasOutput;
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
	let serializerPatched = false;
	let responsePatched = false;

	return {
		// 1. Add output_file / output_filename to task serializer
		ObjectExpression(path) {
			if (serializerPatched) return;
			if (!isTaskSerializerObject(path.node)) return;
			if (path.node.properties.some((p) => hasObjectKeyName(p, "output_file")))
				return;

			// Find enclosing function's first param (the task object)
			const enclosingFn = path.findParent(
				(p) =>
					p.isFunctionDeclaration() ||
					p.isFunctionExpression() ||
					p.isArrowFunctionExpression(),
			);
			if (
				!enclosingFn ||
				!("params" in enclosingFn.node) ||
				!t.isIdentifier(enclosingFn.node.params[0])
			)
				return;
			const taskParam = enclosingFn.node.params[0].name;

			const outputFileExpr = t.memberExpression(
				t.identifier(taskParam),
				t.identifier("outputFile"),
			);

			path.node.properties.push(
				t.objectProperty(
					t.identifier("output_file"),
					t.cloneNode(outputFileExpr),
				),
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
- Use block=true (default) to wait for task completion
- Use block=false for non-blocking check of current status
- Task IDs can be found using the /tasks command
- Works with all task types: background shells, async agents, and remote sessions
- For large output, use output_file path with the Read tool to access full content
- Read the tail first: range "-500:" for recent output, then read in chunks ("1:2000", "2001:4000")
- Use output_filename for display labels; always use output_file as the Read path`;

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

		const serializerResult = verifyTaskSerializer(verifyAst);
		if (serializerResult !== true) return serializerResult;

		const responseResult = verifyResponseMethod(verifyAst);
		if (responseResult !== true) return responseResult;

		// Prompt checks
		if (!code.includes("output_file path with the Read tool"))
			return "Missing output_file Read guidance in prompt";
		if (!code.includes("output_filename for display labels"))
			return "Missing output_filename guidance in prompt";

		return true;
	},
};

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

		// output_file value must be a MemberExpression rooted at the enclosing
		// function's first identifier param, reading .outputFile.
		const enclosingFn = path.findParent(
			(p: any) =>
				p.isFunctionDeclaration() ||
				p.isFunctionExpression() ||
				p.isArrowFunctionExpression(),
		);
		if (
			!enclosingFn ||
			!("params" in enclosingFn.node) ||
			!t.isIdentifier(enclosingFn.node.params[0])
		)
			return;

		const taskParam = (enclosingFn.node.params[0] as t.Identifier).name;
		const value = outputFileProp.value;
		if (
			!t.isMemberExpression(value) ||
			!t.isIdentifier(value.object, { name: taskParam }) ||
			!isMemberPropertyName(value, "outputFile")
		) {
			serializerError =
				"output_file does not reference the enclosing task param's .outputFile";
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
