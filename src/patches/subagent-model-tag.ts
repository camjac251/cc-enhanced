import * as t from "@babel/types";
import { type NodePath, traverse } from "../babel.js";
import type { Patch, PatchAstPass } from "../types.js";
import { getObjectKeyName, getVerifyAst, isTrueLike } from "./ast-helpers.js";

/**
 * Identify if a node is a MemberExpression accessing the ".model" property.
 */
function isModelPropertyAccess(node: t.Node): boolean {
	return (
		t.isMemberExpression(node) &&
		!node.computed &&
		getObjectKeyName(node.property as t.Expression | t.Identifier) === "model"
	);
}

/**
 * Check if a node or any of its descendants match a predicate.
 */
function nodeContains(
	node: t.Node | null | undefined,
	predicate: (value: t.Node) => boolean,
): boolean {
	if (!node) return false;
	if (predicate(node)) return true;
	let found = false;
	traverse(
		node,
		{
			enter(path) {
				if (predicate(path.node)) {
					found = true;
					path.stop();
				}
			},
			noScope: true,
		},
		undefined,
		undefined,
	);
	return found;
}

/**
 * Identify if a node is a call to .push() that appears to be pushing a model tag UI element.
 */
function isModelTagPush(node: t.Node): boolean {
	if (!t.isCallExpression(node)) return false;
	if (!t.isMemberExpression(node.callee)) return false;
	if (getObjectKeyName(node.callee.property as any) !== "push") return false;
	if (node.arguments.length === 0) return false;

	const arg = node.arguments[0];
	if (!t.isExpression(arg)) return false;

	// Look for key: "model" AND dimColor: true (current Agent-era row shape)
	const hasModelKey = nodeContains(
		arg,
		(n) =>
			t.isObjectProperty(n) &&
			getObjectKeyName(n.key) === "key" &&
			t.isStringLiteral(n.value, { value: "model" }),
	);
	if (!hasModelKey) return false;

	const hasSignal = nodeContains(
		arg,
		(n) =>
			t.isObjectProperty(n) &&
			getObjectKeyName(n.key) === "dimColor" &&
			isTrueLike(n.value),
	);

	return hasSignal;
}

function envMember(name: string): t.MemberExpression {
	return t.memberExpression(
		t.memberExpression(t.identifier("process"), t.identifier("env")),
		t.identifier(name),
	);
}

function isProcessEnvMember(node: t.Node, envName: string): boolean {
	if (!t.isMemberExpression(node) || node.computed) return false;
	if (
		getObjectKeyName(node.property as t.Expression | t.Identifier) !== envName
	)
		return false;

	const envObject = node.object;
	if (!t.isMemberExpression(envObject) || envObject.computed) return false;
	if (
		getObjectKeyName(envObject.property as t.Expression | t.Identifier) !==
		"env"
	)
		return false;

	const processObject = envObject.object;
	if (t.isIdentifier(processObject, { name: "process" })) return true;

	return (
		t.isMemberExpression(processObject) &&
		!processObject.computed &&
		t.isIdentifier(processObject.object, { name: "globalThis" }) &&
		getObjectKeyName(processObject.property as t.Expression | t.Identifier) ===
			"process"
	);
}

function testContainsSubagentModelEnvGuard(test: t.Expression): boolean {
	return nodeContains(test, (node) =>
		isProcessEnvMember(node, "CLAUDE_CODE_SUBAGENT_MODEL"),
	);
}

function isCandidate(path: NodePath<t.IfStatement>): boolean {
	// 1. Does the test involve .model?
	if (!nodeContains(path.node.test, isModelPropertyAccess)) return false;

	// 2. Does the body contain a model tag push?
	if (!nodeContains(path.node.consequent, isModelTagPush)) return false;

	return true;
}

function createSubagentModelTagPasses(): PatchAstPass[] {
	const candidates: NodePath<t.IfStatement>[] = [];
	let guardedCount = 0;
	let patched = false;

	return [
		{
			pass: "discover",
			visitor: {
				IfStatement(path) {
					if (!isCandidate(path)) return;

					const isGuarded = testContainsSubagentModelEnvGuard(path.node.test);

					if (isGuarded) {
						guardedCount++;
					} else {
						candidates.push(path);
					}
				},
			},
		},
		{
			pass: "mutate",
			visitor: {
				Program: {
					exit() {
						if (guardedCount === 1 && candidates.length === 0) {
							patched = true;
							return;
						}

						if (candidates.length === 1 && guardedCount === 0) {
							const candidate = candidates[0];
							candidate.node.test = t.logicalExpression(
								"&&",
								t.cloneNode(candidate.node.test),
								t.unaryExpression("!", envMember("CLAUDE_CODE_SUBAGENT_MODEL")),
							);
							patched = true;
						}
					},
				},
			},
		},
		{
			pass: "finalize",
			visitor: {
				Program: {
					exit() {
						if (patched) return;

						const total = guardedCount + candidates.length;
						if (total > 1) {
							console.warn(
								`Subagent model tag: Ambiguous Agent model tag branches (${total} candidates); refusing to patch`,
							);
						} else if (total === 0) {
							console.warn(
								"Subagent model tag: Could not find unique Agent model tag branch to patch",
							);
						}
					},
				},
			},
		},
	];
}

/**
 * Hide Agent-tool model tags in subagent rows when wrapper forces subagent model
 * via CLAUDE_CODE_SUBAGENT_MODEL.
 */
export const subagentModelTag: Patch = {
	tag: "subagent-model-tag",

	astPasses: () => createSubagentModelTagPasses(),

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst)
			return "Unable to parse AST during subagent-model-tag verification";

		let patchedCount = 0;
		let unpatchedCount = 0;

		traverse(verifyAst, {
			IfStatement(path) {
				if (!isCandidate(path)) return;

				const isGuarded = testContainsSubagentModelEnvGuard(path.node.test);
				if (isGuarded) patchedCount++;
				else unpatchedCount++;
			},
		});

		const total = patchedCount + unpatchedCount;
		if (total === 0) {
			return "Agent model tag branch not found";
		}
		if (total > 1) {
			return `Agent model tag branch is ambiguous (${total} branches found)`;
		}
		if (patchedCount === 0) {
			return "Agent model tag branch found but not patched";
		}
		return true;
	},
};
