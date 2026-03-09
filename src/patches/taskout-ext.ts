import template from "@babel/template";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch } from "../types.js";
import { getObjectKeyName, isMemberPropertyName } from "./ast-helpers.js";

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

function isTaskErrorMemberExpression(node: t.Node, resultVar: string): boolean {
	if (!t.isMemberExpression(node)) return false;
	if (!isMemberPropertyName(node, "error")) return false;
	if (!t.isMemberExpression(node.object)) return false;
	if (!isMemberPropertyName(node.object, "task")) return false;
	return t.isIdentifier(node.object.object, { name: resultVar });
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
		if (isTaskErrorMemberExpression(maybeNode, resultVar)) return true;

		return Object.values(maybeNode as unknown as Record<string, unknown>).some(
			(child) => visit(child),
		);
	};

	return visit(node);
}

function hasObjectPropertyKey(
	prop: t.ObjectMethod | t.ObjectProperty | t.SpreadElement,
	keyName: string,
): boolean {
	return t.isObjectProperty(prop) && getObjectKeyName(prop.key) === keyName;
}

function isTaskSerializerObject(obj: t.ObjectExpression): boolean {
	const hasTaskId = obj.properties.some((prop) =>
		hasObjectPropertyKey(prop, "task_id"),
	);
	const hasStatus = obj.properties.some((prop) =>
		hasObjectPropertyKey(prop, "status"),
	);
	const hasOutput = obj.properties.some((prop) =>
		hasObjectPropertyKey(prop, "output"),
	);
	return hasTaskId && hasStatus && hasOutput;
}

function astHasLiteralFragment(ast: t.File, text: string): boolean {
	let found = false;
	traverse.default(ast, {
		StringLiteral(path) {
			if (!path.node.value.includes(text)) return;
			found = true;
			path.stop();
		},
		TemplateElement(path) {
			const raw = path.node.value.raw;
			const cooked = path.node.value.cooked ?? "";
			if (!raw.includes(text) && !cooked.includes(text)) return;
			found = true;
			path.stop();
		},
	});
	return found;
}

function astHasStringLiteralValue(ast: t.File, value: string): boolean {
	let found = false;
	traverse.default(ast, {
		StringLiteral(path) {
			if (path.node.value !== value) return;
			found = true;
			path.stop();
		},
	});
	return found;
}

function astHasLegacyTaskOutputAliasPair(ast: t.File): boolean {
	let found = false;
	traverse.default(ast, {
		ArrayExpression(path) {
			const hasAgentOutputTool = path.node.elements.some((el) =>
				t.isStringLiteral(el, { value: "AgentOutputTool" }),
			);
			const hasBashOutputTool = path.node.elements.some((el) =>
				t.isStringLiteral(el, { value: "BashOutputTool" }),
			);
			if (!hasAgentOutputTool || !hasBashOutputTool) return;
			found = true;
			path.stop();
		},
	});
	return found;
}

function astHasLegacyOutputPushTemplate(ast: t.File): boolean {
	let found = false;
	traverse.default(ast, {
		CallExpression(path) {
			if (!t.isMemberExpression(path.node.callee)) return;
			if (!isMemberPropertyName(path.node.callee, "push")) return;
			const firstArg = path.node.arguments[0];
			if (!t.isTemplateLiteral(firstArg)) return;
			const firstQuasiRaw = firstArg.quasis[0]?.value.raw ?? "";
			if (!firstQuasiRaw.includes("<output>")) return;
			found = true;
			path.stop();
		},
	});
	return found;
}

function isTaskMapMethod(node: t.ObjectMethod): boolean {
	if (getObjectKeyName(node.key) === "mapToolResultToToolResultBlockParam") {
		return true;
	}
	if (!t.isIdentifier(node.params[0])) return false;
	return (
		nodeContainsText(node.body, "<task_id>") &&
		nodeContainsText(node.body, "<status>")
	);
}

/**
 * Rename TaskOutput → TaskStatus and strip output from responses.
 * Output should be read via Read tool from the output file.
 *
 * Hybrid approach:
 * - AST: Variable rename, property additions, structural changes
 * - String: Prompt text updates (cleaner for template literals)
 */

function createTaskOutputToolMutator(): traverse.Visitor {
	let renamedTaskOutput = false;
	let addedOutputFile = false;
	let addedOutputFilename = false;
	let addedOutputFileTag = false;
	let addedOutputFilenameTag = false;
	let replacedOutputPush = false;

	return {
		Program: {
			exit() {
				if (renamedTaskOutput) console.log("Renamed TaskOutput to TaskStatus");
				if (addedOutputFile)
					console.log("Added output_file to task serializer");
				if (addedOutputFilename)
					console.log("Added output_filename to task serializer");
				if (addedOutputFileTag)
					console.log("Added <output_file> tag to response");
				if (addedOutputFilenameTag)
					console.log("Added <output_filename> tag to response");
				if (replacedOutputPush)
					console.log("Replaced output payload with summary and tools");
			},
		},

		// 1. Rename: var X = "TaskOutput" -> var X = "TaskStatus"
		VariableDeclarator(path) {
			if (!t.isStringLiteral(path.node.init, { value: "TaskOutput" })) return;

			path.node.init = t.stringLiteral("TaskStatus");
			renamedTaskOutput = true;
		},

		// 2. Find aliases: ["AgentOutputTool", "BashOutputTool"] and empty it
		ArrayExpression(path) {
			const parent = path.parentPath;
			if (!parent?.isObjectProperty()) return;
			const key = parent.node.key;
			const keyName = t.isIdentifier(key)
				? key.name
				: t.isStringLiteral(key)
					? key.value
					: null;
			if (keyName !== "aliases") return;

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
			const hasTaskId = props.some((p) => hasObjectPropertyKey(p, "task_id"));
			const hasOutput = props.some((p) => hasObjectPropertyKey(p, "output"));
			const hasOutputFile = props.some((p) =>
				hasObjectPropertyKey(p, "output_file"),
			);
			const hasOutputFilename = props.some((p) =>
				hasObjectPropertyKey(p, "output_filename"),
			);

			if (!hasTaskId || !hasOutput) return;
			if (hasOutputFile && hasOutputFilename) return;

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

			if (!hasOutputFile) {
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
			}

			if (!hasOutputFilename) {
				const outputFileExpr = t.memberExpression(
					t.identifier(taskParam),
					t.identifier("outputFile"),
				);
				props.push(
					t.objectProperty(
						t.identifier("output_filename"),
						buildBasenameExpr(outputFileExpr),
					),
				);
				addedOutputFilename = true;
			}
		},

		// 4. Add <output_file> tag after <status> push
		// Find mapToolResultToToolResultBlockParam and patch its task XML payload shape.
		// COUPLED: bash-output-tail also patches mapToolResultToToolResultBlockParam
		// but targets the Bash tool (ObjectPattern first param with `stdout`).
		// This visitor targets TaskOutput (plain Identifier first param).
		ObjectMethod(path) {
			if (!isTaskMapMethod(path.node)) return;

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

			const hasOutputFilePush = nodeContainsText(
				path.node.body,
				"<output_file>",
			);
			const hasOutputFilenamePush = nodeContainsText(
				path.node.body,
				"<output_filename>",
			);
			if (!hasOutputFilePush || !hasOutputFilenamePush) {
				for (const stmt of path.node.body.body) {
					if (!t.isIfStatement(stmt)) continue;
					if (!t.isBlockStatement(stmt.consequent)) continue;

					const block = stmt.consequent;
					const isTaskPayloadBlock =
						nodeContainsText(block, "<task_id>") &&
						nodeContainsText(block, "<status>");
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

					const outputFilenameExpr = t.logicalExpression(
						"||",
						t.memberExpression(
							t.memberExpression(t.identifier(resultVar), t.identifier("task")),
							t.identifier("output_filename"),
						),
						buildBasenameExpr(outputFileExpr),
					);

					const pushOutputFilenameStmt = t.ifStatement(
						t.cloneNode(outputFilenameExpr),
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

					// Place output metadata near other task metadata (before error if present).
					const errorIdx = block.body.findIndex((s) =>
						nodeContainsTaskErrorRef(s, resultVar),
					);
					const insertIdx = errorIdx >= 0 ? errorIdx : block.body.length;
					if (!hasOutputFilePush) {
						block.body.splice(insertIdx, 0, pushOutputFileStmt);
						addedOutputFileTag = true;
					}
					if (!hasOutputFilenamePush) {
						const filenameInsertIdx = insertIdx + (hasOutputFilePush ? 0 : 1);
						block.body.splice(filenameInsertIdx, 0, pushOutputFilenameStmt);
						addedOutputFilenameTag = true;
					}

					break;
				}
			}
		},

		// 5. Replace inline <output> payload with compact summary/tool metadata
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
			if (!isMemberPropertyName(memberCallee, "trim")) return;

			// Check for A.task.output (optional or non-optional member access)
			const obj = memberCallee.object;
			if (!t.isMemberExpression(obj) && !t.isOptionalMemberExpression(obj))
				return;

			const outputProp = t.isIdentifier(obj.property)
				? obj.property.name
				: null;
			if (outputProp !== "output") return;

			// Check consequent has push with <output> and capture target array variable.
			const consequent = path.node.consequent;
			let pushTargetArray: t.Identifier | null = null;
			const hasOutputPush = (() => {
				const isOutputPushCall = (node: t.Node): boolean => {
					if (!t.isCallExpression(node)) return false;
					if (!t.isMemberExpression(node.callee)) return false;
					if (!isMemberPropertyName(node.callee, "push")) return false;
					if (t.isIdentifier(node.callee.object)) {
						pushTargetArray = node.callee.object;
					}
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
			if (!pushTargetArray) return;

			const rawSummaryId = path.scope.generateUidIdentifier("rawSummary");
			const summaryTruncatedId =
				path.scope.generateUidIdentifier("summaryTruncated");
			const displaySummaryId =
				path.scope.generateUidIdentifier("displaySummary");
			const toolScanId = path.scope.generateUidIdentifier("toolScan");
			const toolMatchesId = path.scope.generateUidIdentifier("toolMatches");
			const toolsId = path.scope.generateUidIdentifier("tools");
			const matchId = path.scope.generateUidIdentifier("match");

			const newConsequentStmts = template.default.statements(`
					const RAW = TRIM_EXPR;
					const IS_TRUNCATED = RAW.length > 4000;
					const DISPLAY = IS_TRUNCATED
						? RAW.slice(0, 2500) + "\\n...[middle truncated]...\\n" + RAW.slice(-1400)
						: RAW;
					ARRAY.push(\`<summary>\${DISPLAY}</summary>\`);
					ARRAY.push(\`<summary_chars>\${RAW.length}</summary_chars>\`);
					ARRAY.push(\`<summary_truncated>\${IS_TRUNCATED ? "true" : "false"}</summary_truncated>\`);
					const SCAN = RAW.length > 80000 ? RAW.slice(-80000) : RAW;
					const MATCHES = Array.from(SCAN.matchAll(/"(?:name|tool_name|tool)"\\s*:\\s*"([^"]+)"/g), MATCH_FN => MATCH_FN[1]);
					const TOOLS = Array.from(new Set(MATCHES)).slice(0, 20);
					if (TOOLS.length) ARRAY.push(\`<tools>\${TOOLS.join(", ")}</tools>\`);
				`)({
				RAW: rawSummaryId,
				IS_TRUNCATED: summaryTruncatedId,
				DISPLAY: displaySummaryId,
				ARRAY: t.cloneNode(pushTargetArray),
				TRIM_EXPR: t.cloneNode(test as t.Expression),
				SCAN: toolScanId,
				MATCHES: toolMatchesId,
				TOOLS: toolsId,
				MATCH_FN: matchId,
			});

			path.node.consequent = t.blockStatement(newConsequentStmts);
			replacedOutputPush = true;
		},
	};
}

export const taskOutputTool: Patch = {
	tag: "taskout-ext",

	astPasses: () => [{ pass: "mutate", visitor: createTaskOutputToolMutator() }],

	// String patch for prompt text updates (cleaner than AST for template literals)
	string: (code) => {
		let result = code;

		// Update userFacingName
		result = result.replace(
			/return\s+["']Task Output["']/,
			'return "Task Status"',
		);

		// Update description
		result = result.replace(
			/return\s+["']Retrieves output from a running or completed task["']/,
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
- Returns: status (running/completed/failed), exit_code, error, summary, summary_chars, summary_truncated, tools, output_file, output_filename
- summary is preview-only, not full raw output
- Use block=true (default) to wait for completion
- Use block=false for non-blocking status check
- Task IDs can be found using the /tasks command
- To read output, use: Read tool with the output_file path
- For large files, start with range: "-500:" for recent tail, then read full output in chunks (e.g. "1:2000", "2001:4000")
- Use output_filename for display/log labels; always use output_file as the Read input path\``;

		result = result.replace(oldPrompt, newPrompt);
		if (!result.includes("summary is preview-only, not full raw output")) {
			result = result.replace(
				/`- Retrieves output from a running or completed task[\s\S]*?- Works with all task types: background shells, async agents, and remote sessions`/,
				newPrompt,
			);
		}

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

	verify: (_code, ast) => {
		if (!ast) return "Missing AST for taskout-ext verification";

		let taskSerializerFound = false;
		let hasOutputFileField = false;
		let hasOutputFilenameField = false;
		traverse.default(ast, {
			ObjectExpression(path) {
				if (!isTaskSerializerObject(path.node)) return;
				taskSerializerFound = true;
				if (
					path.node.properties.some((prop) =>
						hasObjectPropertyKey(prop, "output_file"),
					)
				) {
					hasOutputFileField = true;
				}
				if (
					path.node.properties.some((prop) =>
						hasObjectPropertyKey(prop, "output_filename"),
					)
				) {
					hasOutputFilenameField = true;
				}
			},
		});

		if (!astHasStringLiteralValue(ast, "TaskStatus")) {
			return "TaskOutput not renamed to TaskStatus";
		}
		if (!taskSerializerFound) {
			return "Task serializer object not found";
		}
		if (!hasOutputFileField) {
			return "Missing output_file in TaskStatus response";
		}
		if (!hasOutputFilenameField) {
			return "Missing output_filename in TaskStatus response";
		}
		if (!astHasLiteralFragment(ast, "<output_file>")) {
			return "Missing <output_file> tag in TaskStatus output payload";
		}
		if (!astHasLiteralFragment(ast, "<output_filename>")) {
			return "Missing <output_filename> tag in TaskStatus output payload";
		}
		if (!astHasLiteralFragment(ast, "<summary>")) {
			return "Missing <summary> tag in TaskStatus output payload";
		}
		if (!astHasLiteralFragment(ast, "<summary_chars>")) {
			return "Missing <summary_chars> tag in TaskStatus output payload";
		}
		if (!astHasLiteralFragment(ast, "<summary_truncated>")) {
			return "Missing <summary_truncated> tag in TaskStatus output payload";
		}
		if (!astHasLiteralFragment(ast, "<tools>")) {
			return "Missing <tools> tag in TaskStatus output payload";
		}
		if (!astHasLiteralFragment(ast, "summary is preview-only")) {
			return "Missing summary preview-only guidance";
		}
		if (
			!astHasLiteralFragment(ast, "Use output_filename for display/log labels")
		) {
			return "Missing output_filename guidance in TaskStatus prompt";
		}
		if (!astHasLiteralFragment(ast, "[middle truncated]")) {
			return "Missing head+tail summary truncation marker";
		}
		if (astHasLegacyOutputPushTemplate(ast)) {
			return "TaskStatus output payload still includes inline <output> template block";
		}
		if (
			astHasLiteralFragment(
				ast,
				"agentId from sync agents is for 'resume' parameter only",
			)
		) {
			return "Unexpected global task-not-found hint leaked into unrelated tools";
		}
		if (astHasLegacyTaskOutputAliasPair(ast)) {
			return "Old aliases AgentOutputTool/BashOutputTool still present in aliases array";
		}
		if (astHasLiteralFragment(ast, "Use TaskOutput to read the output later")) {
			return "Legacy TaskOutput prompt guidance still present";
		}
		if (
			astHasLiteralFragment(
				ast,
				"You can check its output using the TaskOutput tool",
			)
		) {
			return "Legacy TaskOutput tool reference still present";
		}
		return true;
	},
};
