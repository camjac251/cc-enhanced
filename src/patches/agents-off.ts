import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch } from "../types.js";
import {
	getObjectPropertyByName,
	getVerifyAst,
	resolveStringValue,
} from "./ast-helpers.js";

/**
 * Remove built-in agents from the registry that exposes them to the model.
 *
 * The current bundle assembles built-in agents in a central registry function
 * and conditionally pushes optional entries. Filtering that registry is enough;
 * we no longer rewrite agent object definitions themselves.
 */

const AGENTS_TO_DISABLE = new Set(["statusline-setup", "claude-code-guide"]);

function resolveObjectPropertyStringValue(
	path: any,
	prop: t.ObjectMethod | t.ObjectProperty | null | undefined,
): string | null {
	if (!prop || !t.isObjectProperty(prop)) return null;
	return resolveStringValue(path, prop.value as any);
}

function resolveAssignedObjectExpression(
	binding: any,
): t.ObjectExpression | null {
	if (!binding) return null;

	if (t.isVariableDeclarator(binding.path.node) && binding.path.node.init) {
		if (t.isObjectExpression(binding.path.node.init)) {
			return binding.path.node.init;
		}
		if (t.isCallExpression(binding.path.node.init)) {
			const firstArg = binding.path.node.init.arguments[0];
			if (t.isObjectExpression(firstArg)) return firstArg;
		}
	}

	for (const violation of binding.constantViolations) {
		if (!violation.isAssignmentExpression()) continue;
		if (t.isObjectExpression(violation.node.right)) return violation.node.right;
		if (t.isCallExpression(violation.node.right)) {
			const firstArg = violation.node.right.arguments[0];
			if (t.isObjectExpression(firstArg)) return firstArg;
		}
	}

	return null;
}

function resolveBuiltInAgentType(scope: any, name: string): string | null {
	const binding = scope.getBinding(name);
	const init = resolveAssignedObjectExpression(binding);
	if (!init) return null;

	const agentTypeProp = getObjectPropertyByName(init, "agentType");
	const sourceProp = getObjectPropertyByName(init, "source");
	if (
		resolveObjectPropertyStringValue(binding.path, sourceProp) !== "built-in"
	) {
		return null;
	}

	return resolveObjectPropertyStringValue(binding.path, agentTypeProp);
}

function collectReturnedIdentifiers(fnPath: any): Set<string> {
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
}

function createAgentRegistryMutator(): traverse.Visitor {
	let foundRegistry = false;

	return {
		Function(path: any) {
			const body = path.node.body;
			if (!t.isBlockStatement(body)) return;

			const returnedIdentifiers = collectReturnedIdentifiers(path);
			if (returnedIdentifiers.size === 0) return;

			for (const stmt of body.body) {
				if (!t.isVariableDeclaration(stmt)) continue;

				for (const decl of stmt.declarations) {
					if (!t.isIdentifier(decl.id) || !t.isArrayExpression(decl.init)) {
						continue;
					}
					if (!returnedIdentifiers.has(decl.id.name)) continue;

					let sawBuiltInAgent = false;
					decl.init.elements = decl.init.elements.filter((element) => {
						if (!t.isIdentifier(element)) return true;
						const agentType = resolveBuiltInAgentType(path.scope, element.name);
						if (!agentType) return true;
						sawBuiltInAgent = true;
						return !AGENTS_TO_DISABLE.has(agentType);
					});

					const arrayVarName = decl.id.name;
					path.traverse({
						CallExpression(pushPath: any) {
							const callee = pushPath.node.callee;
							if (!t.isMemberExpression(callee)) return;
							if (!t.isIdentifier(callee.object, { name: arrayVarName })) {
								return;
							}
							if (
								!t.isIdentifier(callee.property, { name: "push" }) &&
								!t.isStringLiteral(callee.property, { value: "push" })
							) {
								return;
							}

							let sawBuiltInPush = false;
							const filteredArgs = pushPath.node.arguments.filter(
								(arg: t.Expression) => {
									if (!t.isIdentifier(arg)) return true;
									const agentType = resolveBuiltInAgentType(
										pushPath.scope,
										arg.name,
									);
									if (!agentType) return true;
									sawBuiltInPush = true;
									return !AGENTS_TO_DISABLE.has(agentType);
								},
							);

							if (!sawBuiltInPush) return;
							sawBuiltInAgent = true;

							if (filteredArgs.length === 0) {
								const exprStmt = pushPath.parentPath;
								if (exprStmt?.isExpressionStatement()) {
									exprStmt.remove();
								}
								return;
							}

							if (filteredArgs.length < pushPath.node.arguments.length) {
								pushPath.node.arguments = filteredArgs;
							}
						},
					});

					if (sawBuiltInAgent) {
						foundRegistry = true;
					}
				}
			}
		},
		Program: {
			exit() {
				if (!foundRegistry) {
					console.warn(
						"agents-off: Could not find built-in agent registry to filter",
					);
				}
			},
		},
	};
}

function verifyBuiltInAgentRegistry(ast: t.File): true | string {
	const foundDefinitions = new Set<string>();
	let foundRegistry = false;
	let leakedAgentType: string | null = null;

	traverse.default(ast, {
		ObjectExpression(path: any) {
			const agentTypeProp = getObjectPropertyByName(path.node, "agentType");
			if (!agentTypeProp || !t.isObjectProperty(agentTypeProp)) return;

			const agentType = resolveStringValue(path, agentTypeProp.value as any);
			if (!agentType || !AGENTS_TO_DISABLE.has(agentType)) return;

			const sourceProp = getObjectPropertyByName(path.node, "source");
			if (resolveObjectPropertyStringValue(path, sourceProp) !== "built-in") {
				return;
			}

			foundDefinitions.add(agentType);
		},
		Function(path: any) {
			if (leakedAgentType) {
				path.stop();
				return;
			}
			if (!t.isBlockStatement(path.node.body)) return;

			const returnedIdentifiers = collectReturnedIdentifiers(path);
			if (returnedIdentifiers.size === 0) return;

			for (const stmt of path.node.body.body) {
				if (!t.isVariableDeclaration(stmt)) continue;

				for (const decl of stmt.declarations) {
					if (!t.isIdentifier(decl.id) || !t.isArrayExpression(decl.init)) {
						continue;
					}
					if (!returnedIdentifiers.has(decl.id.name)) continue;

					for (const element of decl.init.elements) {
						if (!t.isIdentifier(element)) continue;
						const agentType = resolveBuiltInAgentType(path.scope, element.name);
						if (!agentType) continue;
						foundRegistry = true;
						if (AGENTS_TO_DISABLE.has(agentType)) {
							leakedAgentType = agentType;
							path.stop();
							return;
						}
					}

					const arrayVarName = decl.id.name;
					path.traverse({
						CallExpression(pushPath: any) {
							if (leakedAgentType) {
								pushPath.stop();
								return;
							}

							const callee = pushPath.node.callee;
							if (!t.isMemberExpression(callee)) return;
							if (!t.isIdentifier(callee.object, { name: arrayVarName })) {
								return;
							}
							if (
								!t.isIdentifier(callee.property, { name: "push" }) &&
								!t.isStringLiteral(callee.property, { value: "push" })
							) {
								return;
							}

							for (const arg of pushPath.node.arguments) {
								if (!t.isIdentifier(arg)) continue;
								const agentType = resolveBuiltInAgentType(
									pushPath.scope,
									arg.name,
								);
								if (!agentType) continue;
								foundRegistry = true;
								if (AGENTS_TO_DISABLE.has(agentType)) {
									leakedAgentType = agentType;
									pushPath.stop();
									path.stop();
									return;
								}
							}
						},
					});
				}
			}
		},
	});

	for (const agentType of AGENTS_TO_DISABLE) {
		if (!foundDefinitions.has(agentType)) {
			return `${agentType} built-in agent definition not found`;
		}
	}
	if (!foundRegistry) {
		return "Built-in agent registry not found";
	}
	if (leakedAgentType) {
		return `Disabled agent "${leakedAgentType}" still present in built-in agent registry`;
	}
	return true;
}

export const agentTools: Patch = {
	tag: "agents-off",

	astPasses: () => [{ pass: "mutate", visitor: createAgentRegistryMutator() }],

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) return "Missing AST for agents-off verification";
		return verifyBuiltInAgentRegistry(verifyAst);
	},
};
