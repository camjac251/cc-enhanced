import * as t from "@babel/types";
import { type NodePath, traverse } from "../babel.js";
import type { Patch, PatchAstPass } from "../types.js";
import { getVerifyAst, isMemberPropertyName } from "./ast-helpers.js";

const CONDITIONAL_SKILL_LOG_FRAGMENT =
	"conditional skills stored (activated when matching files are touched)";

interface SkillBucketNames {
	conditional: string;
	unconditional: string;
}

function visitChildNodes(
	node: t.Node | null | undefined,
	visitor: (child: t.Node) => boolean,
): boolean {
	if (!node) return false;
	if (visitor(node)) return true;

	const keys = t.VISITOR_KEYS[node.type] ?? [];
	for (const key of keys) {
		const value = (node as unknown as Record<string, unknown>)[key];
		if (Array.isArray(value)) {
			for (const item of value) {
				if (item && typeof item === "object" && "type" in item) {
					if (visitChildNodes(item as t.Node, visitor)) return true;
				}
			}
			continue;
		}
		if (value && typeof value === "object" && "type" in value) {
			if (visitChildNodes(value as t.Node, visitor)) return true;
		}
	}

	return false;
}

function nodeContainsStringFragment(
	node: t.Node | null | undefined,
	fragment: string,
): boolean {
	return visitChildNodes(node, (child) => {
		if (t.isStringLiteral(child)) return child.value.includes(fragment);
		if (t.isTemplateLiteral(child)) {
			return child.quasis.some((quasi) =>
				(quasi.value.cooked ?? quasi.value.raw).includes(fragment),
			);
		}
		return false;
	});
}

function nodeContainsMemberProperty(
	node: t.Node | null | undefined,
	propertyName: string,
): boolean {
	return visitChildNodes(
		node,
		(child) =>
			t.isMemberExpression(child) && isMemberPropertyName(child, propertyName),
	);
}

function getPushTargetName(
	statement: t.Statement | null | undefined,
): string | null {
	if (!statement) return null;
	if (t.isBlockStatement(statement) && statement.body.length === 1) {
		return getPushTargetName(statement.body[0]);
	}
	if (!t.isExpressionStatement(statement)) return null;

	const expression = statement.expression;
	if (!t.isCallExpression(expression)) return null;
	const callee = expression.callee;
	if (!t.isMemberExpression(callee)) return null;
	if (!t.isIdentifier(callee.object)) return null;
	if (!isMemberPropertyName(callee, "push")) return null;
	if (expression.arguments.length !== 1) return null;

	return callee.object.name;
}

function functionContainsConditionalSkillLog(
	path: NodePath<t.Function>,
): boolean {
	return nodeContainsStringFragment(
		path.node.body,
		CONDITIONAL_SKILL_LOG_FRAGMENT,
	);
}

function findSkillBucketNames(
	path: NodePath<t.Function>,
): SkillBucketNames | null {
	const matches: SkillBucketNames[] = [];

	path.traverse({
		IfStatement(ifPath) {
			if (ifPath.getFunctionParent() !== path) return;
			if (!nodeContainsMemberProperty(ifPath.node.test, "paths")) return;
			if (
				!nodeContainsMemberProperty(
					ifPath.node.test,
					"activatedConditionalSkillNames",
				)
			) {
				return;
			}

			const conditional = getPushTargetName(ifPath.node.consequent);
			const unconditional = getPushTargetName(ifPath.node.alternate);
			if (!conditional || !unconditional || conditional === unconditional)
				return;
			matches.push({ conditional, unconditional });
		},
	});

	return matches.length === 1 ? matches[0] : null;
}

function isMergedSkillBucketExpression(
	node: t.Node | null | undefined,
	buckets: SkillBucketNames,
): node is t.ArrayExpression {
	return (
		!!node &&
		t.isArrayExpression(node) &&
		node.elements.length === 2 &&
		node.elements.every((element) => t.isSpreadElement(element)) &&
		t.isIdentifier(node.elements[0]?.argument, {
			name: buckets.unconditional,
		}) &&
		t.isIdentifier(node.elements[1]?.argument, { name: buckets.conditional })
	);
}

function buildMergedSkillBucketExpression(
	buckets: SkillBucketNames,
): t.ArrayExpression {
	return t.arrayExpression([
		t.spreadElement(t.identifier(buckets.unconditional)),
		t.spreadElement(t.identifier(buckets.conditional)),
	]);
}

function getFinalReturnExpression(
	node: t.Expression | null | undefined,
): t.Expression | null {
	if (!node) return null;
	if (t.isSequenceExpression(node)) {
		const last = node.expressions.at(-1);
		return last && t.isExpression(last) ? last : null;
	}
	return node;
}

function replaceFinalReturnExpression(
	returnStatement: t.ReturnStatement,
	buckets: SkillBucketNames,
): boolean {
	const argument = returnStatement.argument;
	if (!argument) return false;

	if (
		t.isIdentifier(argument, {
			name: buckets.unconditional,
		})
	) {
		returnStatement.argument = buildMergedSkillBucketExpression(buckets);
		return true;
	}

	if (!t.isSequenceExpression(argument)) return false;
	const lastIndex = argument.expressions.length - 1;
	const last = argument.expressions[lastIndex];
	if (!t.isIdentifier(last, { name: buckets.unconditional })) return false;

	argument.expressions[lastIndex] = buildMergedSkillBucketExpression(buckets);
	return true;
}

function patchConditionalSkillLoader(path: NodePath<t.Function>): boolean {
	if (!functionContainsConditionalSkillLog(path)) return false;
	const buckets = findSkillBucketNames(path);
	if (!buckets) return false;

	let patched = false;
	path.traverse({
		ReturnStatement(returnPath) {
			if (returnPath.getFunctionParent() !== path) return;
			const finalExpression = getFinalReturnExpression(
				returnPath.node.argument,
			);
			if (isMergedSkillBucketExpression(finalExpression, buckets)) {
				patched = true;
				return;
			}
			if (replaceFinalReturnExpression(returnPath.node, buckets)) {
				patched = true;
			}
		},
	});

	return patched;
}

function createSkillPathsInvokePasses(): PatchAstPass[] {
	let foundLoader = false;
	let patchedLoader = false;

	return [
		{
			pass: "mutate",
			visitor: {
				Function(path) {
					if (!functionContainsConditionalSkillLog(path)) return;
					foundLoader = true;
					if (patchConditionalSkillLoader(path)) patchedLoader = true;
				},
				Program: {
					exit() {
						if (!foundLoader) {
							console.warn(
								"skill-paths-invoke: could not find path-scoped skill loader",
							);
						} else if (!patchedLoader) {
							console.warn(
								"skill-paths-invoke: path-scoped skill loader return was not patched",
							);
						}
					},
				},
			},
		},
	];
}

function verifyConditionalSkillLoader(ast: t.File): true | string {
	let foundLoader = false;
	let patchedLoader = false;
	let stillReturnsOnlyUnconditional = false;

	traverse(ast, {
		Function(path) {
			if (!functionContainsConditionalSkillLog(path)) return;
			foundLoader = true;
			const buckets = findSkillBucketNames(path);
			if (!buckets) return;

			path.traverse({
				ReturnStatement(returnPath) {
					if (returnPath.getFunctionParent() !== path) return;
					const finalExpression = getFinalReturnExpression(
						returnPath.node.argument,
					);
					if (isMergedSkillBucketExpression(finalExpression, buckets)) {
						patchedLoader = true;
						return;
					}
					if (
						t.isIdentifier(finalExpression, {
							name: buckets.unconditional,
						})
					) {
						stillReturnsOnlyUnconditional = true;
					}
				},
			});
		},
	});

	if (!foundLoader) {
		return "Could not find the path-scoped skill loader";
	}
	if (stillReturnsOnlyUnconditional) {
		return "Path-scoped skill loader still returns only unconditional skills";
	}
	if (!patchedLoader) {
		return "Path-scoped skill loader is missing the merged skill return";
	}

	return true;
}

export const skillPathsInvoke: Patch = {
	tag: "skill-paths-invoke",
	astPasses: () => createSkillPathsInvokePasses(),
	verify(code, ast) {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst)
			return "Could not parse code for skill paths invoke verification";
		return verifyConditionalSkillLoader(verifyAst);
	},
};
