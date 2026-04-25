import * as t from "@babel/types";
import { template, traverse, type Visitor } from "../babel.js";
import type { Patch } from "../types.js";

/**
 * Carves out an opt-in allowlist for MCP servers that bypass tool-search deferral.
 *
 * Tool names follow `mcp__<server>__<tool>`. When CLAUDE_ALWAYS_LOAD_MCP is set
 * to a comma-separated server list, any tool whose `<server>` segment matches
 * is treated as `alwaysLoad`, keeping its schema in the active tool list under
 * any ENABLE_TOOL_SEARCH mode.
 *
 * Targets `qp` (`isDeferredTool`) at the original cli.js line ~201982. The
 * function's first two statements are:
 *   if (H.alwaysLoad === !0) return !1;
 *   if (H.isMcp === !0) return !0;
 * The patch inserts a new check between them.
 */

function isLiteralTrue(node: t.Node | null | undefined): boolean {
	if (!node) return false;
	if (t.isBooleanLiteral(node)) return node.value === true;
	if (
		t.isUnaryExpression(node) &&
		node.operator === "!" &&
		t.isNumericLiteral(node.argument)
	)
		return node.argument.value === 0;
	return false;
}

function isLiteralFalse(node: t.Node | null | undefined): boolean {
	if (!node) return false;
	if (t.isBooleanLiteral(node)) return node.value === false;
	if (
		t.isUnaryExpression(node) &&
		node.operator === "!" &&
		t.isNumericLiteral(node.argument)
	)
		return node.argument.value === 1;
	return false;
}

function isPropertyEquals(
	expr: t.Expression | t.PrivateName,
	objectName: string,
	propertyName: string,
): boolean {
	if (!t.isMemberExpression(expr)) return false;
	if (!t.isIdentifier(expr.object) || expr.object.name !== objectName)
		return false;
	if (!t.isIdentifier(expr.property) || expr.property.name !== propertyName)
		return false;
	return true;
}

interface MatchInfo {
	paramName: string;
	insertIdx: number;
}

function findTargetFunction(body: t.Statement[]): MatchInfo | null {
	for (let i = 0; i + 1 < Math.min(body.length, 4); i++) {
		const a = body[i];
		if (!t.isIfStatement(a)) continue;
		if (!t.isBinaryExpression(a.test) || a.test.operator !== "===") continue;
		if (!t.isMemberExpression(a.test.left)) continue;
		if (!t.isIdentifier(a.test.left.object)) continue;
		if (
			!t.isIdentifier(a.test.left.property) ||
			a.test.left.property.name !== "alwaysLoad"
		)
			continue;
		if (!isLiteralTrue(a.test.right)) continue;
		if (
			!t.isReturnStatement(a.consequent) ||
			!isLiteralFalse(a.consequent.argument)
		)
			continue;

		const paramName = a.test.left.object.name;
		const b = body[i + 1];
		if (!t.isIfStatement(b)) continue;
		if (!t.isBinaryExpression(b.test) || b.test.operator !== "===") continue;
		if (!isPropertyEquals(b.test.left, paramName, "isMcp")) continue;
		if (!isLiteralTrue(b.test.right)) continue;
		if (
			!t.isReturnStatement(b.consequent) ||
			!isLiteralTrue(b.consequent.argument)
		)
			continue;

		return { paramName, insertIdx: i + 1 };
	}
	return null;
}

const buildAllowlistCheck = template.statement(
	`
	if (PARAM.isMcp === true && process.env.CLAUDE_ALWAYS_LOAD_MCP) {
		var __cclm_n = PARAM.name;
		if (typeof __cclm_n === "string" && __cclm_n.indexOf("mcp__") === 0) {
			var __cclm_s = __cclm_n.slice(5).split("__")[0];
			var __cclm_l = process.env.CLAUDE_ALWAYS_LOAD_MCP.split(",");
			for (var __cclm_i = 0; __cclm_i < __cclm_l.length; __cclm_i++) {
				if (__cclm_l[__cclm_i].trim() === __cclm_s) return false;
			}
		}
	}
`,
	{
		placeholderPattern: false,
		placeholderWhitelist: new Set(["PARAM"]),
	},
);

function createMutator(): Visitor {
	return {
		"FunctionDeclaration|FunctionExpression"(path) {
			const fn = path.node as t.FunctionDeclaration | t.FunctionExpression;
			if (!t.isBlockStatement(fn.body)) return;
			const match = findTargetFunction(fn.body.body);
			if (!match) return;

			const stmt = buildAllowlistCheck({
				PARAM: t.identifier(match.paramName),
			}) as t.Statement;
			fn.body.body.splice(match.insertIdx, 0, stmt);
		},
	};
}

export const alwaysLoadMcp: Patch = {
	tag: "always-load-mcp",

	astPasses: () => [{ pass: "mutate", visitor: createMutator() }],

	verify: (_code, ast) => {
		if (!ast) return "Missing AST for always-load-mcp verification";

		let envRefs = 0;
		traverse(ast, {
			Identifier(path) {
				if (path.node.name !== "CLAUDE_ALWAYS_LOAD_MCP") return;
				const parent = path.parent;
				if (!t.isMemberExpression(parent) || parent.property !== path.node)
					return;
				envRefs++;
			},
		});

		if (envRefs < 2)
			return `Expected at least 2 process.env.CLAUDE_ALWAYS_LOAD_MCP references, got ${envRefs}`;

		return true;
	},
};
