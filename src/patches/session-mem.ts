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

		let hasPatchedAutoDreamGate = false;

		traverse(verifyAst, {
			IfStatement(path) {
				const { test, consequent } = path.node;
				if (
					isNullOrFalseReturn(consequent) &&
					nodeContainsProperty(test, "autoDreamEnabled")
				) {
					hasPatchedAutoDreamGate = true;
				}
			},
		});

		if (!hasPatchedAutoDreamGate) {
			return "Missing autoDreamEnabled force-on gate";
		}
		return true;
	},
};
