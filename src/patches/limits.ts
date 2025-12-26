import traverse from "@babel/traverse";
import * as t from "@babel/types";
import { print } from "../loader.js";
import type { PatchContext } from "../types.js";

const NEW_LINES_CAP = 5000;
const NEW_LINE_CHARS = 5000;
const NEW_BYTE_CEILING = 1048576;
const NEW_TOKEN_BUDGET = 50000;

const TRIGGER_PHRASE = "Reads a file from the local filesystem";

export function bumpLimits(ast: any, ctx: PatchContext) {
	traverse.default(ast, {
		VariableDeclarator(path: any) {
			const node = path.node;
			if (t.isLiteral(node.init)) {
				const val = (node.init as any).value;
				if (val === 262144) {
					node.init = t.numericLiteral(NEW_BYTE_CEILING);
					if (t.isIdentifier(node.id)) {
						ctx.report.byte_ceiling_bumped = [
							node.id.name,
							String(NEW_BYTE_CEILING),
						];
					}
				} else if (val === 25000 || val === 2.5e4) {
					node.init = t.numericLiteral(NEW_TOKEN_BUDGET);
					if (t.isIdentifier(node.id)) {
						ctx.report.token_budget_bumped = [
							node.id.name,
							String(NEW_TOKEN_BUDGET),
						];
					}
				}
			}
		},

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
							updateVarValue(
								ast,
								linesVarName,
								NEW_LINES_CAP,
								ctx,
								"lines_cap_bumped",
							);
						}
					}
					if (q.includes("longer than ")) {
						if (i < exprs.length && t.isIdentifier(exprs[i])) {
							const charsVarName = (exprs[i] as any).name;
							updateVarValue(
								ast,
								charsVarName,
								NEW_LINE_CHARS,
								ctx,
								"line_chars_bumped",
							);
						}
					}
				}
			}
		},

		FunctionDeclaration(path: any) {
			const node = path.node;
			if (node.body.body.length !== 2) return;

			const lastStmt = node.body.body[1];
			if (!t.isReturnStatement(lastStmt)) return;
			if (
				!t.isNumericLiteral(lastStmt.argument) ||
				lastStmt.argument.value !== 200000
			)
				return;

			const firstStmt = node.body.body[0];
			if (!t.isIfStatement(firstStmt)) return;

			if (!t.isReturnStatement(firstStmt.consequent)) return;
			if (
				!t.isNumericLiteral(firstStmt.consequent.argument) ||
				firstStmt.consequent.argument.value !== 1000000
			)
				return;

			const envCheck = t.ifStatement(
				t.memberExpression(
					t.memberExpression(t.identifier("process"), t.identifier("env")),
					t.identifier("API_MAX_INPUT_TOKENS"),
				),
				t.returnStatement(
					t.callExpression(t.identifier("parseInt"), [
						t.memberExpression(
							t.memberExpression(t.identifier("process"), t.identifier("env")),
							t.identifier("API_MAX_INPUT_TOKENS"),
						),
					]),
				),
			);

			node.body.body.unshift(envCheck);
			ctx.report.context_size_patched = true;
		},
	});
}

function updateVarValue(
	ast: any,
	varName: string,
	newValue: number,
	ctx: PatchContext,
	reportKey: keyof PatchContext["report"],
) {
	traverse.default(ast, {
		VariableDeclarator(path: any) {
			if (t.isIdentifier(path.node.id) && path.node.id.name === varName) {
				path.node.init = t.numericLiteral(newValue);
				(ctx.report as any)[reportKey] = [varName, String(newValue)];
				path.stop();
			}
		},
		AssignmentExpression(path: any) {
			if (t.isIdentifier(path.node.left) && path.node.left.name === varName) {
				path.node.right = t.numericLiteral(newValue);
				(ctx.report as any)[reportKey] = [varName, String(newValue)];
				// Don't stop here, assignment might happen multiple times? usually init is once.
			}
		},
	});
}
