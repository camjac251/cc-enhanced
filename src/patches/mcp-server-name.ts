import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch } from "../types.js";

/**
 * Relaxes the serverName regex in allowedMcpServers and deniedMcpServers schemas
 * to allow colons and dots, so plugin server names (plugin:name:key) can be matched.
 *
 * Without this, deniedMcpServers cannot target plugin MCP servers because their names
 * use the format `plugin:<pluginName>:<serverKey>` which contains colons.
 * The original regex /^[a-zA-Z0-9_-]+$/ rejects colons, causing the entire settings
 * file to be skipped on validation failure.
 */

const OLD_PATTERN = "^[a-zA-Z0-9_-]+$";
const NEW_PATTERN = "^[a-zA-Z0-9_:./-]+$";
const OLD_MESSAGE =
	"Server name can only contain letters, numbers, hyphens, and underscores";
const NEW_MESSAGE =
	"Server name can only contain letters, numbers, hyphens, underscores, colons, dots, and slashes";

function isRegexCall(node: t.CallExpression): boolean {
	if (!t.isMemberExpression(node.callee)) return false;
	return (
		(t.isIdentifier(node.callee.property) &&
			node.callee.property.name === "regex") ||
		(t.isStringLiteral(node.callee.property) &&
			node.callee.property.value === "regex")
	);
}

export const mcpServerName: Patch = {
	tag: "mcp-server-name",

	astPasses: () => [
		{
			pass: "mutate",
			visitor: createMcpServerNameMutator(),
		},
	],

	verify: (_code, ast) => {
		if (!ast) return "Missing AST for mcp-server-name verification";

		let updatedCount = 0;
		let oldValidationCount = 0;

		traverse.default(ast, {
			CallExpression(path) {
				if (!isRegexCall(path.node)) return;
				if (path.node.arguments.length < 2) return;

				const [patternArg, messageArg] = path.node.arguments;
				if (!t.isRegExpLiteral(patternArg)) return;
				if (!t.isStringLiteral(messageArg)) return;
				if (!messageArg.value.includes("Server name can only contain")) return;

				if (
					patternArg.pattern === NEW_PATTERN &&
					messageArg.value === NEW_MESSAGE
				) {
					updatedCount++;
				}
				if (patternArg.pattern === OLD_PATTERN) {
					oldValidationCount++;
				}
			},
		});

		if (oldValidationCount > 0) {
			return "Old MCP serverName regex validation still present";
		}
		if (updatedCount < 1) {
			return "Expected MCP serverName regex updates not found";
		}

		return true;
	},
};

function createMcpServerNameMutator(): traverse.Visitor {
	let patchedCount = 0;
	return {
		CallExpression(path) {
			if (!isRegexCall(path.node)) return;
			if (path.node.arguments.length < 1) return;

			const [patternArg, messageArg] = path.node.arguments;
			if (!t.isRegExpLiteral(patternArg)) return;
			if (!t.isStringLiteral(messageArg)) return;

			const patternNeedsUpdate = patternArg.pattern === OLD_PATTERN;
			const messageNeedsUpdate = messageArg.value === OLD_MESSAGE;
			// Fail closed: only patch the known MCP server-name validator pair.
			if (!patternNeedsUpdate || !messageNeedsUpdate) return;

			path.node.arguments[0] = t.regExpLiteral(NEW_PATTERN);
			path.node.arguments[1] = t.stringLiteral(NEW_MESSAGE);
			patchedCount++;
		},
		Program: {
			exit() {
				if (patchedCount > 0) {
					console.log(
						`Patched ${patchedCount} MCP serverName regex validation(s)`,
					);
				}
			},
		},
	};
}
