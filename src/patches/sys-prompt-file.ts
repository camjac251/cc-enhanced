import * as t from "@babel/types";
import { type NodePath, template, traverse, type Visitor } from "../babel.js";
import type { Patch } from "../types.js";
import { getObjectKeyName, getVerifyAst } from "./ast-helpers.js";

function isMemberOnOptions(
	node: t.Node,
	optionsName: string,
	propertyName: string,
): node is t.MemberExpression {
	if (!t.isMemberExpression(node)) return false;
	if (!t.isIdentifier(node.object)) return false;
	if (node.object.name !== optionsName) {
		return false;
	}
	return (
		getObjectKeyName(node.property as t.Expression | t.Identifier) ===
		propertyName
	);
}

function hasEnvOverrideStrings(node: t.Statement): boolean {
	let found = false;
	traverse(t.file(t.program([node])), {
		StringLiteral(path) {
			if (
				path.node.value === "CLAUDE_CODE_APPEND_SYSTEM_PROMPT_FILE" ||
				path.node.value === "/etc/claude-code/system-prompt.md"
			) {
				found = true;
				path.stop();
			}
		},
	});
	return found;
}

function isUndefinedCheckForOptionProp(
	node: t.Node,
	propName: string,
): node is t.BinaryExpression {
	if (!t.isBinaryExpression(node, { operator: "===" })) return false;
	if (!t.isMemberExpression(node.left)) return false;
	if (
		getObjectKeyName(node.left.property as t.Expression | t.Identifier) !==
		propName
	)
		return false;
	return (
		t.isUnaryExpression(node.right, { operator: "void" }) &&
		t.isNumericLiteral(node.right.argument, { value: 0 })
	);
}

function flattenLogicalAnd(node: t.Node): t.Node[] {
	if (t.isLogicalExpression(node, { operator: "&&" })) {
		return [...flattenLogicalAnd(node.left), ...flattenLogicalAnd(node.right)];
	}
	return [node];
}

function findAppendFileBranchHelpers(
	appendIf: t.IfStatement,
	optionsName: string,
): { resolveCallee: t.Expression; readFileCallee: t.Expression } | null {
	if (!t.isBlockStatement(appendIf.consequent)) return null;

	let resolvedVarName: string | null = null;
	let resolveCallee: t.Expression | null = null;
	let readFileCallee: t.Expression | null = null;

	for (const stmt of appendIf.consequent.body) {
		if (!t.isTryStatement(stmt) || !t.isBlockStatement(stmt.block)) continue;

		for (const innerStmt of stmt.block.body) {
			if (t.isVariableDeclaration(innerStmt)) {
				for (const decl of innerStmt.declarations) {
					if (!t.isIdentifier(decl.id) || !t.isCallExpression(decl.init))
						continue;
					if (!t.isExpression(decl.init.callee)) continue;
					if (decl.init.arguments.length !== 1) continue;
					const [firstArg] = decl.init.arguments;
					if (
						isMemberOnOptions(firstArg, optionsName, "appendSystemPromptFile")
					) {
						resolvedVarName = decl.id.name;
						if (t.isExpression(decl.init.callee)) {
							resolveCallee = t.cloneNode(decl.init.callee);
						}
					}
				}
			}

			const readFileCall =
				t.isExpressionStatement(innerStmt) &&
				t.isCallExpression(innerStmt.expression)
					? innerStmt.expression
					: t.isExpressionStatement(innerStmt) &&
							t.isAssignmentExpression(innerStmt.expression) &&
							t.isAwaitExpression(innerStmt.expression.right) &&
							t.isCallExpression(innerStmt.expression.right.argument)
						? innerStmt.expression.right.argument
						: null;
			if (
				readFileCall &&
				t.isExpression(readFileCall.callee) &&
				readFileCall.arguments.length >= 1
			) {
				const [firstArg] = readFileCall.arguments;
				if (
					resolvedVarName &&
					t.isIdentifier(firstArg) &&
					firstArg.name === resolvedVarName
				) {
					readFileCallee = t.cloneNode(readFileCall.callee);
				}
			}
		}
	}

	if (!resolveCallee || !readFileCallee) return null;
	return { resolveCallee, readFileCallee };
}

function hasAppendPromptConflictCheck(
	appendIf: t.IfStatement,
	optionsName: string,
): boolean {
	if (!t.isBlockStatement(appendIf.consequent)) return false;

	return appendIf.consequent.body.some((stmt) => {
		if (!t.isIfStatement(stmt)) return false;
		return isMemberOnOptions(stmt.test, optionsName, "appendSystemPrompt");
	});
}

function isProcessEnvOverrideAccess(node: t.Node): boolean {
	if (!t.isMemberExpression(node)) return false;
	if (!t.isMemberExpression(node.object)) return false;

	const envObj = node.object;
	const envProp = getObjectKeyName(
		envObj.property as t.Expression | t.Identifier,
	);
	if (envProp !== "env") return false;

	const processRef =
		(t.isIdentifier(envObj.object) && envObj.object.name === "process") ||
		(t.isMemberExpression(envObj.object) &&
			getObjectKeyName(
				envObj.object.property as t.Expression | t.Identifier,
			) === "process" &&
			t.isIdentifier(envObj.object.object, { name: "globalThis" }));
	if (!processRef) return false;

	return (
		getObjectKeyName(node.property as t.Expression | t.Identifier) ===
		"CLAUDE_CODE_APPEND_SYSTEM_PROMPT_FILE"
	);
}

function isMissingFileOnlyCatch(handler: t.CatchClause | null): boolean {
	if (!handler || !t.isIdentifier(handler.param)) return false;
	if (handler.body.body.length !== 1) return false;

	const [statement] = handler.body.body;
	if (!t.isIfStatement(statement) || statement.alternate) return false;
	if (!t.isLogicalExpression(statement.test, { operator: "||" })) return false;
	if (
		!t.isUnaryExpression(statement.test.left, { operator: "!" }) ||
		!t.isIdentifier(statement.test.left.argument, {
			name: handler.param.name,
		})
	) {
		return false;
	}
	if (!t.isBinaryExpression(statement.test.right, { operator: "!==" })) {
		return false;
	}
	if (
		!t.isMemberExpression(statement.test.right.left) ||
		!t.isIdentifier(statement.test.right.left.object, {
			name: handler.param.name,
		}) ||
		getObjectKeyName(
			statement.test.right.left.property as t.Expression | t.Identifier,
		) !== "code" ||
		!t.isStringLiteral(statement.test.right.right, { value: "ENOENT" })
	) {
		return false;
	}

	const consequent = t.isBlockStatement(statement.consequent)
		? statement.consequent.body[0]
		: statement.consequent;
	return (
		t.isThrowStatement(consequent) &&
		t.isIdentifier(consequent.argument, { name: handler.param.name })
	);
}

function inspectAutoAppendGuard(
	path: NodePath<t.IfStatement>,
	expected: {
		appendLocalName: string;
		resolveCallee: t.Expression;
		readFileCallee: t.Expression;
	},
): {
	hasEnvOverride: boolean;
	hasDefaultPath: boolean;
	hasResolvedConfiguredPath: boolean;
	hasAppendAssignment: boolean;
	hasReadFile: boolean;
	hasMissingFileOnlyCatch: boolean;
	guardsReplacementPrompt: boolean;
} | null {
	const guardedProps = new Set<string>();
	let guardedAppendLocal: string | null = null;
	for (const part of flattenLogicalAnd(path.node.test)) {
		for (const propName of [
			"appendSystemPromptFile",
			"appendSystemPrompt",
			"systemPromptFile",
			"systemPrompt",
		]) {
			if (isUndefinedCheckForOptionProp(part, propName)) {
				guardedProps.add(propName);
			}
		}
		if (
			t.isBinaryExpression(part, { operator: "===" }) &&
			t.isIdentifier(part.left) &&
			t.isUnaryExpression(part.right, { operator: "void" }) &&
			t.isNumericLiteral(part.right.argument, { value: 0 })
		) {
			guardedAppendLocal = part.left.name;
		}
	}
	if (!guardedProps.has("appendSystemPromptFile")) return null;
	if (!guardedAppendLocal) return null;
	if (guardedAppendLocal !== expected.appendLocalName) return null;
	if (!t.isBlockStatement(path.node.consequent)) return null;

	// The mutator injects a single wired shape:
	//   appendPrompt = await readFile(resolvedVar, "utf8")
	// inside a try { ... } catch, where resolvedVar = resolve(
	//   process.env.<ENV> ?? "/etc/claude-code/system-prompt.md"
	// ). Verify mirrors that wiring rather than checking the four pieces
	// independently, so a dead env read, a swapped fallback, or a dropped
	// catch fails instead of passing on incidental presence.
	let configuredPathName: string | null = null;
	let hasEnvOverride = false;
	let hasDefaultPath = false;
	for (const statement of path.node.consequent.body) {
		if (!t.isVariableDeclaration(statement)) continue;
		for (const declaration of statement.declarations) {
			if (!t.isIdentifier(declaration.id)) continue;
			if (!t.isLogicalExpression(declaration.init, { operator: "??" })) {
				continue;
			}
			if (!isProcessEnvOverrideAccess(declaration.init.left)) continue;
			hasEnvOverride = true;
			configuredPathName = declaration.id.name;
			hasDefaultPath = t.isStringLiteral(declaration.init.right, {
				value: "/etc/claude-code/system-prompt.md",
			});
		}
	}

	let hasResolvedConfiguredPath = false;
	let hasReadFile = false;
	let hasAppendAssignment = false;
	let hasMissingFileOnlyCatch = false;
	for (const statement of path.node.consequent.body) {
		if (!t.isTryStatement(statement) || !statement.handler) continue;
		let resolvedPathName: string | null = null;
		let tryHasReadFile = false;
		for (const innerStatement of statement.block.body) {
			if (t.isVariableDeclaration(innerStatement)) {
				for (const declaration of innerStatement.declarations) {
					if (
						!configuredPathName ||
						!t.isIdentifier(declaration.id) ||
						!t.isCallExpression(declaration.init) ||
						declaration.init.arguments.length !== 1 ||
						!t.isIdentifier(declaration.init.arguments[0], {
							name: configuredPathName,
						})
					) {
						continue;
					}
					if (
						!t.isNodesEquivalent(
							declaration.init.callee,
							expected.resolveCallee,
						)
					) {
						continue;
					}
					resolvedPathName = declaration.id.name;
					hasResolvedConfiguredPath = true;
				}
			}
			if (
				!resolvedPathName ||
				!t.isExpressionStatement(innerStatement) ||
				!t.isAssignmentExpression(innerStatement.expression) ||
				!t.isIdentifier(innerStatement.expression.left, {
					name: guardedAppendLocal,
				}) ||
				!t.isAwaitExpression(innerStatement.expression.right) ||
				!t.isCallExpression(innerStatement.expression.right.argument)
			) {
				continue;
			}
			const readCall = innerStatement.expression.right.argument;
			if (readCall.arguments.length !== 2) continue;
			if (
				!t.isIdentifier(readCall.arguments[0], { name: resolvedPathName }) ||
				!t.isStringLiteral(readCall.arguments[1], { value: "utf8" })
			) {
				continue;
			}
			tryHasReadFile = t.isNodesEquivalent(
				readCall.callee,
				expected.readFileCallee,
			);
			if (tryHasReadFile) {
				hasReadFile = true;
				hasAppendAssignment = true;
			}
		}
		if (tryHasReadFile) {
			hasMissingFileOnlyCatch = isMissingFileOnlyCatch(statement.handler);
		}
	}

	return {
		hasEnvOverride,
		hasDefaultPath,
		hasResolvedConfiguredPath,
		hasAppendAssignment,
		hasReadFile,
		hasMissingFileOnlyCatch,
		guardsReplacementPrompt:
			guardedProps.has("systemPromptFile") || guardedProps.has("systemPrompt"),
	};
}

function findAutoAppendGuardBeforeAppendBranch(ast: t.File): {
	hasEnvOverride: boolean;
	hasDefaultPath: boolean;
	hasResolvedConfiguredPath: boolean;
	hasAppendAssignment: boolean;
	hasReadFile: boolean;
	hasMissingFileOnlyCatch: boolean;
	guardsReplacementPrompt: boolean;
} | null {
	let found: {
		hasEnvOverride: boolean;
		hasDefaultPath: boolean;
		hasResolvedConfiguredPath: boolean;
		hasAppendAssignment: boolean;
		hasReadFile: boolean;
		hasMissingFileOnlyCatch: boolean;
		guardsReplacementPrompt: boolean;
	} | null = null;

	traverse(ast, {
		IfStatement(path) {
			if (found) return;
			if (!isAppendSystemPromptFileBranch(path)) return;
			if (!t.isMemberExpression(path.node.test)) return;
			if (!t.isIdentifier(path.node.test.object)) return;
			const optionsName = path.node.test.object.name;
			const helpers = findAppendFileBranchHelpers(path.node, optionsName);
			if (!helpers) return;

			const statementPath = path.getStatementParent();
			if (!statementPath) return;
			const appendLocal = findAppendPromptLocalBeforeBranch(
				statementPath,
				optionsName,
			);
			if (!appendLocal) return;
			const parentPath = statementPath.parentPath;
			if (!parentPath?.isBlockStatement()) return;

			const siblingIndex = parentPath.node.body.indexOf(statementPath.node);
			if (siblingIndex <= 0) return;
			const previousSibling = statementPath.getSibling(
				siblingIndex - 1,
			) as NodePath<t.Statement>;
			if (!previousSibling.isIfStatement()) return;

			found = inspectAutoAppendGuard(previousSibling, {
				appendLocalName: appendLocal.localName,
				resolveCallee: helpers.resolveCallee,
				readFileCallee: helpers.readFileCallee,
			});
			path.stop();
		},
	});

	return found;
}

function isAppendSystemPromptFileBranch(
	path: NodePath<t.IfStatement>,
): path is NodePath<t.IfStatement> {
	if (!t.isMemberExpression(path.node.test)) return false;
	if (
		getObjectKeyName(path.node.test.property as t.Expression | t.Identifier) !==
		"appendSystemPromptFile"
	) {
		return false;
	}
	if (!t.isIdentifier(path.node.test.object)) return false;
	return (
		hasAppendPromptConflictCheck(path.node, path.node.test.object.name) &&
		findAppendFileBranchHelpers(path.node, path.node.test.object.name) !== null
	);
}

function findAppendPromptLocalBeforeBranch(
	statementPath: NodePath<t.Statement>,
	optionsName: string,
): { localName: string; insertIndex: number } | null {
	const parentPath = statementPath.parentPath;
	if (!parentPath?.isBlockStatement()) return null;
	const siblingIndex = parentPath.node.body.indexOf(statementPath.node);
	if (siblingIndex <= 0) return null;

	for (let index = siblingIndex - 1; index >= 0; index--) {
		const sibling = parentPath.node.body[index];
		if (!t.isVariableDeclaration(sibling)) continue;
		for (const decl of sibling.declarations) {
			if (!t.isIdentifier(decl.id)) continue;
			if (
				!isMemberOnOptions(
					decl.init as t.Node,
					optionsName,
					"appendSystemPrompt",
				)
			) {
				continue;
			}
			return { localName: decl.id.name, insertIndex: index + 1 };
		}
	}
	return null;
}

export const systemPromptFile: Patch = {
	tag: "sys-prompt-file",

	astPasses: () => [
		{
			pass: "mutate",
			visitor: createSystemPromptFileMutator(),
		},
	],

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst)
			return "Unable to parse AST during sys-prompt-file verification";

		const autoAppendGuard = findAutoAppendGuardBeforeAppendBranch(verifyAst);
		if (!autoAppendGuard) {
			return "Missing auto-append guard immediately before appendSystemPromptFile branch";
		}
		if (!autoAppendGuard.hasEnvOverride) {
			return "Missing CLAUDE_CODE_APPEND_SYSTEM_PROMPT_FILE override";
		}
		if (!autoAppendGuard.hasDefaultPath) {
			return "Missing default /etc/claude-code/system-prompt.md path";
		}
		if (!autoAppendGuard.hasResolvedConfiguredPath) {
			return "Auto-append resolver is not connected to the configured managed prompt path";
		}
		if (!autoAppendGuard.hasReadFile) {
			return "Auto-append read does not use the append-file readFile callee";
		}
		if (!autoAppendGuard.hasAppendAssignment) {
			return "Missing appendSystemPrompt assignment in auto-append flow";
		}
		if (!autoAppendGuard.hasMissingFileOnlyCatch) {
			return "Auto-append catch must rethrow non-ENOENT errors";
		}
		if (autoAppendGuard.guardsReplacementPrompt) {
			return "Auto-append guard must not skip replacement-mode systemPrompt/systemPromptFile";
		}

		return true;
	},
};

function createSystemPromptFileMutator(): Visitor {
	let patched = false;
	return {
		IfStatement(path) {
			if (patched) return;

			if (!isAppendSystemPromptFileBranch(path)) return;
			if (!t.isMemberExpression(path.node.test)) return;
			if (!t.isIdentifier(path.node.test.object)) return;

			const optionsName = path.node.test.object.name;
			const helpers = findAppendFileBranchHelpers(path.node, optionsName);
			if (!helpers) return;

			const statementPath = path.getStatementParent();
			if (!statementPath) return;
			const parentPath = statementPath.parentPath;
			if (!parentPath?.isBlockStatement()) return;

			const parentBlock = parentPath.node;
			if (hasEnvOverrideStrings(parentBlock)) {
				patched = true;
				return;
			}

			const siblingIndex = parentBlock.body.indexOf(statementPath.node);
			if (siblingIndex < 0) return;
			if (!hasAppendPromptConflictCheck(path.node, optionsName)) return;
			const appendLocal = findAppendPromptLocalBeforeBranch(
				statementPath,
				optionsName,
			);
			if (!appendLocal) return;

			const [autoAppendIf] = template.statements(
				`
                if (APPEND_PROMPT === void 0 && OPTIONS.appendSystemPromptFile === void 0) {
                    let configuredSystemPromptFilePath = process.env.CLAUDE_CODE_APPEND_SYSTEM_PROMPT_FILE ?? "/etc/claude-code/system-prompt.md";
                    try {
						let resolvedSystemPromptFile = RESOLVE(configuredSystemPromptFilePath);
						APPEND_PROMPT = await READ_FILE(resolvedSystemPromptFile, "utf8");
					} catch (err) {
						if (!err || err.code !== "ENOENT") throw err;
					}
				}
			`,
				{ placeholderPattern: /^(APPEND_PROMPT|OPTIONS|RESOLVE|READ_FILE)$/ },
			)({
				APPEND_PROMPT: t.identifier(appendLocal.localName),
				OPTIONS: t.identifier(optionsName),
				RESOLVE: t.cloneNode(helpers.resolveCallee),
				READ_FILE: t.cloneNode(helpers.readFileCallee),
			});

			parentBlock.body.splice(appendLocal.insertIndex, 0, autoAppendIf);
			patched = true;
		},
		Program: {
			exit() {
				if (!patched) {
					console.warn(
						"system-prompt-file: Could not find appendSystemPromptFile flow to patch",
					);
				}
			},
		},
	};
}
