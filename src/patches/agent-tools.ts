import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { PatchContext } from "../types.js";

/**
 * Patch built-in agent configurations:
 * 1. Disable statusline-setup agent (not useful)
 * 2. Convert claude-code-guide from whitelist to blocklist (allows MCP tools)
 */

const AGENTS_TO_DISABLE = new Set(["statusline-setup"]);

// Tools to block for claude-code-guide (prevent file modifications)
const CLAUDE_GUIDE_BLOCKED_TOOLS = ["Write", "Edit", "NotebookEdit"];

/**
 * Resolve a variable name to its string value by following bindings.
 */
function resolveToString(
	path: any,
	node: t.Expression | null | undefined,
): string | null {
	if (!node) return null;
	if (t.isStringLiteral(node)) return node.value;
	if (t.isIdentifier(node)) {
		const binding = path.scope.getBinding(node.name);
		if (binding && t.isVariableDeclarator(binding.path.node)) {
			const init = binding.path.node.init;
			if (t.isStringLiteral(init)) return init.value;
		}
	}
	return null;
}

/**
 * Find the variable name that holds a specific tool string.
 * E.g., find that "Write" is stored in variable "FI".
 */
function findToolVarName(ast: any, toolName: string): string | null {
	let varName: string | null = null;
	traverse.default(ast, {
		VariableDeclarator(path: any) {
			if (varName) return;
			if (
				t.isIdentifier(path.node.id) &&
				t.isStringLiteral(path.node.init) &&
				path.node.init.value === toolName
			) {
				varName = path.node.id.name;
				path.stop();
			}
		},
	});
	return varName;
}

export function patchAgentTools(ast: any, ctx: PatchContext) {
	// First, find variable names for the tools we want to block
	const toolVarNames: Map<string, string> = new Map();
	for (const tool of CLAUDE_GUIDE_BLOCKED_TOOLS) {
		const varName = findToolVarName(ast, tool);
		if (varName) {
			toolVarNames.set(tool, varName);
		}
	}

	traverse.default(ast, {
		ObjectExpression(path: any) {
			const props = path.node.properties;

			// Find agentType property
			const agentTypeProp = props.find(
				(p: any) =>
					t.isObjectProperty(p) &&
					t.isIdentifier(p.key) &&
					p.key.name === "agentType",
			) as t.ObjectProperty | undefined;

			if (!agentTypeProp) return;

			const agentType = resolveToString(path, agentTypeProp.value as any);
			if (!agentType) return;

			// Check if this is a built-in agent (has source: "built-in")
			const sourceProp = props.find(
				(p: any) =>
					t.isObjectProperty(p) &&
					t.isIdentifier(p.key) &&
					p.key.name === "source" &&
					t.isStringLiteral(p.value) &&
					p.value.value === "built-in",
			);
			if (!sourceProp) return;

			// Handle agents to disable
			if (AGENTS_TO_DISABLE.has(agentType)) {
				// Add isEnabled: false property
				const hasIsEnabled = props.some(
					(p: any) =>
						t.isObjectProperty(p) &&
						t.isIdentifier(p.key) &&
						p.key.name === "isEnabled",
				);

				if (!hasIsEnabled) {
					props.push(
						t.objectProperty(
							t.identifier("isEnabled"),
							t.booleanLiteral(false),
						),
					);
					ctx.report.agents_disabled = true;
					console.log(`Disabled agent: ${agentType}`);
				}
				return;
			}

			// Handle claude-code-guide: convert whitelist to blocklist
			if (agentType === "claude-code-guide") {
				// Find and remove the tools property
				const toolsIndex = props.findIndex(
					(p: any) =>
						t.isObjectProperty(p) &&
						t.isIdentifier(p.key) &&
						p.key.name === "tools",
				);

				if (toolsIndex !== -1) {
					// Remove the tools whitelist
					props.splice(toolsIndex, 1);

					// Add disallowedTools blocklist
					const blockedToolNodes: t.Expression[] = [];
					for (const tool of CLAUDE_GUIDE_BLOCKED_TOOLS) {
						const varName = toolVarNames.get(tool);
						if (varName) {
							blockedToolNodes.push(t.identifier(varName));
						} else {
							// Fallback to string literal if variable not found
							blockedToolNodes.push(t.stringLiteral(tool));
						}
					}

					props.push(
						t.objectProperty(
							t.identifier("disallowedTools"),
							t.arrayExpression(blockedToolNodes),
						),
					);

					ctx.report.claude_guide_blocklist = true;
					console.log(
						`Converted claude-code-guide to blocklist: disallowedTools: [${CLAUDE_GUIDE_BLOCKED_TOOLS.join(", ")}]`,
					);
				}
			}
		},
	});

	// Also filter disabled agents from zF0 return array
	traverse.default(ast, {
		FunctionDeclaration(path: any) {
			// Find zF0 function by its structure: returns array with JX1, Ty2, LL, SHA
			if (!path.node.id) return;

			const body = path.node.body;
			if (!t.isBlockStatement(body)) return;

			// Look for: let A = [JX1, Ty2, LL, SHA];
			for (const stmt of body.body) {
				if (!t.isVariableDeclaration(stmt)) continue;

				for (const decl of stmt.declarations) {
					if (!t.isArrayExpression(decl.init)) continue;

					const elements = decl.init.elements;
					if (elements.length < 3) continue;

					// Check if this looks like the built-in agents array
					// by checking if elements are identifiers
					const allIdentifiers = elements.every((el) => t.isIdentifier(el));
					if (!allIdentifiers) continue;

					// Filter out disabled agents by checking their resolved values
					// We need to check which identifier corresponds to statusline-setup (Ty2)
					const filteredElements = elements.filter((el) => {
						if (!t.isIdentifier(el)) return true;

						// Look up the agent definition to see its agentType
						const binding = path.scope.getBinding(el.name);
						if (!binding) return true;

						// Check if this binding's init has agentType: "statusline-setup"
						const bindingPath = binding.path;
						if (!t.isVariableDeclarator(bindingPath.node)) return true;

						const init = bindingPath.node.init;
						if (!t.isObjectExpression(init)) return true;

						const agentTypeProp = init.properties.find(
							(p: any) =>
								t.isObjectProperty(p) &&
								t.isIdentifier(p.key) &&
								p.key.name === "agentType",
						);

						if (!agentTypeProp || !t.isObjectProperty(agentTypeProp))
							return true;

						const agentTypeValue = agentTypeProp.value;
						if (t.isStringLiteral(agentTypeValue)) {
							return !AGENTS_TO_DISABLE.has(agentTypeValue.value);
						}

						return true;
					});

					if (filteredElements.length < elements.length) {
						decl.init.elements = filteredElements;
						ctx.report.agents_filtered = true;
					}
				}
			}
		},
	});
}
