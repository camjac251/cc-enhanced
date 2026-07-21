import * as t from "@babel/types";
import { type NodePath, traverse } from "../babel.js";
import type { Patch, PatchAstPass } from "../types.js";
import {
	getObjectKeyName,
	getObjectPropertyByName,
	getVerifyAst,
} from "./ast-helpers.js";

const APPEND_VAR_NAME = "__ccEnhancedSubagentSystemPromptAppend";
const SUBAGENT_APPEND_ENV = "CLAUDE_CODE_ENABLE_APPEND_SUBAGENT_PROMPT";

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

function flattenLogicalAnd(node: t.Expression): t.Expression[] {
	if (t.isLogicalExpression(node, { operator: "&&" })) {
		return [...flattenLogicalAnd(node.left), ...flattenLogicalAnd(node.right)];
	}
	return [node];
}

function buildLogicalAnd(parts: t.Expression[]): t.Expression {
	if (parts.length === 0) return t.identifier(APPEND_VAR_NAME);
	const [first, ...rest] = parts;
	return rest.reduce<t.Expression>(
		(left, right) => t.logicalExpression("&&", left, right),
		first,
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

function containsSubagentAppendEnv(node: t.Node): boolean {
	return nodeContains(node, (candidate) =>
		isProcessEnvMember(candidate, SUBAGENT_APPEND_ENV),
	);
}

function getOptionsObjectForProp(
	node: t.Node,
	propName: string,
): t.Expression | null {
	if (!t.isMemberExpression(node)) return null;
	if (
		getObjectKeyName(node.property as t.Expression | t.Identifier) !== propName
	)
		return null;
	if (!t.isMemberExpression(node.object)) return null;
	if (
		getObjectKeyName(node.object.property as t.Expression | t.Identifier) !==
		"options"
	)
		return null;
	if (!t.isExpression(node.object.object)) return null;
	return node.object.object;
}

function containsOptionsProp(node: t.Node, propName: string): boolean {
	return nodeContains(
		node,
		(candidate) => getOptionsObjectForProp(candidate, propName) !== null,
	);
}

function findOptionsObjectForProp(
	node: t.Node,
	propName: string,
): t.Expression | null {
	let optionsObject: t.Expression | null = null;
	traverse(
		node,
		{
			MemberExpression(path) {
				const found = getOptionsObjectForProp(path.node, propName);
				if (!found) return;
				optionsObject = t.cloneNode(found);
				path.stop();
			},
			noScope: true,
		},
		undefined,
		undefined,
	);
	return optionsObject;
}

function optionMember(
	optionsObject: t.Expression,
	propName: string,
): t.MemberExpression {
	return t.memberExpression(
		t.memberExpression(t.cloneNode(optionsObject), t.identifier("options")),
		t.identifier(propName),
	);
}

function isAppendVar(node: t.Node): boolean {
	return t.isIdentifier(node, { name: APPEND_VAR_NAME });
}

function isVoidZero(node: t.Node | null | undefined): boolean {
	return (
		t.isUnaryExpression(node, { operator: "void" }) &&
		t.isNumericLiteral(node.argument, { value: 0 })
	);
}

function getStartupAppendDefault(
	node: t.ObjectExpression,
): { appendValue: t.Expression; subagentProp: t.ObjectProperty } | null {
	const appendProp = getObjectPropertyByName(node, "appendSystemPrompt");
	const subagentProp = getObjectPropertyByName(
		node,
		"appendSubagentSystemPrompt",
	);
	if (!appendProp || !subagentProp) return null;
	if (!t.isExpression(appendProp.value)) return null;
	if (!isVoidZero(subagentProp.value)) return null;

	return { appendValue: appendProp.value, subagentProp };
}

function isFallbackAppendDeclarator(node: t.VariableDeclarator): boolean {
	if (!t.isIdentifier(node.id, { name: APPEND_VAR_NAME })) return false;
	const init = node.init;
	if (!t.isLogicalExpression(init, { operator: "??" })) return false;
	return (
		containsOptionsProp(init.left, "appendSubagentSystemPrompt") &&
		containsOptionsProp(init.right, "appendSystemPrompt")
	);
}

function hasFallbackAppendDeclarator(ast: t.File | t.Program): boolean {
	let found = false;
	const root = t.isFile(ast) ? ast : t.file(ast);
	traverse(root, {
		VariableDeclarator(path) {
			if (!isFallbackAppendDeclarator(path.node)) return;
			found = true;
			path.stop();
		},
	});
	return found;
}

// A void-0 subagent append default means the startup channel no longer
// forwards the append prompt natively; verify fails on any such object so
// the patch gets repointed instead of the channel silently dying.
function countStartupAppendDefaults(ast: t.File | t.Program): {
	legacy: number;
} {
	let legacy = 0;
	const root = t.isFile(ast) ? ast : t.file(ast);
	traverse(root, {
		ObjectExpression(path) {
			if (getStartupAppendDefault(path.node)) legacy++;
		},
	});
	return { legacy };
}

function isCallWithPromptAppend(
	node: t.Node,
	appendPredicate: (value: t.Node) => boolean,
): node is t.CallExpression {
	if (!t.isCallExpression(node)) return false;
	if (node.arguments.length !== 1) return false;
	const [firstArg] = node.arguments;
	if (!t.isArrayExpression(firstArg)) return false;
	return firstArg.elements.some(
		(element) => !!element && appendPredicate(element),
	);
}

function isPatchedCallShape(
	consequent: t.Expression,
	alternate: t.Expression,
): boolean {
	if (!t.isCallExpression(consequent)) return false;
	if (consequent.arguments.length !== 1) return false;
	const [arr] = consequent.arguments;
	if (!t.isArrayExpression(arr)) return false;
	if (arr.elements.length !== 2) return false;

	const [first, second] = arr.elements;
	if (!first || !second) return false;
	if (!t.isSpreadElement(first)) return false;
	if (!t.isIdentifier(second, { name: APPEND_VAR_NAME })) return false;

	// The spread argument must structurally match the alternate (base prompt).
	// A regression emitting `[append]` instead of `[...basePrompt, append]`
	// would silently strip the base subagent system prompt; this catches it.
	return t.isNodesEquivalent(first.argument, alternate);
}

function isPatchedTestShape(test: t.Expression): boolean {
	if (containsSubagentAppendEnv(test)) return false;
	// The patched test must be a (possibly multi-operand) `&&` chain whose
	// final operand is the append-var identifier the mutator introduced.
	const operands = flattenLogicalAnd(test);
	const last = operands[operands.length - 1];
	if (!last || !isAppendVar(last)) return false;
	// No earlier operand may reference the legacy env or the
	// appendSubagentSystemPrompt option (the mutator strips both).
	for (const operand of operands.slice(0, -1)) {
		if (containsSubagentAppendEnv(operand)) return false;
		if (containsOptionsProp(operand, "appendSubagentSystemPrompt"))
			return false;
	}
	return true;
}

function isPatchedSubagentPromptConditional(
	node: t.ConditionalExpression,
): boolean {
	if (!isPatchedTestShape(node.test)) return false;
	if (!isPatchedCallShape(node.consequent, node.alternate)) return false;
	return true;
}

function isLegacySubagentPromptConditional(
	node: t.ConditionalExpression,
): boolean {
	return (
		containsSubagentAppendEnv(node.test) &&
		containsOptionsProp(node.test, "appendSubagentSystemPrompt") &&
		isCallWithPromptAppend(node.consequent, (candidate) =>
			containsOptionsProp(candidate, "appendSubagentSystemPrompt"),
		)
	);
}

interface SubagentAppendCandidate {
	declPath: NodePath<t.VariableDeclarator>;
	optionsObject: t.Expression;
	renderCallee: t.Expression;
	basePrompt: t.Expression;
	controlOperands: t.Expression[];
}

function getCandidate(
	path: NodePath<t.VariableDeclarator>,
): SubagentAppendCandidate | null {
	const init = path.node.init;
	if (!t.isConditionalExpression(init)) return null;
	if (!isLegacySubagentPromptConditional(init)) return null;

	const consequent = init.consequent;
	if (!t.isCallExpression(consequent)) return null;
	if (!t.isExpression(consequent.callee)) return null;

	const optionsObject = findOptionsObjectForProp(
		init.test,
		"appendSubagentSystemPrompt",
	);
	if (!optionsObject) return null;

	const controlOperands = flattenLogicalAnd(init.test)
		.filter((operand) => !containsSubagentAppendEnv(operand))
		.filter(
			(operand) => !containsOptionsProp(operand, "appendSubagentSystemPrompt"),
		)
		.map((operand) => t.cloneNode(operand));

	return {
		declPath: path,
		optionsObject,
		renderCallee: t.cloneNode(consequent.callee),
		basePrompt: t.cloneNode(init.alternate),
		controlOperands,
	};
}

function createSubagentSystemPromptPasses(): PatchAstPass[] {
	const candidates: SubagentAppendCandidate[] = [];
	let alreadyPatched = false;
	let patched = false;

	return [
		{
			pass: "discover",
			visitor: {
				Program(path) {
					alreadyPatched = hasFallbackAppendDeclarator(path.node);
				},
				VariableDeclarator(path) {
					const candidate = getCandidate(path);
					if (candidate) candidates.push(candidate);
				},
			},
		},
		{
			pass: "mutate",
			visitor: {
				Program: {
					exit() {
						if (alreadyPatched) {
							patched = true;
							return;
						}
						if (candidates.length !== 1) return;

						const candidate = candidates[0];
						const parent = candidate.declPath.parentPath;
						if (!parent.isVariableDeclaration()) return;

						const siblingIndex = parent.node.declarations.indexOf(
							candidate.declPath.node,
						);
						if (siblingIndex < 0) return;

						parent.node.declarations.splice(
							siblingIndex,
							0,
							t.variableDeclarator(
								t.identifier(APPEND_VAR_NAME),
								t.logicalExpression(
									"??",
									optionMember(
										candidate.optionsObject,
										"appendSubagentSystemPrompt",
									),
									optionMember(candidate.optionsObject, "appendSystemPrompt"),
								),
							),
						);

						candidate.declPath.node.init = t.conditionalExpression(
							buildLogicalAnd([
								...candidate.controlOperands,
								t.identifier(APPEND_VAR_NAME),
							]),
							t.callExpression(candidate.renderCallee, [
								t.arrayExpression([
									t.spreadElement(t.cloneNode(candidate.basePrompt)),
									t.identifier(APPEND_VAR_NAME),
								]),
							]),
							t.cloneNode(candidate.basePrompt),
						);
						patched = true;
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
						if (candidates.length > 1) {
							console.warn(
								`Subagent system prompt: Ambiguous subagent append prompt branches (${candidates.length} candidates); refusing to patch`,
							);
						} else {
							console.warn(
								"Subagent system prompt: Could not find subagent append prompt branch to patch",
							);
						}
					},
				},
			},
		},
	];
}

export const subagentSystemPrompt: Patch = {
	tag: "subagent-system-prompt",

	astPasses: () => createSubagentSystemPromptPasses(),

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst)
			return "Unable to parse AST during subagent-system-prompt verification";

		let patchedCount = 0;
		let legacyCount = 0;
		const startupDefaults = countStartupAppendDefaults(verifyAst);

		traverse(verifyAst, {
			ConditionalExpression(path) {
				if (isLegacySubagentPromptConditional(path.node)) legacyCount++;
				if (isPatchedSubagentPromptConditional(path.node)) patchedCount++;
			},
		});

		if (legacyCount > 0) {
			return "Legacy env-gated subagent system prompt append branch still present";
		}
		if (!hasFallbackAppendDeclarator(verifyAst)) {
			return "Missing subagent prompt fallback from appendSubagentSystemPrompt to appendSystemPrompt";
		}
		if (startupDefaults.legacy > 0) {
			return `Subagent append prompt still defaults to void 0 (${startupDefaults.legacy} surviving)`;
		}
		if (patchedCount !== 1) {
			return `Expected exactly one patched subagent system prompt branch, found ${patchedCount}`;
		}

		return true;
	},
};
