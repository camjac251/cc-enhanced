import * as t from "@babel/types";
import { template, traverse, type Visitor } from "../babel.js";
import type { Patch } from "../types.js";
import {
	getObjectKeyName,
	getVerifyAst,
	hasObjectKeyName,
	isMemberPropertyName,
	objectPatternHasKey,
} from "./ast-helpers.js";
import { MODERN_OUTPUT_LIMIT_WARNING } from "./prompt-policy.js";

/**
 * Add output_tail and max_output options to Bash tool.
 *
 * Stock behavior: truncation is head-first only (first 30K chars).
 * Build errors, test failures, and other end-of-output content is lost.
 * Persistence saves to disk with a 2K head-only preview.
 *
 * This patch adds:
 * - output_tail: boolean - keep LAST N chars instead of first
 * - max_output: number - override inline threshold (up to 500K)
 *
 * Uses globalThis.__bashTailOpts to bridge Bash tool call() params to the
 * truncation function, since threading through minified call chains is fragile.
 * Safe because Bash calls are serialized (one at a time in main flow).
 */

const PROMPT_ADDITION = `\
  - **Disk persistence**: Outputs over 30KB are saved to disk and you'll receive a file path instead. You'll need to read that file separately (e.g., \`bat /path/to/output.txt\`). To avoid this extra step, use \`max_output\` proactively.
  - Use \`max_output: N\` to keep outputs inline up to N characters, preventing disk saves. Set 100000-500000 for commands you expect to have large output (bat, git diff, git log, build output you want to analyze). This avoids the round-trip of reading a saved file.
  - Use \`output_tail: true\` when the useful part is usually near the end: package manager builds, compiler/test output, Docker builds, and log reads. If output is truncated, the kept inline text comes from the final N characters.
  - For slow builds or tests, pair \`run_in_background: true\` with \`output_tail: true\` so later checks show final diagnostics.
  - **IMPORTANT**: Do not add shell pipeline truncation just to shorten output. Use \`max_output: N\`, \`output_tail: true\`, \`rg -m N\` for non-code text, \`fd --max-results N\`, or \`bat -r START:END\` instead. For eza directory listings, use Bash max_output or switch to fd --max-results when you need bounded filenames. Never add a head or tail pipeline as an output cap. Never pipe listing output through head or tail.`;

const LEGACY_TOKEN_WARNING_RE =
	/Pipe output through head, tail, or grep to reduce result size\. Avoid cat on large files (?:—|\\u2014) use Read with offset\/limit instead\./g;

const LEGACY_POWERSHELL_TOKEN_WARNING_RE =
	/Pipe output through Select-Object -First\/-Last or Select-String to reduce result size\. Avoid Get-Content on large files (?:—|\\u2014) use Read with offset\/limit instead\./g;

// --- Helpers ---

function hasCopyableOutputCapPipeText(value: string, command: "head" | "tail") {
	return (
		value.includes(`\`| ${command}`) ||
		new RegExp(`(^|[^\\w-])\\|\\s*${command}\\s+-\\d`).test(value)
	);
}

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

function buildZodProperty(
	key: string,
	type: "boolean" | "number",
	description: string,
	zodVar: string,
): t.ObjectProperty {
	return t.objectProperty(
		t.identifier(key),
		template.expression(`ZOD.TYPE().optional().describe(DESC)`)({
			ZOD: t.identifier(zodVar),
			TYPE: t.identifier(type),
			DESC: t.stringLiteral(description),
		}),
	);
}

function buildConditionalProperty(key: string, inputVar: string): t.Expression {
	return t.conditionalExpression(
		t.binaryExpression("in", t.stringLiteral(key), t.identifier(inputVar)),
		t.memberExpression(t.identifier(inputVar), t.identifier(key)),
		t.unaryExpression("void", t.numericLiteral(0)),
	);
}

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

function getBashRenderInputName(node: t.FunctionDeclaration): string | null {
	if (node.params.length !== 2) return null;
	const firstParam = node.params[0];
	const secondParam = node.params[1];
	if (!t.isIdentifier(firstParam)) return null;
	if (!t.isObjectPattern(secondParam)) return null;
	if (!objectPatternHasKey(secondParam, "verbose")) return null;
	if (!objectPatternHasKey(secondParam, "theme")) return null;

	let destructuresCommand = false;
	for (const stmt of node.body.body) {
		if (!t.isVariableDeclaration(stmt)) continue;
		for (const decl of stmt.declarations) {
			if (!t.isObjectPattern(decl.id)) continue;
			if (!t.isIdentifier(decl.init, { name: firstParam.name })) continue;
			if (objectPatternHasKey(decl.id, "command")) {
				destructuresCommand = true;
				break;
			}
		}
		if (destructuresCommand) break;
	}

	if (!destructuresCommand) return null;
	if (!nodeContainsPropertyName(node.body, "filePath")) return null;

	return firstParam.name;
}

function functionBodyHasDeclaration(
	node: t.FunctionDeclaration,
	name: string,
): boolean {
	return node.body.body.some(
		(stmt) =>
			t.isFunctionDeclaration(stmt) && t.isIdentifier(stmt.id, { name }),
	);
}

function returnCallsHelper(
	ret: t.ReturnStatement,
	helperName: string,
): boolean {
	return (
		t.isCallExpression(ret.argument) &&
		t.isIdentifier(ret.argument.callee, { name: helperName })
	);
}

function hasOnlyWrappedTopLevelReturns(path: any, helperName: string): boolean {
	let wrappedReturns = 0;
	let unwrappedReturn = false;

	path.traverse({
		Function(innerPath: any) {
			innerPath.skip();
		},
		ReturnStatement(retPath: any) {
			if (!retPath.node.argument) return;
			if (returnCallsHelper(retPath.node, helperName)) {
				wrappedReturns += 1;
				return;
			}
			unwrappedReturn = true;
		},
	});

	return wrappedReturns > 0 && !unwrappedReturn;
}

function nodeContainsPropertyName(node: t.Node, propertyName: string): boolean {
	const visit = (value: unknown): boolean => {
		if (!value) return false;
		if (Array.isArray(value)) return value.some((item) => visit(item));
		if (typeof value !== "object") return false;
		const maybeNode = value as t.Node;
		if (typeof (maybeNode as { type?: unknown }).type !== "string")
			return false;
		if (
			(t.isMemberExpression(maybeNode) ||
				t.isOptionalMemberExpression(maybeNode)) &&
			isMemberPropertyName(maybeNode, propertyName)
		) {
			return true;
		}
		return Object.values(maybeNode as unknown as Record<string, unknown>).some(
			(child) => visit(child),
		);
	};
	return visit(node);
}

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

function buildTruncationBody(
	paramName: string,
	isImageFn: string,
	thresholdFn: string,
): t.Statement[] {
	const buildStmts = template.statements(`
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

// --- Mutator ---

function createBashOutputTailMutator(): Visitor {
	let persistencePatched = false;
	let truncationPatched = false;
	let previewPatched = false;
	let renderPatched = false;

	return {
		// 1. Add output_tail and max_output to Bash schema
		ObjectProperty(path) {
			if (getObjectKeyName(path.node.key) !== "dangerouslyDisableSandbox")
				return;
			if (!t.isCallExpression(path.node.value)) return;
			const callee = path.node.value.callee;
			if (!t.isMemberExpression(callee)) return;
			if (!isMemberPropertyName(callee, "describe")) return;

			const parent = path.parent;
			if (!t.isObjectExpression(parent)) return;
			if (parent.properties.some((p) => hasObjectKeyName(p, "output_tail")))
				return;

			const zodVar = findZodVariable(path);
			if (!zodVar) return;

			const idx = parent.properties.indexOf(path.node);
			if (idx < 0) return;

			parent.properties.splice(
				idx + 1,
				0,
				buildZodProperty(
					"output_tail",
					"boolean",
					"When output exceeds limit, keep the LAST N characters instead of first. Use for build/test output where errors appear at the end.",
					zodVar,
				),
				buildZodProperty(
					"max_output",
					"number",
					"Override max output characters for this command. Use higher values (500000+) for bat, git diff, or when you need full output. Default uses BASH_MAX_OUTPUT_LENGTH env var.",
					zodVar,
				),
			);
		},

		// 2. Add maxOutput/outputTail to Bash result + 3. Inject global setter
		ReturnStatement(path) {
			const arg = path.node.argument;
			if (!t.isObjectExpression(arg)) return;

			const dataProp = arg.properties.find(
				(p): p is t.ObjectProperty =>
					t.isObjectProperty(p) && getObjectKeyName(p.key) === "data",
			);
			if (!dataProp || !t.isObjectExpression(dataProp.value)) return;

			const dataObj = dataProp.value;
			const hasDangerous = dataObj.properties.some((p) =>
				hasObjectKeyName(p, "dangerouslyDisableSandbox"),
			);
			const hasStdout = dataObj.properties.some((p) =>
				hasObjectKeyName(p, "stdout"),
			);
			if (!hasDangerous || !hasStdout) return;
			if (dataObj.properties.some((p) => hasObjectKeyName(p, "maxOutput")))
				return;

			// Find input variable from conditional pattern
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
			// Inject global setter at start of enclosing call()
			const funcPath = path.getFunctionParent();
			if (!funcPath) return;
			const funcBody = funcPath.node.body;
			if (!t.isBlockStatement(funcBody)) return;

			const firstStmt = funcBody.body[0];
			if (
				t.isExpressionStatement(firstStmt) &&
				t.isAssignmentExpression(firstStmt.expression) &&
				t.isMemberExpression(firstStmt.expression.left) &&
				isMemberPropertyName(firstStmt.expression.left, "__bashTailOpts")
			) {
				return;
			}

			const callParam = funcPath.node.params[0];
			if (!t.isIdentifier(callParam)) return;

			const globalSetter = template.statement(`
				globalThis.__bashTailOpts = {
					outputTail: "output_tail" in INPUT ? INPUT.output_tail : void 0,
					maxOutput: "max_output" in INPUT ? INPUT.max_output : void 0,
				};
			`)({ INPUT: t.identifier(callParam.name) });

			funcBody.body.unshift(globalSetter);
		},

		// 4. Persistence threshold override + 5. Truncation function replacement
		Function(path) {
			if (!t.isBlockStatement(path.node.body)) return;
			const bodyBlock = path.node.body;

			// 4. Persistence: async 3-param function with mapToolResultToToolResultBlockParam call
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
						firstStmt.declarations.length === 1 &&
						t.isCallExpression(firstStmt.declarations[0].init) &&
						t.isMemberExpression(firstStmt.declarations[0].init.callee) &&
						isMemberPropertyName(
							firstStmt.declarations[0].init.callee,
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
											returnCall.arguments[2] = t.conditionalExpression(
												t.binaryExpression(
													">",
													t.optionalMemberExpression(
														t.memberExpression(
															t.identifier(resultVar.name),
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
														t.identifier(resultVar.name),
														t.identifier("data"),
													),
													t.identifier("maxOutput"),
												),
												t.cloneNode(thresholdArg),
											);
											persistencePatched = true;
										}
									}
								}
							}
						}
					}
				}
			}

			// 5. Truncation function body replacement
			if (truncationPatched) return;
			const node = path.node;
			if (node.params.length !== 1) return;
			if (!t.isIdentifier(node.params[0])) return;
			if (node.async || node.generator) return;

			const body = bodyBlock.body;
			if (body.length < 4) return;

			const paramName = node.params[0].name;
			const thresholdFn = findThresholdCallName(body);
			if (!thresholdFn) return;
			if (!hasReturnWithTruncatedContent(body)) return;
			const isImageFn = findIsImageCallName(body, paramName);
			if (!isImageFn) return;

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

			bodyBlock.body = buildTruncationBody(paramName, isImageFn, thresholdFn);
			truncationPatched = true;
		},

		// 6. Destructuring + 7. Preview fix
		ObjectMethod(path) {
			if (
				getObjectKeyName(path.node.key) !==
				"mapToolResultToToolResultBlockParam"
			)
				return;

			const firstParam = path.node.params[0];
			if (!t.isObjectPattern(firstParam)) return;
			if (!firstParam.properties.some((p) => hasObjectKeyName(p, "stdout")))
				return;
			if (objectPatternHasKey(firstParam, "outputTail")) return;

			firstParam.properties.push(
				t.objectProperty(
					t.identifier("outputTail"),
					t.identifier("outputTail"),
					false,
					true,
				),
			);
			// Fix persistence preview for tail mode
			path.traverse({
				VariableDeclarator(declPath: any) {
					if (previewPatched) return;
					const init = declPath.node.init;
					const declaredId = declPath.node.id;
					if (!t.isIdentifier(declaredId)) return;
					if (!t.isCallExpression(init)) return;
					if (!t.isIdentifier(init.callee)) return;
					if (init.arguments.length !== 2) return;

					const stdoutArg = init.arguments[0];
					const thresholdArg = init.arguments[1];
					if (!t.isIdentifier(stdoutArg) || !t.isIdentifier(thresholdArg))
						return;

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

					declPath.node.init = t.conditionalExpression(
						t.identifier("outputTail"),
						t.objectExpression([
							t.objectProperty(
								t.identifier("preview"),
								t.callExpression(
									t.memberExpression(
										t.identifier(stdoutArg.name),
										t.identifier("slice"),
									),
									[t.unaryExpression("-", t.identifier(thresholdArg.name))],
								),
							),
							t.objectProperty(
								t.identifier("hasMore"),
								t.binaryExpression(
									">",
									t.memberExpression(
										t.identifier(stdoutArg.name),
										t.identifier("length"),
									),
									t.identifier(thresholdArg.name),
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

		// 8. renderToolUseMessage: append patched opts to the displayed label so
		// run_in_background / output_tail / max_output surface in the tool chip.
		FunctionDeclaration(path) {
			if (renderPatched) return;
			const node = path.node;
			const inputName = getBashRenderInputName(node);
			if (!inputName) return;

			path.traverse({
				Function(innerPath) {
					innerPath.skip();
				},
				ReturnStatement(retPath) {
					if (!retPath.node.argument) return;
					const arg = retPath.node.argument;
					if (
						t.isCallExpression(arg) &&
						t.isIdentifier(arg.callee, { name: "_bashAppendOpts" })
					)
						return;
					retPath.node.argument = t.callExpression(
						t.identifier("_bashAppendOpts"),
						[arg],
					);
				},
			});

			const injected = template.statements(`
				var _bashOptsRaw = INPUT ? [
					INPUT.run_in_background ? "background" : null,
					INPUT.output_tail ? "tail" : null,
					(typeof INPUT.max_output === "number" && INPUT.max_output > 0)
						? "max_output: " + INPUT.max_output
						: null,
				].filter(function (v) { return v != null; }) : [];
				var _bashOptsSuffix = _bashOptsRaw.length > 0
					? " · " + _bashOptsRaw.join(", ")
					: "";
				function _bashAppendOpts(_bashResult) {
					if (!_bashOptsSuffix || _bashResult == null) return _bashResult;
					if (typeof _bashResult === "string") return _bashResult + _bashOptsSuffix;
					if (_bashResult && typeof _bashResult === "object" && _bashResult.props) {
						var _bashChildren = _bashResult.props.children;
						var _bashArr = _bashChildren == null
							? []
							: (Array.isArray(_bashChildren) ? _bashChildren.slice() : [_bashChildren]);
						_bashArr.push(_bashOptsSuffix);
						return Object.assign({}, _bashResult, {
							props: Object.assign({}, _bashResult.props, { children: _bashArr }),
						});
					}
					return _bashResult;
				}
			`)({ INPUT: t.identifier(inputName) });

			node.body.body.unshift(...injected);
			renderPatched = true;
		},
	};
}

// --- Patch ---

export const bashOutputTail: Patch = {
	tag: "bash-tail",

	string: (code) => {
		code = code
			.replace(LEGACY_TOKEN_WARNING_RE, MODERN_OUTPUT_LIMIT_WARNING)
			.replace(LEGACY_POWERSHELL_TOKEN_WARNING_RE, MODERN_OUTPUT_LIMIT_WARNING);

		// Insert disk persistence / output_tail guidance into the Bash prompt.
		// The current prompt builder emits an array of strings (one per bullet).
		// Inject new items before "When issuing multiple commands:".
		const arrayAnchor = '"When issuing multiple commands:"';
		if (
			code.includes("Executes a given bash command") &&
			code.includes(arrayAnchor)
		) {
			// Current array-builder format: inject as separate array elements
			const items = PROMPT_ADDITION.split("\n")
				.map((line) => line.replace(/^\s+-\s*/, "").trim())
				.filter((line) => line.length > 0);
			const escaped = items
				.map((item) => {
					const jsStr = item.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
					return `"${jsStr}"`;
				})
				.join(",\n      ");
			return code.replace(arrayAnchor, `${escaped},\n      ${arrayAnchor}`);
		}
		return code;
	},

	astPasses: () => [{ pass: "mutate", visitor: createBashOutputTailMutator() }],

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) return "Unable to parse AST for bash-tail verification";

		let foundBashSchema = false;
		let schemaHasOutputTail = false;
		let schemaHasMaxOutput = false;
		let resultHasMaxOutput = false;
		let resultHasOutputTail = false;
		let hasGlobalSetter = false;
		let hasTruncationBridge = false;
		let hasTailSlice = false;
		let hasDestructuringOutputTail = false;
		let hasPersistenceMaxOutput = false;
		let hasRenderOptsFunction = false;
		let hasRenderOptsHelper = false;
		let hasRenderOptsWrappedReturns = false;
		let hasCopyablePipeHeadText = false;
		let hasCopyablePipeTailText = false;

		traverse(verifyAst, {
			StringLiteral(path) {
				const value = path.node.value;
				if (hasCopyableOutputCapPipeText(value, "head")) {
					hasCopyablePipeHeadText = true;
				}
				if (hasCopyableOutputCapPipeText(value, "tail")) {
					hasCopyablePipeTailText = true;
				}
			},

			TemplateElement(path) {
				const value = path.node.value.cooked ?? path.node.value.raw;
				if (hasCopyableOutputCapPipeText(value, "head")) {
					hasCopyablePipeHeadText = true;
				}
				if (hasCopyableOutputCapPipeText(value, "tail")) {
					hasCopyablePipeTailText = true;
				}
			},

			// Schema check
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
				)
					return;
				foundBashSchema = true;
				if (keyNames.has("output_tail")) schemaHasOutputTail = true;
				if (keyNames.has("max_output")) schemaHasMaxOutput = true;
			},

			// Result data check
			ReturnStatement(path) {
				const arg = path.node.argument;
				if (!t.isObjectExpression(arg)) return;
				const dataProp = arg.properties.find(
					(p): p is t.ObjectProperty =>
						t.isObjectProperty(p) && getObjectKeyName(p.key) === "data",
				);
				if (!dataProp || !t.isObjectExpression(dataProp.value)) return;
				const dataObj = dataProp.value;
				const hasStdout = dataObj.properties.some((p) =>
					hasObjectKeyName(p, "stdout"),
				);
				const hasDangerous = dataObj.properties.some((p) =>
					hasObjectKeyName(p, "dangerouslyDisableSandbox"),
				);
				if (!hasStdout || !hasDangerous) return;
				for (const prop of dataObj.properties) {
					if (!t.isObjectProperty(prop)) continue;
					const keyName = getObjectKeyName(prop.key);
					if (keyName === "maxOutput") resultHasMaxOutput = true;
					if (keyName === "outputTail") resultHasOutputTail = true;
				}
			},

			// Global setter check
			AssignmentExpression(path) {
				const left = path.node.left;
				if (!t.isMemberExpression(left)) return;
				if (
					t.isIdentifier(left.object, { name: "globalThis" }) &&
					isMemberPropertyName(left, "__bashTailOpts") &&
					t.isObjectExpression(path.node.right)
				) {
					hasGlobalSetter = true;
				}
			},

			// Truncation bridge consumer check
			MemberExpression(path) {
				if (
					t.isIdentifier(path.node.object, { name: "globalThis" }) &&
					isMemberPropertyName(path.node, "__bashTailOpts")
				) {
					const parent = path.parentPath;
					if (
						parent &&
						!(parent.isAssignmentExpression() && parent.node.left === path.node)
					) {
						hasTruncationBridge = true;
					}
				}
			},

			// Tail slice check
			CallExpression(path) {
				const callee = path.node.callee;
				if (
					t.isMemberExpression(callee) &&
					isMemberPropertyName(callee, "slice") &&
					path.node.arguments.length === 1 &&
					t.isUnaryExpression(path.node.arguments[0], { operator: "-" })
				) {
					hasTailSlice = true;
				}
			},

			// Destructuring check
			ObjectMethod(path) {
				if (
					getObjectKeyName(path.node.key) !==
					"mapToolResultToToolResultBlockParam"
				)
					return;
				const firstParam = path.node.params[0];
				if (!t.isObjectPattern(firstParam)) return;
				if (!firstParam.properties.some((p) => hasObjectKeyName(p, "stdout")))
					return;
				if (objectPatternHasKey(firstParam, "outputTail"))
					hasDestructuringOutputTail = true;
			},

			// Persistence maxOutput conditional check
			ConditionalExpression(path) {
				const test = path.node.test;
				if (!t.isBinaryExpression(test, { operator: ">" })) return;
				const left = test.left;
				if (
					(t.isOptionalMemberExpression(left) &&
						isMemberPropertyName(left, "maxOutput")) ||
					(t.isMemberExpression(left) &&
						isMemberPropertyName(left, "maxOutput"))
				) {
					hasPersistenceMaxOutput = true;
				}
			},

			// renderToolUseMessage opts suffix: verify the Bash renderer itself.
			FunctionDeclaration(path) {
				if (!getBashRenderInputName(path.node)) return;
				hasRenderOptsFunction = true;
				if (functionBodyHasDeclaration(path.node, "_bashAppendOpts")) {
					hasRenderOptsHelper = true;
				}
				if (hasOnlyWrappedTopLevelReturns(path, "_bashAppendOpts")) {
					hasRenderOptsWrappedReturns = true;
				}
			},
		});

		if (!foundBashSchema) return "Bash input schema not found";
		if (!schemaHasOutputTail) return "Missing output_tail in Bash schema";
		if (!schemaHasMaxOutput) return "Missing max_output in Bash schema";
		if (!resultHasMaxOutput) return "Missing maxOutput in Bash result data";
		if (!resultHasOutputTail) return "Missing outputTail in Bash result data";
		if (!hasGlobalSetter) return "Missing __bashTailOpts setter";
		if (!hasTruncationBridge) return "Missing __bashTailOpts consumer";
		if (!hasTailSlice) return "Missing tail slice(-) in truncation";
		if (!hasDestructuringOutputTail)
			return "Missing outputTail in mapToolResult destructuring";
		if (!hasPersistenceMaxOutput)
			return "Missing maxOutput conditional in persistence";
		if (!hasRenderOptsFunction)
			return "Missing Bash renderToolUseMessage current-shape function";
		if (!hasRenderOptsHelper)
			return "Missing _bashAppendOpts helper in renderToolUseMessage";
		if (!hasRenderOptsWrappedReturns)
			return "Bash renderToolUseMessage returns are not all wrapped with _bashAppendOpts";
		// Prompt checks
		if (!code.includes("Disk persistence"))
			return "Missing disk persistence guidance in prompt";
		if (
			!code.includes("compiler/test output") ||
			!code.includes("final diagnostics")
		)
			return "Missing output_tail guidance in prompt";
		if (!code.includes("preventing disk saves"))
			return "Missing max_output guidance in prompt";
		if (
			!code.includes(
				"Do not add shell pipeline truncation just to shorten output",
			)
		)
			return "Missing shell pipeline truncation prohibition in prompt";
		if (!code.includes("Never add a head or tail pipeline as an output cap")) {
			return "Missing explicit head/tail pipeline prohibition in prompt";
		}
		if (!code.includes("Never pipe listing output through head or tail")) {
			return "Missing directory-listing head/tail pipeline prohibition in prompt";
		}
		if (hasCopyablePipeHeadText) {
			return "Prompt still contains copyable pipe-head syntax";
		}
		if (hasCopyablePipeTailText) {
			return "Prompt still contains copyable pipe-tail syntax";
		}
		if (code.includes("Pipe output through head, tail, or grep")) {
			return "Legacy oversized-output warning still recommends head/tail/grep";
		}
		if (code.includes("Pipe output through Select-Object -First/-Last")) {
			return "Legacy oversized-output warning still recommends PowerShell truncation pipes";
		}
		if (!code.includes(MODERN_OUTPUT_LIMIT_WARNING)) {
			return "Missing modern oversized-output warning guidance";
		}

		return true;
	},
};
