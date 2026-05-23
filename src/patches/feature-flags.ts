import * as t from "@babel/types";
import { traverse, type Visitor } from "../babel.js";
import type { Patch } from "../types.js";
import { getMemberPropertyName, getVerifyAst } from "./ast-helpers.js";

/**
 * Add explicit local overrides for feature/account gates.
 */

function isProcessReference(node: t.Expression): boolean {
	if (t.isIdentifier(node)) return node.name === "process";
	if (!t.isMemberExpression(node)) return false;
	return (
		getMemberPropertyName(node) === "process" &&
		t.isIdentifier(node.object) &&
		node.object.name === "globalThis"
	);
}

function findTruthyCheckFn(ast: t.File): string | null {
	const scores = new Map<string, number>();
	const bump = (name: string, weight: number) => {
		scores.set(name, (scores.get(name) ?? 0) + weight);
	};

	traverse(ast, {
		CallExpression(path) {
			if (!t.isIdentifier(path.node.callee)) return;
			if (path.node.arguments.length !== 1) return;

			const arg = path.node.arguments[0];
			if (!t.isMemberExpression(arg)) return;
			if (!t.isMemberExpression(arg.object)) return;

			const innerObj = arg.object;
			if (!isProcessReference(innerObj.object)) return;
			if (getMemberPropertyName(innerObj) !== "env") return;

			const fnName = path.node.callee.name;
			bump(fnName, 1);

			const parent = path.parentPath;
			if (t.isIfStatement(parent?.node) && parent.node.test === path.node) {
				bump(fnName, 5);
				return;
			}

			if (
				t.isUnaryExpression(parent?.node, { operator: "!" }) &&
				parent.node.argument === path.node
			) {
				const grandParent = parent.parentPath;
				if (
					t.isIfStatement(grandParent?.node) &&
					grandParent.node.test === parent.node
				) {
					bump(fnName, 4);
					return;
				}
			}

			if (
				t.isLogicalExpression(parent?.node) &&
				(parent.node.operator === "||" || parent.node.operator === "&&")
			) {
				const grandParent = parent.parentPath;
				if (
					t.isIfStatement(grandParent?.node) &&
					grandParent.node.test === parent.node
				) {
					bump(fnName, 3);
				}
			}
		},
	});

	if (scores.size === 0) return null;

	const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
	if (ranked.length === 1) return ranked[0][0];
	if (ranked[0][1] === ranked[1][1]) return null;
	return ranked[0][0];
}

function isEnvMember(node: t.Node, envName: string): boolean {
	if (!t.isMemberExpression(node)) return false;
	if (getMemberPropertyName(node) !== envName) return false;
	if (!t.isMemberExpression(node.object)) return false;
	const envObject = node.object;
	return (
		getMemberPropertyName(envObject) === "env" &&
		isProcessReference(envObject.object)
	);
}

function isTruthyEnvCall(
	node: t.Node,
	truthyFn: string,
	envName: string,
): boolean {
	if (!t.isCallExpression(node)) return false;
	if (!t.isIdentifier(node.callee, { name: truthyFn })) return false;
	if (node.arguments.length !== 1) return false;
	return isEnvMember(node.arguments[0], envName);
}

function isNegatedTruthyEnvCall(
	node: t.Node,
	truthyFn: string,
	envName: string,
): boolean {
	return (
		t.isUnaryExpression(node, { operator: "!" }) &&
		isTruthyEnvCall(node.argument, truthyFn, envName)
	);
}

function isFlagCall(node: t.Node, flagName: string): boolean {
	if (!t.isCallExpression(node)) return false;
	if (node.arguments.length < 1) return false;
	return t.isStringLiteral(node.arguments[0], { value: flagName });
}

function nodeContainsFlagCall(node: t.Node, flagName: string): boolean {
	const visit = (value: unknown): boolean => {
		if (!value) return false;
		if (Array.isArray(value)) return value.some((item) => visit(item));
		if (typeof value !== "object") return false;
		const maybeNode = value as t.Node;
		if (typeof (maybeNode as { type?: unknown }).type !== "string")
			return false;
		if (isFlagCall(maybeNode, flagName)) return true;
		return Object.values(maybeNode as unknown as Record<string, unknown>).some(
			(child) => visit(child),
		);
	};
	return visit(node);
}

function getAssignmentExpression(
	node: t.Statement | null | undefined,
): t.AssignmentExpression | null {
	if (!node) return null;
	if (
		t.isExpressionStatement(node) &&
		t.isAssignmentExpression(node.expression)
	) {
		return node.expression;
	}
	if (t.isBlockStatement(node) && node.body.length === 1) {
		return getAssignmentExpression(node.body[0]);
	}
	return null;
}

function createFeatureFlagsMutator(truthyFn: string): Visitor {
	let patchedWorkflowGate = false;
	return {
		IfStatement(path) {
			const test = path.node.test;
			if (!isNegatedTruthyEnvCall(test, truthyFn, "CLAUDE_CODE_WORKFLOWS")) {
				return;
			}

			const alternateAssignment = getAssignmentExpression(path.node.alternate);
			if (
				alternateAssignment &&
				nodeContainsFlagCall(
					alternateAssignment.right,
					"tengu_workflows_enabled",
				)
			) {
				alternateAssignment.right = t.booleanLiteral(true);
				patchedWorkflowGate = true;
				return;
			}

			if (
				alternateAssignment &&
				t.isBooleanLiteral(alternateAssignment.right, { value: true })
			) {
				patchedWorkflowGate = true;
			}
		},
		Program: {
			exit() {
				if (!patchedWorkflowGate) {
					console.warn("Feature flags: Could not find workflow account gate");
				}
			},
		},
	};
}

export const featureFlags: Patch = {
	tag: "feature-flags",

	astPasses: (ast) => {
		const truthyFn = findTruthyCheckFn(ast);
		if (!truthyFn) {
			console.warn("Feature flags: Could not find truthy check function");
			return [];
		}
		return [
			{
				pass: "mutate",
				visitor: createFeatureFlagsMutator(truthyFn),
			},
		];
	},

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) {
			return "Unable to parse AST during feature-flags verification";
		}

		let hasWorkflowEnvGate = false;
		let hasPatchedWorkflowGate = false;
		let hasOldWorkflowAccountGate = false;

		traverse(verifyAst, {
			IfStatement(path) {
				const { test } = path.node;
				// Mirror the mutator's strict gate shape: `!CALL(MEMBER(...))`
				// where the inner member is exactly process.env.CLAUDE_CODE_WORKFLOWS.
				// The previous nodeContainsEnvRef check accepted any AST that
				// happened to contain a CLAUDE_CODE_WORKFLOWS identifier
				// anywhere in the test, including local variables sharing the
				// name or unrelated comparisons.
				if (!isPatchedWorkflowGateTest(test)) return;

				hasWorkflowEnvGate = true;
				const alternateAssignment = getAssignmentExpression(
					path.node.alternate,
				);
				if (!alternateAssignment) return;
				if (isFlagCall(alternateAssignment.right, "tengu_workflows_enabled")) {
					hasOldWorkflowAccountGate = true;
				}
				if (t.isBooleanLiteral(alternateAssignment.right, { value: true })) {
					hasPatchedWorkflowGate = true;
				}
			},
		});

		if (!hasWorkflowEnvGate) {
			return "Missing CLAUDE_CODE_WORKFLOWS env var check (or the gate's `!truthyFn(process.env.CLAUDE_CODE_WORKFLOWS)` shape changed)";
		}
		if (hasOldWorkflowAccountGate) {
			return "Old workflow account feature gate still present";
		}
		if (!hasPatchedWorkflowGate) {
			return "Missing workflow local opt-in gate";
		}
		return true;
	},
};

function isPatchedWorkflowGateTest(node: t.Node): boolean {
	if (!t.isUnaryExpression(node, { operator: "!" })) return false;
	const inner = node.argument;
	if (!t.isCallExpression(inner)) return false;
	if (inner.arguments.length !== 1) return false;
	return isEnvMember(inner.arguments[0], "CLAUDE_CODE_WORKFLOWS");
}
