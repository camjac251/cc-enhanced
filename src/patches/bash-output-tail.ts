import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch } from "../types.js";

/**
 * Add output_tail and max_output options to Bash tool.
 *
 * Architecture (2.1.2+):
 * - Bash outputs > 30KB are saved to disk
 * - max_output overrides this threshold to allow larger inline outputs
 * - output_tail truncates from END instead of beginning
 *
 * All modifications are AST-based for robustness across versions.
 */
// Coupling: targets the same Bash tool prompt as bash-prompt.ts but in a
// different section (disk persistence/tail guidance vs CLI tool recommendations).

// Helper to find the Zod variable (h, u, or U) used in schemas
function findZodVariable(path: any): string | null {
	let zodVar: string | null = null;
	path.traverse({
		CallExpression(callPath: any) {
			const callee = callPath.node.callee;
			if (
				t.isMemberExpression(callee) &&
				t.isIdentifier(callee.property, { name: "boolean" }) &&
				t.isIdentifier(callee.object)
			) {
				zodVar = callee.object.name;
				callPath.stop();
			}
		},
	});
	return zodVar;
}

// Build a Zod schema property: VAR.boolean().optional().describe("...")
function buildZodBooleanProperty(
	key: string,
	description: string,
	zodVar: string,
): t.ObjectProperty {
	return t.objectProperty(
		t.identifier(key),
		t.callExpression(
			t.memberExpression(
				t.callExpression(
					t.memberExpression(
						t.callExpression(
							t.memberExpression(t.identifier(zodVar), t.identifier("boolean")),
							[],
						),
						t.identifier("optional"),
					),
					[],
				),
				t.identifier("describe"),
			),
			[t.stringLiteral(description)],
		),
	);
}

// Build a Zod schema property: VAR.number().optional().describe("...")
function buildZodNumberProperty(
	key: string,
	description: string,
	zodVar: string,
): t.ObjectProperty {
	return t.objectProperty(
		t.identifier(key),
		t.callExpression(
			t.memberExpression(
				t.callExpression(
					t.memberExpression(
						t.callExpression(
							t.memberExpression(t.identifier(zodVar), t.identifier("number")),
							[],
						),
						t.identifier("optional"),
					),
					[],
				),
				t.identifier("describe"),
			),
			[t.stringLiteral(description)],
		),
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

function objectPatternHasKey(
	pattern: t.ObjectPattern,
	keyName: string,
): boolean {
	return pattern.properties.some((prop) => {
		if (!t.isObjectProperty(prop)) return false;
		if (t.isIdentifier(prop.key, { name: keyName })) return true;
		return t.isStringLiteral(prop.key, { value: keyName });
	});
}

export const bashOutputTail: Patch = {
	tag: "bash-tail",

	ast: (ast) => {
		let schemaPatched = false;
		let resultPatched = false;
		let persistencePatched = false;
		let destructuringPatched = false;

		traverse.default(ast, {
			// 1. Add output_tail and max_output to Bash schema
			// Find: dangerouslyDisableSandbox property, insert after it
			ObjectProperty(path) {
				if (
					!t.isIdentifier(path.node.key, { name: "dangerouslyDisableSandbox" })
				) {
					return;
				}

				// Verify this is a Zod schema (has .boolean().optional().describe() chain)
				if (!t.isCallExpression(path.node.value)) return;
				const callee = path.node.value.callee;
				if (!t.isMemberExpression(callee)) return;
				if (!t.isIdentifier(callee.property, { name: "describe" })) return;

				// Check if already patched
				const parent = path.parent;
				if (!t.isObjectExpression(parent)) return;
				const hasOutputTail = parent.properties.some(
					(p) =>
						t.isObjectProperty(p) &&
						t.isIdentifier(p.key, { name: "output_tail" }),
				);
				if (hasOutputTail) return;

				// Find Zod variable — bail if unresolvable
				const zodVar = findZodVariable(path);
				if (!zodVar) {
					console.warn("bash-tail: Could not resolve Zod variable name");
					return;
				}

				// Find index of dangerouslyDisableSandbox
				const idx = parent.properties.indexOf(path.node);
				if (idx < 0) return;

				// Insert output_tail and max_output after dangerouslyDisableSandbox
				const outputTailProp = buildZodBooleanProperty(
					"output_tail",
					"When output exceeds limit, keep the LAST N characters instead of first. Use for build/test output where errors appear at the end.",
					zodVar,
				);
				const maxOutputProp = buildZodNumberProperty(
					"max_output",
					"Override max output characters for this command. Use higher values (500000+) for bat, git diff, or when you need full output. Default uses BASH_MAX_OUTPUT_LENGTH env var.",
					zodVar,
				);

				parent.properties.splice(idx + 1, 0, outputTailProp, maxOutputProp);
				schemaPatched = true;
			},

			// 2. Add maxOutput and outputTail to Bash result data
			// Find: return { data: { ..., dangerouslyDisableSandbox: "..." in A ? ... } }
			ReturnStatement(path) {
				const arg = path.node.argument;
				if (!t.isObjectExpression(arg)) return;

				// Find data property
				const dataProp = arg.properties.find(
					(p): p is t.ObjectProperty =>
						t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "data" }),
				);
				if (!dataProp || !t.isObjectExpression(dataProp.value)) return;

				const dataObj = dataProp.value;

				// Check for dangerouslyDisableSandbox and stdout (confirms this is Bash result)
				const hasDangerous = dataObj.properties.some(
					(p) =>
						t.isObjectProperty(p) &&
						t.isIdentifier(p.key, { name: "dangerouslyDisableSandbox" }),
				);
				const hasStdout = dataObj.properties.some(
					(p) =>
						t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "stdout" }),
				);
				if (!hasDangerous || !hasStdout) return;

				// Check if already patched
				const hasMaxOutput = dataObj.properties.some(
					(p) =>
						t.isObjectProperty(p) &&
						t.isIdentifier(p.key, { name: "maxOutput" }),
				);
				if (hasMaxOutput) return;

				// Find the input variable name from the conditional (usually "A")
				const dangerousProp = dataObj.properties.find(
					(p): p is t.ObjectProperty =>
						t.isObjectProperty(p) &&
						t.isIdentifier(p.key, { name: "dangerouslyDisableSandbox" }),
				);
				if (!dangerousProp || !t.isConditionalExpression(dangerousProp.value))
					return;

				const testExpr = dangerousProp.value.test;
				if (!t.isBinaryExpression(testExpr, { operator: "in" })) return;
				if (!t.isIdentifier(testExpr.right)) return;
				const inputVar = testExpr.right.name;

				// Add maxOutput and outputTail properties
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
			},

			// 3. Modify persistence function to use maxOutput
			// Find: function(A, K, q) { let Y = A.mapToolResultToToolResultBlockParam(K, q); return X(Y, A.name, A.maxResultSizeChars); }
			FunctionDeclaration(path) {
				if (!path.node.async) return;
				if (path.node.params.length !== 3) return;

				const body = path.node.body.body;
				if (body.length !== 2) return;

				// First statement: let Y = A.mapToolResultToToolResultBlockParam(K, q)
				const firstStmt = body[0];
				if (!t.isVariableDeclaration(firstStmt)) return;
				if (firstStmt.declarations.length !== 1) return;

				const decl = firstStmt.declarations[0];
				if (!t.isCallExpression(decl.init)) return;

				const callee = decl.init.callee;
				if (!t.isMemberExpression(callee)) return;
				if (
					!t.isIdentifier(callee.property, {
						name: "mapToolResultToToolResultBlockParam",
					})
				)
					return;

				// Second statement: return X(Y, A.name, A.maxResultSizeChars)
				const secondStmt = body[1];
				if (!t.isReturnStatement(secondStmt)) return;
				if (!t.isCallExpression(secondStmt.argument)) return;

				const returnCall = secondStmt.argument;
				if (returnCall.arguments.length !== 3) return;

				const thirdArg = returnCall.arguments[2];
				if (!t.isMemberExpression(thirdArg)) return;
				if (!t.isIdentifier(thirdArg.property, { name: "maxResultSizeChars" }))
					return;

				// Check if already patched
				if (t.isConditionalExpression(returnCall.arguments[2])) return;

				// Get variable names
				const resultVar = path.node.params[1]; // K - the tool result
				if (!t.isIdentifier(resultVar)) return;
				const resultVarName = resultVar.name;

				// Replace A.maxResultSizeChars with:
				// (K.data?.maxOutput > 0 ? K.data.maxOutput : A.maxResultSizeChars)
				returnCall.arguments[2] = t.conditionalExpression(
					t.binaryExpression(
						">",
						t.optionalMemberExpression(
							t.memberExpression(
								t.identifier(resultVarName),
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
							t.identifier(resultVarName),
							t.identifier("data"),
						),
						t.identifier("maxOutput"),
					),
					thirdArg,
				);
				persistencePatched = true;
				console.log("Patched persistence function to use maxOutput");
			},

			// 4. Add outputTail to Bash mapToolResultToToolResultBlockParam destructuring
			ObjectMethod(path) {
				if (
					!t.isIdentifier(path.node.key, {
						name: "mapToolResultToToolResultBlockParam",
					})
				)
					return;

				// Get the first param (destructured object)
				const firstParam = path.node.params[0];
				if (!t.isObjectPattern(firstParam)) return;

				// Verify this is Bash by checking for stdout in destructuring
				const hasStdout = firstParam.properties.some(
					(p) =>
						t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "stdout" }),
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
			},
		});

		// Log results
		if (schemaPatched)
			console.log("Added output_tail/max_output to Bash schema");
		if (resultPatched) console.log("Added maxOutput/outputTail to Bash result");
		if (persistencePatched) console.log("Patched persistence threshold");
		if (destructuringPatched) console.log("Added outputTail to destructuring");
	},

	// String patch for prompt update (complex template literal, easier as string)
	string: (code) => {
		const promptPattern =
			/(If the output exceeds \$\{\w+\(\)\} characters, output will be truncated before being returned to you\.)/;

		if (!promptPattern.test(code)) return code;

		return code.replace(
			promptPattern,
			`$1
  - **Disk persistence**: Outputs over 30KB are saved to disk and you'll receive a file path instead. You'll need to read that file separately (e.g., \\\`bat /path/to/output.txt\\\`). To avoid this extra step, use \\\`max_output\\\` proactively.
  - Use \\\`max_output: N\\\` to keep outputs inline up to N characters, preventing disk saves. Set 100000-500000 for commands you expect to have large output (bat, git diff, git log, build output you want to analyze). This avoids the round-trip of reading a saved file.
  - Use \\\`output_tail: true\\\` for commands where errors/results appear at the end: build commands (npm/pnpm/yarn build, cargo build, make, go build), test runners (pytest, jest, vitest, cargo test, go test), Docker builds, and log viewing. When truncation occurs, keeps the LAST N characters instead of first.
  - For long builds/tests, combine \\\`run_in_background: true\\\` with \\\`output_tail: true\\\` to get the final errors when checking results later.`,
		);
	},

	verify: (code) => {
		if (!code.includes("output_tail")) {
			return "Missing output_tail in schema";
		}
		if (!code.includes("max_output")) {
			return "Missing max_output in schema";
		}
		if (!code.includes("Disk persistence")) {
			return "Missing disk persistence explanation in prompt";
		}
		if (!code.includes("build commands") || !code.includes("test runners")) {
			return "Missing proactive output_tail guidance in prompt";
		}
		if (!code.includes("preventing disk saves")) {
			return "Missing max_output disk prevention guidance in prompt";
		}
		if (!code.includes("maxOutput:") || !code.includes("max_output")) {
			return "Missing max_output pass-through in Bash result";
		}
		if (!code.includes("data?.maxOutput")) {
			return "Missing max_output usage in persistence threshold";
		}
		if (!/outputTail[,}\s]/.test(code)) {
			return "Missing outputTail in mapToolResultToToolResultBlockParam destructuring";
		}
		return true;
	},
};
