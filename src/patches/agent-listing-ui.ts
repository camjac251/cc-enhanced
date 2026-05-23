import * as t from "@babel/types";
import { type NodePath, template, traverse } from "../babel.js";
import type { Patch, PatchAstPass } from "../types.js";
import { getVerifyAst, isMemberPropertyName } from "./ast-helpers.js";

const AGENT_LISTING_SUMMARY_HELPER = "_claudePatchFormatAgentListingSummary";

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
	rootCall: t.CallExpression;
} | null {
	const attachmentName = getAgentListingAttachmentName(path);
	if (!attachmentName) return null;

	const statements = getAgentListingRenderStatements(path);
	const countName = getAgentListingCountName(statements, attachmentName);
	if (!countName) return null;

	const returnStmt = statements.find((stmt): stmt is t.ReturnStatement =>
		t.isReturnStatement(stmt),
	);
	if (!returnStmt?.argument) return null;
	if (!t.isCallExpression(returnStmt.argument)) return null;

	const rootCall = returnStmt.argument;
	if (!t.isMemberExpression(rootCall.callee)) return null;
	if (!isMemberPropertyName(rootCall.callee, "createElement")) return null;

	return { attachmentName, countName, rootCall };
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

	return (
		hasAgentCountText && hasPluralType && hasAgentLiteral && hasAvailableLiteral
	);
}

function isAgentListingRenderCase(path: NodePath<t.SwitchCase>): boolean {
	if (!t.isStringLiteral(path.node.test, { value: "agent_listing_delta" })) {
		return false;
	}
	const renderRoot = getAgentListingRenderRootCall(path);
	if (!renderRoot) return false;
	return isAgentListingRenderLine(
		renderRoot.rootCall,
		renderRoot.attachmentName,
		renderRoot.countName,
	);
}

function hasAgentListingSummaryCall(
	rootCall: t.CallExpression,
	attachmentName?: string,
): boolean {
	for (const arg of rootCall.arguments) {
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

	const { attachmentName, countName, rootCall } = renderRoot;
	if (!isAgentListingRenderLine(rootCall, attachmentName, countName)) {
		return false;
	}
	if (hasAgentListingSummaryCall(rootCall, attachmentName)) {
		return true;
	}

	rootCall.arguments.push(
		t.callExpression(t.identifier(AGENT_LISTING_SUMMARY_HELPER), [
			t.identifier(attachmentName),
		]),
	);
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
		let rendererPatched = false;

		traverse(verifyAst, {
			FunctionDeclaration(path) {
				if (
					t.isIdentifier(path.node.id, {
						name: AGENT_LISTING_SUMMARY_HELPER,
					})
				) {
					helperFound = true;
				}
			},
			SwitchCase(path) {
				if (!isAgentListingRenderCase(path)) return;
				const renderRoot = getAgentListingRenderRootCall(path);
				if (!renderRoot) return;
				rendererPatched = hasAgentListingSummaryCall(
					renderRoot.rootCall,
					renderRoot.attachmentName,
				);
			},
		});

		if (!helperFound) {
			return "Agent listing summary helper not found";
		}
		if (!rendererPatched) {
			return "agent_listing_delta renderer is missing the agent-type summary";
		}
		return true;
	},
};
