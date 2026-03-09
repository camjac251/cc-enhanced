import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch, PatchAstPass } from "../types.js";
import { getMemberPropertyName } from "./ast-helpers.js";

function isProcessReference(node: t.Expression): boolean {
	if (t.isIdentifier(node)) return node.name === "process";
	if (!t.isMemberExpression(node)) return false;
	return (
		getMemberPropertyName(node) === "process" &&
		t.isIdentifier(node.object) &&
		node.object.name === "globalThis"
	);
}

/**
 * Disables the automatic core updaters.
 * Without this patch, cli.js would be silently replaced with the
 * latest version, undoing local patches.
 *
 * Plugin marketplace autoupdates are preserved.
 *
 * The check function (e.g., A_H) returns null if auto-updates are enabled,
 * or a string reason if disabled. We inject an early return "patched".
 */
function isDisableAutoupdaterCheck(node: t.Node | null | undefined): boolean {
	if (!node || !t.isCallExpression(node)) return false;
	if (node.arguments.length !== 1) return false;

	const arg = node.arguments[0];
	if (!t.isMemberExpression(arg)) return false;
	if (!t.isMemberExpression(arg.object)) return false;

	const innerObj = arg.object;
	if (!isProcessReference(innerObj.object)) return false;
	if (getMemberPropertyName(innerObj) !== "env") return false;
	return getMemberPropertyName(arg) === "DISABLE_AUTOUPDATER";
}

function isForceAutoupdatePluginsCheck(
	node: t.Node | null | undefined,
): boolean {
	if (!node || !t.isCallExpression(node)) return false;
	if (node.arguments.length !== 1) return false;

	const arg = node.arguments[0];
	if (!t.isMemberExpression(arg)) return false;
	if (!t.isMemberExpression(arg.object)) return false;

	const innerObj = arg.object;
	if (!isProcessReference(innerObj.object)) return false;
	if (getMemberPropertyName(innerObj) !== "env") return false;
	return getMemberPropertyName(arg) === "FORCE_AUTOUPDATE_PLUGINS";
}

function hasDisableAutoupdaterCheck(
	path: traverse.NodePath<t.Function>,
): boolean {
	let hasDisableCheck = false;
	path.traverse({
		IfStatement(ifPath) {
			if (!isDisableAutoupdaterCheck(ifPath.node.test)) return;
			hasDisableCheck = true;
			ifPath.stop();
		},
	});
	return hasDisableCheck;
}

function hasPluginAutoupdateForceCheck(
	path: traverse.NodePath<t.Function>,
): boolean {
	let hasForceCheck = false;
	path.traverse({
		CallExpression(callPath) {
			if (!isForceAutoupdatePluginsCheck(callPath.node)) return;
			hasForceCheck = true;
			callPath.stop();
		},
	});
	return hasForceCheck;
}

function isPluginGatePatchedStatement(
	stmt: t.Statement,
	guardFunctionNames: Set<string>,
): boolean {
	if (!t.isIfStatement(stmt)) return false;
	if (!t.isBinaryExpression(stmt.test, { operator: "===" })) return false;
	if (
		!t.isCallExpression(stmt.test.left) ||
		!t.isIdentifier(stmt.test.left.callee) ||
		!guardFunctionNames.has(stmt.test.left.callee.name) ||
		stmt.test.left.arguments.length !== 0
	) {
		return false;
	}
	if (!t.isStringLiteral(stmt.test.right, { value: "patched" })) return false;
	if (!t.isReturnStatement(stmt.consequent)) return false;
	return t.isBooleanLiteral(stmt.consequent.argument, { value: false });
}

function getCallableFunctionName(
	path: traverse.NodePath<t.Function>,
): string | null {
	const node = path.node;
	if (t.isFunctionDeclaration(node) && node.id?.name) return node.id.name;
	if (t.isFunctionExpression(node) && node.id?.name) return node.id.name;

	const parent = path.parentPath;
	if (
		parent?.isVariableDeclarator() &&
		t.isIdentifier(parent.node.id) &&
		parent.node.init === node
	) {
		return parent.node.id.name;
	}
	if (
		parent?.isAssignmentExpression() &&
		t.isIdentifier(parent.node.left) &&
		parent.node.right === node
	) {
		return parent.node.left.name;
	}
	return null;
}

interface DisableAutoupdaterPassState {
	guardFunctionFound: boolean;
	guardFunctionNames: Set<string>;
	guardFunctionName?: string;
	pluginGatePatched: boolean;
}

function createDisableAutoupdaterPasses(): PatchAstPass[] {
	const state: DisableAutoupdaterPassState = {
		guardFunctionFound: false,
		guardFunctionNames: new Set<string>(),
		guardFunctionName: undefined,
		pluginGatePatched: false,
	};
	return [
		{
			pass: "discover",
			visitor: {
				Function(path) {
					if (!t.isBlockStatement(path.node.body)) return;
					if (!hasDisableAutoupdaterCheck(path)) return;
					state.guardFunctionFound = true;
					const fnName = getCallableFunctionName(path);
					if (fnName) {
						state.guardFunctionNames.add(fnName);
					}
				},
				Program: {
					exit() {
						state.guardFunctionName =
							state.guardFunctionNames.size === 1
								? (state.guardFunctionNames.values().next().value as string)
								: undefined;
					},
				},
			},
		},
		{
			pass: "mutate",
			visitor: {
				Function(path) {
					if (!t.isBlockStatement(path.node.body)) return;

					if (hasDisableAutoupdaterCheck(path)) {
						const firstStmt = path.node.body.body[0];
						if (
							!(
								t.isReturnStatement(firstStmt) &&
								t.isStringLiteral(firstStmt.argument, { value: "patched" })
							)
						) {
							path.node.body.body.unshift(
								t.returnStatement(t.stringLiteral("patched")),
							);
							console.log("Disabled auto-updater");
						}
					}

					if (!state.guardFunctionName) return;
					if (!hasPluginAutoupdateForceCheck(path)) return;

					const firstStmt = path.node.body.body[0];
					if (
						firstStmt &&
						isPluginGatePatchedStatement(firstStmt, state.guardFunctionNames)
					) {
						state.pluginGatePatched = true;
						return;
					}

					path.node.body.body.unshift(
						t.ifStatement(
							t.binaryExpression(
								"===",
								t.callExpression(t.identifier(state.guardFunctionName), []),
								t.stringLiteral("patched"),
							),
							t.returnStatement(t.booleanLiteral(false)),
						),
					);
					state.pluginGatePatched = true;
					console.log(
						"Enabled plugin autoupdate while core autoupdater remains patched off",
					);
				},
			},
		},
		{
			pass: "finalize",
			visitor: {
				Program: {
					exit() {
						if (!state.guardFunctionFound) {
							console.warn(
								"disable-autoupdater: Could not find autoupdater function",
							);
						}
						if (!state.guardFunctionName) {
							console.warn(
								"disable-autoupdater: Could not resolve autoupdater guard function name",
							);
						}
						if (state.guardFunctionNames.size > 1) {
							console.warn(
								`disable-autoupdater: Ambiguous autoupdater guard function names (${[...state.guardFunctionNames].join(", ")})`,
							);
						}
						if (state.guardFunctionName && !state.pluginGatePatched) {
							console.warn(
								"disable-autoupdater: Could not find plugin autoupdate gate function",
							);
						}
					},
				},
			},
		},
	];
}

export const disableAutoupdater: Patch = {
	tag: "no-autoupdate",

	astPasses: () => createDisableAutoupdaterPasses(),

	verify: (_code, ast) => {
		if (!ast) return "Missing AST for no-autoupdate verification";

		let targetFunctionCount = 0;
		let patchedFunctionCount = 0;
		const guardFunctionNames = new Set<string>();
		let pluginGateTargetCount = 0;
		let pluginGatePatchedCount = 0;

		traverse.default(ast, {
			Function(path) {
				if (!t.isBlockStatement(path.node.body)) return;
				if (!hasDisableAutoupdaterCheck(path)) return;

				targetFunctionCount++;
				const fnName = getCallableFunctionName(path);
				if (fnName) {
					guardFunctionNames.add(fnName);
				}
				const firstStmt = path.node.body.body[0];
				if (
					t.isReturnStatement(firstStmt) &&
					t.isStringLiteral(firstStmt.argument, { value: "patched" })
				) {
					patchedFunctionCount++;
				}
			},
		});

		if (guardFunctionNames.size === 1) {
			traverse.default(ast, {
				Function(path) {
					if (!t.isBlockStatement(path.node.body)) return;
					if (!hasPluginAutoupdateForceCheck(path)) return;
					pluginGateTargetCount++;

					const firstStmt = path.node.body.body[0];
					if (
						firstStmt &&
						isPluginGatePatchedStatement(firstStmt, guardFunctionNames)
					) {
						pluginGatePatchedCount++;
					}
				},
			});
		}

		if (targetFunctionCount < 1) {
			return "Auto-updater guard function not found";
		}
		if (patchedFunctionCount !== targetFunctionCount) {
			return `Auto-updater guard not patched at function entry (${patchedFunctionCount}/${targetFunctionCount})`;
		}
		if (guardFunctionNames.size !== 1) {
			return `Expected exactly one auto-updater guard function name (found ${guardFunctionNames.size})`;
		}
		if (pluginGateTargetCount < 1) {
			return "Plugin autoupdate gate function not found";
		}
		if (pluginGatePatchedCount !== pluginGateTargetCount) {
			return `Plugin autoupdate gate not patched at function entry (${pluginGatePatchedCount}/${pluginGateTargetCount})`;
		}
		return true;
	},
};
