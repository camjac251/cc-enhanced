import * as t from "@babel/types";
import { type NodePath, traverse } from "../babel.js";
import type { Patch, PatchAstPass } from "../types.js";
import { getMemberPropertyName } from "./ast-helpers.js";

/**
 * Disables the automatic core updaters.
 * Without this patch, cli.js would be silently replaced with the
 * latest version, undoing local patches.
 *
 * Plugin marketplace autoupdates are preserved.
 *
 * The check function returns null if auto-updates are enabled, or a non-null
 * reason if disabled. We inject an early return "patched".
 */
function isDisableAutoupdaterCheck(node: t.Node | null | undefined): boolean {
	if (!node || !t.isMemberExpression(node)) return false;
	if (!t.isIdentifier(node.object)) return false;
	return getMemberPropertyName(node) === "DISABLE_AUTOUPDATER";
}

function isForceAutoupdatePluginsMember(
	node: t.Node | null | undefined,
): boolean {
	return (
		!!node &&
		t.isMemberExpression(node) &&
		getMemberPropertyName(node) === "FORCE_AUTOUPDATE_PLUGINS"
	);
}

function isPluginAutoupdateGateReturn(stmt: t.Statement): boolean {
	if (!t.isReturnStatement(stmt)) return false;
	if (!t.isLogicalExpression(stmt.argument, { operator: "&&" })) return false;

	const { left, right } = stmt.argument;
	if (
		!t.isCallExpression(left) ||
		!t.isIdentifier(left.callee) ||
		left.arguments.length !== 0
	) {
		return false;
	}
	if (!t.isUnaryExpression(right, { operator: "!" })) return false;
	return isForceAutoupdatePluginsMember(right.argument);
}

function hasDisableAutoupdaterCheck(path: NodePath<t.Function>): boolean {
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

function hasPluginAutoupdateGate(path: NodePath<t.Function>): boolean {
	if (!t.isBlockStatement(path.node.body)) return false;
	return path.node.body.body.some(isPluginAutoupdateGateReturn);
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

function getCallableFunctionName(path: NodePath<t.Function>): string | null {
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
					if (!hasPluginAutoupdateGate(path)) return;

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

		traverse(ast, {
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
			traverse(ast, {
				Function(path) {
					if (!t.isBlockStatement(path.node.body)) return;
					if (!hasPluginAutoupdateGate(path)) return;
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
		if (pluginGateTargetCount !== 1) {
			return `Expected exactly one plugin autoupdate gate function (found ${pluginGateTargetCount})`;
		}
		if (pluginGatePatchedCount !== 1) {
			return `Plugin autoupdate gate not patched at function entry (${pluginGatePatchedCount}/${pluginGateTargetCount})`;
		}
		return true;
	},
};
