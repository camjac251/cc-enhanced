import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch } from "../types.js";
import {
	getObjectKeyName,
	getObjectPropertyByName,
	isFalseLike,
	resolveStringValue,
} from "./ast-helpers.js";

/**
 * Patch built-in agent configurations:
 * 1. Disable statusline-setup agent
 * 2. Disable claude-code-guide agent
 */

const AGENTS_TO_DISABLE = new Set(["statusline-setup", "claude-code-guide"]);

function resolveObjectPropertyStringValue(
	path: any,
	prop: t.ObjectMethod | t.ObjectProperty | null | undefined,
): string | null {
	if (!prop || !t.isObjectProperty(prop)) return null;
	return resolveStringValue(path, prop.value as any);
}

function forceIsEnabledFalse(
	props: Array<t.ObjectMethod | t.ObjectProperty | t.SpreadElement>,
): void {
	let patched = false;
	for (const prop of props) {
		if (
			t.isObjectProperty(prop) &&
			getObjectKeyName(prop.key) === "isEnabled"
		) {
			prop.value = t.booleanLiteral(false);
			patched = true;
			continue;
		}

		if (t.isObjectMethod(prop) && getObjectKeyName(prop.key) === "isEnabled") {
			prop.params = [];
			prop.body = t.blockStatement([
				t.returnStatement(t.booleanLiteral(false)),
			]);
			patched = true;
		}
	}

	if (!patched) {
		props.push(
			t.objectProperty(t.identifier("isEnabled"), t.booleanLiteral(false)),
		);
	}
}

function createAgentToolVarDiscoverer(
	_toolVarNames: Map<string, string>,
): traverse.Visitor {
	return {
		VariableDeclarator() {},
	};
}

function createAgentObjectMutator(
	_toolVarNames: Map<string, string>,
): traverse.Visitor {
	return {
		ObjectExpression(path: any) {
			const props = path.node.properties;

			const agentTypeProp = getObjectPropertyByName(path.node, "agentType");

			if (!agentTypeProp) return;
			if (!t.isObjectProperty(agentTypeProp)) return;

			const agentType = resolveStringValue(path, agentTypeProp.value as any);
			if (!agentType) return;

			const sourceProp = getObjectPropertyByName(path.node, "source");
			if (resolveObjectPropertyStringValue(path, sourceProp) !== "built-in")
				return;

			if (AGENTS_TO_DISABLE.has(agentType)) {
				forceIsEnabledFalse(props);
				console.log(`Disabled agent: ${agentType}`);
				return;
			}
		},
	};
}

function createAgentArrayFilterMutator(): traverse.Visitor {
	const collectReturnedIdentifiers = (fnPath: any): Set<string> => {
		const returned = new Set<string>();

		const visit = (expr: t.Expression | null | undefined): void => {
			if (!expr) return;
			if (t.isIdentifier(expr)) {
				returned.add(expr.name);
				return;
			}
			if (t.isParenthesizedExpression(expr)) {
				visit(expr.expression);
				return;
			}
			if (t.isConditionalExpression(expr)) {
				visit(expr.consequent);
				visit(expr.alternate);
				return;
			}
			if (t.isLogicalExpression(expr)) {
				if (t.isExpression(expr.left)) visit(expr.left);
				if (t.isExpression(expr.right)) visit(expr.right);
				return;
			}
			if (t.isSequenceExpression(expr)) {
				for (const sequenceExpr of expr.expressions) {
					if (t.isExpression(sequenceExpr)) visit(sequenceExpr);
				}
			}
		};

		fnPath.traverse({
			ReturnStatement(returnPath: any) {
				if (returnPath.getFunctionParent() !== fnPath) return;
				if (!returnPath.node.argument) return;
				if (!t.isExpression(returnPath.node.argument)) return;
				visit(returnPath.node.argument);
			},
		});

		return returned;
	};

	return {
		Function(path: any) {
			const body = path.node.body;
			if (!t.isBlockStatement(body)) return;
			const returnedIdentifiers = collectReturnedIdentifiers(path);

			for (const stmt of body.body) {
				if (!t.isVariableDeclaration(stmt)) continue;

				for (const decl of stmt.declarations) {
					if (!t.isArrayExpression(decl.init)) continue;
					if (!t.isIdentifier(decl.id)) continue;
					if (!returnedIdentifiers.has(decl.id.name)) continue;

					const elements = decl.init.elements;

					const filteredElements = elements.filter((el) => {
						if (!t.isIdentifier(el)) return true;

						let resolvedAgentType: string | null = null;
						let isBuiltIn = false;

						const binding = path.scope.getBinding(el.name);
						if (!binding) return true;

						const bindingPath = binding.path;
						if (!t.isVariableDeclarator(bindingPath.node)) return true;

						let init = bindingPath.node.init;

						// Handle lazy init pattern: var X; var Y = J(() => { X = {...} })
						// The binding's init is undefined; the actual object is assigned
						// inside a J() callback. Follow the constant violations to find it.
						if (!t.isObjectExpression(init)) {
							for (const violation of binding.constantViolations) {
								if (
									violation.isAssignmentExpression() &&
									t.isObjectExpression(violation.node.right)
								) {
									init = violation.node.right;
									break;
								}
							}
						}
						if (!t.isObjectExpression(init)) return true;

						const agentTypeProp = getObjectPropertyByName(init, "agentType");
						resolvedAgentType = resolveObjectPropertyStringValue(
							bindingPath,
							agentTypeProp,
						);

						const sourceProp = getObjectPropertyByName(init, "source");
						isBuiltIn =
							resolveObjectPropertyStringValue(bindingPath, sourceProp) ===
							"built-in";

						if (!resolvedAgentType || !isBuiltIn) return true;
						return !AGENTS_TO_DISABLE.has(resolvedAgentType);
					});

					if (filteredElements.length < elements.length) {
						decl.init.elements = filteredElements;
					}

					// Also handle .push() calls on the same array variable.
					// Pattern: H.push(e7f) where e7f is a disabled agent.
					const arrayVarName = decl.id.name;
					path.traverse({
						CallExpression(pushPath: any) {
							const callee = pushPath.node.callee;
							if (!t.isMemberExpression(callee)) return;
							if (!t.isIdentifier(callee.object, { name: arrayVarName }))
								return;
							if (
								!t.isIdentifier(callee.property, { name: "push" }) &&
								!t.isStringLiteral(callee.property, { value: "push" })
							)
								return;

							const filteredArgs = pushPath.node.arguments.filter(
								(arg: t.Expression) => {
									if (!t.isIdentifier(arg)) return true;
									const argBinding = path.scope.getBinding(arg.name);
									if (!argBinding) return true;
									if (!t.isVariableDeclarator(argBinding.path.node))
										return true;

									let argInit = argBinding.path.node.init;
									if (!t.isObjectExpression(argInit)) {
										for (const v of argBinding.constantViolations) {
											if (
												v.isAssignmentExpression() &&
												t.isObjectExpression(v.node.right)
											) {
												argInit = v.node.right;
												break;
											}
										}
									}
									if (!t.isObjectExpression(argInit)) return true;

									const agentTypeProp = getObjectPropertyByName(
										argInit,
										"agentType",
									);
									const agentType = resolveObjectPropertyStringValue(
										argBinding.path,
										agentTypeProp,
									);
									const sourceProp = getObjectPropertyByName(argInit, "source");
									const isBI =
										resolveObjectPropertyStringValue(
											argBinding.path,
											sourceProp,
										) === "built-in";

									if (!agentType || !isBI) return true;
									return !AGENTS_TO_DISABLE.has(agentType);
								},
							);

							if (filteredArgs.length === 0) {
								// Remove the entire push statement
								const exprStmt = pushPath.parentPath;
								if (exprStmt?.isExpressionStatement()) {
									exprStmt.remove();
								}
							} else if (filteredArgs.length < pushPath.node.arguments.length) {
								pushPath.node.arguments = filteredArgs;
							}
						},
					});
				}
			}
		},
	};
}

export const agentTools: Patch = {
	tag: "agents-off",

	astPasses: () => {
		const toolVarNames: Map<string, string> = new Map();
		return [
			{
				pass: "discover",
				visitor: createAgentToolVarDiscoverer(toolVarNames),
			},
			{
				pass: "mutate",
				visitor: createAgentObjectMutator(toolVarNames),
			},
			{
				pass: "mutate",
				visitor: createAgentArrayFilterMutator(),
			},
		];
	},

	verify: (_code, ast) => {
		if (!ast) return "Missing AST for agents-off verification";

		let statuslineFound = false;
		let statuslineDisabled = false;
		let guideFound = false;
		let guideDisabled = false;

		traverse.default(ast, {
			ObjectExpression(path: any) {
				const props = path.node.properties;

				const agentTypeProp = getObjectPropertyByName(path.node, "agentType");
				if (!agentTypeProp) return;
				if (!t.isObjectProperty(agentTypeProp)) return;

				const agentType = resolveStringValue(path, agentTypeProp.value as any);
				if (!agentType) return;

				const sourceProp = getObjectPropertyByName(path.node, "source");
				if (resolveObjectPropertyStringValue(path, sourceProp) !== "built-in")
					return;

				if (agentType === "statusline-setup") {
					statuslineFound = true;

					const isEnabledProp = props.find(
						(p: any) =>
							(t.isObjectProperty(p) || t.isObjectMethod(p)) &&
							getObjectKeyName(p.key) === "isEnabled",
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

				const isEnabledProp = props.find(
					(p: any) =>
						(t.isObjectProperty(p) || t.isObjectMethod(p)) &&
						getObjectKeyName(p.key) === "isEnabled",
				) as t.ObjectProperty | t.ObjectMethod | undefined;

				if (
					t.isObjectProperty(isEnabledProp) &&
					isFalseLike(isEnabledProp.value)
				) {
					guideDisabled = true;
				} else if (t.isObjectMethod(isEnabledProp)) {
					const firstStmt = isEnabledProp.body.body[0];
					if (
						t.isReturnStatement(firstStmt) &&
						isFalseLike(firstStmt.argument)
					) {
						guideDisabled = true;
					}
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
		if (!guideDisabled) {
			return "claude-code-guide agent is not disabled via isEnabled";
		}
		return true;
	},
};
