import traverse from "@babel/traverse";
import * as t from "@babel/types";
import { print } from "../loader.js";
import type { Patch, PatchResult } from "../types.js";

const NEW_LINES_CAP = 5000;
const NEW_LINE_CHARS = 5000;
const NEW_BYTE_CEILING = 1048576;
const NEW_TOKEN_BUDGET = 50000;

const TRIGGER_PHRASE = "Reads a file from the local filesystem";

// Coupling: identifies the Read tool prompt via the same trigger phrase as
// read-with-bat.ts. This patch modifies variable declarations (numeric limits),
// while read-with-bat replaces the prompt body. Both can coexist safely.

// Store limit changes for reporting
let limitsChanged: NonNullable<PatchResult["limits"]> = {};

function collectCurrentLimits(ast: t.File): {
	linesCap?: number;
	lineChars?: number;
	byteCeiling?: number;
	tokenBudget?: number;
} {
	const current: {
		linesCap?: number;
		lineChars?: number;
		byteCeiling?: number;
		tokenBudget?: number;
	} = {};

	traverse.default(ast, {
		TemplateLiteral(path: any) {
			if (current.linesCap !== undefined && current.lineChars !== undefined)
				return;
			const quasis = path.node.quasis;
			const hasTrigger = quasis.some((q: any) =>
				q.value.raw.includes(TRIGGER_PHRASE),
			);
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
		FunctionDeclaration(path: any) {
			if (current.byteCeiling !== undefined) return;
			if (path.node.params.length < 2) return;

			const [fileParam, limitParam] = path.node.params;
			if (!t.isIdentifier(fileParam)) return;
			if (!t.isAssignmentPattern(limitParam)) return;
			if (!t.isIdentifier(limitParam.left)) return;
			if (!t.isIdentifier(limitParam.right)) return;

			const fileParamName = fileParam.name;
			const limitParamName = limitParam.left.name;
			const byteCeilingVarName = limitParam.right.name;

			let isFileSizeCheckFn = false;
			path.traverse({
				BinaryExpression(innerPath: any) {
					const node = innerPath.node;
					if (node.operator !== "<=") return;
					if (!t.isIdentifier(node.right, { name: limitParamName })) return;

					const left = node.left;
					if (!t.isMemberExpression(left)) return;
					if (!t.isIdentifier(left.property, { name: "size" })) return;

					const statCall = left.object;
					if (!t.isCallExpression(statCall)) return;
					if (!t.isMemberExpression(statCall.callee)) return;
					if (!t.isIdentifier(statCall.callee.property, { name: "statSync" }))
						return;
					if (
						statCall.arguments.length < 1 ||
						!t.isIdentifier(statCall.arguments[0], { name: fileParamName })
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
		FunctionDeclaration(path: any) {
			if (current.tokenBudget !== undefined) return;

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

	return current;
}

export const limits: Patch = {
	tag: "limits",

	ast: (ast) => {
		limitsChanged = {};

		patchByteCeiling(ast);
		patchTokenBudget(ast);

		traverse.default(ast, {
			TemplateLiteral(path: any) {
				const quasis = path.node.quasis;
				const hasTrigger = quasis.some((q: any) =>
					q.value.raw.includes(TRIGGER_PHRASE),
				);

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
				FunctionDeclaration(path: any) {
					if (patched) return;
					if (path.node.params.length < 2) return;

					const [fileParam, limitParam] = path.node.params;
					if (!t.isIdentifier(fileParam)) return;
					if (!t.isAssignmentPattern(limitParam)) return;
					if (!t.isIdentifier(limitParam.left)) return;
					if (!t.isIdentifier(limitParam.right)) return;

					const fileParamName = fileParam.name;
					const limitParamName = limitParam.left.name;
					const byteCeilingVarName = limitParam.right.name;

					let isFileSizeCheckFn = false;
					path.traverse({
						BinaryExpression(innerPath: any) {
							const node = innerPath.node;
							if (node.operator !== "<=") return;
							if (!t.isIdentifier(node.right, { name: limitParamName })) return;

							const left = node.left;
							if (!t.isMemberExpression(left)) return;
							if (!t.isIdentifier(left.property, { name: "size" })) return;

							const statCall = left.object;
							if (!t.isCallExpression(statCall)) return;
							if (!t.isMemberExpression(statCall.callee)) return;
							if (
								!t.isIdentifier(statCall.callee.property, {
									name: "statSync",
								})
							)
								return;
							if (
								statCall.arguments.length < 1 ||
								!t.isIdentifier(statCall.arguments[0], {
									name: fileParamName,
								})
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
				FunctionDeclaration(path: any) {
					if (patched) return;

					let hasEnv = false;
					path.traverse({
						MemberExpression(innerPath: any) {
							const node = innerPath.node;
							const prop = node.property;
							const propName =
								(t.isIdentifier(prop) && prop.name) ||
								(t.isStringLiteral(prop) && prop.value) ||
								null;
							if (propName !== "CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS")
								return;
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
							if (!binding || !t.isVariableDeclarator(binding.path.node))
								return;

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
	},

	verify: (_code, ast) => {
		if (!ast) return "Missing AST for limits verification";
		const current = collectCurrentLimits(ast);

		const checks: Array<
			[keyof NonNullable<PatchResult["limits"]>, number, number | undefined]
		> = [
			["linesCap", NEW_LINES_CAP, current.linesCap],
			["lineChars", NEW_LINE_CHARS, current.lineChars],
			["byteCeiling", NEW_BYTE_CEILING, current.byteCeiling],
			["tokenBudget", NEW_TOKEN_BUDGET, current.tokenBudget],
		];

		for (const [key, expected, actual] of checks) {
			if (actual === undefined) return `Could not resolve limit ${key}`;
			if (actual !== expected) {
				return `Limit ${key} has unexpected value: ${actual} (expected ${expected})`;
			}
		}

		return true;
	},
};

export function getLimitsChanged(): PatchResult["limits"] {
	return limitsChanged;
}
