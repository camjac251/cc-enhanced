import * as t from "@babel/types";
import { type NodePath, template, traverse } from "../babel.js";
import type { Patch, PatchAstPass } from "../types.js";
import {
	appendElementChild,
	getElementChildren,
	getObjectKeyName,
	getObjectPropertyByName,
	getVerifyAst,
	isElementCall,
	isMemberPropertyName,
} from "./ast-helpers.js";

const SKILL_LISTING_SUMMARY_HELPER = "_claudePatchFormatSkillListingSummary";

type RenderRoot = {
	rootCall: t.CallExpression;
	cacheGuard?: t.IfStatement;
};

function buildSkillListingSummaryHelper(): t.Statement {
	return template.statement(
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

const VISITOR_KEYS = (
	t as unknown as { VISITOR_KEYS: Record<string, string[]> }
).VISITOR_KEYS;

function nodeContains(
	node: t.Node | null | undefined,
	predicate: (node: t.Node) => boolean,
): boolean {
	if (!node) return false;
	if (predicate(node)) return true;
	const keys = VISITOR_KEYS[node.type] ?? [];
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

	const keys = VISITOR_KEYS[node.type] ?? [];
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

function isSkillNamesLengthAccess(
	node: t.Node | null | undefined,
	attachmentName: string,
): node is t.MemberExpression {
	if (!node || !t.isMemberExpression(node)) return false;
	if (!isMemberPropertyName(node, "length")) return false;
	const skillNamesAccess = node.object;
	return (
		t.isMemberExpression(skillNamesAccess) &&
		t.isIdentifier(skillNamesAccess.object, { name: attachmentName }) &&
		isMemberPropertyName(skillNamesAccess, "skillNames")
	);
}

function getSkillListingRenderRootCall(
	path: NodePath<t.SwitchCase>,
): { attachmentName: string; renderRoot: RenderRoot } | null {
	const attachmentName = getSkillListingAttachmentName(path);
	if (!attachmentName) return null;

	const renderRoot = getReturnedRenderRoot(
		getSkillListingRenderStatements(path),
	);
	if (!renderRoot) return null;

	return { attachmentName, renderRoot };
}

function isSkillListingRenderLine(
	rootCall: t.CallExpression,
	attachmentName: string,
	statements: t.Statement[] = [],
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

	if (hasSkillCountText && hasPluralSkill && hasAvailableLiteral) {
		return true;
	}

	return (
		statementsContain(statements, (node) =>
			isSkillCountAccess(node, attachmentName),
		) &&
		statementsContain(
			statements,
			(node) =>
				t.isCallExpression(node) &&
				node.arguments.length >= 2 &&
				isSkillCountAccess(node.arguments[0], attachmentName) &&
				t.isStringLiteral(node.arguments[1], { value: "skill" }),
		) &&
		statementsContain(
			statements,
			(node) => t.isStringLiteral(node) && node.value.includes("available"),
		)
	);
}

function getDynamicSkillRenderStatements(
	path: NodePath<t.SwitchCase>,
): t.Statement[] {
	if (path.node.consequent.length !== 1) return path.node.consequent;
	const [onlyStmt] = path.node.consequent;
	return t.isBlockStatement(onlyStmt) ? onlyStmt.body : path.node.consequent;
}

function getDynamicSkillCountBinding(path: NodePath<t.SwitchCase>): {
	attachmentName: string;
	countName: string;
} | null {
	for (const statement of getDynamicSkillRenderStatements(path)) {
		if (!t.isVariableDeclaration(statement)) continue;
		for (const declarator of statement.declarations) {
			if (!t.isIdentifier(declarator.id)) continue;
			const init = declarator.init;
			if (!init || !t.isMemberExpression(init)) continue;
			if (!isMemberPropertyName(init, "length")) continue;
			const skillNamesAccess = init.object;
			if (
				t.isMemberExpression(skillNamesAccess) &&
				t.isIdentifier(skillNamesAccess.object) &&
				isMemberPropertyName(skillNamesAccess, "skillNames")
			) {
				return {
					attachmentName: skillNamesAccess.object.name,
					countName: declarator.id.name,
				};
			}
		}
	}
	return null;
}

function isDynamicSkillCountAccess(
	node: t.Node | null | undefined,
	attachmentName: string,
	countName: string,
): boolean {
	return (
		!!node &&
		(t.isIdentifier(node, { name: countName }) ||
			isSkillNamesLengthAccess(node, attachmentName))
	);
}

function callContainsDynamicSkillCount(
	call: t.CallExpression,
	attachmentName: string,
	countName: string,
): boolean {
	return call.arguments.some((arg) =>
		isDynamicSkillCountAccess(arg, attachmentName, countName),
	);
}

function callContainsDynamicSkillPlural(
	call: t.CallExpression,
	attachmentName: string,
	countName: string,
): boolean {
	return call.arguments.some(
		(arg) =>
			t.isCallExpression(arg) &&
			arg.arguments.length >= 2 &&
			isDynamicSkillCountAccess(arg.arguments[0], attachmentName, countName) &&
			t.isStringLiteral(arg.arguments[1], { value: "skill" }),
	);
}

function getDynamicSkillRenderRootCall(path: NodePath<t.SwitchCase>): {
	attachmentName: string;
	countName: string;
	renderRoot: RenderRoot;
} | null {
	const binding = getDynamicSkillCountBinding(path);
	if (!binding) return null;

	const renderRoot = getReturnedRenderRoot(
		getDynamicSkillRenderStatements(path),
	);
	if (!renderRoot) return null;

	return { ...binding, renderRoot };
}

function isDynamicSkillRenderLine(
	rootCall: t.CallExpression,
	attachmentName: string,
	countName: string,
	statements: t.Statement[] = [],
): boolean {
	const hasLoadedLiteral = rootCall.arguments.some(
		(arg) => t.isStringLiteral(arg) && arg.value.includes("Loaded"),
	);
	const hasFromLiteral = rootCall.arguments.some(
		(arg) => t.isStringLiteral(arg) && arg.value.includes("from"),
	);
	const hasSkillCountText = rootCall.arguments.some(
		(arg) =>
			isDynamicSkillCountAccess(arg, attachmentName, countName) ||
			(t.isCallExpression(arg) &&
				t.isMemberExpression(arg.callee) &&
				isMemberPropertyName(arg.callee, "createElement") &&
				callContainsDynamicSkillCount(arg, attachmentName, countName)),
	);
	const hasPluralSkill = rootCall.arguments.some(
		(arg) =>
			(t.isCallExpression(arg) &&
				arg.arguments.length >= 2 &&
				isDynamicSkillCountAccess(
					arg.arguments[0],
					attachmentName,
					countName,
				) &&
				t.isStringLiteral(arg.arguments[1], { value: "skill" })) ||
			(t.isCallExpression(arg) &&
				t.isMemberExpression(arg.callee) &&
				isMemberPropertyName(arg.callee, "createElement") &&
				callContainsDynamicSkillPlural(arg, attachmentName, countName)),
	);
	const hasDisplayPath = rootCall.arguments.some(
		(arg) =>
			t.isCallExpression(arg) &&
			t.isMemberExpression(arg.callee) &&
			isMemberPropertyName(arg.callee, "createElement") &&
			arg.arguments.some(
				(childArg) =>
					t.isMemberExpression(childArg) &&
					t.isIdentifier(childArg.object, { name: attachmentName }) &&
					isMemberPropertyName(childArg, "displayPath"),
			),
	);

	if (
		hasLoadedLiteral &&
		hasFromLiteral &&
		hasSkillCountText &&
		hasPluralSkill &&
		hasDisplayPath
	) {
		return true;
	}

	return (
		statementsContain(
			statements,
			(node) => t.isStringLiteral(node) && node.value.includes("Loaded"),
		) &&
		statementsContain(
			statements,
			(node) => t.isStringLiteral(node) && node.value.includes("from"),
		) &&
		statementsContain(statements, (node) =>
			isDynamicSkillCountAccess(node, attachmentName, countName),
		) &&
		statementsContain(
			statements,
			(node) =>
				t.isCallExpression(node) &&
				node.arguments.length >= 2 &&
				isDynamicSkillCountAccess(
					node.arguments[0],
					attachmentName,
					countName,
				) &&
				t.isStringLiteral(node.arguments[1], { value: "skill" }),
		) &&
		statementsContain(
			statements,
			(node) =>
				t.isMemberExpression(node) &&
				t.isIdentifier(node.object, { name: attachmentName }) &&
				isMemberPropertyName(node, "displayPath"),
		)
	);
}

function isDynamicSkillRenderCase(path: NodePath<t.SwitchCase>): boolean {
	if (!t.isStringLiteral(path.node.test, { value: "dynamic_skill" })) {
		return false;
	}
	const renderRoot = getDynamicSkillRenderRootCall(path);
	if (!renderRoot) return false;
	return isDynamicSkillRenderLine(
		renderRoot.renderRoot.rootCall,
		renderRoot.attachmentName,
		renderRoot.countName,
		getDynamicSkillRenderStatements(path),
	);
}

function hasSkillListingSummaryCall(
	rootCall: t.CallExpression,
	attachmentName?: string,
): boolean {
	for (const arg of getElementChildren(rootCall)) {
		if (!t.isCallExpression(arg)) continue;
		if (
			!t.isIdentifier(arg.callee, {
				name: SKILL_LISTING_SUMMARY_HELPER,
			})
		) {
			continue;
		}
		// If we know the attachment identifier the case binds, require the
		// helper call to pass it as its single argument. The previous
		// version accepted ANY helper call regardless of arguments, so a
		// regression that called the helper with no arguments (rendering
		// nothing) would still pass verify.
		if (attachmentName === undefined) return true;
		if (arg.arguments.length !== 1) continue;
		if (t.isIdentifier(arg.arguments[0], { name: attachmentName })) {
			return true;
		}
	}
	return false;
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

	const { attachmentName } = renderRoot;
	const { rootCall } = renderRoot.renderRoot;
	if (
		!isSkillListingRenderLine(
			rootCall,
			attachmentName,
			getSkillListingRenderStatements(path),
		)
	) {
		return false;
	}
	if (hasSkillListingSummaryCall(rootCall, attachmentName)) {
		makeCacheGuardAlwaysRecompute(renderRoot.renderRoot);
		return true;
	}

	appendElementChild(
		rootCall,
		t.callExpression(t.identifier(SKILL_LISTING_SUMMARY_HELPER), [
			t.identifier(attachmentName),
		]),
	);
	makeCacheGuardAlwaysRecompute(renderRoot.renderRoot);
	return true;
}

function patchDynamicSkillRenderer(path: NodePath<t.SwitchCase>): boolean {
	const renderRoot = getDynamicSkillRenderRootCall(path);
	if (!renderRoot) return false;

	const { attachmentName, countName } = renderRoot;
	const { rootCall } = renderRoot.renderRoot;
	if (
		!isDynamicSkillRenderLine(
			rootCall,
			attachmentName,
			countName,
			getDynamicSkillRenderStatements(path),
		)
	) {
		return false;
	}
	if (hasSkillListingSummaryCall(rootCall, attachmentName)) {
		makeCacheGuardAlwaysRecompute(renderRoot.renderRoot);
		return true;
	}

	appendElementChild(
		rootCall,
		t.callExpression(t.identifier(SKILL_LISTING_SUMMARY_HELPER), [
			t.identifier(attachmentName),
		]),
	);
	makeCacheGuardAlwaysRecompute(renderRoot.renderRoot);
	return true;
}

function createSkillListingUiPasses(): PatchAstPass[] {
	const attachmentCandidates: NodePath<t.ObjectExpression>[] = [];
	const renderCandidates: NodePath<t.SwitchCase>[] = [];
	const dynamicRenderCandidates: NodePath<t.SwitchCase>[] = [];
	let helperExists = false;
	let patchedAttachment = false;
	let patchedRenderer = false;
	let patchedDynamicRenderer = false;

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
					if (isDynamicSkillRenderCase(path)) {
						dynamicRenderCandidates.push(path);
						return;
					}
					if (!isSkillListingRenderCase(path)) return;
					const renderRoot = getSkillListingRenderRootCall(path);
					if (!renderRoot) return;
					if (
						isSkillListingRenderLine(
							renderRoot.renderRoot.rootCall,
							renderRoot.attachmentName,
							getSkillListingRenderStatements(path),
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

						if (
							(renderCandidates.length === 1 ||
								dynamicRenderCandidates.length === 1) &&
							!helperExists
						) {
							path.node.body.unshift(buildSkillListingSummaryHelper());
							helperExists = true;
						}

						if (renderCandidates.length === 1) {
							patchedRenderer = patchSkillListingRenderer(renderCandidates[0]);
						}

						if (dynamicRenderCandidates.length === 1) {
							patchedDynamicRenderer = patchDynamicSkillRenderer(
								dynamicRenderCandidates[0],
							);
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

						if (dynamicRenderCandidates.length > 1) {
							console.warn(
								`Skill listing UI: ambiguous dynamic_skill render cases (${dynamicRenderCandidates.length} found)`,
							);
						} else if (dynamicRenderCandidates.length === 0) {
							console.warn(
								"Skill listing UI: could not find dynamic_skill render case",
							);
						} else if (!patchedDynamicRenderer) {
							console.warn(
								"Skill listing UI: failed to patch dynamic_skill render case",
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
		let dynamicRendererPatched = false;

		traverse(verifyAst, {
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
				if (isSkillListingRenderCase(path)) {
					const renderRoot = getSkillListingRenderRootCall(path);
					if (
						renderRoot &&
						isSkillListingRenderLine(
							renderRoot.renderRoot.rootCall,
							renderRoot.attachmentName,
							getSkillListingRenderStatements(path),
						)
					) {
						rendererPatched =
							hasSkillListingSummaryCall(
								renderRoot.renderRoot.rootCall,
								renderRoot.attachmentName,
							) && isCacheGuardAlwaysRecomputed(renderRoot.renderRoot);
					}
				}

				if (isDynamicSkillRenderCase(path)) {
					const renderRoot = getDynamicSkillRenderRootCall(path);
					if (renderRoot) {
						dynamicRendererPatched =
							hasSkillListingSummaryCall(
								renderRoot.renderRoot.rootCall,
								renderRoot.attachmentName,
							) && isCacheGuardAlwaysRecomputed(renderRoot.renderRoot);
					}
				}
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
		if (!dynamicRendererPatched) {
			return "dynamic_skill renderer is missing the loaded-skill summary";
		}
		return true;
	},
};
