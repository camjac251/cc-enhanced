import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch } from "../types.js";

/**
 * Rename TaskOutput → TaskStatus and strip output from responses.
 * Output should be read via Read tool from the output file.
 *
 * Hybrid approach:
 * - AST: Variable rename, property additions, structural changes
 * - String: Prompt text updates (cleaner for template literals)
 */

export const taskOutputTool: Patch = {
	tag: "taskout-ext",

	ast: (ast) => {
		let addedOutputFile = false;
		let addedOutputFileTag = false;
		let removedOutputPush = false;
		let improvedErrorMessage = false;

		traverse.default(ast, {
			// 1. Rename: var X = "TaskOutput" -> var X = "TaskStatus"
			VariableDeclarator(path) {
				if (!t.isStringLiteral(path.node.init, { value: "TaskOutput" })) return;

				path.node.init = t.stringLiteral("TaskStatus");
				console.log("Renamed TaskOutput to TaskStatus");
			},

			// 1b. Improve error message: `No task found with ID: ${X}` -> better message
			// Find template literals with "No task found with ID:" prefix
			TemplateLiteral(path) {
				const quasis = path.node.quasis;
				if (quasis.length !== 2) return; // Should be: "prefix" + expr + ""

				const prefix = quasis[0].value.raw;
				if (prefix !== "No task found with ID: ") return;

				// Get the expression (the ID variable)
				const expressions = path.node.expressions;
				if (expressions.length !== 1) return;

				// Replace with improved message
				const idExpr = expressions[0];
				path.replaceWith(
					t.templateLiteral(
						[
							t.templateElement({
								raw: "No background task with ID: ",
								cooked: "No background task with ID: ",
							}),
							t.templateElement(
								{
									raw: ". Note: agentId from sync agents is for 'resume' parameter only - TaskStatus requires run_in_background: true",
									cooked:
										". Note: agentId from sync agents is for 'resume' parameter only - TaskStatus requires run_in_background: true",
								},
								true,
							),
						],
						[t.cloneNode(idExpr)],
					),
				);
				improvedErrorMessage = true;
			},

			// 2. Find aliases: ["AgentOutputTool", "BashOutputTool"] and empty it
			ArrayExpression(path) {
				const elements = path.node.elements;
				if (elements.length !== 2) return;
				if (
					!t.isStringLiteral(elements[0], { value: "AgentOutputTool" }) ||
					!t.isStringLiteral(elements[1], { value: "BashOutputTool" })
				) {
					return;
				}

				// Empty the array
				path.node.elements = [];
			},

			// 3. Add output_file to task serializer object
			// Find: { task_id: H.id, task_type: H.type, status: H.status, ..., output: X }
			// The object is assigned to a local var; we need the enclosing function's
			// first parameter (the task object that has .outputFile).
			ObjectExpression(path) {
				const props = path.node.properties;

				// Check for task_id, task_type, status, output properties
				const hasTaskId = props.some(
					(p) =>
						t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "task_id" }),
				);
				const hasOutput = props.some(
					(p) =>
						t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "output" }),
				);
				const hasOutputFile = props.some(
					(p) =>
						t.isObjectProperty(p) &&
						t.isIdentifier(p.key, { name: "output_file" }),
				);

				if (!hasTaskId || !hasOutput || hasOutputFile) return;

				// Resolve the task parameter from the enclosing function (e.g. "H" in
				// `function RC$(H) { let A = { task_id: H.id, ... }; ... }`)
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
				) {
					return;
				}
				const taskParam = enclosingFn.node.params[0].name;

				props.push(
					t.objectProperty(
						t.identifier("output_file"),
						t.memberExpression(
							t.identifier(taskParam),
							t.identifier("outputFile"),
						),
					),
				);
				addedOutputFile = true;
			},

			// 4. Add <output_file> tag after <status> push
			// Find mapToolResultToToolResultBlockParam and patch its task XML payload shape.
			// COUPLED: bash-output-tail also patches mapToolResultToToolResultBlockParam
			// but targets the Bash tool (ObjectPattern first param with `stdout`).
			// This visitor targets TaskOutput (plain Identifier first param).
			ObjectMethod(path) {
				if (
					!t.isIdentifier(path.node.key, {
						name: "mapToolResultToToolResultBlockParam",
					})
				) {
					return;
				}

				const firstParam = path.node.params[0];
				if (!t.isIdentifier(firstParam)) return;
				const resultVar = firstParam.name;

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

				const hasOutputFilePush = JSON.stringify(path.node.body).includes(
					"<output_file>",
				);
				if (!hasOutputFilePush) {
					for (const stmt of path.node.body.body) {
						if (!t.isIfStatement(stmt)) continue;
						if (!t.isBlockStatement(stmt.consequent)) continue;

						const block = stmt.consequent;
						const isTaskPayloadBlock =
							JSON.stringify(block).includes("<task_id>") &&
							JSON.stringify(block).includes("<status>");
						if (!isTaskPayloadBlock) continue;

						const outputFileExpr = t.memberExpression(
							t.memberExpression(t.identifier(resultVar), t.identifier("task")),
							t.identifier("output_file"),
						);

						const pushOutputFileStmt = t.ifStatement(
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

						// Place output_file near other task metadata (before error if present).
						const errorIdx = block.body.findIndex((s) =>
							JSON.stringify(s).includes(`${resultVar}.task.error`),
						);
						if (errorIdx >= 0)
							block.body.splice(errorIdx, 0, pushOutputFileStmt);
						else block.body.push(pushOutputFileStmt);

						addedOutputFileTag = true;
						break;
					}
				}
			},

			// 5. Remove output from mapToolResultToToolResultBlockParam
			// Find: if (A.task.output?.trim()) B.push(`<output>...`)
			IfStatement(path) {
				const test = path.node.test;
				if (!t.isCallExpression(test) && !t.isOptionalCallExpression(test))
					return;

				const callee = test.callee;
				const memberCallee =
					t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)
						? callee
						: null;
				if (!memberCallee) return;
				if (!t.isIdentifier(memberCallee.property, { name: "trim" })) return;

				// Check for A.task.output (optional or non-optional member access)
				const obj = memberCallee.object;
				if (!t.isMemberExpression(obj) && !t.isOptionalMemberExpression(obj))
					return;

				const outputProp = t.isIdentifier(obj.property)
					? obj.property.name
					: null;
				if (outputProp !== "output") return;

				// Check consequent has push with <output>
				const consequent = path.node.consequent;
				const hasOutputPush = (() => {
					const isOutputPushCall = (node: t.Node): boolean => {
						if (!t.isCallExpression(node)) return false;
						if (!t.isMemberExpression(node.callee)) return false;
						if (!t.isIdentifier(node.callee.property, { name: "push" }))
							return false;
						const arg = node.arguments[0];
						if (!t.isTemplateLiteral(arg)) return false;
						const first = arg.quasis[0]?.value.raw;
						return !!first?.includes("<output>");
					};

					if (t.isExpressionStatement(consequent)) {
						return isOutputPushCall(consequent.expression);
					}
					if (t.isBlockStatement(consequent)) {
						return consequent.body.some(
							(stmt) =>
								t.isExpressionStatement(stmt) &&
								isOutputPushCall(stmt.expression),
						);
					}
					return false;
				})();
				if (!hasOutputPush) return;

				// Remove output payload from TaskStatus response.
				path.remove();
				removedOutputPush = true;
			},
		});

		if (addedOutputFile) console.log("Added output_file to task serializer");
		if (addedOutputFileTag) console.log("Added <output_file> tag to response");
		if (removedOutputPush) console.log("Removed output from response");
		if (improvedErrorMessage)
			console.log("Improved 'No task found' error message");
	},

	// String patch for prompt text updates (cleaner than AST for template literals)
	string: (code) => {
		let result = code;

		// Update userFacingName
		result = result.replace(/return "Task Output"/, 'return "Task Status"');

		// Update description
		result = result.replace(
			/return "Retrieves output from a running or completed task"/,
			'return "Check status of a background task"',
		);

		// Update the prompt
		const oldPrompt = `\`- Retrieves output from a running or completed task (background shell, agent, or remote session)
- Takes a task_id parameter identifying the task
- Returns the task output along with status information
- Use block=true (default) to wait for task completion
- Use block=false for non-blocking check of current status
- Task IDs can be found using the /tasks command
- Works with all task types: background shells, async agents, and remote sessions\``;

		const newPrompt = `\`- Check status of a background task (shell, agent, or remote session)
- Returns: status (running/completed/failed), exit_code, error
- Use block=true (default) to wait for completion
- Use block=false for non-blocking status check
- Task IDs can be found using the /tasks command
- To read output, use: Read tool with the output_file path\``;

		result = result.replace(oldPrompt, newPrompt);

		// Clean up remaining TaskOutput references in prompts
		result = result.replace(
			/Use TaskOutput to read the output later/g,
			"Use TaskStatus to check status, Read tool for output",
		);

		result = result.replace(
			/You can check its output using the TaskOutput tool/g,
			"Check status with TaskStatus, read output with Read tool",
		);

		return result;
	},

	verify: (code) => {
		if (!code.includes('"TaskStatus"')) {
			return "TaskOutput not renamed to TaskStatus";
		}
		if (!/\boutput_file:\s*\w+\.outputFile\b/.test(code)) {
			return "Missing output_file in TaskStatus response";
		}
		if (!code.includes("<output_file>")) {
			return "Missing <output_file> tag in TaskStatus output payload";
		}
		if (!code.includes("No background task with ID:")) {
			return "Missing improved error message for task not found";
		}
		if (/\.task\.output\??\.trim\(\)/.test(code)) {
			return "TaskStatus output payload still includes inline <output> block";
		}
		if (code.includes('"AgentOutputTool", "BashOutputTool"')) {
			return "Old aliases AgentOutputTool/BashOutputTool still present in aliases array";
		}
		return true;
	},
};
