import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch } from "../types.js";

/**
 * Disables the automatic CLI updater.
 * Without this patch, cli.js would be silently replaced with the
 * latest version from npm, undoing all patches.
 *
 * This ONLY affects CLI updates (cli.js replacement).
 * Marketplace plugin updates are unaffected and will still work.
 *
 * The check function (e.g., PMA) returns null if auto-updates are enabled,
 * or a string reason if disabled. We inject an early return "patched".
 */
function isDisableAutoupdaterCheck(node: t.Node | null | undefined): boolean {
	if (!node || !t.isCallExpression(node)) return false;
	if (node.arguments.length !== 1) return false;

	const arg = node.arguments[0];
	if (!t.isMemberExpression(arg)) return false;
	if (!t.isMemberExpression(arg.object)) return false;

	const innerObj = arg.object;
	if (!t.isIdentifier(innerObj.object, { name: "process" })) return false;
	if (!t.isIdentifier(innerObj.property, { name: "env" })) return false;
	return t.isIdentifier(arg.property, { name: "DISABLE_AUTOUPDATER" });
}

export const disableAutoupdater: Patch = {
	tag: "no-autoupdate",

	ast: (ast) => {
		let patched = false;

		traverse.default(ast, {
			FunctionDeclaration(path) {
				// Find function containing: if (P1(process.env.DISABLE_AUTOUPDATER)) return "DISABLE_AUTOUPDATER set"
				let hasDisableCheck = false;

				path.traverse({
					IfStatement(ifPath) {
						const test = ifPath.node.test;
						if (!isDisableAutoupdaterCheck(test)) return;

						// Found the right if statement
						hasDisableCheck = true;
						ifPath.stop();
					},
				});

				if (!hasDisableCheck) return;

				// Check if already patched
				const firstStmt = path.node.body.body[0];
				if (
					t.isReturnStatement(firstStmt) &&
					t.isStringLiteral(firstStmt.argument, { value: "patched" })
				) {
					return;
				}

				// Inject: return "patched"; at the start
				path.node.body.body.unshift(
					t.returnStatement(t.stringLiteral("patched")),
				);
				patched = true;
				console.log("Disabled auto-updater");
				path.stop();
			},
		});

		if (!patched) {
			console.warn("disable-autoupdater: Could not find autoupdater function");
		}
	},

	verify: (_code, ast) => {
		if (!ast) return "Missing AST for no-autoupdate verification";

		let targetFunctionCount = 0;
		let patchedFunctionCount = 0;

		traverse.default(ast, {
			FunctionDeclaration(path) {
				let hasDisableCheck = false;
				path.traverse({
					IfStatement(ifPath) {
						if (!isDisableAutoupdaterCheck(ifPath.node.test)) return;
						hasDisableCheck = true;
						ifPath.stop();
					},
				});
				if (!hasDisableCheck) return;

				targetFunctionCount++;
				const firstStmt = path.node.body.body[0];
				if (
					t.isReturnStatement(firstStmt) &&
					t.isStringLiteral(firstStmt.argument, { value: "patched" })
				) {
					patchedFunctionCount++;
				}
			},
		});

		if (targetFunctionCount < 1) {
			return "Auto-updater guard function not found";
		}
		if (patchedFunctionCount !== targetFunctionCount) {
			return `Auto-updater guard not patched at function entry (${patchedFunctionCount}/${targetFunctionCount})`;
		}
		return true;
	},
};
