import * as t from "@babel/types";
import { traverse, type Visitor } from "../babel.js";
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
		let mismatchedShape = false;

		traverse(ast, {
			CallExpression(path) {
				if (!isRegexCall(path.node)) return;
				if (path.node.arguments.length < 2) return;

				const [patternArg, messageArg] = path.node.arguments;
				if (!t.isRegExpLiteral(patternArg)) return;
				if (!t.isStringLiteral(messageArg)) return;

				// Catch the corrupting shape: OLD_PATTERN + Server-name message OR
				// any OLD_PATTERN whose paired message starts with the server-name
				// prefix. The previous check required the message to also be the
				// exact old message, so partial upstream rewording defeated it.
				if (patternArg.pattern === OLD_PATTERN) {
					if (
						messageArg.value === OLD_MESSAGE ||
						messageArg.value.includes("Server name can only contain")
					) {
						oldValidationCount++;
					}
					return;
				}

				if (patternArg.pattern !== NEW_PATTERN) return;
				if (!messageArg.value.includes("Server name can only contain")) {
					return;
				}
				if (messageArg.value !== NEW_MESSAGE) {
					mismatchedShape = true;
					return;
				}
				updatedCount++;
			},
		});

		if (oldValidationCount > 0) {
			return `Old MCP serverName regex validation still present (${oldValidationCount} site(s))`;
		}
		if (mismatchedShape) {
			return "MCP serverName regex pattern was updated but the validator message does not match the patched wording";
		}
		// Anchor the site count. Upstream ships exactly two schemas that share
		// this validator (allowedMcpServers and deniedMcpServers). A drop to
		// one means our mutation only landed in half the call sites; a single
		// updated site silently lets the other schema reject plugin names.
		if (updatedCount < 2) {
			return `Expected MCP serverName regex updates on both allowedMcpServers and deniedMcpServers schemas; found ${updatedCount}`;
		}

		return true;
	},
};

function createMcpServerNameMutator(): Visitor {
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
