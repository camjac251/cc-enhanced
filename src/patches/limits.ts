import * as t from "@babel/types";
import { traverse } from "../babel.js";
import { print } from "../loader.js";
import type { Patch, PatchResult } from "../types.js";
import { getObjectKeyName, isMemberPropertyName } from "./ast-helpers.js";

const NEW_LINES_CAP = 5000;
const NEW_LINE_CHARS = 5000;
const NEW_BYTE_CEILING = 1048576;
const NEW_TOKEN_BUDGET = 50000;
// Persistence cap: controls when formatted results get disk-persisted.
// 120K chars ~ 30K tokens. The token budget (50K raw) remains the primary gate;
// this cap prevents large formatted output from staying inline forever.
const NEW_RESULT_SIZE_CAP = 120000;
// Per-tool maxResultSizeChars. Kept at 250K so the persistence cap (120K)
// is the effective governor: min(250K, 120K) = 120K.
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

/** Resolve maxResultSizeChars value from NumericLiteral or BinaryExpression (1/0 = Infinity). */
function resolveMaxResultSizeValue(node: t.Node): number | null {
	if (t.isNumericLiteral(node)) return node.value;
	// 1 / 0 = Infinity
	if (
		t.isBinaryExpression(node, { operator: "/" }) &&
		t.isNumericLiteral(node.left, { value: 1 }) &&
		t.isNumericLiteral(node.right, { value: 0 })
	) {
		return Infinity;
	}
	return null;
}

function resolveResultSizeCapBinding(path: any): {
	value: number;
	binding: any;
} | null {
	if (!t.isBlockStatement(path.node.body)) return null;
	if (path.node.params.length < 3) return null;

	const [_, maxCharsParam, ceilingParam] = path.node.params;
	if (!t.isIdentifier(maxCharsParam)) return null;
	if (!t.isAssignmentPattern(ceilingParam)) return null;
	if (
		!t.isIdentifier(ceilingParam.left) ||
		!t.isIdentifier(ceilingParam.right)
	) {
		return null;
	}

	const maxCharsBinding = path.scope.getBinding(maxCharsParam.name);
	const ceilingBinding = path.scope.getBinding(ceilingParam.left.name);
	let foundClamp = false;

	path.traverse({
		CallExpression(innerPath: any) {
			const callee = innerPath.node.callee;
			if (!t.isMemberExpression(callee)) return;
			if (!isMathReference(callee.object)) return;
			if (!isMemberPropertyName(callee, "min")) return;
			if (innerPath.node.arguments.length !== 2) return;

			const [leftArg, rightArg] = innerPath.node.arguments;
			if (!isSameBinding(innerPath, leftArg, maxCharsBinding)) return;
			if (!isSameBinding(innerPath, rightArg, ceilingBinding)) return;

			foundClamp = true;
			innerPath.stop();
		},
	});
	if (!foundClamp) return null;

	const binding = path.scope.getBinding(ceilingParam.right.name);
	if (!binding || !t.isVariableDeclarator(binding.path.node)) return null;
	const init = binding.path.node.init;
	if (!t.isNumericLiteral(init)) return null;

	return { value: init.value, binding };
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

	traverse(ast, {
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

	traverse(ast, {
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

	traverse(ast, {
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

			// The token budget default is stored as a sibling variable after the function.
			const nextSibling = path.getNextSibling?.();
			if (nextSibling?.node && t.isVariableDeclaration(nextSibling.node)) {
				for (const decl of nextSibling.node.declarations) {
					if (
						t.isNumericLiteral(decl.init) &&
						(decl.init.value === 25000 || decl.init.value === NEW_TOKEN_BUDGET)
					) {
						current.tokenBudget = decl.init.value;
						break;
					}
				}
			}

			if (current.tokenBudget !== undefined) path.stop();
		},
	});

	traverse(ast, {
		Function(path: any) {
			if (current.resultSizeCap !== undefined) return;
			const resolved = resolveResultSizeCapBinding(path);
			if (!resolved) return;

			current.resultSizeCap = resolved.value;
			path.stop();
		},
	});

	// Find Read tool's maxResultSizeChars
	traverse(ast, {
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
			if (!maxProp) return;
			const resolved = resolveMaxResultSizeValue(maxProp.value);
			if (resolved === null) return;

			current.readMaxResultSize = resolved;
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

	traverse(ast, {
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

		traverse(ast, {
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

		traverse(ast, {
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

				// The token budget default is stored as a sibling variable after the function.
				const nextSibling = path.getNextSibling?.();
				if (!nextSibling?.node || !t.isVariableDeclaration(nextSibling.node))
					return;

				for (const decl of nextSibling.node.declarations) {
					if (t.isNumericLiteral(decl.init, { value: 25000 })) {
						const oldValue = decl.init.value;
						decl.init = t.numericLiteral(NEW_TOKEN_BUDGET);
						limitsChanged.tokenBudget = [
							String(oldValue),
							String(NEW_TOKEN_BUDGET),
						];
						patched = true;
						path.stop();
						return;
					}
				}
			},
		});
	}

	function patchResultSizeCap(ast: any) {
		let patched = false;

		traverse(ast, {
			Function(path: any) {
				if (patched) return;
				const resolved = resolveResultSizeCapBinding(path);
				if (!resolved) return;
				const init = resolved.binding.path.node.init;
				if (!t.isNumericLiteral(init, { value: 50000 })) return;

				resolved.binding.path.node.init = t.numericLiteral(NEW_RESULT_SIZE_CAP);
				limitsChanged.resultSizeCap = [
					String(init.value),
					String(NEW_RESULT_SIZE_CAP),
				];
				patched = true;
				path.stop();
			},
		});
	}

	function patchReadMaxResultSize(ast: any) {
		let patched = false;

		traverse(ast, {
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
				if (!maxProp) return;

				// Handle both NumericLiteral (1e5) and BinaryExpression (1 / 0 = Infinity)
				const resolvedValue = resolveMaxResultSizeValue(maxProp.value);
				if (resolvedValue === null) return;

				// Skip if already >= our target (e.g. Infinity)
				if (resolvedValue >= NEW_READ_MAX_RESULT_SIZE) {
					limitsChanged.readMaxResultSize = [
						String(resolvedValue),
						String(resolvedValue),
					];
					patched = true;
					path.stop();
					return;
				}

				maxProp.value = t.numericLiteral(NEW_READ_MAX_RESULT_SIZE);
				limitsChanged.readMaxResultSize = [
					String(resolvedValue),
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
		traverse(ast, {
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
		];
		for (const [key, expected, actual] of requiredChecks) {
			if (actual === undefined) return `Could not resolve limit ${key}`;
			if (actual !== expected) {
				return `Limit ${key} has unexpected value: ${actual} (expected ${expected})`;
			}
		}
		// readMaxResultSize accepts values >= target (Infinity is fine — means no per-tool cap)
		if (current.readMaxResultSize === undefined) {
			return "Could not resolve limit readMaxResultSize";
		}
		if (current.readMaxResultSize < NEW_READ_MAX_RESULT_SIZE) {
			return `Limit readMaxResultSize has unexpected value: ${current.readMaxResultSize} (expected >= ${NEW_READ_MAX_RESULT_SIZE})`;
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

		// Structural integrity: persistence cap must be less than maxResultSizeChars
		// so it is the effective governor in the Math.min call
		if (
			current.resultSizeCap !== undefined &&
			current.readMaxResultSize !== undefined &&
			current.resultSizeCap >= current.readMaxResultSize
		) {
			return `resultSizeCap (${current.resultSizeCap}) must be less than readMaxResultSize (${current.readMaxResultSize}) for persistence to govern`;
		}

		// Verify the token budget function still references the env var override
		let hasTokenEnvRef = false;
		traverse(ast, {
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
