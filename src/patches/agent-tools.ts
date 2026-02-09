import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch } from "../types.js";
import { isFalseLike, resolveStringValue } from "./ast-helpers.js";

/**
 * Patch built-in agent configurations:
 * 1. Disable statusline-setup agent
 * 2. Convert claude-code-guide from whitelist to blocklist
 */

const AGENTS_TO_DISABLE = new Set(["statusline-setup"]);
const CLAUDE_GUIDE_BLOCKED_TOOLS = ["Write", "Edit", "NotebookEdit"];

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

// Coupling: disable-tools.ts also interacts with NotebookEdit (disables it
// globally via isEnabled), while this patch blocks it from the claude-code-guide
// agent specifically via disallowedTools.

export const agentTools: Patch = {
	tag: "agents-off",

	ast: (ast) => {
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

				const agentTypeProp = props.find(
					(p: any) =>
						t.isObjectProperty(p) &&
						t.isIdentifier(p.key) &&
						p.key.name === "agentType",
				) as t.ObjectProperty | undefined;

				if (!agentTypeProp) return;

				const agentType = resolveStringValue(path, agentTypeProp.value as any);
				if (!agentType) return;

				const sourceProp = props.find(
					(p: any) =>
						t.isObjectProperty(p) &&
						t.isIdentifier(p.key) &&
						p.key.name === "source" &&
						t.isStringLiteral(p.value) &&
						p.value.value === "built-in",
				);
				if (!sourceProp) return;

				if (AGENTS_TO_DISABLE.has(agentType)) {
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
						console.log(`Disabled agent: ${agentType}`);
					}
					return;
				}

				if (agentType === "claude-code-guide") {
					const toolsIndex = props.findIndex(
						(p: any) =>
							t.isObjectProperty(p) &&
							t.isIdentifier(p.key) &&
							p.key.name === "tools",
					);

					if (toolsIndex !== -1) {
						props.splice(toolsIndex, 1);

						const blockedToolNodes: t.Expression[] = [];
						for (const tool of CLAUDE_GUIDE_BLOCKED_TOOLS) {
							const varName = toolVarNames.get(tool);
							if (varName) {
								blockedToolNodes.push(t.identifier(varName));
							} else {
								blockedToolNodes.push(t.stringLiteral(tool));
							}
						}

						props.push(
							t.objectProperty(
								t.identifier("disallowedTools"),
								t.arrayExpression(blockedToolNodes),
							),
						);

						console.log(
							`Converted claude-code-guide to blocklist: disallowedTools: [${CLAUDE_GUIDE_BLOCKED_TOOLS.join(", ")}]`,
						);
					}
				}
			},
		});

		// Filter disabled agents from return array
		traverse.default(ast, {
			FunctionDeclaration(path: any) {
				if (!path.node.id) return;

				const body = path.node.body;
				if (!t.isBlockStatement(body)) return;

				for (const stmt of body.body) {
					if (!t.isVariableDeclaration(stmt)) continue;

					for (const decl of stmt.declarations) {
						if (!t.isArrayExpression(decl.init)) continue;

						const elements = decl.init.elements;
						if (elements.length < 3) continue;

						const allIdentifiers = elements.every((el) => t.isIdentifier(el));
						if (!allIdentifiers) continue;

						const filteredElements = elements.filter((el) => {
							if (!t.isIdentifier(el)) return true;

							const binding = path.scope.getBinding(el.name);
							if (!binding) return true;

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
						}
					}
				}
			},
		});
	},

	verify: (_code, ast) => {
		if (!ast) return "Missing AST for agents-off verification";

		let statuslineFound = false;
		let statuslineDisabled = false;
		let guideFound = false;
		let guideHasToolsAllowlist = false;
		const guideBlockedTools = new Set<string>();

		traverse.default(ast, {
			ObjectExpression(path: any) {
				const props = path.node.properties;

				const agentTypeProp = props.find(
					(p: any) =>
						t.isObjectProperty(p) &&
						t.isIdentifier(p.key) &&
						p.key.name === "agentType",
				) as t.ObjectProperty | undefined;
				if (!agentTypeProp) return;

				const agentType = resolveStringValue(path, agentTypeProp.value as any);
				if (!agentType) return;

				const sourceProp = props.find(
					(p: any) =>
						t.isObjectProperty(p) &&
						t.isIdentifier(p.key) &&
						p.key.name === "source" &&
						t.isStringLiteral(p.value) &&
						p.value.value === "built-in",
				);
				if (!sourceProp) return;

				if (agentType === "statusline-setup") {
					statuslineFound = true;

					const isEnabledProp = props.find(
						(p: any) =>
							(t.isObjectProperty(p) || t.isObjectMethod(p)) &&
							t.isIdentifier(p.key, { name: "isEnabled" }),
					) as t.ObjectProperty | t.ObjectMethod | undefined;

					if (
						t.isObjectProperty(isEnabledProp) &&
						isFalseLike(isEnabledProp.value)
					) {
						statuslineDisabled = true;
					} else if (t.isObjectMethod(isEnabledProp)) {
						const firstStmt = isEnabledProp.body.body[0];
						if (
							t.isReturnStatement(firstStmt) &&
							isFalseLike(firstStmt.argument)
						) {
							statuslineDisabled = true;
						}
					}
					return;
				}

				if (agentType !== "claude-code-guide") return;
				guideFound = true;

				guideHasToolsAllowlist = props.some(
					(p: any) =>
						t.isObjectProperty(p) &&
						t.isIdentifier(p.key) &&
						p.key.name === "tools",
				);

				const disallowedProp = props.find(
					(p: any) =>
						t.isObjectProperty(p) &&
						t.isIdentifier(p.key, { name: "disallowedTools" }) &&
						t.isArrayExpression(p.value),
				) as t.ObjectProperty | undefined;
				if (!disallowedProp || !t.isArrayExpression(disallowedProp.value))
					return;

				for (const el of disallowedProp.value.elements) {
					if (t.isStringLiteral(el)) {
						guideBlockedTools.add(el.value);
						continue;
					}

					if (!t.isIdentifier(el)) continue;
					const binding = path.scope.getBinding(el.name);
					if (!binding || !t.isVariableDeclarator(binding.path.node)) continue;
					if (!t.isStringLiteral(binding.path.node.init)) continue;
					guideBlockedTools.add(binding.path.node.init.value);
				}
			},
		});

		if (!statuslineFound) {
			return "statusline-setup built-in agent not found";
		}
		if (!statuslineDisabled) {
			return "statusline-setup agent is not disabled via isEnabled";
		}
		if (!guideFound) {
			return "claude-code-guide built-in agent not found";
		}
		if (guideHasToolsAllowlist) {
			return "claude-code-guide still has tools allowlist";
		}
		for (const tool of CLAUDE_GUIDE_BLOCKED_TOOLS) {
			if (!guideBlockedTools.has(tool)) {
				return `claude-code-guide disallowedTools missing ${tool}`;
			}
		}
		return true;
	},
};
