import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch } from "../types.js";

/**
 * Increases MCP timeouts from 30/60 seconds to 10 minutes.
 *
 * Two targeted timeouts are patched via AST:
 * 1. MCP_TIMEOUT default (connection timeout) - 30000 -> 600000
 * 2. MCP CLI endpoint request timeout - 30000 -> 600000
 *
 * Note: MCP_TOOL_TIMEOUT (tool execution) already defaults to 1e8 (~27 hours).
 */

const DEFAULT_TIMEOUT = 600000; // 10 minutes

export const mcpTimeout: Patch = {
	tag: "mcp-timeout",

	ast: (ast) => {
		let patchedMcpDefault = false;
		let patchedSetTimeout = false;

		traverse.default(ast, {
			// 1. Patch: parseInt(process.env.MCP_TIMEOUT || "", 10) || 30000
			LogicalExpression(path) {
				if (path.node.operator !== "||") return;
				if (!t.isNumericLiteral(path.node.right, { value: 30000 })) return;

				// Check left side is parseInt(process.env.MCP_TIMEOUT...)
				const left = path.node.left;
				if (!t.isCallExpression(left)) return;
				if (!t.isIdentifier(left.callee, { name: "parseInt" })) return;
				if (left.arguments.length < 1) return;

				const firstArg = left.arguments[0];
				if (!t.isLogicalExpression(firstArg, { operator: "||" })) return;
				if (!t.isMemberExpression(firstArg.left)) return;

				const member = firstArg.left;
				if (!t.isMemberExpression(member.object)) return;
				if (!t.isIdentifier(member.object.object, { name: "process" })) return;
				if (!t.isIdentifier(member.object.property, { name: "env" })) return;
				if (!t.isIdentifier(member.property, { name: "MCP_TIMEOUT" })) return;

				// Replace 30000 with DEFAULT_TIMEOUT
				path.node.right = t.numericLiteral(DEFAULT_TIMEOUT);
				patchedMcpDefault = true;
			},

			// 2. Patch: .setTimeout(30000)
			CallExpression(path) {
				const callee = path.node.callee;
				if (!t.isMemberExpression(callee)) return;
				if (!t.isIdentifier(callee.property, { name: "setTimeout" })) return;
				if (path.node.arguments.length !== 1) return;

				const arg = path.node.arguments[0];
				if (!t.isNumericLiteral(arg, { value: 30000 })) return;

				// Replace with DEFAULT_TIMEOUT
				path.node.arguments[0] = t.numericLiteral(DEFAULT_TIMEOUT);
				patchedSetTimeout = true;
			},
		});

		if (patchedMcpDefault) console.log("Patched MCP_TIMEOUT default to 600000");
		if (patchedSetTimeout) console.log("Patched setTimeout(30000) to 600000");
	},

	verify: (_code, ast) => {
		if (!ast) return "Missing AST for mcp-timeout verification";

		let patchedMcpDefault = 0;
		let oldMcpDefault = 0;
		let patchedSetTimeout = 0;
		let oldSetTimeout = 0;

		traverse.default(ast, {
			LogicalExpression(path) {
				if (path.node.operator !== "||") return;
				if (!t.isNumericLiteral(path.node.right)) return;

				const left = path.node.left;
				if (!t.isCallExpression(left)) return;
				if (!t.isIdentifier(left.callee, { name: "parseInt" })) return;
				if (left.arguments.length < 1) return;

				const firstArg = left.arguments[0];
				if (!t.isLogicalExpression(firstArg, { operator: "||" })) return;
				if (!t.isMemberExpression(firstArg.left)) return;

				const member = firstArg.left;
				if (!t.isMemberExpression(member.object)) return;
				if (!t.isIdentifier(member.object.object, { name: "process" })) return;
				if (!t.isIdentifier(member.object.property, { name: "env" })) return;
				if (!t.isIdentifier(member.property, { name: "MCP_TIMEOUT" })) return;

				if (path.node.right.value === DEFAULT_TIMEOUT) patchedMcpDefault++;
				if (path.node.right.value === 30000) oldMcpDefault++;
			},
			CallExpression(path) {
				const callee = path.node.callee;
				if (!t.isMemberExpression(callee)) return;
				if (!t.isIdentifier(callee.property, { name: "setTimeout" })) return;
				if (path.node.arguments.length !== 1) return;
				if (!t.isNumericLiteral(path.node.arguments[0])) return;

				if (path.node.arguments[0].value === DEFAULT_TIMEOUT)
					patchedSetTimeout++;
				if (path.node.arguments[0].value === 30000) oldSetTimeout++;
			},
		});

		if (patchedMcpDefault < 1) {
			return `Missing MCP_TIMEOUT default patch (${DEFAULT_TIMEOUT})`;
		}
		if (oldMcpDefault > 0) {
			return "Old MCP_TIMEOUT 30000 default still present";
		}
		if (patchedSetTimeout < 1) {
			return `Missing setTimeout patch (${DEFAULT_TIMEOUT})`;
		}
		if (oldSetTimeout > 0) {
			return "Old MCP CLI endpoint 30000 timeout still present";
		}
		return true;
	},
};
