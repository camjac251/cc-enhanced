import template from "@babel/template";
import traverse, { type NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch, PatchAstPass } from "../types.js";
import {
	getObjectKeyName,
	getObjectPropertyByName,
	getVerifyAst,
	isMemberPropertyName,
} from "./ast-helpers.js";

const SKILL_LISTING_SUMMARY_HELPER = "_claudePatchFormatSkillListingSummary";

function buildSkillListingSummaryHelper(): t.Statement {
	return template.default.statement(
		`
function ${SKILL_LISTING_SUMMARY_HELPER}(attachment) {
  let skillNames = Array.isArray(attachment.skillNames)
    ? attachment.skillNames.filter((name) => typeof name === "string" && name.length > 0)
    : [];
  if (skillNames.length === 0) return "";
  let visibleSkillNames = skillNames.slice(0, 5).join(", ");
  let hiddenCount = skillNames.length - Math.min(skillNames.length, 5);
  return hiddenCount > 0
    ? ": " + visibleSkillNames + " +" + hiddenCount + " more"
    : ": " + visibleSkillNames;
}
`,
		{ placeholderPattern: false },
	)();
}

function isSkillListingAttachment(path: NodePath<t.ObjectExpression>): boolean {
	const typeProp = getObjectPropertyByName(path.node, "type");
	if (
		!typeProp ||
		!t.isStringLiteral(typeProp.value, { value: "skill_listing" })
	) {
		return false;
	}
	return (
		getObjectPropertyByName(path.node, "content") !== null &&
		getObjectPropertyByName(path.node, "skillCount") !== null &&
		getObjectPropertyByName(path.node, "isInitial") !== null
	);
}

function getSkillListingRenderStatements(
	path: NodePath<t.SwitchCase>,
): t.Statement[] {
	if (path.node.consequent.length !== 1) return path.node.consequent;
	const [onlyStmt] = path.node.consequent;
	return t.isBlockStatement(onlyStmt) ? onlyStmt.body : path.node.consequent;
}

function isSkillListingRenderCase(path: NodePath<t.SwitchCase>): boolean {
	if (!t.isStringLiteral(path.node.test, { value: "skill_listing" }))
		return false;
	const statements = getSkillListingRenderStatements(path);
	if (statements.length < 2) return false;
	const [firstStmt] = statements;
	if (!t.isIfStatement(firstStmt)) return false;
	if (!t.isMemberExpression(firstStmt.test)) return false;
	return isMemberPropertyName(firstStmt.test, "isInitial");
}

function getSkillListingAttachmentName(
	path: NodePath<t.SwitchCase>,
): string | null {
	const [firstStmt] = getSkillListingRenderStatements(path);
	if (
		!firstStmt ||
		!t.isIfStatement(firstStmt) ||
		!t.isMemberExpression(firstStmt.test) ||
		!t.isIdentifier(firstStmt.test.object)
	) {
		return null;
	}
	if (!isMemberPropertyName(firstStmt.test, "isInitial")) return null;
	return firstStmt.test.object.name;
}

function isSkillCountAccess(
	node: t.Node | null | undefined,
	attachmentName: string,
): node is t.MemberExpression {
	return (
		!!node &&
		t.isMemberExpression(node) &&
		t.isIdentifier(node.object, { name: attachmentName }) &&
		isMemberPropertyName(node, "skillCount")
	);
}

function getSkillListingRenderRootCall(
	path: NodePath<t.SwitchCase>,
): { attachmentName: string; rootCall: t.CallExpression } | null {
	const attachmentName = getSkillListingAttachmentName(path);
	if (!attachmentName) return null;

	const returnStmt = getSkillListingRenderStatements(path).find(
		(stmt): stmt is t.ReturnStatement => t.isReturnStatement(stmt),
	);
	if (!returnStmt || !returnStmt.argument) return null;
	if (!t.isCallExpression(returnStmt.argument)) return null;

	const rootCall = returnStmt.argument;
	if (!t.isMemberExpression(rootCall.callee)) return null;
	if (!isMemberPropertyName(rootCall.callee, "createElement")) return null;

	return { attachmentName, rootCall };
}

function isSkillListingRenderLine(
	rootCall: t.CallExpression,
	attachmentName: string,
): boolean {
	const hasSkillCountText = rootCall.arguments.some(
		(arg) =>
			isSkillCountAccess(arg, attachmentName) ||
			(t.isCallExpression(arg) &&
				t.isMemberExpression(arg.callee) &&
				isMemberPropertyName(arg.callee, "createElement") &&
				arg.arguments.some((childArg) =>
					isSkillCountAccess(childArg, attachmentName),
				)),
	);
	const hasPluralSkill = rootCall.arguments.some(
		(arg) =>
			t.isCallExpression(arg) &&
			arg.arguments.length >= 2 &&
			isSkillCountAccess(arg.arguments[0], attachmentName) &&
			t.isStringLiteral(arg.arguments[1], { value: "skill" }),
	);
	const hasAvailableLiteral = rootCall.arguments.some(
		(arg) => t.isStringLiteral(arg) && arg.value.includes("available"),
	);

	return hasSkillCountText && hasPluralSkill && hasAvailableLiteral;
}

function hasSkillListingSummaryCall(rootCall: t.CallExpression): boolean {
	return rootCall.arguments.some(
		(arg) =>
			t.isCallExpression(arg) &&
			t.isIdentifier(arg.callee, {
				name: SKILL_LISTING_SUMMARY_HELPER,
			}),
	);
}

function patchSkillListingAttachment(
	path: NodePath<t.ObjectExpression>,
): boolean {
	if (getObjectPropertyByName(path.node, "skillNames")) return true;

	const contentProp = getObjectPropertyByName(path.node, "content");
	if (!contentProp || !t.isCallExpression(contentProp.value)) return false;

	const [skillItems] = contentProp.value.arguments;
	if (!skillItems || !t.isExpression(skillItems)) return false;

	const skillNamesProp = t.objectProperty(
		t.identifier("skillNames"),
		t.callExpression(
			t.memberExpression(t.cloneNode(skillItems, true), t.identifier("map")),
			[
				t.arrowFunctionExpression(
					[t.identifier("_claudePatchSkillItem")],
					t.memberExpression(
						t.identifier("_claudePatchSkillItem"),
						t.identifier("name"),
					),
				),
			],
		),
	);

	const insertIndex = path.node.properties.findIndex(
		(prop) =>
			t.isObjectProperty(prop) && getObjectKeyName(prop.key) === "skillCount",
	);
	if (insertIndex === -1) return false;

	path.node.properties.splice(insertIndex, 0, skillNamesProp);
	return true;
}

function patchSkillListingRenderer(path: NodePath<t.SwitchCase>): boolean {
	const renderRoot = getSkillListingRenderRootCall(path);
	if (!renderRoot) return false;

	const { attachmentName, rootCall } = renderRoot;
	if (!isSkillListingRenderLine(rootCall, attachmentName)) return false;
	if (hasSkillListingSummaryCall(rootCall)) {
		return true;
	}

	rootCall.arguments.push(
		t.callExpression(t.identifier(SKILL_LISTING_SUMMARY_HELPER), [
			t.identifier(attachmentName),
		]),
	);
	return true;
}

function createSkillListingUiPasses(): PatchAstPass[] {
	const attachmentCandidates: NodePath<t.ObjectExpression>[] = [];
	const renderCandidates: NodePath<t.SwitchCase>[] = [];
	let helperExists = false;
	let patchedAttachment = false;
	let patchedRenderer = false;

	return [
		{
			pass: "discover",
			visitor: {
				FunctionDeclaration(path) {
					if (
						t.isIdentifier(path.node.id, {
							name: SKILL_LISTING_SUMMARY_HELPER,
						})
					) {
						helperExists = true;
					}
				},
				ObjectExpression(path) {
					if (isSkillListingAttachment(path)) {
						attachmentCandidates.push(path);
					}
				},
				SwitchCase(path) {
					if (
						isSkillListingRenderCase(path) &&
						!!getSkillListingRenderRootCall(path) &&
						isSkillListingRenderLine(
							getSkillListingRenderRootCall(path)!.rootCall,
							getSkillListingRenderRootCall(path)!.attachmentName,
						)
					) {
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
						if (attachmentCandidates.length === 1) {
							patchedAttachment = patchSkillListingAttachment(
								attachmentCandidates[0],
							);
						}

						if (renderCandidates.length === 1) {
							if (!helperExists) {
								path.node.body.unshift(buildSkillListingSummaryHelper());
								helperExists = true;
							}
							patchedRenderer = patchSkillListingRenderer(renderCandidates[0]);
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
						if (attachmentCandidates.length > 1) {
							console.warn(
								`Skill listing UI: ambiguous skill_listing attachment producers (${attachmentCandidates.length} found)`,
							);
						} else if (attachmentCandidates.length === 0) {
							console.warn(
								"Skill listing UI: could not find skill_listing attachment producer",
							);
						} else if (!patchedAttachment) {
							console.warn(
								"Skill listing UI: failed to patch skill_listing attachment producer",
							);
						}

						if (renderCandidates.length > 1) {
							console.warn(
								`Skill listing UI: ambiguous skill_listing render cases (${renderCandidates.length} found)`,
							);
						} else if (renderCandidates.length === 0) {
							console.warn(
								"Skill listing UI: could not find skill_listing render case",
							);
						} else if (!patchedRenderer) {
							console.warn(
								"Skill listing UI: failed to patch skill_listing render case",
							);
						}
					},
				},
			},
		},
	];
}

export const skillListingUi: Patch = {
	tag: "skill-listing-ui",

	astPasses: () => createSkillListingUiPasses(),

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) {
			return "Unable to parse AST during skill-listing-ui verification";
		}

		let helperFound = false;
		let attachmentPatched = false;
		let rendererPatched = false;

		traverse.default(verifyAst, {
			FunctionDeclaration(path) {
				if (
					t.isIdentifier(path.node.id, {
						name: SKILL_LISTING_SUMMARY_HELPER,
					})
				) {
					helperFound = true;
				}
			},
			ObjectExpression(path) {
				if (!isSkillListingAttachment(path)) return;
				const skillNamesProp = getObjectPropertyByName(path.node, "skillNames");
				if (!skillNamesProp) return;
				if (!t.isCallExpression(skillNamesProp.value)) return;
				if (!t.isMemberExpression(skillNamesProp.value.callee)) return;
				if (!isMemberPropertyName(skillNamesProp.value.callee, "map")) return;
				attachmentPatched = true;
			},
			SwitchCase(path) {
				if (!isSkillListingRenderCase(path)) return;
				const renderRoot = getSkillListingRenderRootCall(path);
				if (!renderRoot) return;
				if (
					!isSkillListingRenderLine(
						renderRoot.rootCall,
						renderRoot.attachmentName,
					)
				) {
					return;
				}
				rendererPatched = hasSkillListingSummaryCall(renderRoot.rootCall);
			},
		});

		if (!helperFound) {
			return "Skill listing summary helper not found";
		}
		if (!attachmentPatched) {
			return "skill_listing attachment is missing skillNames metadata";
		}
		if (!rendererPatched) {
			return "skill_listing renderer is missing the activated-skill summary";
		}
		return true;
	},
};
