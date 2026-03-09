import traverse from "@babel/traverse";
import * as t from "@babel/types";
import { print } from "../loader.js";
import type { Patch, PatchResult } from "../types.js";
import { getObjectKeyName, isMemberPropertyName } from "./ast-helpers.js";

const NEW_LINES_CAP = 5000;
const NEW_LINE_CHARS = 5000;
const NEW_BYTE_CEILING = 1048576;
const NEW_TOKEN_BUDGET = 50000;
// Persistence cap (ZPA): controls when formatted results get disk-persisted.
// 120K chars ~ 30K tokens. Reads consuming >30K tokens formatted get persisted,
// preventing large reads from bloating conversation context. The token budget
// (50K raw tokens) remains the primary gate for whether a read succeeds;
// this cap just ensures the formatted output doesn't stay inline forever.
const NEW_RESULT_SIZE_CAP = 120000;
// Per-tool maxResultSizeChars fed into Math.min(maxResultSizeChars, ZPA).
// Kept at 250K so ZPA (120K) is the effective governor: min(250K, 120K) = 120K.
const NEW_READ_MAX_RESULT_SIZE = 250000;

const READ_PROMPT_TRIGGERS = [
	"Reads a file from the local filesystem",
	"Read files from the local filesystem",
];

// Coupling: identifies the Read tool prompt via the same trigger phrase as
// read-with-bat.ts. This patch modifies variable declarations (numeric limits),
// while read-with-bat replaces the prompt body. Both can coexist safely.

// Store limit changes for reporting
let limitsChanged: NonNullable<PatchResult["limits"]> = {};

function isReadPromptTemplate(
	quasis: Array<{ value: { raw: string } }>,
): boolean {
	return quasis.some((q) =>
		READ_PROMPT_TRIGGERS.some((trigger) => q.value.raw.includes(trigger)),
	);
}

function isSameBinding(
	path: any,
	node: t.Node | null | undefined,
	binding: any,
): boolean {
	return (
		!!binding &&
		t.isIdentifier(node) &&
		path.scope.getBinding(node.name) === binding
	);
}

function isMathReference(node: t.Expression | t.Super): boolean {
	if (t.isSuper(node)) return false;
	if (t.isIdentifier(node)) return node.name === "Math";
	if (!t.isMemberExpression(node)) return false;
	return (
		isMemberPropertyName(node, "Math") &&
		t.isIdentifier(node.object) &&
		node.object.name === "globalThis"
	);
}

function collectCurrentLimits(ast: t.File): {
	linesCap?: number;
	lineChars?: number;
	byteCeiling?: number;
	tokenBudget?: number;
	resultSizeCap?: number;
	readMaxResultSize?: number;
} {
	const current: {
		linesCap?: number;
		lineChars?: number;
		byteCeiling?: number;
		tokenBudget?: number;
		resultSizeCap?: number;
		readMaxResultSize?: number;
	} = {};

	traverse.default(ast, {
		TemplateLiteral(path: any) {
			if (current.linesCap !== undefined && current.lineChars !== undefined)
				return;
			const quasis = path.node.quasis;
			const hasTrigger = isReadPromptTemplate(quasis);
			if (!hasTrigger) return;

			const exprs = path.node.expressions;
			for (let i = 0; i < quasis.length; i++) {
				if (i >= exprs.length) continue;
				if (!t.isIdentifier(exprs[i])) continue;

				const binding = path.scope.getBinding(exprs[i].name);
				const init =
					binding && t.isVariableDeclarator(binding.path.node)
						? binding.path.node.init
						: null;
				if (!t.isNumericLiteral(init)) continue;

				const text = quasis[i].value.raw;
				if (text.includes("reads up to ")) current.linesCap = init.value;
				if (text.includes("longer than ")) current.lineChars = init.value;
			}
		},
	});

	traverse.default(ast, {
		Function(path: any) {
			if (current.byteCeiling !== undefined) return;
			if (!t.isBlockStatement(path.node.body)) return;
			if (path.node.params.length < 2) return;

			const [fileParam, limitParam] = path.node.params;
			if (!t.isIdentifier(fileParam)) return;
			if (!t.isAssignmentPattern(limitParam)) return;
			if (!t.isIdentifier(limitParam.left)) return;
			if (!t.isIdentifier(limitParam.right)) return;

			const fileParamName = fileParam.name;
			const limitParamName = limitParam.left.name;
			const byteCeilingVarName = limitParam.right.name;
			const fileBinding = path.scope.getBinding(fileParamName);
			const limitBinding = path.scope.getBinding(limitParamName);

			let isFileSizeCheckFn = false;
			path.traverse({
				BinaryExpression(innerPath: any) {
					const node = innerPath.node;
					if (node.operator !== "<=") return;
					if (!isSameBinding(innerPath, node.right, limitBinding)) return;

					const left = node.left;
					if (!t.isMemberExpression(left)) return;
					if (!isMemberPropertyName(left, "size")) return;

					const statCall = left.object;
					if (!t.isCallExpression(statCall)) return;
					if (!t.isMemberExpression(statCall.callee)) return;
					if (!isMemberPropertyName(statCall.callee, "statSync")) return;
					if (
						statCall.arguments.length < 1 ||
						!isSameBinding(innerPath, statCall.arguments[0], fileBinding)
					)
						return;

					isFileSizeCheckFn = true;
					innerPath.stop();
				},
			});
			if (!isFileSizeCheckFn) return;

			const binding = path.scope.getBinding(byteCeilingVarName);
			const init =
				binding && t.isVariableDeclarator(binding.path.node)
					? binding.path.node.init
					: null;
			if (!t.isNumericLiteral(init)) return;

			current.byteCeiling = init.value;
			path.stop();
		},
	});

	traverse.default(ast, {
		Function(path: any) {
			if (current.tokenBudget !== undefined) return;
			if (!t.isBlockStatement(path.node.body)) return;

			let hasEnv = false;
			path.traverse({
				MemberExpression(innerPath: any) {
					const node = innerPath.node;
					const prop = node.property;
					const propName =
						(t.isIdentifier(prop) && prop.name) ||
						(t.isStringLiteral(prop) && prop.value) ||
						null;
					if (propName !== "CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS") return;
					hasEnv = true;
					innerPath.stop();
				},
			});
			if (!hasEnv) return;

			path.traverse({
				ReturnStatement(innerPath: any) {
					if (current.tokenBudget !== undefined) return;
					const arg = innerPath.node.argument;
					if (!t.isIdentifier(arg)) return;

					const binding = innerPath.scope.getBinding(arg.name);
					const init =
						binding && t.isVariableDeclarator(binding.path.node)
							? binding.path.node.init
							: null;
					if (!t.isNumericLiteral(init)) return;

					current.tokenBudget = init.value;
					innerPath.stop();
				},
			});

			if (current.tokenBudget !== undefined) path.stop();
		},
	});

	// Find ZPA (result size cap) via Math.min with a known persistence cap arg.
	// Supports both old form: Math.min(X.maxResultSizeChars, Y) where Y=50000
	// and new form (2.1.71+): Math.min($param, Y) where Y=50000 inside SLD()
	const knownResultSizeValues = new Set([50000, NEW_RESULT_SIZE_CAP]);
	traverse.default(ast, {
		CallExpression(path: any) {
			if (current.resultSizeCap !== undefined) return;
			const callee = path.node.callee;
			if (!t.isMemberExpression(callee)) return;
			if (!isMathReference(callee.object)) return;
			if (!isMemberPropertyName(callee, "min")) return;
			if (path.node.arguments.length !== 2) return;

			for (const arg of path.node.arguments) {
				if (!t.isIdentifier(arg)) continue;
				const binding = path.scope.getBinding(arg.name);
				if (!binding || !t.isVariableDeclarator(binding.path.node)) continue;
				const init = binding.path.node.init;
				if (!t.isNumericLiteral(init)) continue;
				if (!knownResultSizeValues.has(init.value)) continue;
				current.resultSizeCap = init.value;
				path.stop();
				return;
			}
		},
	});

	// Find Read tool's maxResultSizeChars
	traverse.default(ast, {
		ObjectExpression(path: any) {
			if (current.readMaxResultSize !== undefined) return;
			const nameProp = path.node.properties.find(
				(p: any): p is t.ObjectProperty =>
					t.isObjectProperty(p) && getObjectKeyName(p.key) === "name",
			);
			if (!nameProp) return;

			let nameVal: string | null = null;
			if (t.isStringLiteral(nameProp.value)) {
				nameVal = nameProp.value.value;
			} else if (t.isIdentifier(nameProp.value)) {
				const binding = path.scope.getBinding(nameProp.value.name);
				const init = binding?.path.node;
				if (t.isVariableDeclarator(init) && t.isStringLiteral(init.init)) {
					nameVal = init.init.value;
				}
			}
			if (nameVal !== "Read") return;

			// Discriminate against other tools: Read tool has searchHint with "read files"
			const searchHintProp = path.node.properties.find(
				(p: any): p is t.ObjectProperty =>
					t.isObjectProperty(p) && getObjectKeyName(p.key) === "searchHint",
			);
			if (
				searchHintProp &&
				t.isStringLiteral(searchHintProp.value) &&
				!searchHintProp.value.value.includes("read file")
			) {
				return;
			}

			const maxProp = path.node.properties.find(
				(p: any): p is t.ObjectProperty =>
					t.isObjectProperty(p) &&
					getObjectKeyName(p.key) === "maxResultSizeChars",
			);
			if (!maxProp || !t.isNumericLiteral(maxProp.value)) return;

			current.readMaxResultSize = maxProp.value.value;
			path.stop();
		},
	});

	return current;
}

function runLimitsPatch(ast: t.File): void {
	limitsChanged = {};

	patchByteCeiling(ast);
	patchTokenBudget(ast);
	patchResultSizeCap(ast);
	patchReadMaxResultSize(ast);

	traverse.default(ast, {
		TemplateLiteral(path: any) {
			const quasis = path.node.quasis;
			const hasTrigger = isReadPromptTemplate(quasis);

			if (!hasTrigger) return;

			const code = print(path.node);
			if (code.includes("Reads a file from the local filesystem.")) {
				const exprs = path.node.expressions;

				for (let i = 0; i < quasis.length; i++) {
					const q = quasis[i].value.raw;
					if (q.includes("reads up to ")) {
						if (i < exprs.length && t.isIdentifier(exprs[i])) {
							const linesVarName = (exprs[i] as any).name;
							updateVarValue(ast, linesVarName, NEW_LINES_CAP, "linesCap");
						}
					}
					if (q.includes("longer than ")) {
						if (i < exprs.length && t.isIdentifier(exprs[i])) {
							const charsVarName = (exprs[i] as any).name;
							updateVarValue(ast, charsVarName, NEW_LINE_CHARS, "lineChars");
						}
					}
				}
			}
		},
	});

	function patchByteCeiling(ast: any) {
		let patched = false;

		traverse.default(ast, {
			Function(path: any) {
				if (patched) return;
				if (!t.isBlockStatement(path.node.body)) return;
				if (path.node.params.length < 2) return;

				const [fileParam, limitParam] = path.node.params;
				if (!t.isIdentifier(fileParam)) return;
				if (!t.isAssignmentPattern(limitParam)) return;
				if (!t.isIdentifier(limitParam.left)) return;
				if (!t.isIdentifier(limitParam.right)) return;

				const fileParamName = fileParam.name;
				const limitParamName = limitParam.left.name;
				const byteCeilingVarName = limitParam.right.name;
				const fileBinding = path.scope.getBinding(fileParamName);
				const limitBinding = path.scope.getBinding(limitParamName);

				let isFileSizeCheckFn = false;
				path.traverse({
					BinaryExpression(innerPath: any) {
						const node = innerPath.node;
						if (node.operator !== "<=") return;
						if (!isSameBinding(innerPath, node.right, limitBinding)) return;

						const left = node.left;
						if (!t.isMemberExpression(left)) return;
						if (!isMemberPropertyName(left, "size")) return;

						const statCall = left.object;
						if (!t.isCallExpression(statCall)) return;
						if (!t.isMemberExpression(statCall.callee)) return;
						if (!isMemberPropertyName(statCall.callee, "statSync")) return;
						if (
							statCall.arguments.length < 1 ||
							!isSameBinding(innerPath, statCall.arguments[0], fileBinding)
						)
							return;

						isFileSizeCheckFn = true;
						innerPath.stop();
					},
				});
				if (!isFileSizeCheckFn) return;

				const binding = path.scope.getBinding(byteCeilingVarName);
				if (!binding || !t.isVariableDeclarator(binding.path.node)) return;

				const init = binding.path.node.init;
				if (!t.isNumericLiteral(init, { value: 262144 })) return;

				binding.path.node.init = t.numericLiteral(NEW_BYTE_CEILING);
				limitsChanged.byteCeiling = [
					String(init.value),
					String(NEW_BYTE_CEILING),
				];
				patched = true;
				path.stop();
			},
		});
	}

	function patchTokenBudget(ast: any) {
		let patched = false;

		traverse.default(ast, {
			Function(path: any) {
				if (patched) return;
				if (!t.isBlockStatement(path.node.body)) return;

				let hasEnv = false;
				path.traverse({
					MemberExpression(innerPath: any) {
						const node = innerPath.node;
						const prop = node.property;
						const propName =
							(t.isIdentifier(prop) && prop.name) ||
							(t.isStringLiteral(prop) && prop.value) ||
							null;
						if (propName !== "CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS") return;
						hasEnv = true;
						innerPath.stop();
					},
				});
				if (!hasEnv) return;

				let tokenVarName: string | null = null;
				path.traverse({
					ReturnStatement(innerPath: any) {
						if (tokenVarName) return;
						const arg = innerPath.node.argument;
						if (!t.isIdentifier(arg)) return;

						const binding = innerPath.scope.getBinding(arg.name);
						if (!binding || !t.isVariableDeclarator(binding.path.node)) return;

						const init = binding.path.node.init;
						if (!t.isNumericLiteral(init, { value: 25000 })) return;

						tokenVarName = arg.name;
						innerPath.stop();
					},
				});
				if (!tokenVarName) return;

				const binding = path.scope.getBinding(tokenVarName);
				if (!binding || !t.isVariableDeclarator(binding.path.node)) return;

				const init = binding.path.node.init;
				if (!t.isNumericLiteral(init, { value: 25000 })) return;

				binding.path.node.init = t.numericLiteral(NEW_TOKEN_BUDGET);
				limitsChanged.tokenBudget = [
					String(init.value),
					String(NEW_TOKEN_BUDGET),
				];
				patched = true;
				path.stop();
			},
		});
	}

	function patchResultSizeCap(ast: any) {
		let patched = false;

		traverse.default(ast, {
			CallExpression(path: any) {
				if (patched) return;
				const callee = path.node.callee;
				if (!t.isMemberExpression(callee)) return;
				if (!isMathReference(callee.object)) return;
				if (!isMemberPropertyName(callee, "min")) return;
				if (path.node.arguments.length !== 2) return;

				for (const arg of path.node.arguments) {
					if (!t.isIdentifier(arg)) continue;
					const binding = path.scope.getBinding(arg.name);
					if (!binding || !t.isVariableDeclarator(binding.path.node)) continue;
					const init = binding.path.node.init;
					if (!t.isNumericLiteral(init, { value: 50000 })) continue;

					binding.path.node.init = t.numericLiteral(NEW_RESULT_SIZE_CAP);
					limitsChanged.resultSizeCap = [
						String(init.value),
						String(NEW_RESULT_SIZE_CAP),
					];
					patched = true;
					path.stop();
					return;
				}
			},
		});
	}

	function patchReadMaxResultSize(ast: any) {
		let patched = false;

		traverse.default(ast, {
			ObjectExpression(path: any) {
				if (patched) return;
				const nameProp = path.node.properties.find(
					(p: any): p is t.ObjectProperty =>
						t.isObjectProperty(p) && getObjectKeyName(p.key) === "name",
				);
				if (!nameProp) return;

				let nameVal: string | null = null;
				if (t.isStringLiteral(nameProp.value)) {
					nameVal = nameProp.value.value;
				} else if (t.isIdentifier(nameProp.value)) {
					const binding = path.scope.getBinding(nameProp.value.name);
					const init = binding?.path.node;
					if (t.isVariableDeclarator(init) && t.isStringLiteral(init.init)) {
						nameVal = init.init.value;
					}
				}
				if (nameVal !== "Read") return;

				// Discriminate against other tools: Read tool has searchHint with "read files"
				const searchHintProp = path.node.properties.find(
					(p: any): p is t.ObjectProperty =>
						t.isObjectProperty(p) && getObjectKeyName(p.key) === "searchHint",
				);
				if (
					searchHintProp &&
					t.isStringLiteral(searchHintProp.value) &&
					!searchHintProp.value.value.includes("read file")
				) {
					return;
				}

				const maxProp = path.node.properties.find(
					(p: any): p is t.ObjectProperty =>
						t.isObjectProperty(p) &&
						getObjectKeyName(p.key) === "maxResultSizeChars",
				);
				if (!maxProp || !t.isNumericLiteral(maxProp.value, { value: 1e5 }))
					return;

				maxProp.value = t.numericLiteral(NEW_READ_MAX_RESULT_SIZE);
				limitsChanged.readMaxResultSize = [
					String(1e5),
					String(NEW_READ_MAX_RESULT_SIZE),
				];
				patched = true;
				path.stop();
			},
		});
	}

	function updateVarValue(
		ast: any,
		varName: string,
		newValue: number,
		limitKey: keyof NonNullable<PatchResult["limits"]>,
	) {
		traverse.default(ast, {
			VariableDeclarator(path: any) {
				if (t.isIdentifier(path.node.id) && path.node.id.name === varName) {
					const oldValue = t.isNumericLiteral(path.node.init)
						? String(path.node.init.value)
						: "unknown";
					path.node.init = t.numericLiteral(newValue);
					limitsChanged[limitKey] = [oldValue, String(newValue)];
					path.stop();
				}
			},
		});
	}
}

export const limits: Patch = {
	tag: "limits",

	astPasses: (ast) => [
		{
			pass: "mutate",
			visitor: {
				Program: {
					exit() {
						runLimitsPatch(ast);
					},
				},
			},
		},
	],

	verify: (_code, ast) => {
		if (!ast) return "Missing AST for limits verification";
		const current = collectCurrentLimits(ast);

		const requiredChecks: Array<
			[keyof NonNullable<PatchResult["limits"]>, number, number | undefined]
		> = [
			["byteCeiling", NEW_BYTE_CEILING, current.byteCeiling],
			["tokenBudget", NEW_TOKEN_BUDGET, current.tokenBudget],
			["resultSizeCap", NEW_RESULT_SIZE_CAP, current.resultSizeCap],
			[
				"readMaxResultSize",
				NEW_READ_MAX_RESULT_SIZE,
				current.readMaxResultSize,
			],
		];
		for (const [key, expected, actual] of requiredChecks) {
			if (actual === undefined) return `Could not resolve limit ${key}`;
			if (actual !== expected) {
				return `Limit ${key} has unexpected value: ${actual} (expected ${expected})`;
			}
		}
		const optionalPromptChecks: Array<
			[keyof NonNullable<PatchResult["limits"]>, number, number | undefined]
		> = [
			["linesCap", NEW_LINES_CAP, current.linesCap],
			["lineChars", NEW_LINE_CHARS, current.lineChars],
		];
		for (const [key, expected, actual] of optionalPromptChecks) {
			if (actual === undefined) continue;
			if (actual !== expected) {
				return `Limit ${key} has unexpected value: ${actual} (expected ${expected})`;
			}
		}

		// Structural integrity: ZPA must be less than maxResultSizeChars so the
		// persistence cap is the effective governor in Math.min(maxResultSizeChars, ZPA)
		if (
			current.resultSizeCap !== undefined &&
			current.readMaxResultSize !== undefined &&
			current.resultSizeCap >= current.readMaxResultSize
		) {
			return `resultSizeCap (${current.resultSizeCap}) must be less than readMaxResultSize (${current.readMaxResultSize}) for persistence to govern`;
		}

		// Verify the token budget function still references the env var override
		let hasTokenEnvRef = false;
		traverse.default(ast, {
			MemberExpression(path: any) {
				const prop = path.node.property;
				const propName =
					(t.isIdentifier(prop) && prop.name) ||
					(t.isStringLiteral(prop) && prop.value) ||
					null;
				if (propName === "CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS") {
					hasTokenEnvRef = true;
					path.stop();
				}
			},
		});
		if (!hasTokenEnvRef) {
			return "CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS env var reference not found in token budget function";
		}

		return true;
	},
};

export function getLimitsChanged(): PatchResult["limits"] {
	return limitsChanged;
}
