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

function isStateMapClearCall(node: t.Node, mapName: string): boolean {
	return (
		t.isCallExpression(node) &&
		t.isMemberExpression(node.callee) &&
		isMemberPropertyName(node.callee, "clear") &&
		t.isMemberExpression(node.callee.object) &&
		isMemberPropertyName(node.callee.object, mapName)
	);
}

interface SkillStateResetShape {
	kind: "cache-reset" | "full-reset";
	clearsActivatedGuard: boolean;
}

/**
 * Two small reset functions clear conditional-skill state: a cache reset
 * (memoizer caches + conditional bucket + activation guard) and a full
 * session reset that also clears the dynamic-skill map. Only the cache reset
 * lacks any dynamic-skill reference, which is what distinguishes them.
 */
function getSkillStateResetShape(fn: t.Function): SkillStateResetShape | null {
	if (!t.isBlockStatement(fn.body)) return null;
	if (fn.body.body.length > 8) return null;

	let clearsConditional = false;
	let clearsActivatedGuard = false;
	let touchesDynamicSkills = false;
	visitChildNodes(fn.body, (child) => {
		if (isStateMapClearCall(child, "conditionalSkills")) {
			clearsConditional = true;
		}
		if (isStateMapClearCall(child, "activatedConditionalSkillNames")) {
			clearsActivatedGuard = true;
		}
		if (
			t.isMemberExpression(child) &&
			isMemberPropertyName(child, "dynamicSkills")
		) {
			touchesDynamicSkills = true;
		}
		return false;
	});

	if (!clearsConditional) return null;
	return {
		kind: touchesDynamicSkills ? "full-reset" : "cache-reset",
		clearsActivatedGuard,
	};
}

/**
 * Keep `activatedConditionalSkillNames` intact across the skill-cache reset.
 * Clearing it re-buckets every already-activated path skill as conditional,
 * so the next matching file touch re-activates it, which emits a skill-change
 * event, which triggers another reload and reset: an endless churn loop that
 * reloads the skill/command registries on every attachment cycle. Under this
 * patch path skills are always model-available, so suppressing re-activation
 * loses nothing. The full session reset (which also clears the dynamic-skill
 * map) keeps its guard clear.
 */
function patchCacheResetActivationGuard(path: NodePath<t.Function>): boolean {
	const shape = getSkillStateResetShape(path.node);
	if (shape?.kind !== "cache-reset") return false;
	if (!shape.clearsActivatedGuard) return true;

	let removed = false;
	path.traverse({
		CallExpression(callPath) {
			if (removed) return;
			if (
				!isStateMapClearCall(callPath.node, "activatedConditionalSkillNames")
			) {
				return;
			}
			removed = true;
			const parentNode = callPath.parentPath?.node;
			if (
				t.isSequenceExpression(parentNode) &&
				parentNode.expressions.length === 2 &&
				callPath.parentPath
			) {
				const sibling = parentNode.expressions.find(
					(expr) => expr !== callPath.node,
				);
				if (sibling) {
					callPath.parentPath.replaceWith(sibling);
					return;
				}
			}
			callPath.remove();
		},
	});
	return removed;
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
	let patchedCacheReset = false;

	return [
		{
			pass: "mutate",
			visitor: {
				Function(path) {
					if (!patchedCacheReset && patchCacheResetActivationGuard(path)) {
						patchedCacheReset = true;
					}
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
						if (foundLoader && !patchedCacheReset) {
							console.warn(
								"skill-paths-invoke: could not find conditional-skill cache reset",
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
	let foundCacheReset = false;
	let cacheResetStillClearsGuard = false;
	let fullResetMissingGuardClear = false;

	traverse(ast, {
		Function(path) {
			const resetShape = getSkillStateResetShape(path.node);
			if (resetShape?.kind === "cache-reset") {
				foundCacheReset = true;
				if (resetShape.clearsActivatedGuard) cacheResetStillClearsGuard = true;
			} else if (
				resetShape?.kind === "full-reset" &&
				!resetShape.clearsActivatedGuard
			) {
				fullResetMissingGuardClear = true;
			}
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
	if (!foundCacheReset) {
		return "Could not find the conditional-skill cache reset";
	}
	if (cacheResetStillClearsGuard) {
		return "Skill-cache reset still clears the conditional-activation guard";
	}
	if (fullResetMissingGuardClear) {
		return "Full skill-state reset no longer clears the conditional-activation guard";
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
