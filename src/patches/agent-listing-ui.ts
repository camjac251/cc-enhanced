import * as t from "@babel/types";
import { type NodePath, template, traverse } from "../babel.js";
import type { Patch, PatchAstPass } from "../types.js";
import {
	appendElementChild,
	getElementChildren,
	getVerifyAst,
	isElementCall,
	isMemberPropertyName,
} from "./ast-helpers.js";

const AGENT_LISTING_SUMMARY_HELPER = "_claudePatchFormatAgentListingSummary";

type RenderRoot = {
	rootCall: t.CallExpression;
	cacheGuard?: t.IfStatement;
};

function buildAgentListingSummaryHelper(): t.Statement {
	return template.statement(
		`
function ${AGENT_LISTING_SUMMARY_HELPER}(attachment) {
  let agentTypes = Array.isArray(attachment.addedTypes)
    ? attachment.addedTypes.filter((agentType) => typeof agentType === "string" && agentType.length > 0)
    : [];
  if (agentTypes.length === 0) return "";
  let visibleAgentTypes = agentTypes.slice(0, 5).join(", ");
  let hiddenCount = agentTypes.length - Math.min(agentTypes.length, 5);
  return hiddenCount > 0
    ? ": " + visibleAgentTypes + " +" + hiddenCount + " more"
    : ": " + visibleAgentTypes;
}
`,
		{ placeholderPattern: false },
	)();
}

/**
 * Confirms the injected summary helper still caps the visible list and emits the
 * overflow suffix, so a corrupted helper body cannot pass on name alone. Checks
 * behavior (a `slice` with a numeric bound, an `addedTypes` reference, and the
 * overflow word) rather than the exact expression shape.
 */
function isSummaryHelperBodyWellFormed(fn: t.FunctionDeclaration): boolean {
	const referencesAddedTypes = nodeContains(
		fn.body,
		(node) =>
			t.isMemberExpression(node) && isMemberPropertyName(node, "addedTypes"),
	);
	const hasNumericSlice = nodeContains(
		fn.body,
		(node) =>
			t.isCallExpression(node) &&
			t.isMemberExpression(node.callee) &&
			isMemberPropertyName(node.callee, "slice") &&
			node.arguments.some((arg) => t.isNumericLiteral(arg)),
	);
	const hasOverflowSuffix = nodeContains(
		fn.body,
		(node) => t.isStringLiteral(node) && node.value.includes("more"),
	);
	return referencesAddedTypes && hasNumericSlice && hasOverflowSuffix;
}

function nodeContains(
	node: t.Node | null | undefined,
	predicate: (node: t.Node) => boolean,
): boolean {
	if (!node) return false;
	if (predicate(node)) return true;
	const keys = t.VISITOR_KEYS[node.type] ?? [];
	for (const key of keys) {
		const value = (node as unknown as Record<string, unknown>)[key];
		if (Array.isArray(value)) {
			for (const child of value) {
				if (child && typeof child === "object" && "type" in child) {
					if (nodeContains(child as t.Node, predicate)) return true;
				}
			}
		} else if (value && typeof value === "object" && "type" in value) {
			if (nodeContains(value as t.Node, predicate)) return true;
		}
	}
	return false;
}

function statementsContain(
	statements: t.Statement[],
	predicate: (node: t.Node) => boolean,
): boolean {
	return statements.some((statement) => nodeContains(statement, predicate));
}

function findAssignedCreateElementCall(
	node: t.Node | null | undefined,
	targetName: string,
	cacheGuard?: t.IfStatement,
): RenderRoot | null {
	if (!node) return null;
	if (
		t.isAssignmentExpression(node) &&
		node.operator === "=" &&
		t.isIdentifier(node.left, { name: targetName }) &&
		isElementCall(node.right)
	) {
		return { rootCall: node.right, cacheGuard };
	}
	if (
		t.isVariableDeclarator(node) &&
		t.isIdentifier(node.id, { name: targetName }) &&
		isElementCall(node.init)
	) {
		return { rootCall: node.init, cacheGuard };
	}
	if (t.isIfStatement(node)) {
		return (
			findAssignedCreateElementCall(node.consequent, targetName, node) ??
			findAssignedCreateElementCall(node.alternate, targetName, node)
		);
	}

	const keys = t.VISITOR_KEYS[node.type] ?? [];
	for (const key of keys) {
		const value = (node as unknown as Record<string, unknown>)[key];
		if (Array.isArray(value)) {
			for (const child of value) {
				if (!child || typeof child !== "object" || !("type" in child)) {
					continue;
				}
				const found = findAssignedCreateElementCall(
					child as t.Node,
					targetName,
					cacheGuard,
				);
				if (found) return found;
			}
		} else if (value && typeof value === "object" && "type" in value) {
			const found = findAssignedCreateElementCall(
				value as t.Node,
				targetName,
				cacheGuard,
			);
			if (found) return found;
		}
	}
	return null;
}

function getReturnedRenderRoot(statements: t.Statement[]): RenderRoot | null {
	const returnIndex = statements.findIndex((statement) =>
		t.isReturnStatement(statement),
	);
	if (returnIndex === -1) return null;
	const returnStmt = statements[returnIndex];
	if (!t.isReturnStatement(returnStmt) || !returnStmt.argument) return null;
	if (isElementCall(returnStmt.argument)) {
		return { rootCall: returnStmt.argument };
	}
	if (!t.isIdentifier(returnStmt.argument)) return null;

	const targetName = returnStmt.argument.name;
	for (let i = returnIndex - 1; i >= 0; i--) {
		const found = findAssignedCreateElementCall(statements[i], targetName);
		if (found) return found;
	}
	return null;
}

function makeCacheGuardAlwaysRecompute(renderRoot: RenderRoot): void {
	if (renderRoot.cacheGuard) {
		renderRoot.cacheGuard.test = t.booleanLiteral(true);
	}
}

function isCacheGuardAlwaysRecomputed(renderRoot: RenderRoot): boolean {
	return (
		!renderRoot.cacheGuard ||
		t.isBooleanLiteral(renderRoot.cacheGuard.test, { value: true })
	);
}

function getAgentListingRenderStatements(
	path: NodePath<t.SwitchCase>,
): t.Statement[] {
	if (path.node.consequent.length !== 1) return path.node.consequent;
	const [onlyStmt] = path.node.consequent;
	return t.isBlockStatement(onlyStmt) ? onlyStmt.body : path.node.consequent;
}

function getMemberObjectNameForProperty(
	node: t.Node | null | undefined,
	propertyName: string,
): string | null {
	if (!node) return null;
	if (
		t.isMemberExpression(node) &&
		t.isIdentifier(node.object) &&
		isMemberPropertyName(node, propertyName)
	) {
		return node.object.name;
	}
	if (t.isLogicalExpression(node) || t.isBinaryExpression(node)) {
		return (
			getMemberObjectNameForProperty(node.left, propertyName) ??
			getMemberObjectNameForProperty(node.right, propertyName)
		);
	}
	if (t.isUnaryExpression(node)) {
		return getMemberObjectNameForProperty(node.argument, propertyName);
	}
	if (t.isParenthesizedExpression(node)) {
		return getMemberObjectNameForProperty(node.expression, propertyName);
	}
	return null;
}

function getAgentListingAttachmentName(
	path: NodePath<t.SwitchCase>,
): string | null {
	const [firstStmt] = getAgentListingRenderStatements(path);
	if (!firstStmt || !t.isIfStatement(firstStmt)) return null;
	return getMemberObjectNameForProperty(firstStmt.test, "isInitial");
}

function isAddedTypesLengthAccess(
	node: t.Node | null | undefined,
	attachmentName: string,
): node is t.MemberExpression {
	if (!node || !t.isMemberExpression(node)) return false;
	if (!isMemberPropertyName(node, "length")) return false;
	const addedTypesAccess = node.object;
	return (
		t.isMemberExpression(addedTypesAccess) &&
		t.isIdentifier(addedTypesAccess.object, { name: attachmentName }) &&
		isMemberPropertyName(addedTypesAccess, "addedTypes")
	);
}

function getAgentListingCountName(
	statements: t.Statement[],
	attachmentName: string,
): string | null {
	for (const statement of statements) {
		if (!t.isVariableDeclaration(statement)) continue;
		for (const declarator of statement.declarations) {
			if (
				t.isIdentifier(declarator.id) &&
				isAddedTypesLengthAccess(declarator.init, attachmentName)
			) {
				return declarator.id.name;
			}
		}
	}
	return null;
}

function isAgentCountAccess(
	node: t.Node | null | undefined,
	attachmentName: string,
	countName: string,
): boolean {
	return (
		!!node &&
		(t.isIdentifier(node, { name: countName }) ||
			isAddedTypesLengthAccess(node, attachmentName))
	);
}

function getAgentListingRenderRootCall(path: NodePath<t.SwitchCase>): {
	attachmentName: string;
	countName: string;
	renderRoot: RenderRoot;
} | null {
	const attachmentName = getAgentListingAttachmentName(path);
	if (!attachmentName) return null;

	const statements = getAgentListingRenderStatements(path);
	const countName = getAgentListingCountName(statements, attachmentName);
	if (!countName) return null;

	const renderRoot = getReturnedRenderRoot(statements);
	if (!renderRoot) return null;

	return { attachmentName, countName, renderRoot };
}

function callContainsAgentCount(
	call: t.CallExpression,
	attachmentName: string,
	countName: string,
): boolean {
	return call.arguments.some((arg) =>
		isAgentCountAccess(arg, attachmentName, countName),
	);
}

function isAgentListingRenderLine(
	rootCall: t.CallExpression,
	attachmentName: string,
	countName: string,
	statements: t.Statement[] = [],
): boolean {
	const hasAgentCountText = rootCall.arguments.some(
		(arg) =>
			isAgentCountAccess(arg, attachmentName, countName) ||
			(t.isCallExpression(arg) &&
				t.isMemberExpression(arg.callee) &&
				isMemberPropertyName(arg.callee, "createElement") &&
				callContainsAgentCount(arg, attachmentName, countName)),
	);
	const hasPluralType = rootCall.arguments.some(
		(arg) =>
			t.isCallExpression(arg) &&
			arg.arguments.length >= 2 &&
			isAgentCountAccess(arg.arguments[0], attachmentName, countName) &&
			t.isStringLiteral(arg.arguments[1], { value: "type" }),
	);
	const hasAgentLiteral = rootCall.arguments.some(
		(arg) => t.isStringLiteral(arg) && arg.value.includes("agent"),
	);
	const hasAvailableLiteral = rootCall.arguments.some(
		(arg) => t.isStringLiteral(arg) && arg.value.includes("available"),
	);

	if (
		hasAgentCountText &&
		hasPluralType &&
		hasAgentLiteral &&
		hasAvailableLiteral
	) {
		return true;
	}

	return (
		statementsContain(statements, (node) =>
			isAgentCountAccess(node, attachmentName, countName),
		) &&
		statementsContain(
			statements,
			(node) =>
				t.isCallExpression(node) &&
				node.arguments.length >= 2 &&
				isAgentCountAccess(node.arguments[0], attachmentName, countName) &&
				t.isStringLiteral(node.arguments[1], { value: "type" }),
		) &&
		statementsContain(
			statements,
			(node) => t.isStringLiteral(node) && node.value.includes("agent"),
		) &&
		statementsContain(
			statements,
			(node) => t.isStringLiteral(node) && node.value.includes("available"),
		)
	);
}

function isAgentListingRenderCase(path: NodePath<t.SwitchCase>): boolean {
	if (!t.isStringLiteral(path.node.test, { value: "agent_listing_delta" })) {
		return false;
	}
	const renderRoot = getAgentListingRenderRootCall(path);
	if (!renderRoot) return false;
	return isAgentListingRenderLine(
		renderRoot.renderRoot.rootCall,
		renderRoot.attachmentName,
		renderRoot.countName,
		getAgentListingRenderStatements(path),
	);
}

function hasAgentListingSummaryCall(
	rootCall: t.CallExpression,
	attachmentName?: string,
): boolean {
	for (const arg of getElementChildren(rootCall)) {
		if (!t.isCallExpression(arg)) continue;
		if (
			!t.isIdentifier(arg.callee, {
				name: AGENT_LISTING_SUMMARY_HELPER,
			})
		) {
			continue;
		}
		// Same hardening as skill-listing-ui: confirm the helper is called
		// with the case's attachment identifier. A regression that passed no
		// argument (or the wrong identifier) would render incorrectly at
		// runtime but still match the loose presence-only check.
		if (attachmentName === undefined) return true;
		if (arg.arguments.length !== 1) continue;
		if (t.isIdentifier(arg.arguments[0], { name: attachmentName })) {
			return true;
		}
	}
	return false;
}

function patchAgentListingRenderer(path: NodePath<t.SwitchCase>): boolean {
	const renderRoot = getAgentListingRenderRootCall(path);
	if (!renderRoot) return false;

	const { attachmentName, countName } = renderRoot;
	const { rootCall } = renderRoot.renderRoot;
	if (
		!isAgentListingRenderLine(
			rootCall,
			attachmentName,
			countName,
			getAgentListingRenderStatements(path),
		)
	) {
		return false;
	}
	if (hasAgentListingSummaryCall(rootCall, attachmentName)) {
		makeCacheGuardAlwaysRecompute(renderRoot.renderRoot);
		return true;
	}

	appendElementChild(
		rootCall,
		t.callExpression(t.identifier(AGENT_LISTING_SUMMARY_HELPER), [
			t.identifier(attachmentName),
		]),
	);
	makeCacheGuardAlwaysRecompute(renderRoot.renderRoot);
	return true;
}

function createAgentListingUiPasses(): PatchAstPass[] {
	const renderCandidates: NodePath<t.SwitchCase>[] = [];
	let helperExists = false;
	let patchedRenderer = false;

	return [
		{
			pass: "discover",
			visitor: {
				FunctionDeclaration(path) {
					if (
						t.isIdentifier(path.node.id, {
							name: AGENT_LISTING_SUMMARY_HELPER,
						})
					) {
						helperExists = true;
					}
				},
				SwitchCase(path) {
					if (isAgentListingRenderCase(path)) {
						renderCandidates.push(path);
					}
				},
			},
		},
		{
			pass: "mutate",
			visitor: {
				Program: {
					exit(path) {
						if (renderCandidates.length !== 1) return;
						if (!helperExists) {
							path.node.body.unshift(buildAgentListingSummaryHelper());
							helperExists = true;
						}
						patchedRenderer = patchAgentListingRenderer(renderCandidates[0]);
					},
				},
			},
		},
		{
			pass: "finalize",
			visitor: {
				Program: {
					exit() {
						if (renderCandidates.length > 1) {
							console.warn(
								`Agent listing UI: ambiguous agent_listing_delta render cases (${renderCandidates.length} found)`,
							);
						} else if (renderCandidates.length === 0) {
							console.warn(
								"Agent listing UI: could not find agent_listing_delta render case",
							);
						} else if (!patchedRenderer) {
							console.warn(
								"Agent listing UI: failed to patch agent_listing_delta render case",
							);
						}
					},
				},
			},
		},
	];
}

export const agentListingUi: Patch = {
	tag: "agent-listing-ui",

	astPasses: () => createAgentListingUiPasses(),

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) {
			return "Unable to parse AST during agent-listing-ui verification";
		}

		let helperFound = false;
		let helperWellFormed = false;
		// Count render cases and patched render cases independently so a
		// multi-case world fails explicitly (mirroring the mutator's
		// renderCandidates.length === 1 gate) instead of silently reflecting
		// whichever case the traversal visited last.
		let renderCaseCount = 0;
		let patchedCaseCount = 0;

		traverse(verifyAst, {
			FunctionDeclaration(path) {
				if (
					t.isIdentifier(path.node.id, {
						name: AGENT_LISTING_SUMMARY_HELPER,
					})
				) {
					helperFound = true;
					if (isSummaryHelperBodyWellFormed(path.node)) {
						helperWellFormed = true;
					}
				}
			},
			SwitchCase(path) {
				if (!isAgentListingRenderCase(path)) return;
				const renderRoot = getAgentListingRenderRootCall(path);
				if (!renderRoot) return;
				renderCaseCount++;
				if (
					hasAgentListingSummaryCall(
						renderRoot.renderRoot.rootCall,
						renderRoot.attachmentName,
					) &&
					isCacheGuardAlwaysRecomputed(renderRoot.renderRoot)
				) {
					patchedCaseCount++;
				}
			},
		});

		if (!helperFound) {
			return "Agent listing summary helper not found";
		}
		if (!helperWellFormed) {
			return "Agent listing summary helper body is malformed";
		}
		if (renderCaseCount === 0) {
			return "agent_listing_delta render case not found";
		}
		if (renderCaseCount > 1) {
			return `agent_listing_delta render case is ambiguous (${renderCaseCount} cases found)`;
		}
		if (patchedCaseCount !== 1) {
			return "agent_listing_delta renderer is missing the agent-type summary";
		}
		return true;
	},
};
