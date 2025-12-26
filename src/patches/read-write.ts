import traverse from "@babel/traverse";
import * as t from "@babel/types";
import { parse, print } from "../loader.js";
import type { PatchContext } from "../types.js";

const WRITE_REPLACEMENT =
	"- For existing files, review the current contents before overwriting to avoid accidental loss.";

const TRIGGER_PHRASES = [
	"allows Claude Code to read images",
	"tool first to read the file's contents",
	"readFileState", // Add this trigger for the code guard logic
];

export function readWritePrompts(ast: any, ctx: PatchContext) {
	traverse.default(ast, {
		TemplateLiteral(path: any) {
			// Optimization: Check if any quasi contains our target phrases before printing
			const hasTrigger = path.node.quasis.some((q: any) => {
				return TRIGGER_PHRASES.some((phrase) => q.value.raw.includes(phrase));
			});

			if (!hasTrigger) return;

			let code = print(path.node);
			let changed = false;

			// Regex-based replacements (Dynamic variable names)
			const writeRegex =
				/- If this is an existing file, you MUST use the \${[A-Za-z0-9_$]+} tool first to read the file's contents\. This tool will fail if you did not read the file first\./;
			if (writeRegex.test(code)) {
				code = code.replace(writeRegex, WRITE_REPLACEMENT);
				ctx.report.write_prompt_relaxed = true;
				changed = true;
			}

			if (changed) {
				try {
					const newExpr = parse(`(${code})`).program.body[0].expression;
					path.replaceWith(newExpr);
					path.skip();
				} catch (e) {
					console.error("Failed to parse patched read/write prompt", e);
				}
			}
		},

		IfStatement: {
			enter(path: any) {
				// Dynamic Code Guard Removal via AST analysis
				// Target pattern:
				// let X = ...readFileState.get(...);
				// if (!X) return { result: false, ... }

				const test = path.node.test;

				// Case 1: "File has not been read yet" -> if (!X)
				if (
					t.isUnaryExpression(test) &&
					test.operator === "!" &&
					t.isIdentifier(test.argument)
				) {
					const varName = test.argument.name;
					const binding = path.scope.getBinding(varName);

					if (
						binding &&
						t.isVariableDeclarator(binding.path.node) &&
						binding.path.node.init
					) {
						const init = binding.path.node.init;
						// Check if init is call to readFileState.get
						if (
							t.isCallExpression(init) &&
							t.isMemberExpression(init.callee) &&
							t.isIdentifier(init.callee.property) &&
							init.callee.property.name === "get"
						) {
							// Check object has readFileState property
							const obj = init.callee.object;
							if (
								t.isMemberExpression(obj) &&
								t.isIdentifier(obj.property) &&
								obj.property.name === "readFileState"
							) {
								// Found it! Verify consequent is a rejection
								if (isRejectionBlock(path.node.consequent)) {
									path.remove();
									ctx.report.write_guard_relaxed = true;
									return;
								}
							}
						}
					}
				}

				// Case 2: "File has been modified" -> if (X) { if (timestamp check) ... }
				// We are looking for the inner IF.
				// Structure: if (GD(I) > X.timestamp) ...
				if (
					t.isBinaryExpression(test) &&
					(test.operator === ">" || test.operator === "<")
				) {
					// Check if one side accesses .timestamp
					const checkTimestamp = (node: any) =>
						t.isMemberExpression(node) &&
						t.isIdentifier(node.property) &&
						node.property.name === "timestamp";

					if (checkTimestamp(test.left) || checkTimestamp(test.right)) {
						// Check if the object being accessed comes from readFileState
						const memberExpr = checkTimestamp(test.left)
							? test.left
							: test.right;
						// @ts-expect-error
						if (t.isIdentifier(memberExpr.object)) {
							// @ts-expect-error
							const varName = memberExpr.object.name;
							const binding = path.scope.getBinding(varName);
							if (
								binding &&
								t.isVariableDeclarator(binding.path.node) &&
								binding.path.node.init
							) {
								const init = binding.path.node.init;
								if (
									t.isCallExpression(init) &&
									t.isMemberExpression(init.callee) &&
									t.isIdentifier(init.callee.property) &&
									init.callee.property.name === "get"
								) {
									const obj = init.callee.object;
									if (
										t.isMemberExpression(obj) &&
										t.isIdentifier(obj.property) &&
										obj.property.name === "readFileState"
									) {
										if (isRejectionBlock(path.node.consequent)) {
											path.remove();
											ctx.report.write_guard_relaxed = true;
											return;
										}
									}
								}
							}
						}
					}
				}
			},
			exit(path: any) {
				// Remove any now-empty or declaration-only guards left after stripping rejection logic
				if (
					!path.node.alternate &&
					t.isBlockStatement(path.node.consequent) &&
					(path.node.consequent.body.length === 0 ||
						path.node.consequent.body.every(
							(s: any) => t.isEmptyStatement(s) || t.isVariableDeclaration(s),
						))
				) {
					path.remove();
					return;
				}
			},
		},

		ThrowStatement(path: any) {
			const arg = path.node.argument;
			if (
				t.isCallExpression(arg) &&
				t.isIdentifier(arg.callee, { name: "Error" }) &&
				arg.arguments.length > 0 &&
				t.isStringLiteral(arg.arguments[0]) &&
				arg.arguments[0].value.includes(
					"Read it again before attempting to write it.",
				)
			) {
				const ifParent = path.findParent((p: any) => p.isIfStatement?.());
				if (ifParent) {
					ifParent.remove();
				} else {
					path.remove();
				}
				ctx.report.write_guard_relaxed = true;
			}
		},
	});
}

function isRejectionBlock(node: any): boolean {
	// Check if the block returns/throws an error-like object
	// Usually: return { result: !1, ... }
	let returnStmt = null;
	if (t.isBlockStatement(node)) {
		returnStmt = node.body.find((s) => t.isReturnStatement(s));
	} else if (t.isReturnStatement(node)) {
		returnStmt = node;
	}

	if (returnStmt?.argument && t.isObjectExpression(returnStmt.argument)) {
		const props = returnStmt.argument.properties;
		// Check for result: !1 or result: false
		const resultProp = props.find(
			(p: any) => t.isIdentifier(p.key) && p.key.name === "result",
		);
		if (resultProp && t.isObjectProperty(resultProp)) {
			if (
				t.isUnaryExpression(resultProp.value) &&
				resultProp.value.operator === "!"
			)
				return true; // !1
			if (
				t.isBooleanLiteral(resultProp.value) &&
				resultProp.value.value === false
			)
				return true;
		}
		// Check for errorCode prop
		const errorProp = props.find(
			(p: any) => t.isIdentifier(p.key) && p.key.name === "errorCode",
		);
		if (errorProp) return true;
	}

	// Also check for throw Error
	if (t.isBlockStatement(node)) {
		if (node.body.some((s) => t.isThrowStatement(s))) return true;
	} else if (t.isThrowStatement(node)) {
		return true;
	}

	return false;
}
