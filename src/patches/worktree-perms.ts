import traverse from "@babel/traverse";
import * as t from "@babel/types";
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
 * Build: if (worktreeExpr) { permVar.additionalWorkingDirectories.set(worktreeExpr, "session"); }
 */
function buildWorktreeSetStatement(
	permVarName: string,
	worktreeExpr: t.Expression,
): t.IfStatement {
	return t.ifStatement(
		worktreeExpr,
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
					[t.cloneNode(worktreeExpr), t.stringLiteral("session")],
				),
			),
		]),
	);
}

function createMutateVisitor(): traverse.Visitor {
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
				declIndex = siblings.findIndex(
					(s: any) => s.node === declPath.node,
				);
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
							if (
								t.isIdentifier(d.id) &&
								t.isNullLiteral(d.init)
							) {
								worktreeVarName = d.id.name;
							}
						}
					}
					// Also check within the same VariableDeclaration (comma-separated)
					if (!worktreeVarName) {
						for (const d of declPath.node.declarations) {
							if (
								t.isIdentifier(d.id) &&
								t.isNullLiteral(d.init)
							) {
								worktreeVarName = d.id.name;
							}
						}
					}

					if (!worktreeVarName) return;

					// Build: if (worktreeVar) { permVar.additionalWorkingDirectories.set(worktreeVar.worktreePath, "session"); }
					const worktreePathExpr = t.memberExpression(
						t.identifier(worktreeVarName),
						t.identifier("worktreePath"),
					);
					const ifStmt = buildWorktreeSetStatement(
						permVarName,
						worktreePathExpr,
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
			const searchDeclarators = (declarations: t.VariableDeclarator[]): string | null => {
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
					console.log(
						`Worktree permissions: patched ${parts.join(" + ")}`,
					);
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

	let foundAdditionalWorkingDirectoriesSet = 0;

	traverse.default(verifyAst, {
		CallExpression(path) {
			// Look for: X.additionalWorkingDirectories.set(Y, "session")
			const callee = path.node.callee;
			if (!t.isMemberExpression(callee)) return;
			if (getMemberPropertyName(callee) !== "set") return;
			if (!t.isMemberExpression(callee.object)) return;
			if (
				getMemberPropertyName(callee.object) !==
				"additionalWorkingDirectories"
			)
				return;

			// Check second arg is "session"
			if (path.node.arguments.length < 2) return;
			if (!t.isStringLiteral(path.node.arguments[1], { value: "session" }))
				return;

			// Must be inside an if-statement (our injected guard)
			const ifParent = path.findParent((p) => p.isIfStatement());
			if (!ifParent) return;

			foundAdditionalWorkingDirectoriesSet++;
		},
	});

	if (foundAdditionalWorkingDirectoriesSet < 2) {
		return `Expected 2 additionalWorkingDirectories.set("session") calls inside if-guards, found ${foundAdditionalWorkingDirectoriesSet}`;
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
