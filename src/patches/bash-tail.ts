import template from "@babel/template";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch } from "../types.js";
import {
	getObjectKeyName,
	getVerifyAst,
	hasObjectKeyName,
	isMemberPropertyName,
	objectPatternHasKey,
} from "./ast-helpers.js";

/**
 * Add output_tail and max_output options to Bash tool.
 *
 * Architecture (2.1.2+):
 * - Bash outputs > 30KB are saved to disk
 * - max_output overrides this threshold to allow larger inline outputs
 * - output_tail truncates from END instead of beginning
 *
 * All modifications are AST-based for robustness across versions.
 *
 * Implementation uses globalThis.__bashTailOpts to bridge the Bash tool's
 * input params to the truncation function (FvI), since threading params
 * through minified call chains is fragile. This is safe because:
 * - Bash calls are serialized (one tool call at a time in main flow)
 * - Background tasks run in separate processes (don't share globals)
 * - The global is consumed immediately (set → FvI → cleared)
 */
// Coupling: targets the same Bash tool prompt as bash-prompt.ts but in a
// different section (disk persistence/tail guidance vs CLI tool recommendations).

const PROMPT_ADDITION = `\
  - **Disk persistence**: Outputs over 30KB are saved to disk and you'll receive a file path instead. You'll need to read that file separately (e.g., \`bat /path/to/output.txt\`). To avoid this extra step, use \`max_output\` proactively.
  - Use \`max_output: N\` to keep outputs inline up to N characters, preventing disk saves. Set 100000-500000 for commands you expect to have large output (bat, git diff, git log, build output you want to analyze). This avoids the round-trip of reading a saved file.
  - Use \`output_tail: true\` for commands where errors/results appear at the end: build commands (npm/pnpm/yarn build, cargo build, make, go build), test runners (pytest, jest, vitest, cargo test, go test), Docker builds, and log viewing. When truncation occurs, keeps the LAST N characters instead of first.
  - For long builds/tests, combine \`run_in_background: true\` with \`output_tail: true\` to get the final errors when checking results later.`;

// Helper to find the Zod variable (h, u, or U) used in schemas
function findZodVariable(path: any): string | null {
	let zodVar: string | null = null;
	path.traverse({
		CallExpression(callPath: any) {
			const callee = callPath.node.callee;
			if (
				t.isMemberExpression(callee) &&
				isMemberPropertyName(callee, "boolean") &&
				t.isIdentifier(callee.object)
			) {
				zodVar = callee.object.name;
				callPath.stop();
			}
		},
	});
	return zodVar;
}

// Build a Zod schema property: VAR.type().optional().describe("...")
function buildZodProperty(
	key: string,
	type: "boolean" | "number",
	description: string,
	zodVar: string,
): t.ObjectProperty {
	return t.objectProperty(
		t.identifier(key),
		template.default.expression(`ZOD.TYPE().optional().describe(DESC)`)({
			ZOD: t.identifier(zodVar),
			TYPE: t.identifier(type),
			DESC: t.stringLiteral(description),
		}),
	);
}

// Build: "key" in A ? A.key : void 0
function buildConditionalProperty(key: string, inputVar: string): t.Expression {
	return t.conditionalExpression(
		t.binaryExpression("in", t.stringLiteral(key), t.identifier(inputVar)),
		t.memberExpression(t.identifier(inputVar), t.identifier(key)),
		t.unaryExpression("void", t.numericLiteral(0)),
	);
}

// objectPatternHasKey moved to ast-helpers.ts

/**
 * Find the name of a 0-arg function call in variable declarations.
 * Matches patterns like: let A = XXH();
 */
function findThresholdCallName(body: t.Statement[]): string | null {
	for (const stmt of body) {
		if (!t.isVariableDeclaration(stmt)) continue;
		for (const decl of stmt.declarations) {
			if (
				t.isCallExpression(decl.init) &&
				t.isIdentifier(decl.init.callee) &&
				decl.init.arguments.length === 0
			) {
				return decl.init.callee.name;
			}
		}
	}
	return null;
}

/**
 * Check if a function body returns an object with a "truncatedContent" property.
 */
function hasReturnWithTruncatedContent(body: t.Statement[]): boolean {
	for (const stmt of body) {
		if (t.isReturnStatement(stmt) && t.isObjectExpression(stmt.argument)) {
			for (const prop of stmt.argument.properties) {
				if (
					t.isObjectProperty(prop) &&
					getObjectKeyName(prop.key) === "truncatedContent"
				) {
					return true;
				}
			}
		}
	}
	return false;
}

/**
 * Find the isImage check function name from the first statement.
 * Pattern: let $ = X6A(H); — a call with 1 arg matching the function param.
 */
function findIsImageCallName(
	body: t.Statement[],
	paramName: string,
): string | null {
	if (body.length === 0) return null;
	const first = body[0];
	if (!t.isVariableDeclaration(first)) return null;
	for (const decl of first.declarations) {
		if (
			t.isCallExpression(decl.init) &&
			t.isIdentifier(decl.init.callee) &&
			decl.init.arguments.length === 1 &&
			t.isIdentifier(decl.init.arguments[0], { name: paramName })
		) {
			return decl.init.callee.name;
		}
	}
	return null;
}

/**
 * Build the replacement body for the truncation function (FvI).
 * Uses @babel/template for readable AST construction with placeholder interpolation.
 */
function buildTruncationBody(
	paramName: string,
	isImageFn: string,
	thresholdFn: string,
): t.Statement[] {
	const buildStmts = template.default.statements(`
		var _opts = globalThis.__bashTailOpts;
		if (_opts) globalThis.__bashTailOpts = null;
		let _img = IS_IMAGE(PARAM);
		if (_img) return { totalLines: 1, truncatedContent: PARAM, isImage: _img };
		let _limit = _opts?.maxOutput > 0
			? Math.min(_opts.maxOutput, 500000)
			: THRESHOLD();
		if (PARAM.length <= _limit)
			return {
				totalLines: PARAM.split('\\n').length,
				truncatedContent: PARAM,
				isImage: _img,
			};
		let _content = _opts?.outputTail
			? PARAM.slice(-_limit)
			: PARAM.slice(0, _limit);
		let _dropped = (_opts?.outputTail
			? PARAM.slice(0, PARAM.length - _limit)
			: PARAM.slice(_limit)
		).split('\\n').length;
		let _msg = _opts?.outputTail
			? '... [' + _dropped + ' lines truncated] ...\\n\\n' + _content
			: _content + '\\n\\n... [' + _dropped + ' lines truncated] ...';
		return {
			totalLines: PARAM.split('\\n').length,
			truncatedContent: _msg,
			isImage: _img,
		};
	`);
	return buildStmts({
		PARAM: t.identifier(paramName),
		IS_IMAGE: t.identifier(isImageFn),
		THRESHOLD: t.identifier(thresholdFn),
	});
}

function createBashOutputTailMutator(): traverse.Visitor {
	let schemaPatched = false;
	let resultPatched = false;
	let persistencePatched = false;
	let destructuringPatched = false;
	let truncationPatched = false;
	let globalSetterPatched = false;
	let previewPatched = false;

	return {
		// Step 1: Add output_tail and max_output to Bash schema
		// Find: dangerouslyDisableSandbox property in Zod schema, insert after it
		ObjectProperty(path) {
			if (getObjectKeyName(path.node.key) !== "dangerouslyDisableSandbox") {
				return;
			}

			// Verify this is a Zod schema (has .boolean().optional().describe() chain)
			if (!t.isCallExpression(path.node.value)) return;
			const callee = path.node.value.callee;
			if (!t.isMemberExpression(callee)) return;
			if (!isMemberPropertyName(callee, "describe")) return;

			// Check if already patched
			const parent = path.parent;
			if (!t.isObjectExpression(parent)) return;
			const hasOutputTail = parent.properties.some((p) =>
				hasObjectKeyName(p, "output_tail"),
			);
			if (hasOutputTail) return;

			// Find Zod variable — bail if unresolvable
			const zodVar = findZodVariable(path);
			if (!zodVar) {
				console.warn("Bash output tail: Could not resolve Zod variable name");
				return;
			}

			// Find index of dangerouslyDisableSandbox
			const idx = parent.properties.indexOf(path.node);
			if (idx < 0) return;

			// Insert output_tail and max_output after dangerouslyDisableSandbox
			const outputTailProp = buildZodProperty(
				"output_tail",
				"boolean",
				"When output exceeds limit, keep the LAST N characters instead of first. Use for build/test output where errors appear at the end.",
				zodVar,
			);
			const maxOutputProp = buildZodProperty(
				"max_output",
				"number",
				"Override max output characters for this command. Use higher values (500000+) for bat, git diff, or when you need full output. Default uses BASH_MAX_OUTPUT_LENGTH env var.",
				zodVar,
			);

			parent.properties.splice(idx + 1, 0, outputTailProp, maxOutputProp);
			schemaPatched = true;
		},

		// Step 2: Add maxOutput/outputTail to Bash result + inject global setter in call()
		// Find: return { data: { ..., dangerouslyDisableSandbox: "..." in A ? ... } }
		ReturnStatement(path) {
			const arg = path.node.argument;
			if (!t.isObjectExpression(arg)) return;

			// Find data property
			const dataProp = arg.properties.find(
				(p): p is t.ObjectProperty =>
					t.isObjectProperty(p) && getObjectKeyName(p.key) === "data",
			);
			if (!dataProp || !t.isObjectExpression(dataProp.value)) return;

			const dataObj = dataProp.value;

			// Check for dangerouslyDisableSandbox and stdout (confirms this is Bash result)
			const hasDangerous = dataObj.properties.some((p) =>
				hasObjectKeyName(p, "dangerouslyDisableSandbox"),
			);
			const hasStdout = dataObj.properties.some((p) =>
				hasObjectKeyName(p, "stdout"),
			);
			if (!hasDangerous || !hasStdout) return;

			// Check if already patched
			const hasMaxOutput = dataObj.properties.some((p) =>
				hasObjectKeyName(p, "maxOutput"),
			);
			if (hasMaxOutput) return;

			// Find the input variable name from the conditional (usually "A")
			const dangerousProp = dataObj.properties.find(
				(p): p is t.ObjectProperty =>
					t.isObjectProperty(p) &&
					getObjectKeyName(p.key) === "dangerouslyDisableSandbox",
			);
			if (!dangerousProp || !t.isConditionalExpression(dangerousProp.value))
				return;

			const testExpr = dangerousProp.value.test;
			if (!t.isBinaryExpression(testExpr, { operator: "in" })) return;
			if (!t.isIdentifier(testExpr.right)) return;
			const inputVar = testExpr.right.name;

			// Add maxOutput and outputTail properties to result data
			dataObj.properties.push(
				t.objectProperty(
					t.identifier("maxOutput"),
					buildConditionalProperty("max_output", inputVar),
				),
				t.objectProperty(
					t.identifier("outputTail"),
					buildConditionalProperty("output_tail", inputVar),
				),
			);
			resultPatched = true;

			// --- Inject globalThis.__bashTailOpts setter at start of enclosing call method ---
			const funcPath = path.getFunctionParent();
			if (!funcPath) return;
			const funcBody = funcPath.node.body;
			if (!t.isBlockStatement(funcBody)) return;

			// Check if already patched
			const firstStmt = funcBody.body[0];
			if (
				t.isExpressionStatement(firstStmt) &&
				t.isAssignmentExpression(firstStmt.expression) &&
				t.isMemberExpression(firstStmt.expression.left) &&
				isMemberPropertyName(firstStmt.expression.left, "__bashTailOpts")
			) {
				globalSetterPatched = true;
				return;
			}

			// The call method signature is: async call(H, $, A, L, I)
			// H is the input object.
			const callParam = funcPath.node.params[0];
			if (!t.isIdentifier(callParam)) return;
			const callInputVar = callParam.name;

			const globalSetter = template.default.statement(`
					globalThis.__bashTailOpts = {
						outputTail: "output_tail" in INPUT ? INPUT.output_tail : void 0,
						maxOutput: "max_output" in INPUT ? INPUT.max_output : void 0,
					};
				`)({ INPUT: t.identifier(callInputVar) });

			funcBody.body.unshift(globalSetter);
			globalSetterPatched = true;
		},

		// Step 3: Patch persistence function + Step 5: Patch truncation function
		// Both target FunctionDeclaration nodes, combined into one visitor.
		Function(path) {
			if (!t.isBlockStatement(path.node.body)) return;
			const bodyBlock = path.node.body;
			// --- Step 3: Persistence function (maxOutput override for threshold) ---
			if (
				!persistencePatched &&
				path.node.async &&
				path.node.params.length === 3
			) {
				const body = bodyBlock.body;
				if (body.length === 2) {
					const firstStmt = body[0];
					if (
						t.isVariableDeclaration(firstStmt) &&
						firstStmt.declarations.length === 1
					) {
						const decl = firstStmt.declarations[0];
						if (
							t.isCallExpression(decl.init) &&
							t.isMemberExpression(decl.init.callee) &&
							isMemberPropertyName(
								decl.init.callee,
								"mapToolResultToToolResultBlockParam",
							)
						) {
							const secondStmt = body[1];
							if (
								t.isReturnStatement(secondStmt) &&
								t.isCallExpression(secondStmt.argument) &&
								secondStmt.argument.arguments.length === 3
							) {
								const returnCall = secondStmt.argument;
								// Skip if already patched
								if (!t.isConditionalExpression(returnCall.arguments[2])) {
									const thresholdArg = returnCall.arguments[2];
									if (t.isExpression(thresholdArg)) {
										const hasRef = (() => {
											if (
												t.isMemberExpression(thresholdArg) &&
												isMemberPropertyName(thresholdArg, "maxResultSizeChars")
											)
												return true;
											if (t.isCallExpression(thresholdArg)) {
												return thresholdArg.arguments.some(
													(arg) =>
														t.isMemberExpression(arg) &&
														isMemberPropertyName(arg, "maxResultSizeChars"),
												);
											}
											return false;
										})();
										if (hasRef) {
											const resultVar = path.node.params[1];
											if (t.isIdentifier(resultVar)) {
												const rv = resultVar.name;
												returnCall.arguments[2] = t.conditionalExpression(
													t.binaryExpression(
														">",
														t.optionalMemberExpression(
															t.memberExpression(
																t.identifier(rv),
																t.identifier("data"),
															),
															t.identifier("maxOutput"),
															false,
															true,
														),
														t.numericLiteral(0),
													),
													t.memberExpression(
														t.memberExpression(
															t.identifier(rv),
															t.identifier("data"),
														),
														t.identifier("maxOutput"),
													),
													t.cloneNode(thresholdArg),
												);
												persistencePatched = true;
												console.log(
													"Patched persistence function to use maxOutput",
												);
											}
										}
									}
								}
							}
						}
					}
				}
			}

			// --- Step 5: Truncation function (FvI) body replacement ---
			if (truncationPatched) return;
			const node = path.node;
			if (node.params.length !== 1) return;
			if (!t.isIdentifier(node.params[0])) return;
			if (node.async || node.generator) return;

			const body = bodyBlock.body;
			if (body.length < 4) return;

			const paramName = node.params[0].name;

			// Structural anchors:
			// 1. Has a 0-arg call (threshold getter like XXH())
			const thresholdFn = findThresholdCallName(body);
			if (!thresholdFn) return;

			// 2. Has a return with truncatedContent property
			if (!hasReturnWithTruncatedContent(body)) return;

			// 3. Has isImage call as first meaningful statement
			const isImageFn = findIsImageCallName(body, paramName);
			if (!isImageFn) return;

			// 4. Confirm "lines truncated" template literal
			let hasLinesTruncated = false;
			path.traverse({
				TemplateElement(tePath: any) {
					if (tePath.node.value.raw.includes("lines truncated")) {
						hasLinesTruncated = true;
						tePath.stop();
					}
				},
			});
			if (!hasLinesTruncated) return;

			// All checks pass — replace the body
			bodyBlock.body = buildTruncationBody(paramName, isImageFn, thresholdFn);
			truncationPatched = true;
			console.log(
				`Patched truncation function (isImage=${isImageFn}, threshold=${thresholdFn})`,
			);
		},

		// Step 4: Add outputTail to Bash mapToolResultToToolResultBlockParam destructuring
		//         + fix persistence preview for tail mode
		ObjectMethod(path) {
			if (
				getObjectKeyName(path.node.key) !==
				"mapToolResultToToolResultBlockParam"
			)
				return;

			// Get the first param (destructured object)
			const firstParam = path.node.params[0];
			if (!t.isObjectPattern(firstParam)) return;

			// Verify this is Bash by checking for stdout in destructuring
			const hasStdout = firstParam.properties.some((p) =>
				hasObjectKeyName(p, "stdout"),
			);
			if (!hasStdout) return;

			// Check if already patched
			if (objectPatternHasKey(firstParam, "outputTail")) return;

			// Add outputTail to destructuring
			firstParam.properties.push(
				t.objectProperty(
					t.identifier("outputTail"),
					t.identifier("outputTail"),
					false,
					true, // shorthand
				),
			);
			destructuringPatched = true;

			// --- Fix persistence preview for tail mode ---
			// Find the Y6A call inside this method body (persistence preview).
			// Pattern: let X = Y6A(G, j7$);
			// Replace with: let X = outputTail
			//   ? { preview: G.slice(-j7$), hasMore: G.length > j7$ }
			//   : Y6A(G, j7$);
			path.traverse({
				VariableDeclarator(declPath: any) {
					if (previewPatched) return;
					const init = declPath.node.init;
					const declaredId = declPath.node.id;
					if (!t.isIdentifier(declaredId)) return;
					if (!t.isCallExpression(init)) return;
					if (!t.isIdentifier(init.callee)) return;
					if (init.arguments.length !== 2) return;

					// Both args must be identifiers
					const stdoutArg = init.arguments[0];
					const thresholdArg = init.arguments[1];
					if (!t.isIdentifier(stdoutArg)) return;
					if (!t.isIdentifier(thresholdArg)) return;

					const stdoutVar = stdoutArg.name;
					const thresholdVar = thresholdArg.name;
					const binding = declPath.scope.getBinding(declaredId.name);
					if (!binding) return;
					let usedAsPreview = false;
					let usedAsHasMore = false;
					for (const refPath of binding.referencePaths) {
						const parent = refPath.parentPath;
						if (!parent?.isMemberExpression()) continue;
						const member = parent.node;
						if (member.computed || !t.isIdentifier(member.property)) continue;
						if (member.property.name === "preview") usedAsPreview = true;
						if (member.property.name === "hasMore") usedAsHasMore = true;
					}
					if (!usedAsPreview || !usedAsHasMore) return;

					// Replace with conditional: outputTail ? tail-preview : original
					declPath.node.init = t.conditionalExpression(
						t.identifier("outputTail"),
						t.objectExpression([
							t.objectProperty(
								t.identifier("preview"),
								t.callExpression(
									t.memberExpression(
										t.identifier(stdoutVar),
										t.identifier("slice"),
									),
									[t.unaryExpression("-", t.identifier(thresholdVar))],
								),
							),
							t.objectProperty(
								t.identifier("hasMore"),
								t.binaryExpression(
									">",
									t.memberExpression(
										t.identifier(stdoutVar),
										t.identifier("length"),
									),
									t.identifier(thresholdVar),
								),
							),
						]),
						t.cloneNode(init),
					);

					previewPatched = true;
					declPath.stop();
				},
			});
		},

		Program: {
			exit() {
				if (schemaPatched)
					console.log("Added output_tail/max_output to Bash schema");
				if (resultPatched)
					console.log("Added maxOutput/outputTail to Bash result");
				if (persistencePatched) console.log("Patched persistence threshold");
				if (destructuringPatched)
					console.log("Added outputTail to destructuring");
				if (truncationPatched) console.log("Patched truncation function body");
				if (globalSetterPatched)
					console.log("Injected global setter in call method");
				if (previewPatched)
					console.log("Patched persistence preview for tail mode");
			},
		},
	};
}

export const bashOutputTail: Patch = {
	tag: "bash-tail",

	astPasses: () => [{ pass: "mutate", visitor: createBashOutputTailMutator() }],

	// String patch for prompt update — add disk persistence and output_tail guidance
	string: (code) => {
		// Old pattern (pre-2.1.55): truncation text in template literal
		const oldPattern =
			/(If the output exceeds \$\{\w+\(\)\} characters, output will be truncated before being returned to you\.)/;
		if (oldPattern.test(code)) {
			const safeText = PROMPT_ADDITION.replace(/`/g, "\\`");
			return code.replace(oldPattern, `$1\n${safeText}`);
		}

		// New pattern (2.1.55+): array-based instructions, insert before "Write a clear"
		const newAnchor =
			'"Write a clear, concise description of what your command does.';
		if (
			code.includes("Executes a given bash command") &&
			code.includes(newAnchor)
		) {
			const jsStr = PROMPT_ADDITION.replace(/\\/g, "\\\\")
				.replace(/"/g, '\\"')
				.replace(/\n/g, "\\n");
			return code.replace(newAnchor, `"${jsStr}",\n      ${newAnchor}`);
		}

		return code;
	},

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) return "Unable to parse AST for bash-tail verification";

		// --- AST-based structural checks ---

		// 1. Verify Bash input schema has output_tail and max_output properties.
		// Do not rely on `name: "Bash"` because that also matches unrelated
		// syntax-highlighter language objects.
		let foundBashInputSchema = false;
		let schemaHasOutputTail = false;
		let schemaHasMaxOutput = false;
		// 2. Verify Bash result data object has maxOutput and outputTail fields
		let resultHasMaxOutput = false;
		let resultHasOutputTail = false;
		// 3. Verify __bashTailOpts global bridge exists (setter assignment)
		let hasGlobalSetter = false;
		// 4. Verify truncation body has __bashTailOpts consumption and tail-slice logic
		let hasTruncationBridge = false;
		let hasTailSlice = false;
		// 5. Verify outputTail in mapToolResultToToolResultBlockParam destructuring
		let hasDestructuringOutputTail = false;
		// 6. Verify persistence threshold uses maxOutput conditional
		let hasPersistenceMaxOutput = false;

		traverse.default(verifyAst, {
			// Check 1: Bash input schema object.
			// Anchor on schema-shape keys: command + dangerouslyDisableSandbox.
			ObjectExpression(path) {
				const keyNames = new Set<string>();
				for (const prop of path.node.properties) {
					if (!t.isObjectProperty(prop) && !t.isObjectMethod(prop)) continue;
					const keyName = getObjectKeyName(prop.key);
					if (keyName) keyNames.add(keyName);
				}
				if (
					!keyNames.has("command") ||
					!keyNames.has("run_in_background") ||
					!keyNames.has("dangerouslyDisableSandbox")
				) {
					return;
				}
				foundBashInputSchema = true;
				if (keyNames.has("output_tail")) schemaHasOutputTail = true;
				if (keyNames.has("max_output")) schemaHasMaxOutput = true;
			},

			// Check 2: Bash result data -- return { data: { ..., stdout,
			// dangerouslyDisableSandbox, maxOutput, outputTail } }
			ReturnStatement(path) {
				const arg = path.node.argument;
				if (!t.isObjectExpression(arg)) return;
				const dataProp = arg.properties.find(
					(p): p is t.ObjectProperty =>
						t.isObjectProperty(p) && getObjectKeyName(p.key) === "data",
				);
				if (!dataProp || !t.isObjectExpression(dataProp.value)) return;
				const dataObj = dataProp.value;
				const hasStdout = dataObj.properties.some(
					(p) =>
						(t.isObjectProperty(p) || t.isObjectMethod(p)) &&
						getObjectKeyName(p.key) === "stdout",
				);
				const hasDangerous = dataObj.properties.some(
					(p) =>
						(t.isObjectProperty(p) || t.isObjectMethod(p)) &&
						getObjectKeyName(p.key) === "dangerouslyDisableSandbox",
				);
				if (!hasStdout || !hasDangerous) return;
				for (const prop of dataObj.properties) {
					if (!t.isObjectProperty(prop)) continue;
					const keyName = getObjectKeyName(prop.key);
					if (keyName === "maxOutput") resultHasMaxOutput = true;
					if (keyName === "outputTail") resultHasOutputTail = true;
				}
			},

			// Check 3: globalThis.__bashTailOpts = { ... } assignment
			AssignmentExpression(path) {
				const left = path.node.left;
				if (!t.isMemberExpression(left)) return;
				if (
					t.isIdentifier(left.object, { name: "globalThis" }) &&
					isMemberPropertyName(left, "__bashTailOpts")
				) {
					// Verify right-hand side is an object (the setter, not the null clear)
					if (t.isObjectExpression(path.node.right)) {
						hasGlobalSetter = true;
					}
				}
			},

			// Check 4: Truncation body -- look for __bashTailOpts consumption
			// and slice(- tail logic. The patched truncation function reads
			// globalThis.__bashTailOpts and uses .slice(-_limit)
			MemberExpression(path) {
				if (
					t.isIdentifier(path.node.object, { name: "globalThis" }) &&
					isMemberPropertyName(path.node, "__bashTailOpts")
				) {
					// Distinguish from the setter: the setter is an AssignmentExpression LHS,
					// the consumer is a VariableDeclarator init or standalone read
					const parent = path.parentPath;
					if (
						parent &&
						!(parent.isAssignmentExpression() && parent.node.left === path.node)
					) {
						hasTruncationBridge = true;
					}
				}
			},

			// Check 4b: tail-slice -- find .slice(- pattern (unary minus in slice call)
			CallExpression(path) {
				const callee = path.node.callee;
				if (
					t.isMemberExpression(callee) &&
					isMemberPropertyName(callee, "slice") &&
					path.node.arguments.length === 1
				) {
					const arg = path.node.arguments[0];
					if (t.isUnaryExpression(arg, { operator: "-" })) {
						hasTailSlice = true;
					}
				}
			},

			// Check 5: outputTail in mapToolResultToToolResultBlockParam destructuring
			ObjectMethod(path) {
				if (
					getObjectKeyName(path.node.key) !==
					"mapToolResultToToolResultBlockParam"
				)
					return;
				const firstParam = path.node.params[0];
				if (!t.isObjectPattern(firstParam)) return;
				// Verify this is the Bash tool's method by checking for stdout
				const hasStdout = firstParam.properties.some(
					(p) =>
						t.isObjectProperty(p) &&
						(t.isIdentifier(p.key, { name: "stdout" }) ||
							t.isStringLiteral(p.key, { value: "stdout" })),
				);
				if (!hasStdout) return;
				if (objectPatternHasKey(firstParam, "outputTail")) {
					hasDestructuringOutputTail = true;
				}
			},

			// Check 6: Persistence threshold -- conditional using data?.maxOutput
			// Pattern: result.data?.maxOutput > 0 ? result.data.maxOutput : <original>
			ConditionalExpression(path) {
				const test = path.node.test;
				if (!t.isBinaryExpression(test, { operator: ">" })) return;
				const left = test.left;
				// Match data?.maxOutput (optional member) or data.maxOutput
				if (
					(t.isOptionalMemberExpression(left) &&
						isMemberPropertyName(left, "maxOutput")) ||
					(t.isMemberExpression(left) &&
						isMemberPropertyName(left, "maxOutput"))
				) {
					hasPersistenceMaxOutput = true;
				}
			},
		});

		// Report AST verification results
		if (!foundBashInputSchema) {
			return "Bash input schema object not found in AST";
		}
		if (!schemaHasOutputTail) {
			return "Missing output_tail property in Bash tool schema";
		}
		if (!schemaHasMaxOutput) {
			return "Missing max_output property in Bash tool schema";
		}
		if (!resultHasMaxOutput) {
			return "Missing maxOutput field in Bash result data object";
		}
		if (!resultHasOutputTail) {
			return "Missing outputTail field in Bash result data object";
		}
		if (!hasGlobalSetter) {
			return "Missing globalThis.__bashTailOpts setter assignment";
		}
		if (!hasTruncationBridge) {
			return "Missing __bashTailOpts consumption in truncation function";
		}
		if (!hasTailSlice) {
			return "Missing tail slice(-) in truncation function";
		}
		if (!hasDestructuringOutputTail) {
			return "Missing outputTail in mapToolResultToToolResultBlockParam destructuring";
		}
		if (!hasPersistenceMaxOutput) {
			return "Missing maxOutput conditional in persistence threshold";
		}

		// --- String-based checks for prompt content (appropriate per project policy) ---
		if (!code.includes("Disk persistence")) {
			return "Missing disk persistence explanation in prompt";
		}
		if (!code.includes("build commands") || !code.includes("test runners")) {
			return "Missing proactive output_tail guidance in prompt";
		}
		if (!code.includes("preventing disk saves")) {
			return "Missing max_output disk prevention guidance in prompt";
		}
		return true;
	},
};
