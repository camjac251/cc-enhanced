import * as t from "@babel/types";
import { type NodePath, traverse, type Visitor } from "../babel.js";
import type { Patch } from "../types.js";
import { getMemberPropertyName, getVerifyAst } from "./ast-helpers.js";

/**
 * Always-enable the workflow account gate.
 *
 * The bundle decides whether workflow support is available inside a small
 * function whose branch shape has shifted across releases (a single
 * if/else assignment in earlier builds, a multi-branch chain in newer
 * ones). Two anchors are stable across those shifts:
 *
 *   - the gate call's first argument is the string "tengu_workflows_enabled"
 *   - the same function references `process.env.CLAUDE_CODE_WORKFLOWS`
 *
 * Replacing every gate call inside that function with `true` collapses the
 * server-side gate to always-available while leaving explicit env checks
 * intact, so a user can still disable workflows by env if they want to.
 */

const WORKFLOW_FLAG = "tengu_workflows_enabled";
const WORKFLOW_ENV = "CLAUDE_CODE_WORKFLOWS";

function isProcessReference(node: t.Expression): boolean {
	if (t.isIdentifier(node)) return node.name === "process";
	if (!t.isMemberExpression(node)) return false;
	return (
		getMemberPropertyName(node) === "process" &&
		t.isIdentifier(node.object) &&
		node.object.name === "globalThis"
	);
}

function isWorkflowsEnvMember(node: t.Node): boolean {
	if (!t.isMemberExpression(node)) return false;
	if (getMemberPropertyName(node) !== WORKFLOW_ENV) return false;
	if (!t.isMemberExpression(node.object)) return false;
	const envObject = node.object;
	return (
		getMemberPropertyName(envObject) === "env" &&
		isProcessReference(envObject.object)
	);
}

function isWorkflowGateCall(node: t.Node): boolean {
	if (!t.isCallExpression(node)) return false;
	if (node.arguments.length < 1) return false;
	return t.isStringLiteral(node.arguments[0], { value: WORKFLOW_FLAG });
}

function functionReferencesWorkflowsEnv(
	funcPath: NodePath<t.Function>,
): boolean {
	let found = false;
	funcPath.traverse({
		MemberExpression(memberPath) {
			if (!found && isWorkflowsEnvMember(memberPath.node)) {
				found = true;
			}
		},
	});
	return found;
}

function createFeatureFlagsMutator(): Visitor {
	let patchedCount = 0;
	return {
		CallExpression(path) {
			if (!isWorkflowGateCall(path.node)) return;
			const funcParent = path.getFunctionParent();
			if (!funcParent) return;
			if (!functionReferencesWorkflowsEnv(funcParent)) return;
			path.replaceWith(t.booleanLiteral(true));
			patchedCount++;
		},
		Program: {
			exit() {
				if (patchedCount === 0) {
					console.warn("Feature flags: Could not find workflow account gate");
				}
			},
		},
	};
}

export const featureFlags: Patch = {
	tag: "feature-flags",

	astPasses: () => [
		{
			pass: "mutate",
			visitor: createFeatureFlagsMutator(),
		},
	],

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) {
			return "Unable to parse AST during feature-flags verification";
		}

		let remainingGateCalls = 0;
		let hasWorkflowsEnvReference = false;

		traverse(verifyAst, {
			CallExpression(path) {
				if (!isWorkflowGateCall(path.node)) return;
				const funcParent = path.getFunctionParent();
				if (!funcParent) return;
				if (!functionReferencesWorkflowsEnv(funcParent)) return;
				remainingGateCalls++;
			},
			MemberExpression(path) {
				if (isWorkflowsEnvMember(path.node)) {
					hasWorkflowsEnvReference = true;
				}
			},
		});

		if (!hasWorkflowsEnvReference) {
			return "Missing CLAUDE_CODE_WORKFLOWS env reference (anchor lost)";
		}
		if (remainingGateCalls > 0) {
			return `Workflow gate calls still present (${remainingGateCalls}); mutator did not run or anchor missed`;
		}
		return true;
	},
};
