import * as t from "@babel/types";
import { traverse, type Visitor } from "../babel.js";
import type { Patch } from "../types.js";
import { getObjectKeyName, getVerifyAst } from "./ast-helpers.js";

/**
 * Ensure the superseded built-in security review command stays unavailable.
 *
 * If the current bundle still assembles it in a central registry array, we
 * remove it there instead of rewriting disabled stubs. If the bundle already
 * omits it entirely, this patch becomes a no-op and verification should pass.
 */

const COMMANDS_TO_DISABLE = new Set(["security-review"]);

function getCommandNameFromObject(obj: t.ObjectExpression): string | null {
	for (const prop of obj.properties) {
		if (
			t.isObjectProperty(prop) &&
			getObjectKeyName(prop.key) === "name" &&
			t.isStringLiteral(prop.value)
		) {
			return prop.value.value;
		}
	}
	return null;
}

function resolveAssignedCommandExpression(
	binding: any,
): t.ObjectExpression | t.CallExpression | null {
	if (!binding) return null;

	if (t.isVariableDeclarator(binding.path.node) && binding.path.node.init) {
		if (
			t.isObjectExpression(binding.path.node.init) ||
			t.isCallExpression(binding.path.node.init)
		) {
			return binding.path.node.init;
		}
	}

	for (const violation of binding.constantViolations) {
		if (!violation.isAssignmentExpression()) continue;
		if (
			t.isObjectExpression(violation.node.right) ||
			t.isCallExpression(violation.node.right)
		) {
			return violation.node.right;
		}
	}

	return null;
}

function resolveCommandName(scope: any, name: string): string | null {
	const binding = scope.getBinding(name);
	const init = resolveAssignedCommandExpression(binding);
	if (!init) return null;

	if (t.isObjectExpression(init)) {
		return getCommandNameFromObject(init);
	}

	const firstArg = init.arguments[0];
	if (!t.isObjectExpression(firstArg)) return null;
	return getCommandNameFromObject(firstArg);
}

function createCommandsRegistryMutator(): Visitor {
	let foundRegistry = false;
	let foundDisabledDefinition = false;

	return {
		ObjectExpression(path) {
			const name = getCommandNameFromObject(path.node);
			if (name && COMMANDS_TO_DISABLE.has(name)) {
				foundDisabledDefinition = true;
			}
		},
		CallExpression(path) {
			const firstArg = path.node.arguments[0];
			if (!t.isObjectExpression(firstArg)) return;
			const name = getCommandNameFromObject(firstArg);
			if (name && COMMANDS_TO_DISABLE.has(name)) {
				foundDisabledDefinition = true;
			}
		},
		ArrayExpression(path) {
			let sawCommandRef = false;
			let removedCommand = false;

			path.node.elements = path.node.elements.filter((element) => {
				if (!t.isIdentifier(element)) return true;

				const commandName = resolveCommandName(path.scope, element.name);
				if (!commandName) return true;

				sawCommandRef = true;
				if (!COMMANDS_TO_DISABLE.has(commandName)) return true;

				removedCommand = true;
				return false;
			});

			if (sawCommandRef) {
				foundRegistry = true;
			}
			if (!removedCommand) return;
		},
		Program: {
			exit() {
				if (foundDisabledDefinition && !foundRegistry) {
					console.warn(
						"commands-off: Could not find built-in command registry to filter",
					);
				}
			},
		},
	};
}

function verifyCommandRegistry(ast: t.File): true | string {
	let foundDefinitions = false;
	let foundRegistry = false;
	let leakedCommandName: string | null = null;

	traverse(ast, {
		ObjectExpression(path) {
			const name = getCommandNameFromObject(path.node);
			if (name && COMMANDS_TO_DISABLE.has(name)) {
				foundDefinitions = true;
			}
		},
		CallExpression(path) {
			const firstArg = path.node.arguments[0];
			if (!t.isObjectExpression(firstArg)) return;
			const name = getCommandNameFromObject(firstArg);
			if (name && COMMANDS_TO_DISABLE.has(name)) {
				foundDefinitions = true;
			}
		},
		ArrayExpression(path) {
			for (const element of path.node.elements) {
				if (!t.isIdentifier(element)) continue;
				const commandName = resolveCommandName(path.scope, element.name);
				if (!commandName) continue;

				foundRegistry = true;
				if (COMMANDS_TO_DISABLE.has(commandName)) {
					leakedCommandName = commandName;
					path.stop();
					return;
				}
			}
		},
	});

	if (!foundDefinitions) {
		return true;
	}
	if (!foundRegistry) {
		return "Built-in command registry not found";
	}
	if (leakedCommandName) {
		return `Disabled command "${leakedCommandName}" still present in built-in command registry`;
	}
	return true;
}

export const commandsOff: Patch = {
	tag: "commands-off",

	astPasses: () => [
		{
			pass: "mutate",
			visitor: createCommandsRegistryMutator(),
		},
	],

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) {
			return "Unable to parse AST during commands-off verification";
		}
		return verifyCommandRegistry(verifyAst);
	},
};
