import traverse from "@babel/traverse";
import * as t from "@babel/types";
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
 * Stock behavior (2.1.77): task output is truncated (tail, 32K default)
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

function createTaskOutputExtMutator(): traverse.Visitor {
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
		// In 2.1.83+ the body is preceded by a DEPRECATED notice which is preserved.
		return code.replace(OLD_PROMPT, NEW_PROMPT);
	},

	astPasses: () => [{ pass: "mutate", visitor: createTaskOutputExtMutator() }],

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) return "Unable to parse AST for taskout-ext verification";

		let taskSerializerFound = false;
		let hasOutputFile = false;
		let hasOutputFilename = false;
		let hasOutputFileTag = false;
		let hasOutputFilenameTag = false;

		traverse.default(verifyAst, {
			ObjectExpression(path) {
				if (!isTaskSerializerObject(path.node)) return;
				taskSerializerFound = true;
				if (
					path.node.properties.some((p) => hasObjectKeyName(p, "output_file"))
				)
					hasOutputFile = true;
				if (
					path.node.properties.some((p) =>
						hasObjectKeyName(p, "output_filename"),
					)
				)
					hasOutputFilename = true;
			},
			StringLiteral(path) {
				if (path.node.value.includes("<output_file>")) hasOutputFileTag = true;
				if (path.node.value.includes("<output_filename>"))
					hasOutputFilenameTag = true;
			},
			TemplateElement(path) {
				const raw = path.node.value.raw;
				if (raw.includes("<output_file>")) hasOutputFileTag = true;
				if (raw.includes("<output_filename>")) hasOutputFilenameTag = true;
			},
		});

		if (!taskSerializerFound) return "Task serializer object not found";
		if (!hasOutputFile) return "Missing output_file in task serializer";
		if (!hasOutputFilename) return "Missing output_filename in task serializer";
		if (!hasOutputFileTag) return "Missing <output_file> tag in response";
		if (!hasOutputFilenameTag)
			return "Missing <output_filename> tag in response";

		// Prompt checks
		if (!code.includes("output_file path with the Read tool"))
			return "Missing output_file Read guidance in prompt";
		if (!code.includes("output_filename for display labels"))
			return "Missing output_filename guidance in prompt";

		return true;
	},
};
