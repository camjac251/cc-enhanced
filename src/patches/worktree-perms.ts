import * as t from "@babel/types";
import { traverse, type Visitor } from "../babel.js";
import type { Patch } from "../types.js";
import {
	getMemberPropertyName,
	getObjectKeyName,
	getVerifyAst,
} from "./ast-helpers.js";

/**
 * Fix agent worktree permissions by adding the worktree path to
 * additionalWorkingDirectories in the agent's permission context.
 *
 * Claude Code creates agent worktrees but never adds their path to
 * additionalWorkingDirectories. This causes every Edit/Write in a
 * worktree to trigger a permission prompt even in acceptEdits mode.
 *
 * The fix: after spreading toolPermissionContext into the agent's
 * permission context object, inject a statement that adds the worktree
 * path to additionalWorkingDirectories.
 *
 * Two code paths need patching:
 * 1. Agent spawn: permission context created, then worktree created
 *    after. Inject after the worktree if-block.
 * 2. Session resume: permission context created with worktree path
 *    already known. Inject right after the assignment.
 *
 * GitHub issues: #28248, #29110, #38914, #27460
 */

/**
 * Check if an ObjectExpression is a spread of .toolPermissionContext
 * with mode defaulting to "acceptEdits":
 *   { ...X.toolPermissionContext, mode: Y ?? "acceptEdits" }
 */
function isPermCtxSpread(node: t.ObjectExpression): boolean {
	let hasSpread = false;
	let hasAcceptEditsMode = false;

	for (const prop of node.properties) {
		// Check for ...X.toolPermissionContext
		if (
			t.isSpreadElement(prop) &&
			t.isMemberExpression(prop.argument) &&
			getMemberPropertyName(prop.argument) === "toolPermissionContext"
		) {
			hasSpread = true;
		}
		// Check for mode: Y ?? "acceptEdits"
		if (
			t.isObjectProperty(prop) &&
			getObjectKeyName(prop.key) === "mode" &&
			t.isLogicalExpression(prop.value, { operator: "??" }) &&
			t.isStringLiteral(prop.value.right, { value: "acceptEdits" })
		) {
			hasAcceptEditsMode = true;
		}
	}

	return hasSpread && hasAcceptEditsMode;
}

/**
 * Build: if (guardExpr) { permVar.additionalWorkingDirectories.set(valueExpr, "session"); }
 *
 * guardExpr is used as the if-test (may use optional chaining like e?.worktreePath).
 * valueExpr is used inside the body (safe to use regular access since guard passed).
 */
function buildWorktreeSetStatement(
	permVarName: string,
	guardExpr: t.Expression,
	valueExpr?: t.Expression,
): t.IfStatement {
	const setArg = valueExpr ?? t.cloneNode(guardExpr);
	return t.ifStatement(
		guardExpr,
		t.blockStatement([
			t.expressionStatement(
				t.callExpression(
					t.memberExpression(
						t.memberExpression(
							t.identifier(permVarName),
							t.identifier("additionalWorkingDirectories"),
						),
						t.identifier("set"),
					),
					[setArg, t.stringLiteral("session")],
				),
			),
		]),
	);
}

function walkNode(
	node: t.Node | null | undefined,
	visit: (node: t.Node) => boolean | undefined,
): boolean {
	if (!node) return false;
	if (visit(node)) return true;
	for (const key of t.VISITOR_KEYS[node.type] ?? []) {
		const child = (node as any)[key];
		if (Array.isArray(child)) {
			for (const item of child) {
				if (item && typeof item.type === "string" && walkNode(item, visit)) {
					return true;
				}
			}
			continue;
		}
		if (child && typeof child.type === "string" && walkNode(child, visit)) {
			return true;
		}
	}
	return false;
}

function isWorktreePathAccess(
	node: t.Node | null | undefined,
	objectName: string,
	options: { optional?: boolean } = {},
): boolean {
	if (options.optional) {
		return (
			t.isOptionalMemberExpression(node) &&
			t.isIdentifier(node.object, { name: objectName }) &&
			getMemberPropertyName(node) === "worktreePath"
		);
	}
	return (
		t.isMemberExpression(node) &&
		t.isIdentifier(node.object, { name: objectName }) &&
		getMemberPropertyName(node) === "worktreePath"
	);
}

function isAdditionalWorkingDirectorySessionSet(
	node: t.Node,
	permVarName: string,
): node is t.CallExpression {
	if (!t.isCallExpression(node)) return false;
	const callee = node.callee;
	if (!t.isMemberExpression(callee)) return false;
	if (getMemberPropertyName(callee) !== "set") return false;
	if (!t.isMemberExpression(callee.object)) return false;
	if (getMemberPropertyName(callee.object) !== "additionalWorkingDirectories")
		return false;
	if (!t.isIdentifier(callee.object.object, { name: permVarName })) {
		return false;
	}
	if (node.arguments.length < 2) return false;
	return t.isStringLiteral(node.arguments[1], { value: "session" });
}

function nodeHasDirectorySet(
	node: t.Node,
	permVarName: string,
	matchesValue: (node: t.Node | null | undefined) => boolean,
): boolean {
	return walkNode(node, (candidate) => {
		if (!isAdditionalWorkingDirectorySessionSet(candidate, permVarName)) {
			return false;
		}
		return matchesValue(candidate.arguments[0]);
	});
}

function createMutateVisitor(): Visitor {
	let patchedSpawn = false;
	let patchedResume = false;

	return {
		VariableDeclarator(path) {
			// Find: VAR = { ...X.toolPermissionContext, mode: Y ?? "acceptEdits" }
			const init = path.node.init;
			if (!init || !t.isObjectExpression(init)) return;
			if (!isPermCtxSpread(init)) return;
			if (!t.isIdentifier(path.node.id)) return;

			const permVarName = path.node.id.name;

			// Determine which code path we're in by looking at the surrounding context.
			// Path 1 (spawn): has an if-block testing === "worktree" nearby,
			//   worktree result stored in a variable initialized to null.
			// Path 2 (resume): worktree path is already available as a variable
			//   and appears later as a worktreePath property in the query object.

			// Walk up to the statement level
			const declPath = path.parentPath;
			if (!declPath?.isVariableDeclaration()) return;
			const stmtParent = declPath.parentPath;
			if (!stmtParent) return;

			// Collect sibling statements after this declaration
			let siblings: any[];
			let declIndex: number;

			if (stmtParent.isBlockStatement() || stmtParent.isProgram()) {
				siblings = stmtParent.get("body") as any[];
				declIndex = siblings.findIndex((s: any) => s.node === declPath.node);
			} else {
				return;
			}

			if (declIndex === -1) return;

			// Path 1: Look for if (X === "worktree") after this declaration
			for (let i = declIndex + 1; i < siblings.length; i++) {
				const sibling = siblings[i];
				if (!sibling.isIfStatement()) continue;
				const test = sibling.node.test;
				if (
					t.isBinaryExpression(test, { operator: "===" }) &&
					t.isStringLiteral(test.right, { value: "worktree" })
				) {
					// Found the worktree creation if-block.
					// The worktree result variable is initialized to null before this if.
					// Find it: look for VAR = null between our declaration and the if.
					let worktreeVarName: string | null = null;
					for (let j = declIndex + 1; j < i; j++) {
						const s = siblings[j];
						if (!s.isVariableDeclaration()) continue;
						for (const d of s.node.declarations) {
							if (t.isIdentifier(d.id) && t.isNullLiteral(d.init)) {
								worktreeVarName = d.id.name;
							}
						}
					}
					// Also check within the same VariableDeclaration (comma-separated)
					if (!worktreeVarName) {
						for (const d of declPath.node.declarations) {
							if (t.isIdentifier(d.id) && t.isNullLiteral(d.init)) {
								worktreeVarName = d.id.name;
							}
						}
					}

					if (!worktreeVarName) return;

					// Build: if (worktreeVar?.worktreePath) { permVar.additionalWorkingDirectories.set(worktreeVar.worktreePath, "session"); }
					// Use optional chaining for the guard since worktreeVar is null when no worktree is created
					const worktreePathExpr = t.optionalMemberExpression(
						t.identifier(worktreeVarName),
						t.identifier("worktreePath"),
						false,
						true,
					);
					// Regular member access for the .set() arg (safe inside the if-guard)
					const worktreePathValue = t.memberExpression(
						t.identifier(worktreeVarName),
						t.identifier("worktreePath"),
					);
					if (
						siblings.some((s) =>
							nodeHasDirectorySet(s.node, permVarName, (value) =>
								isWorktreePathAccess(value, worktreeVarName),
							),
						)
					) {
						patchedSpawn = true;
						return;
					}
					const ifStmt = buildWorktreeSetStatement(
						permVarName,
						worktreePathExpr,
						worktreePathValue,
					);

					// Insert after the worktree if-block
					sibling.insertAfter(ifStmt);
					patchedSpawn = true;
					return;
				}
			}

			// Path 2 (resume): The worktree path variable is used later as
			// a worktreePath property in the query object. Find the variable
			// that holds it by scanning declarators in the same VariableDeclaration
			// (comma-separated let) and sibling statements.
			const searchDeclarators = (
				declarations: t.VariableDeclarator[],
			): string | null => {
				for (const d of declarations) {
					if (!t.isObjectExpression(d.init)) continue;
					for (const prop of d.init.properties) {
						if (
							t.isObjectProperty(prop) &&
							getObjectKeyName(prop.key) === "worktreePath" &&
							t.isIdentifier(prop.value)
						) {
							return prop.value.name;
						}
					}
				}
				return null;
			};

			// Check same VariableDeclaration first (comma-separated)
			let wtPathVar = searchDeclarators(declPath.node.declarations);

			// Then check sibling statements
			if (!wtPathVar) {
				for (let i = declIndex + 1; i < siblings.length; i++) {
					const sibling = siblings[i];
					if (!sibling.isVariableDeclaration()) continue;
					wtPathVar = searchDeclarators(sibling.node.declarations);
					if (wtPathVar) break;
				}
			}

			if (wtPathVar) {
				if (
					siblings.some((s) =>
						nodeHasDirectorySet(s.node, permVarName, (value) =>
							t.isIdentifier(value, { name: wtPathVar }),
						),
					)
				) {
					patchedResume = true;
					return;
				}
				const ifStmt = buildWorktreeSetStatement(
					permVarName,
					t.identifier(wtPathVar),
				);
				// Insert right after our permission context declaration
				declPath.insertAfter(ifStmt);
				patchedResume = true;
			}
		},

		Program: {
			exit() {
				const parts = [];
				if (patchedSpawn) parts.push("spawn");
				if (patchedResume) parts.push("resume");
				if (parts.length > 0) {
					console.log(`Worktree permissions: patched ${parts.join(" + ")}`);
				}
				if (!patchedSpawn) {
					console.warn(
						"Worktree permissions: could not find agent spawn permission context",
					);
				}
				if (!patchedResume) {
					console.warn(
						"Worktree permissions: could not find session resume permission context",
					);
				}
			},
		},
	};
}

function verifyWorktreePerms(code: string, ast?: t.File): true | string {
	const verifyAst = getVerifyAst(code, ast);
	if (!verifyAst) {
		return "Unable to parse AST for worktree-perms verification";
	}

	let foundSpawnSet = false;
	let foundResumeSet = false;

	traverse(verifyAst, {
		CallExpression(path) {
			const callee = path.node.callee;
			if (!t.isMemberExpression(callee)) return;
			if (!t.isMemberExpression(callee.object)) return;
			if (!t.isIdentifier(callee.object.object)) return;
			const permVarName = callee.object.object.name;
			if (!isAdditionalWorkingDirectorySessionSet(path.node, permVarName)) {
				return;
			}
			const ifParent = path.findParent((p) => p.isIfStatement());
			if (!ifParent?.isIfStatement()) return;

			const [valueArg] = path.node.arguments;
			if (
				t.isMemberExpression(valueArg) &&
				getMemberPropertyName(valueArg) === "worktreePath" &&
				t.isIdentifier(valueArg.object) &&
				isWorktreePathAccess(ifParent.node.test, valueArg.object.name, {
					optional: true,
				})
			) {
				foundSpawnSet = true;
				return;
			}

			if (
				t.isIdentifier(valueArg) &&
				t.isIdentifier(ifParent.node.test, { name: valueArg.name })
			) {
				foundResumeSet = true;
			}
		},
	});

	if (!foundSpawnSet) {
		return "Missing guarded spawn worktree additionalWorkingDirectories update";
	}
	if (!foundResumeSet) {
		return "Missing guarded resume worktree additionalWorkingDirectories update";
	}

	return true;
}

export const worktreePerms: Patch = {
	tag: "worktree-perms",

	astPasses: () => [
		{
			pass: "mutate",
			visitor: createMutateVisitor(),
		},
	],

	verify: verifyWorktreePerms,
};
