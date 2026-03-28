import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch } from "../types.js";
import { getObjectKeyName, getVerifyAst } from "./ast-helpers.js";

/**
 * Disable built-in plugin commands that are superseded by our custom skills/agents:
 * - "pr-comments" -> superseded by pr-comments skill (with reply/resolve)
 * - "review" (pluginName "code-review") -> superseded by review-pr skill + code-reviewer agent
 * - "security-review" -> superseded by security-reviewer agent
 *
 * Strategy: find the factory function that builds builtin command objects
 * (returns { type: "prompt", name, isEnabled: () => !0, isHidden: !1, source: "builtin", ... })
 * and inject a guard at the top that returns a disabled stub for commands we supersede.
 */

const COMMANDS_TO_DISABLE = new Set([
	"pr-comments",
	"review",
	"security-review",
]);

function createCommandsOffMutator(): traverse.Visitor {
	let factoryPatched = false;
	const inlinePatched = new Set<string>();
	return {
		// Patch inline command objects that bypass the factory (e.g. "review")
		ObjectExpression(path) {
			const props = path.node.properties;
			const nameProp = props.find(
				(p) =>
					t.isObjectProperty(p) &&
					getObjectKeyName(p.key) === "name" &&
					t.isStringLiteral(p.value) &&
					COMMANDS_TO_DISABLE.has(p.value.value),
			);
			if (!nameProp || !t.isObjectProperty(nameProp)) return;
			const cmdName = (nameProp.value as t.StringLiteral).value;
			if (inlinePatched.has(cmdName)) return;

			const sourceProp = props.find(
				(p) =>
					t.isObjectProperty(p) &&
					getObjectKeyName(p.key) === "source" &&
					t.isStringLiteral(p.value, { value: "builtin" }),
			);
			if (!sourceProp) return;

			const isEnabledProp = props.find(
				(p) => t.isObjectProperty(p) && getObjectKeyName(p.key) === "isEnabled",
			);
			if (!isEnabledProp || !t.isObjectProperty(isEnabledProp)) return;

			isEnabledProp.value = t.arrowFunctionExpression(
				[],
				t.booleanLiteral(false),
			);

			const isHiddenProp = props.find(
				(p) => t.isObjectProperty(p) && getObjectKeyName(p.key) === "isHidden",
			);
			if (isHiddenProp && t.isObjectProperty(isHiddenProp)) {
				isHiddenProp.value = t.booleanLiteral(true);
			}

			inlinePatched.add(cmdName);
			console.log(`Disabled inline command: ${cmdName}`);
		},
		FunctionDeclaration(path) {
			if (factoryPatched) return;

			// Find the factory function by its structure:
			// - Has destructured param with "name", "pluginName", "pluginCommand",
			//   "getPromptWhileMarketplaceIsPrivate"
			// - Returns object with source: "builtin", isEnabled, isHidden
			const params = path.node.params;
			if (params.length !== 1) return;
			if (!t.isObjectPattern(params[0])) return;

			const paramProps = params[0].properties;
			const paramNames = new Set<string>();
			for (const p of paramProps) {
				if (t.isObjectProperty(p) && t.isIdentifier(p.key)) {
					paramNames.add(p.key.name);
				}
			}

			if (
				!paramNames.has("name") ||
				!paramNames.has("pluginName") ||
				!paramNames.has("pluginCommand") ||
				!paramNames.has("getPromptWhileMarketplaceIsPrivate")
			) {
				return;
			}

			// Found the factory. Find which local var holds "name"
			const nameProp = paramProps.find(
				(p) =>
					t.isObjectProperty(p) &&
					t.isIdentifier(p.key) &&
					p.key.name === "name",
			);
			if (!nameProp || !t.isObjectProperty(nameProp)) return;
			if (!t.isIdentifier(nameProp.value)) return;
			const nameVar = nameProp.value.name;

			const body = path.node.body;
			if (!t.isBlockStatement(body)) return;

			// Idempotency: check if the guard is already injected
			const firstStmt = body.body[0];
			if (
				t.isIfStatement(firstStmt) &&
				t.isBinaryExpression(firstStmt.test) &&
				t.isCallExpression(firstStmt.test.left) &&
				t.isMemberExpression(firstStmt.test.left.callee) &&
				t.isArrayExpression(firstStmt.test.left.callee.object)
			) {
				// Guard already present
				factoryPatched = true;
				return;
			}

			// Build the disable set as an array check:
			// if (["pr-comments","review","security-review"].indexOf(H) !== -1) {
			//   return { isEnabled: () => !1, isHidden: !0, name: H, type: "prompt", source: "builtin" };
			// }
			const disabledNames = [...COMMANDS_TO_DISABLE].map((n) =>
				t.stringLiteral(n),
			);

			const guard = t.ifStatement(
				t.binaryExpression(
					"!==",
					t.callExpression(
						t.memberExpression(
							t.arrayExpression(disabledNames),
							t.identifier("indexOf"),
						),
						[t.identifier(nameVar)],
					),
					t.unaryExpression("-", t.numericLiteral(1)),
				),
				t.blockStatement([
					t.returnStatement(
						t.objectExpression([
							t.objectProperty(
								t.identifier("isEnabled"),
								t.arrowFunctionExpression([], t.booleanLiteral(false)),
							),
							t.objectProperty(
								t.identifier("isHidden"),
								t.booleanLiteral(true),
							),
							t.objectProperty(t.identifier("name"), t.identifier(nameVar)),
							t.objectProperty(t.identifier("type"), t.stringLiteral("prompt")),
							t.objectProperty(
								t.identifier("source"),
								t.stringLiteral("builtin"),
							),
						]),
					),
				]),
			);

			body.body.unshift(guard);
			factoryPatched = true;
			console.log(
				`Injected command disable guard for: ${[...COMMANDS_TO_DISABLE].join(", ")}`,
			);
		},
		Program: {
			exit() {
				if (!factoryPatched) {
					console.warn(
						"commands-off: Could not find builtin command factory to patch",
					);
				}
			},
		},
	};
}

export const commandsOff: Patch = {
	tag: "commands-off",

	astPasses: () => [
		{
			pass: "mutate",
			visitor: createCommandsOffMutator(),
		},
	],

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst)
			return "Unable to parse AST during commands-off verification";

		// Verify the factory function has our guard injected.
		// Look for a function with the destructured pluginName/pluginCommand params
		// that has an indexOf guard as its first statement.
		let factoryFound = false;
		let guardFound = false;
		const guardedNames = new Set<string>();

		traverse.default(verifyAst, {
			FunctionDeclaration(path) {
				const params = path.node.params;
				if (params.length !== 1 || !t.isObjectPattern(params[0])) return;

				const paramNames = new Set<string>();
				for (const p of params[0].properties) {
					if (t.isObjectProperty(p) && t.isIdentifier(p.key)) {
						paramNames.add(p.key.name);
					}
				}
				if (
					!paramNames.has("name") ||
					!paramNames.has("pluginName") ||
					!paramNames.has("pluginCommand")
				) {
					return;
				}

				factoryFound = true;

				const body = path.node.body;
				if (!t.isBlockStatement(body)) return;
				const firstStmt = body.body[0];
				if (!t.isIfStatement(firstStmt)) return;
				if (!t.isBinaryExpression(firstStmt.test)) return;
				if (!t.isCallExpression(firstStmt.test.left)) return;

				const callee = firstStmt.test.left.callee;
				if (!t.isMemberExpression(callee)) return;
				if (!t.isArrayExpression(callee.object)) return;
				if (
					!t.isIdentifier(callee.property) ||
					callee.property.name !== "indexOf"
				) {
					return;
				}

				// Extract command names from the array
				for (const el of callee.object.elements) {
					if (t.isStringLiteral(el)) {
						guardedNames.add(el.value);
					}
				}

				// Check the guard returns a disabled stub
				if (!t.isBlockStatement(firstStmt.consequent)) return;
				const retStmt = firstStmt.consequent.body[0];
				if (!t.isReturnStatement(retStmt)) return;
				if (!t.isObjectExpression(retStmt.argument)) return;

				const retProps = retStmt.argument.properties;
				const hasIsEnabledFalse = retProps.some((p) => {
					if (!t.isObjectProperty(p)) return false;
					if (getObjectKeyName(p.key) !== "isEnabled") return false;
					if (!t.isArrowFunctionExpression(p.value)) return false;
					return (
						t.isBooleanLiteral(p.value.body, { value: false }) ||
						(t.isUnaryExpression(p.value.body, { operator: "!" }) &&
							t.isNumericLiteral(p.value.body.argument, { value: 1 }))
					);
				});
				const hasIsHiddenTrue = retProps.some((p) => {
					if (!t.isObjectProperty(p)) return false;
					if (getObjectKeyName(p.key) !== "isHidden") return false;
					return (
						t.isBooleanLiteral(p.value, { value: true }) ||
						(t.isUnaryExpression(p.value, { operator: "!" }) &&
							t.isNumericLiteral(p.value.argument, { value: 0 }))
					);
				});

				if (hasIsEnabledFalse && hasIsHiddenTrue) {
					guardFound = true;
				}
			},
		});

		if (!factoryFound) {
			return "Built-in command factory function not found";
		}
		if (!guardFound) {
			return "Command disable guard not found in factory (missing indexOf check with disabled stub)";
		}

		for (const name of COMMANDS_TO_DISABLE) {
			if (!guardedNames.has(name)) {
				return `Command "${name}" is not in the disable guard array`;
			}
		}

		// Verify inline command objects (like "review") are also disabled
		const inlineDisabled = new Set<string>();
		traverse.default(verifyAst, {
			ObjectExpression(path) {
				const props = path.node.properties;
				const nameProp = props.find(
					(p) =>
						t.isObjectProperty(p) &&
						getObjectKeyName(p.key) === "name" &&
						t.isStringLiteral(p.value) &&
						COMMANDS_TO_DISABLE.has(p.value.value),
				);
				if (!nameProp || !t.isObjectProperty(nameProp)) return;
				const cmdName = (nameProp.value as t.StringLiteral).value;

				const sourceProp = props.find(
					(p) =>
						t.isObjectProperty(p) &&
						getObjectKeyName(p.key) === "source" &&
						t.isStringLiteral(p.value, { value: "builtin" }),
				);
				if (!sourceProp) return;

				const isEnabledProp = props.find(
					(p) =>
						t.isObjectProperty(p) && getObjectKeyName(p.key) === "isEnabled",
				);
				if (!isEnabledProp || !t.isObjectProperty(isEnabledProp)) return;

				// Check isEnabled returns false
				if (t.isArrowFunctionExpression(isEnabledProp.value)) {
					const body = isEnabledProp.value.body;
					if (
						t.isBooleanLiteral(body, { value: false }) ||
						(t.isUnaryExpression(body, { operator: "!" }) &&
							t.isNumericLiteral(body.argument, { value: 1 }))
					) {
						inlineDisabled.add(cmdName);
					}
				}
			},
		});

		// "review" is an inline object that bypasses the factory
		if (!inlineDisabled.has("review") && !guardedNames.has("review")) {
			return 'Inline command "review" is not disabled';
		}

		return true;
	},
};
