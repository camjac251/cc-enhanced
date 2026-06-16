import * as t from "@babel/types";
import { traverse, type Visitor } from "../babel.js";
import type { Patch } from "../types.js";
import { getMemberPropertyName, getVerifyAst } from "./ast-helpers.js";

/**
 * Add explicit local overrides for memory-related surfaces.
 */

function nodeContainsProperty(node: t.Node, propertyName: string): boolean {
	const visit = (value: unknown): boolean => {
		if (!value) return false;
		if (Array.isArray(value)) return value.some((item) => visit(item));
		if (typeof value !== "object") return false;
		const maybeNode = value as t.Node;
		if (typeof (maybeNode as { type?: unknown }).type !== "string")
			return false;
		if (
			t.isMemberExpression(maybeNode) &&
			getMemberPropertyName(maybeNode) === propertyName
		) {
			return true;
		}
		return Object.values(maybeNode as unknown as Record<string, unknown>).some(
			(child) => visit(child),
		);
	};
	return visit(node);
}

function isNullOrFalseReturn(node: t.Statement): boolean {
	if (t.isReturnStatement(node)) {
		return (
			t.isNullLiteral(node.argument) ||
			t.isBooleanLiteral(node.argument, { value: false }) ||
			(t.isUnaryExpression(node.argument, { operator: "!" }) &&
				t.isNumericLiteral(node.argument.argument, { value: 1 }))
		);
	}
	if (t.isBlockStatement(node) && node.body.length === 1) {
		return isNullOrFalseReturn(node.body[0]);
	}
	return false;
}

function getAutoDreamEnabledMember(
	node: t.Statement | null | undefined,
): t.MemberExpression | null {
	if (!node || !t.isVariableDeclaration(node)) return null;
	for (const declaration of node.declarations) {
		const init = declaration.init;
		if (
			t.isMemberExpression(init) &&
			getMemberPropertyName(init) === "autoDreamEnabled"
		) {
			return init;
		}
	}
	return null;
}

function createSessionMemoryMutator(): Visitor {
	let patchedAutoDream = false;
	return {
		IfStatement(path) {
			const test = path.node.test;
			if (
				isNullOrFalseReturn(path.node.consequent) &&
				t.isBlockStatement(path.parentPath.node)
			) {
				const siblings = path.parentPath.node.body;
				const nextStatement = siblings[siblings.indexOf(path.node) + 1];
				const autoDreamMember = getAutoDreamEnabledMember(nextStatement);
				if (autoDreamMember) {
					if (nodeContainsProperty(test, "autoDreamEnabled")) {
						patchedAutoDream = true;
						return;
					}
					path.node.test = t.logicalExpression(
						"&&",
						t.binaryExpression(
							"!==",
							t.cloneNode(autoDreamMember),
							t.booleanLiteral(true),
						),
						test,
					);
					patchedAutoDream = true;
					return;
				}
			}
		},
		Program: {
			exit() {
				if (!patchedAutoDream) {
					console.warn(
						"Session memory: Could not find auto-dream availability gate",
					);
				}
			},
		},
	};
}

export const sessionMemory: Patch = {
	tag: "session-mem",

	astPasses: () => [
		{
			pass: "mutate",
			visitor: createSessionMemoryMutator(),
		},
	],

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) {
			return "Unable to parse AST during session-memory verification";
		}

		// Re-locate the gate the same way the mutator does: an if-statement
		// with a null/false-return consequent whose immediate next sibling is
		// an `autoDreamEnabled` member var-decl. Anchoring on the var-decl
		// sibling (rather than "the test mentions autoDreamEnabled") is what the
		// mutator keys on, so verifying the same node makes this a "did MY
		// mutation land" check instead of a looser global-shape check.
		let targetGateCount = 0;
		let patchedGateCount = 0;

		traverse(verifyAst, {
			IfStatement(path) {
				if (!isAutoDreamAvailabilityGate(path.node, path.parentPath?.node)) {
					return;
				}
				targetGateCount++;
				if (isPatchedAutoDreamGateTest(path.node.test)) {
					patchedGateCount++;
				}
			},
		});

		if (targetGateCount === 0) {
			return "Missing autoDreamEnabled force-on gate";
		}
		if (patchedGateCount < targetGateCount) {
			return "Auto-dream availability gate present but not force-on (missing `autoDreamEnabled !== true &&` prefix)";
		}
		return true;
	},
};

/**
 * Mirror the mutator's gate detection: an if-statement whose consequent is a
 * null/false return and whose immediate next sibling declares an
 * `autoDreamEnabled` member. The mutator only wraps gates that satisfy this, so
 * verify must locate gates the same way.
 */
function isAutoDreamAvailabilityGate(
	node: t.IfStatement,
	parent: t.Node | null | undefined,
): boolean {
	if (!isNullOrFalseReturn(node.consequent)) return false;
	if (!parent || !t.isBlockStatement(parent)) return false;
	const siblings = parent.body;
	const nextStatement = siblings[siblings.indexOf(node) + 1];
	return getAutoDreamEnabledMember(nextStatement) !== null;
}

function isPatchedAutoDreamGateTest(test: t.Expression): boolean {
	// Mutator wraps the original test in: (autoDream !== true) && originalTest.
	// Verify must look for that exact distinctive shape; merely seeing
	// autoDreamEnabled in the test would also accept the unpatched code.
	if (!t.isLogicalExpression(test, { operator: "&&" })) return false;
	const { left, right } = test;
	if (!t.isBinaryExpression(left, { operator: "!==" })) return false;
	if (!t.isBooleanLiteral(left.right, { value: true })) return false;
	if (!t.isMemberExpression(left.left)) return false;
	if (getMemberPropertyName(left.left) !== "autoDreamEnabled") return false;
	// The mutator preserves the original gate condition as the right operand.
	// A bare boolean right operand would mean the original guard was lost,
	// so the wrapped condition must be a non-trivial expression.
	if (t.isBooleanLiteral(right)) return false;
	return true;
}
