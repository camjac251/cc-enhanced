import * as t from "@babel/types";
import { type NodePath, traverse, type Visitor } from "../babel.js";
import type { Patch } from "../types.js";
import {
	getObjectKeyName,
	getVerifyAst,
	isMemberPropertyName,
} from "./ast-helpers.js";

function isZeroArgIdentifierCall(node: t.Node | null | undefined): boolean {
	return (
		!!node &&
		t.isCallExpression(node) &&
		t.isIdentifier(node.callee) &&
		node.arguments.length === 0
	);
}

function containsStartsWithZeroArgCall(
	node: t.Node | null | undefined,
): boolean {
	if (!node) return false;

	if (
		(t.isCallExpression(node) || t.isOptionalCallExpression(node)) &&
		(t.isMemberExpression(node.callee) ||
			t.isOptionalMemberExpression(node.callee)) &&
		isMemberPropertyName(node.callee, "startsWith") &&
		node.arguments.length >= 1 &&
		isZeroArgIdentifierCall(node.arguments[0] as t.Node)
	) {
		return true;
	}

	if (t.isLogicalExpression(node)) {
		return (
			containsStartsWithZeroArgCall(node.left as t.Node) ||
			containsStartsWithZeroArgCall(node.right as t.Node)
		);
	}
	if (t.isUnaryExpression(node))
		return containsStartsWithZeroArgCall(node.argument);
	if (t.isConditionalExpression(node)) {
		return (
			containsStartsWithZeroArgCall(node.test) ||
			containsStartsWithZeroArgCall(node.consequent) ||
			containsStartsWithZeroArgCall(node.alternate)
		);
	}
	if (
		(node as { type?: string }).type === "ChainExpression" &&
		"expression" in (node as unknown as Record<string, unknown>)
	) {
		return containsStartsWithZeroArgCall(
			(node as unknown as { expression?: t.Node }).expression,
		);
	}
	if (
		(node as { type?: string }).type === "ParenthesizedExpression" &&
		"expression" in (node as unknown as Record<string, unknown>)
	) {
		return containsStartsWithZeroArgCall(
			(node as unknown as { expression?: t.Node }).expression,
		);
	}

	return false;
}

function expressionContainsStringLiteral(
	node: unknown,
	literal: string,
): boolean {
	if (!node) return false;
	if (t.isStringLiteral(node as t.Node, { value: literal })) return true;
	if (Array.isArray(node)) {
		return node.some((child) =>
			expressionContainsStringLiteral(child, literal),
		);
	}
	if (typeof node !== "object") return false;

	for (const value of Object.values(node as Record<string, unknown>)) {
		if (!value) continue;
		if (Array.isArray(value)) {
			if (
				value.some((child) =>
					expressionContainsStringLiteral(child as t.Node, literal),
				)
			) {
				return true;
			}
			continue;
		}
		if (
			typeof value === "object" &&
			expressionContainsStringLiteral(value as t.Node, literal)
		) {
			return true;
		}
	}
	return false;
}

function statementContainsPlanPreviewReturn(statement: t.Statement): boolean {
	if (t.isReturnStatement(statement)) {
		return expressionContainsStringLiteral(
			statement.argument,
			"/plan to preview",
		);
	}
	if (t.isBlockStatement(statement)) {
		return statement.body.some((child) =>
			statementContainsPlanPreviewReturn(child),
		);
	}
	if (t.isIfStatement(statement)) {
		if (statementContainsPlanPreviewReturn(statement.consequent)) return true;
		return (
			statement.alternate != null &&
			t.isStatement(statement.alternate) &&
			statementContainsPlanPreviewReturn(statement.alternate)
		);
	}
	return false;
}

function statementContainsEmptyStringReturn(statement: t.Statement): boolean {
	if (t.isReturnStatement(statement)) {
		return t.isStringLiteral(statement.argument, { value: "" });
	}
	if (t.isBlockStatement(statement)) {
		return statement.body.some((child) =>
			statementContainsEmptyStringReturn(child),
		);
	}
	if (t.isIfStatement(statement)) {
		if (statementContainsEmptyStringReturn(statement.consequent)) return true;
		return (
			statement.alternate != null &&
			t.isStatement(statement.alternate) &&
			statementContainsEmptyStringReturn(statement.alternate)
		);
	}
	return false;
}

function collectFunctionReturnLabels(
	path: NodePath<t.FunctionDeclaration | t.FunctionExpression>,
): Set<string> {
	const labels = new Set<string>();
	path.traverse({
		Function(innerPath) {
			if (innerPath !== path) innerPath.skip();
		},
		ReturnStatement(returnPath) {
			if (returnPath.getFunctionParent() !== path) return;
			if (t.isStringLiteral(returnPath.node.argument)) {
				labels.add(returnPath.node.argument.value);
			}
		},
	});
	return labels;
}

function isPlanPreviewHintValue(value: t.Expression): boolean {
	if (t.isStringLiteral(value, { value: "/plan to preview" })) return true;
	if (
		t.isConditionalExpression(value) &&
		t.isStringLiteral(value.consequent, { value: "/plan to preview" })
	) {
		return true;
	}
	return false;
}

function isUnpatchedPlanPreviewGuard(path: NodePath<t.IfStatement>): boolean {
	if (!containsStartsWithZeroArgCall(path.node.test)) return false;
	if (t.isBooleanLiteral(path.node.test, { value: false })) return false;
	return statementContainsPlanPreviewReturn(path.node.consequent);
}

function isUnpatchedPlanToolUseHideGuard(
	path: NodePath<t.IfStatement>,
): boolean {
	if (!containsStartsWithZeroArgCall(path.node.test)) return false;
	if (t.isBooleanLiteral(path.node.test, { value: false })) return false;
	return statementContainsEmptyStringReturn(path.node.consequent);
}

function isPatchedPlanPreviewGuard(path: NodePath<t.IfStatement>): boolean {
	return (
		t.isBooleanLiteral(path.node.test, { value: false }) &&
		statementContainsPlanPreviewReturn(path.node.consequent)
	);
}

function isPatchedPlanToolUseHideGuard(path: NodePath<t.IfStatement>): boolean {
	return (
		t.isBooleanLiteral(path.node.test, { value: false }) &&
		statementContainsEmptyStringReturn(path.node.consequent)
	);
}

function isPatchedPreviewHintValue(value: t.Expression): boolean {
	return (
		(t.isUnaryExpression(value, { operator: "void" }) &&
			t.isNumericLiteral(value.argument, { value: 0 })) ||
		t.isIdentifier(value, { name: "undefined" })
	);
}

function isPatchedPlanLabelReturn(path: NodePath<t.ReturnStatement>): boolean {
	if (!t.isStringLiteral(path.node.argument)) return false;
	if (
		path.node.argument.value !== "Write" &&
		path.node.argument.value !== "Update" &&
		path.node.argument.value !== "Read"
	) {
		return false;
	}

	let current: NodePath<t.Node> | null = path.parentPath;
	while (current && !current.isProgram() && !current.isFunction()) {
		if (
			current.isIfStatement() &&
			containsStartsWithZeroArgCall(current.node.test)
		) {
			return true;
		}
		current = current.parentPath;
	}
	return false;
}

export const planDiffUi: Patch = {
	tag: "plan-diff-ui",

	astPasses: () => [
		{
			pass: "mutate",
			visitor: createPlanDiffUiMutator(),
		},
	],

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) return "Unable to parse AST during verification";

		let candidateCount = 0;
		let hasUpdatedPlanLabel = false;
		let hasReadingPlanLabel = false;
		let hasUnpatchedPreviewHint = false;
		let hasUnpatchedPreviewGuard = false;
		let hasUnpatchedToolUseHideGuard = false;
		let hasPatchedPlanLabel = false;
		let hasPatchedPreviewHint = false;
		let hasPatchedPreviewGuard = false;
		let hasPatchedToolUseHideGuard = false;

		traverse(verifyAst, {
			ReturnStatement(path) {
				if (t.isStringLiteral(path.node.argument, { value: "Updated plan" })) {
					hasUpdatedPlanLabel = true;
					candidateCount++;
				}
				if (t.isStringLiteral(path.node.argument, { value: "Reading Plan" })) {
					hasReadingPlanLabel = true;
					candidateCount++;
				}
				if (isPatchedPlanLabelReturn(path)) {
					hasPatchedPlanLabel = true;
					candidateCount++;
				}
			},
			ObjectProperty(path) {
				if (getObjectKeyName(path.node.key) !== "previewHint") return;
				if (!t.isExpression(path.node.value)) return;
				candidateCount++;
				if (isPlanPreviewHintValue(path.node.value)) {
					hasUnpatchedPreviewHint = true;
				}
				if (isPatchedPreviewHintValue(path.node.value)) {
					hasPatchedPreviewHint = true;
				}
			},
			IfStatement(path) {
				if (isUnpatchedPlanPreviewGuard(path)) {
					hasUnpatchedPreviewGuard = true;
					candidateCount++;
				}
				if (isUnpatchedPlanToolUseHideGuard(path)) {
					hasUnpatchedToolUseHideGuard = true;
					candidateCount++;
				}
				if (isPatchedPlanPreviewGuard(path)) {
					hasPatchedPreviewGuard = true;
					candidateCount++;
				}
				if (isPatchedPlanToolUseHideGuard(path)) {
					hasPatchedToolUseHideGuard = true;
					candidateCount++;
				}
			},
		});

		if (candidateCount === 0) {
			return "Plan diff anchors not found; bundle layout may have drifted";
		}
		if (hasUpdatedPlanLabel) {
			return 'Still renders "Updated plan" label for plan-backed Edit/Write';
		}
		if (hasUnpatchedPreviewHint) {
			return "Plan preview hint still suppresses Edit/Write diff rendering";
		}
		if (hasUnpatchedPreviewGuard) {
			return "Plan-only /plan preview guard still suppresses Write create rendering";
		}
		if (hasReadingPlanLabel) {
			return 'Still renders "Reading Plan" label for plan-backed Read';
		}
		if (hasUnpatchedToolUseHideGuard) {
			return "Plan-backed Edit/Write tool-use message row is still hidden";
		}
		const groups = [
			{
				name: "plan labels",
				hasCandidate:
					hasUpdatedPlanLabel || hasReadingPlanLabel || hasPatchedPlanLabel,
				patched: hasPatchedPlanLabel,
			},
			{
				name: "preview hint",
				hasCandidate: hasUnpatchedPreviewHint || hasPatchedPreviewHint,
				patched: hasPatchedPreviewHint,
			},
			{
				name: "preview guard",
				hasCandidate: hasUnpatchedPreviewGuard || hasPatchedPreviewGuard,
				patched: hasPatchedPreviewGuard,
			},
			{
				name: "tool-use hide guard",
				hasCandidate:
					hasUnpatchedToolUseHideGuard || hasPatchedToolUseHideGuard,
				patched: hasPatchedToolUseHideGuard,
			},
		];

		for (const group of groups) {
			if (group.hasCandidate && !group.patched) {
				return `Plan diff UI: ${group.name} anchor found but not patched`;
			}
		}
		return true;
	},
};

function createPlanDiffUiMutator(): Visitor {
	let patchedLabelReturns = 0;
	let patchedPreviewHints = 0;
	let patchedPreviewGuards = 0;
	let patchedToolUseHideGuards = 0;

	return {
		ReturnStatement(path) {
			if (t.isStringLiteral(path.node.argument, { value: "Reading Plan" })) {
				path.node.argument = t.stringLiteral("Read");
				patchedLabelReturns += 1;
				return;
			}
			if (!t.isStringLiteral(path.node.argument, { value: "Updated plan" }))
				return;

			const fnPath = path.getFunctionParent();
			if (
				!fnPath ||
				(!fnPath.isFunctionDeclaration() && !fnPath.isFunctionExpression())
			) {
				return;
			}

			const labels = collectFunctionReturnLabels(fnPath);
			const fallbackLabel = labels.has("Write")
				? "Write"
				: labels.has("Update")
					? "Update"
					: null;
			if (!fallbackLabel) return;

			path.node.argument = t.stringLiteral(fallbackLabel);
			patchedLabelReturns += 1;
		},

		ObjectProperty(path) {
			if (getObjectKeyName(path.node.key) !== "previewHint") return;
			if (!t.isExpression(path.node.value)) return;
			if (!isPlanPreviewHintValue(path.node.value)) return;

			path.node.value = t.unaryExpression("void", t.numericLiteral(0));
			patchedPreviewHints += 1;
		},

		IfStatement(path) {
			if (isUnpatchedPlanPreviewGuard(path)) {
				path.node.test = t.booleanLiteral(false);
				patchedPreviewGuards += 1;
				return;
			}
			if (isUnpatchedPlanToolUseHideGuard(path)) {
				path.node.test = t.booleanLiteral(false);
				patchedToolUseHideGuards += 1;
			}
		},

		Program: {
			exit() {
				if (patchedLabelReturns === 0) {
					console.warn(
						"plan-diff-ui: Could not find plan label override to patch",
					);
				}
				if (patchedPreviewHints === 0) {
					console.warn(
						"plan-diff-ui: Could not find previewHint plan suppression to patch",
					);
				}
				if (patchedPreviewGuards === 0) {
					console.warn(
						"plan-diff-ui: Could not find plan create preview guard to patch",
					);
				}
				if (patchedToolUseHideGuards === 0) {
					console.warn(
						"plan-diff-ui: Could not find plan tool-use hide guard to patch",
					);
				}
			},
		},
	};
}
