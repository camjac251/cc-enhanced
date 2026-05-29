import * as t from "@babel/types";
import { type NodePath, traverse, type Visitor } from "../babel.js";
import type { Patch } from "../types.js";
import {
	getMemberPropertyName,
	getObjectKeyName,
	getObjectPropertyByName,
	getVerifyAst,
	isTrueLike,
} from "./ast-helpers.js";

const COMPACT_AUTO_VALUE = "yes-compact-auto";
const COMPACT_ACCEPT_EDITS_VALUE = "yes-compact-accept-edits";
const PLAN_IMPLEMENT_PREFIX = "Implement the following plan:";
const COMPACT_FAILED_NOTIFICATION_KEY = "plan-compact-execute-failed";

interface InteractiveContextIds {
	commands: string;
	getToolUseContext: string;
	messagesRef: string;
	setMessages: string;
	mainLoopModel: string;
	addNotification: string;
}

function visitNodeValues(
	value: unknown,
	visit: (node: t.Node) => boolean,
): boolean {
	if (!value) return false;
	if (Array.isArray(value)) {
		return value.some((item) => visitNodeValues(item, visit));
	}
	if (typeof value !== "object") return false;
	const maybeNode = value as t.Node;
	if (typeof (maybeNode as { type?: unknown }).type !== "string") return false;
	if (visit(maybeNode)) return true;
	return Object.values(maybeNode as unknown as Record<string, unknown>).some(
		(child) => visitNodeValues(child, visit),
	);
}

function nodeContainsText(node: unknown, needle: string): boolean {
	return visitNodeValues(node, (candidate) => {
		if (t.isStringLiteral(candidate)) return candidate.value.includes(needle);
		if (t.isTemplateElement(candidate)) {
			return (
				candidate.value.raw.includes(needle) ||
				(candidate.value.cooked?.includes(needle) ?? false)
			);
		}
		return false;
	});
}

function nodeContainsMemberProperty(
	node: unknown,
	propertyName: string,
): boolean {
	return visitNodeValues(node, (candidate) => {
		if (
			t.isMemberExpression(candidate) ||
			t.isOptionalMemberExpression(candidate)
		) {
			return getMemberPropertyName(candidate) === propertyName;
		}
		if (
			(t.isObjectProperty(candidate) || t.isObjectMethod(candidate)) &&
			getObjectKeyName(candidate.key) === propertyName
		) {
			return true;
		}
		return false;
	});
}

function nodeContainsMessagesToKeepArrayFallback(node: unknown): boolean {
	return visitNodeValues(node, (candidate) => {
		if (!t.isLogicalExpression(candidate, { operator: "??" })) return false;
		if (
			!t.isArrayExpression(candidate.right) ||
			candidate.right.elements.length > 0
		) {
			return false;
		}
		if (
			!t.isMemberExpression(candidate.left) &&
			!t.isOptionalMemberExpression(candidate.left)
		) {
			return false;
		}
		return getMemberPropertyName(candidate.left) === "messagesToKeep";
	});
}

function getPatternBindingName(node: t.Node | null | undefined): string | null {
	if (!node) return null;
	if (t.isIdentifier(node)) return node.name;
	if (t.isAssignmentPattern(node)) return getPatternBindingName(node.left);
	return null;
}

function getDestructuredParamLocalName(
	path: NodePath<t.Function>,
	keyName: string,
): string | null {
	const firstParam = path.node.params[0];
	if (!t.isObjectPattern(firstParam)) return null;
	for (const prop of firstParam.properties) {
		if (!t.isObjectProperty(prop)) continue;
		if (getObjectKeyName(prop.key) !== keyName) continue;
		return getPatternBindingName(prop.value as t.Node);
	}
	return null;
}

function objectPropertyStringValue(
	objectExpr: t.ObjectExpression,
	keyName: string,
): string | null {
	const prop = getObjectPropertyByName(objectExpr, keyName);
	if (!prop || !t.isStringLiteral(prop.value)) return null;
	return prop.value.value;
}

function isObjectOptionValue(
	node: t.Node | null | undefined,
	value: string,
): node is t.ObjectExpression {
	return (
		!!node &&
		t.isObjectExpression(node) &&
		objectPropertyStringValue(node, "value") === value
	);
}

function getPushReceiverName(node: t.CallExpression): string | null {
	if (!t.isMemberExpression(node.callee)) return null;
	if (getMemberPropertyName(node.callee) !== "push") return null;
	if (!t.isIdentifier(node.callee.object)) return null;
	return node.callee.object.name;
}

function findOptionsArrayName(path: NodePath<t.Function>): string | null {
	let optionsName: string | null = null;
	path.traverse({
		Function(innerPath) {
			if (innerPath !== path) innerPath.skip();
		},
		CallExpression(callPath) {
			if (optionsName) return;
			const receiverName = getPushReceiverName(callPath.node);
			if (!receiverName) return;
			if (
				callPath.node.arguments.some((arg) =>
					isObjectOptionValue(arg as t.Node, "no"),
				)
			) {
				optionsName = receiverName;
			}
		},
	});
	return optionsName;
}

function findClearContextSuffixName(path: NodePath<t.Function>): string | null {
	let suffixName: string | null = null;
	path.traverse({
		Function(innerPath) {
			if (innerPath !== path) innerPath.skip();
		},
		TemplateLiteral(templatePath) {
			if (suffixName) return;
			const staticText = templatePath.node.quasis
				.map((quasi) => quasi.value.cooked ?? quasi.value.raw)
				.join("");
			if (!staticText.includes("Yes, clear context")) return;
			for (const expression of templatePath.node.expressions) {
				if (t.isIdentifier(expression)) {
					suffixName = expression.name;
					return;
				}
			}
		},
	});
	return suffixName;
}

function findAutoClearContextOptionCondition(
	path: NodePath<t.Function>,
): t.Expression | null {
	let condition: t.Expression | null = null;
	path.traverse({
		Function(innerPath) {
			if (innerPath !== path) innerPath.skip();
		},
		IfStatement(ifPath) {
			if (condition) return;
			if (!nodeContainsText(ifPath.node.consequent, "yes-auto-clear-context"))
				return;
			condition = t.cloneNode(ifPath.node.test, true) as t.Expression;
		},
	});
	return condition;
}

function buildCompactLabel(
	tail: "and use auto mode" | "and auto-accept edits",
	suffixName: string | null,
): t.StringLiteral | t.TemplateLiteral {
	if (!suffixName) return t.stringLiteral(`Yes, compact context ${tail}`);
	return t.templateLiteral(
		[
			t.templateElement({
				raw: "Yes, compact context",
				cooked: "Yes, compact context",
			}),
			t.templateElement({ raw: ` ${tail}`, cooked: ` ${tail}` }, true),
		],
		[t.identifier(suffixName)],
	);
}

function buildPushOptionStatement(
	optionsName: string,
	label: t.Expression,
	value: string,
): t.ExpressionStatement {
	return t.expressionStatement(
		t.callExpression(
			t.memberExpression(t.identifier(optionsName), t.identifier("push")),
			[
				t.objectExpression([
					t.objectProperty(t.identifier("label"), label),
					t.objectProperty(t.identifier("value"), t.stringLiteral(value)),
				]),
			],
		),
	);
}

function buildCompactOptionStatement(
	optionsName: string,
	showClearContextName: string,
	autoClearContextCondition: t.Expression,
	suffixName: string | null,
): t.IfStatement {
	return t.ifStatement(
		t.identifier(showClearContextName),
		t.ifStatement(
			autoClearContextCondition,
			buildPushOptionStatement(
				optionsName,
				buildCompactLabel("and use auto mode", suffixName),
				COMPACT_AUTO_VALUE,
			),
			buildPushOptionStatement(
				optionsName,
				buildCompactLabel("and auto-accept edits", suffixName),
				COMPACT_ACCEPT_EDITS_VALUE,
			),
		),
	);
}

function buildSelectionComparison(
	selectionName: string,
	value: string,
): t.BinaryExpression {
	return t.binaryExpression(
		"===",
		t.identifier(selectionName),
		t.stringLiteral(value),
	);
}

function buildIsCompactSelection(selectionName: string): t.LogicalExpression {
	return t.logicalExpression(
		"||",
		buildSelectionComparison(selectionName, COMPACT_AUTO_VALUE),
		buildSelectionComparison(selectionName, COMPACT_ACCEPT_EDITS_VALUE),
	);
}

function buildNotCompactSelection(selectionName: string): t.UnaryExpression {
	return t.unaryExpression(
		"!",
		t.parenthesizedExpression(buildIsCompactSelection(selectionName)),
	);
}

function buildCompactContextValue(selectionName: string): t.LogicalExpression {
	return t.logicalExpression(
		"||",
		buildIsCompactSelection(selectionName),
		t.unaryExpression("void", t.numericLiteral(0)),
	);
}

function findComparedIdentifierName(
	node: t.Node,
	value: string,
): string | null {
	let found: string | null = null;
	visitNodeValues(node, (candidate) => {
		if (found || !t.isBinaryExpression(candidate)) return false;
		if (candidate.operator !== "===" && candidate.operator !== "!==")
			return false;
		if (
			t.isIdentifier(candidate.left) &&
			t.isStringLiteral(candidate.right, { value })
		) {
			found = candidate.left.name;
			return true;
		}
		if (
			t.isStringLiteral(candidate.left, { value }) &&
			t.isIdentifier(candidate.right)
		) {
			found = candidate.right.name;
			return true;
		}
		return false;
	});
	return found;
}

function extractAutoModeRuntimeCondition(
	test: t.Expression,
): t.Expression | null {
	if (t.isLogicalExpression(test, { operator: "&&" })) {
		if (nodeContainsText(test.left, "yes-auto-clear-context")) {
			return t.cloneNode(test.right, true) as t.Expression;
		}
		if (nodeContainsText(test.right, "yes-auto-clear-context")) {
			return t.cloneNode(test.left, true) as t.Expression;
		}
	}
	if (nodeContainsText(test, "yes-auto-clear-context"))
		return t.booleanLiteral(true);
	return null;
}

function findAutoModeBranch(block: t.BlockStatement): {
	condition: t.Expression;
	consequent: t.Statement;
} | null {
	let found: { condition: t.Expression; consequent: t.Statement } | null = null;
	visitNodeValues(block, (candidate) => {
		if (found || !t.isIfStatement(candidate)) return false;
		if (!nodeContainsText(candidate.test, "yes-auto-clear-context"))
			return false;
		const condition = extractAutoModeRuntimeCondition(candidate.test);
		if (!condition) return false;
		found = {
			condition,
			consequent: t.cloneNode(candidate.consequent, true) as t.Statement,
		};
		return true;
	});
	return found;
}

function findModeDeclaration(block: t.BlockStatement): {
	statementIndex: number;
	modeName: string;
} | null {
	for (
		let statementIndex = 0;
		statementIndex < block.body.length;
		statementIndex += 1
	) {
		const statement = block.body[statementIndex];
		if (!t.isVariableDeclaration(statement)) continue;
		for (const declaration of statement.declarations) {
			if (
				t.isIdentifier(declaration.id) &&
				t.isStringLiteral(declaration.init, { value: "default" })
			) {
				return { statementIndex, modeName: declaration.id.name };
			}
		}
	}
	return null;
}

function buildCompactAutoModeIf(
	selectionName: string,
	autoBranch: { condition: t.Expression; consequent: t.Statement },
): t.IfStatement {
	return t.ifStatement(
		t.logicalExpression(
			"&&",
			buildSelectionComparison(selectionName, COMPACT_AUTO_VALUE),
			autoBranch.condition,
		),
		autoBranch.consequent,
	);
}

function orChainContainsSelectionEquals(
	node: t.Node | null | undefined,
	selectionName: string,
	value: string,
): boolean {
	let found = false;
	visitNodeValues(node, (candidate) => {
		if (found) return true;
		if (!t.isBinaryExpression(candidate)) return false;
		if (candidate.operator !== "===" && candidate.operator !== "==")
			return false;
		if (
			t.isIdentifier(candidate.left, { name: selectionName }) &&
			t.isStringLiteral(candidate.right, { value })
		) {
			found = true;
			return true;
		}
		if (
			t.isStringLiteral(candidate.left, { value }) &&
			t.isIdentifier(candidate.right, { name: selectionName })
		) {
			found = true;
			return true;
		}
		return false;
	});
	return found;
}

function extendPlanGateOrChain(
	ifPath: NodePath<t.IfStatement>,
	selectionName: string,
): boolean {
	const newValues = [COMPACT_AUTO_VALUE, COMPACT_ACCEPT_EDITS_VALUE];

	const matchesAnchor = (node: t.Node | null | undefined): boolean =>
		t.isLogicalExpression(node, { operator: "||" }) &&
		orChainContainsSelectionEquals(
			node,
			selectionName,
			"yes-auto-clear-context",
		);

	const buildExtended = (chain: t.Expression): t.Expression => {
		let current = chain;
		for (const value of newValues) {
			if (orChainContainsSelectionEquals(current, selectionName, value))
				continue;
			current = t.logicalExpression(
				"||",
				current,
				buildSelectionComparison(selectionName, value),
			);
		}
		return current;
	};

	const testPath = ifPath.get("test");
	if (matchesAnchor(testPath.node)) {
		testPath.replaceWith(buildExtended(testPath.node));
		return true;
	}

	let extended = false;
	testPath.traverse({
		LogicalExpression(orPath) {
			if (extended) return;
			if (!matchesAnchor(orPath.node)) return;
			orPath.replaceWith(buildExtended(orPath.node));
			orPath.skip();
			extended = true;
		},
	});
	return extended;
}

function buildCompactAcceptEditsIf(
	selectionName: string,
	modeName: string,
): t.IfStatement {
	return t.ifStatement(
		buildSelectionComparison(selectionName, COMPACT_ACCEPT_EDITS_VALUE),
		t.expressionStatement(
			t.assignmentExpression(
				"=",
				t.identifier(modeName),
				t.stringLiteral("acceptEdits"),
			),
		),
	);
}

function patchClearContextProperties(
	path: NodePath<t.IfStatement>,
	selectionName: string,
): number {
	let patched = 0;
	path.traverse({
		ObjectProperty(propPath) {
			if (getObjectKeyName(propPath.node.key) !== "clearContext") return;
			if (!isTrueLike(propPath.node.value)) return;
			propPath.node.value = buildNotCompactSelection(selectionName);
			patched += 1;
		},
	});
	return patched;
}

function addCompactContextProperty(
	path: NodePath<t.IfStatement>,
	selectionName: string,
): boolean {
	let patched = false;
	path.traverse({
		ObjectProperty(propPath) {
			if (patched) return;
			if (getObjectKeyName(propPath.node.key) !== "initialMessage") return;
			if (!t.isObjectExpression(propPath.node.value)) return;
			const initialMessage = propPath.node.value;
			if (getObjectPropertyByName(initialMessage, "compactContext")) return;
			const compactProp = t.objectProperty(
				t.identifier("compactContext"),
				buildCompactContextValue(selectionName),
			);
			const clearContextIndex = initialMessage.properties.findIndex(
				(prop) =>
					t.isObjectProperty(prop) &&
					getObjectKeyName(prop.key) === "clearContext",
			);
			if (clearContextIndex >= 0) {
				initialMessage.properties.splice(clearContextIndex + 1, 0, compactProp);
			} else {
				initialMessage.properties.push(compactProp);
			}
			patched = true;
		},
	});
	return patched;
}

function getMemberRootAndProperties(
	node: t.Node | null | undefined,
): { rootName: string; properties: string[] } | null {
	const properties: string[] = [];
	let current: t.Node | null | undefined = node;
	while (
		t.isMemberExpression(current) ||
		t.isOptionalMemberExpression(current)
	) {
		const propertyName = getMemberPropertyName(current);
		if (!propertyName) return null;
		properties.unshift(propertyName);
		current = current.object as t.Node;
	}
	if (!t.isIdentifier(current)) return null;
	return { rootName: current.name, properties };
}

function isMemberChain(
	node: t.Node | null | undefined,
	rootName: string,
	properties: string[],
): boolean {
	const chain = getMemberRootAndProperties(node);
	return (
		!!chain &&
		chain.rootName === rootName &&
		chain.properties.length === properties.length &&
		chain.properties.every((property, index) => property === properties[index])
	);
}

function getClearContextObjectName(test: t.Expression): string | null {
	if (t.isMemberExpression(test) || t.isOptionalMemberExpression(test)) {
		const chain = getMemberRootAndProperties(test);
		if (
			chain?.properties.length === 1 &&
			chain.properties[0] === "clearContext"
		) {
			return chain.rootName;
		}
	}
	return null;
}

function findInitialMessageContentStatementIndex(
	body: t.Statement[],
	initialMessageName: string,
): number {
	for (let index = 0; index < body.length; index += 1) {
		const statement = body[index];
		if (!t.isVariableDeclaration(statement)) continue;
		if (
			statement.declarations.some((declaration) =>
				isMemberChain(declaration.init, initialMessageName, [
					"message",
					"message",
					"content",
				]),
			)
		) {
			return index;
		}
	}
	return -1;
}

function objectHasIdentifierProperty(
	objectExpr: t.ObjectExpression,
	keyName: string,
): t.Identifier | null {
	const prop = getObjectPropertyByName(objectExpr, keyName);
	if (!prop || !t.isIdentifier(prop.value)) return null;
	return prop.value;
}

function getIdentifierNameFromExpression(
	node: t.Node | null | undefined,
): string | null {
	if (!node) return null;
	if (t.isIdentifier(node)) return node.name;
	if (t.isLogicalExpression(node, { operator: "??" })) {
		return getIdentifierNameFromExpression(node.right);
	}
	return null;
}

function getMessagesRefIdentifier(
	objectExpr: t.ObjectExpression,
): string | null {
	const prop = getObjectPropertyByName(objectExpr, "messages");
	if (!prop || !t.isMemberExpression(prop.value)) return null;
	if (getMemberPropertyName(prop.value) !== "current") return null;
	if (!t.isIdentifier(prop.value.object)) return null;
	return prop.value.object.name;
}

function discoverInteractiveContextIds(
	path: NodePath<t.Function>,
): InteractiveContextIds | null {
	let ids: InteractiveContextIds | null = null;
	path.traverse({
		ObjectExpression(objectPath) {
			if (ids) return;
			const commands = objectHasIdentifierProperty(
				objectPath.node,
				"commands",
			)?.name;
			const getToolUseContext = objectHasIdentifierProperty(
				objectPath.node,
				"getToolUseContext",
			)?.name;
			const messagesRef = getMessagesRefIdentifier(objectPath.node);
			const setMessages = objectHasIdentifierProperty(
				objectPath.node,
				"setMessages",
			)?.name;
			const mainLoopModel = getIdentifierNameFromExpression(
				getObjectPropertyByName(objectPath.node, "mainLoopModel")?.value,
			);
			const addNotification = objectHasIdentifierProperty(
				objectPath.node,
				"addNotification",
			)?.name;

			if (
				commands &&
				getToolUseContext &&
				messagesRef &&
				setMessages &&
				mainLoopModel &&
				addNotification
			) {
				ids = {
					commands,
					getToolUseContext,
					messagesRef,
					setMessages,
					mainLoopModel,
					addNotification,
				};
			}
		},
	});
	return ids;
}

function findInteractiveContextIds(
	path: NodePath<t.Function>,
): InteractiveContextIds | null {
	let current: NodePath<t.Node> | null = path;
	while (current) {
		if (current.isFunction()) {
			const ids = discoverInteractiveContextIds(
				current as NodePath<t.Function>,
			);
			if (ids) return ids;
		}
		current = current.parentPath;
	}
	return null;
}

function member(object: t.Expression, property: string): t.MemberExpression {
	return t.memberExpression(object, t.identifier(property));
}

function optionalArray(expression: t.Expression): t.LogicalExpression {
	return t.logicalExpression("??", expression, t.arrayExpression([]));
}

function buildCommandPredicate(candidateName: string): t.Expression {
	const candidate = t.identifier(candidateName);
	return t.logicalExpression(
		"&&",
		t.logicalExpression(
			"&&",
			t.logicalExpression(
				"&&",
				candidate,
				t.binaryExpression(
					"===",
					member(candidate, "type"),
					t.stringLiteral("local"),
				),
			),
			t.binaryExpression(
				"===",
				member(candidate, "name"),
				t.stringLiteral("compact"),
			),
		),
		t.parenthesizedExpression(
			t.logicalExpression(
				"||",
				t.unaryExpression("!", member(candidate, "isEnabled")),
				t.callExpression(member(candidate, "isEnabled"), []),
			),
		),
	);
}

function buildCompactionResultExpansion(
	summaryName: string,
): t.ArrayExpression {
	const summary = t.identifier(summaryName);
	return t.arrayExpression([
		member(summary, "boundaryMarker"),
		t.spreadElement(member(summary, "summaryMessages")),
		t.spreadElement(optionalArray(member(summary, "messagesToKeep"))),
		t.spreadElement(member(summary, "attachments")),
		t.spreadElement(member(summary, "hookResults")),
	]);
}

function buildCompactInitialMessageBlock(
	initialMessageName: string,
	ids: InteractiveContextIds,
): t.IfStatement {
	const commandName = "__ccEnhancedPlanCompactCommand";
	const candidateName = "__ccEnhancedPlanCompactCandidate";
	const resultName = "__ccEnhancedPlanCompactResult";
	const summaryName = "__ccEnhancedPlanCompactSummary";
	const errorName = "__ccEnhancedPlanCompactError";
	const command = t.identifier(commandName);
	const result = t.identifier(resultName);
	const summary = t.identifier(summaryName);

	return t.ifStatement(
		member(t.identifier(initialMessageName), "compactContext"),
		t.blockStatement([
			t.variableDeclaration("const", [
				t.variableDeclarator(
					command,
					t.callExpression(member(t.identifier(ids.commands), "find"), [
						t.arrowFunctionExpression(
							[t.identifier(candidateName)],
							buildCommandPredicate(candidateName),
						),
					]),
				),
			]),
			t.ifStatement(
				command,
				t.blockStatement([
					t.tryStatement(
						t.blockStatement([
							t.variableDeclaration("const", [
								t.variableDeclarator(
									result,
									t.awaitExpression(
										t.callExpression(
											member(
												t.awaitExpression(
													t.callExpression(member(command, "load"), []),
												),
												"call",
											),
											[
												t.stringLiteral(""),
												t.callExpression(t.identifier(ids.getToolUseContext), [
													member(t.identifier(ids.messagesRef), "current"),
													t.arrayExpression([]),
													t.newExpression(t.identifier("AbortController"), []),
													t.identifier(ids.mainLoopModel),
												]),
											],
										),
									),
								),
							]),
							t.ifStatement(
								t.logicalExpression(
									"&&",
									t.logicalExpression(
										"&&",
										result,
										t.binaryExpression(
											"===",
											member(result, "type"),
											t.stringLiteral("compact"),
										),
									),
									member(result, "compactionResult"),
								),
								t.blockStatement([
									t.variableDeclaration("const", [
										t.variableDeclarator(
											summary,
											member(result, "compactionResult"),
										),
									]),
									t.expressionStatement(
										t.callExpression(t.identifier(ids.setMessages), [
											buildCompactionResultExpansion(summaryName),
										]),
									),
								]),
							),
						]),
						t.catchClause(
							t.identifier(errorName),
							t.blockStatement([
								t.expressionStatement(
									t.callExpression(t.identifier(ids.addNotification), [
										t.objectExpression([
											t.objectProperty(
												t.identifier("key"),
												t.stringLiteral(COMPACT_FAILED_NOTIFICATION_KEY),
											),
											t.objectProperty(
												t.identifier("text"),
												t.stringLiteral(
													"Plan compaction failed; executing with existing context",
												),
											),
											t.objectProperty(
												t.identifier("priority"),
												t.stringLiteral("high"),
											),
											t.objectProperty(
												t.identifier("color"),
												t.stringLiteral("warning"),
											),
										]),
									]),
								),
							]),
						),
					),
				]),
			),
		]),
	);
}

function selectorUsesDynamicPlanOptions(objectExpr: t.ObjectExpression): {
	optionsName: string;
} | null {
	const optionsProp = getObjectPropertyByName(objectExpr, "options");
	if (!optionsProp || !t.isIdentifier(optionsProp.value)) return null;
	if (!getObjectPropertyByName(objectExpr, "onImagePaste")) return null;
	if (!getObjectPropertyByName(objectExpr, "pastedContents")) return null;
	if (!getObjectPropertyByName(objectExpr, "onRemoveImage")) return null;
	return { optionsName: optionsProp.value.name };
}

function visibleOptionCountMatchesOptionsLength(
	prop: t.ObjectProperty,
	optionsName: string,
): boolean {
	if (!t.isMemberExpression(prop.value)) return false;
	if (getMemberPropertyName(prop.value) !== "length") return false;
	return t.isIdentifier(prop.value.object, { name: optionsName });
}

function testReferencesNonCompactYesValue(test: t.Expression): boolean {
	const NON_COMPACT_YES_VALUES = new Set([
		"yes-bypass-permissions",
		"yes-accept-edits",
		"yes-auto-clear-context",
	]);
	let found = false;
	visitNodeValues(test, (node) => {
		if (found) return true;
		if (t.isStringLiteral(node) && NON_COMPACT_YES_VALUES.has(node.value)) {
			found = true;
			return true;
		}
		return false;
	});
	return found;
}

function consequentAssignsBypassPermissions(consequent: t.Statement): boolean {
	// Walk the consequent looking for an AssignmentExpression whose right side
	// is exactly the StringLiteral "bypassPermissions" (or a permissionMode
	// member set to "bypassPermissions"). A substring match elsewhere in the
	// subtree is not enough — the audit flagged this as a place where unrelated
	// strings could trip the verifier or upstream renames could silently
	// neutralize it.
	let found = false;
	const walk = (value: unknown): void => {
		if (found) return;
		if (!value) return;
		if (Array.isArray(value)) {
			for (const item of value) walk(item);
			return;
		}
		if (typeof value !== "object") return;
		const maybeNode = value as t.Node;
		if (typeof (maybeNode as { type?: unknown }).type !== "string") return;
		if (t.isAssignmentExpression(maybeNode)) {
			if (t.isStringLiteral(maybeNode.right, { value: "bypassPermissions" })) {
				found = true;
				return;
			}
		}
		for (const child of Object.values(
			maybeNode as unknown as Record<string, unknown>,
		)) {
			walk(child);
		}
	};
	walk(consequent);
	return found;
}

export const planCompactExecute: Patch = {
	tag: "plan-compact-execute",

	astPasses: () => [
		{
			pass: "mutate",
			visitor: createPlanCompactExecuteMutator(),
		},
	],

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) return "Unable to parse AST during verification";

		let compactAutoOption = false;
		let compactAcceptEditsOption = false;
		let compactBypassOption = false;
		let compactBranchAssignsBypass = false;
		let initialMessageWithCompactContext = false;
		let initialMessageClearContextStaticTrue = false;
		let compactInitialMessageHandler = false;
		let compactInitialMessageHandlerUsesMessagesToKeepFallback = false;
		let planSelectorCount = 0;
		let patchedPlanSelectorCount = 0;
		let planGateRestrictedWithoutCompact = false;

		traverse(verifyAst, {
			ObjectExpression(path) {
				const optionValue = objectPropertyStringValue(path.node, "value");
				if (
					optionValue === COMPACT_AUTO_VALUE ||
					optionValue === COMPACT_ACCEPT_EDITS_VALUE
				) {
					if (optionValue === COMPACT_AUTO_VALUE) compactAutoOption = true;
					if (optionValue === COMPACT_ACCEPT_EDITS_VALUE)
						compactAcceptEditsOption = true;
					// Tighten bypass-permissions detection: only consider strings
					// inside the option's own label/description/value/key fields,
					// not anything mentioned anywhere in the subtree. A future
					// option that documents the bypass mode (e.g. "do not pick
					// bypass permissions for compact") in a long description
					// must not flip this signal.
					const labelStr = objectPropertyStringValue(path.node, "label") ?? "";
					const descStr =
						objectPropertyStringValue(path.node, "description") ?? "";
					if (
						labelStr.toLowerCase().includes("bypass permissions") ||
						descStr.toLowerCase().includes("bypass permissions")
					) {
						compactBypassOption = true;
					}
				}

				const selector = selectorUsesDynamicPlanOptions(path.node);
				if (selector) {
					planSelectorCount += 1;
					const visibleProp = getObjectPropertyByName(
						path.node,
						"visibleOptionCount",
					);
					if (
						visibleProp &&
						visibleOptionCountMatchesOptionsLength(
							visibleProp,
							selector.optionsName,
						)
					) {
						patchedPlanSelectorCount += 1;
					}
				}
			},
			ObjectProperty(path) {
				if (getObjectKeyName(path.node.key) !== "initialMessage") return;
				if (!t.isObjectExpression(path.node.value)) return;
				const compactProp = getObjectPropertyByName(
					path.node.value,
					"compactContext",
				);
				if (!compactProp) return;
				initialMessageWithCompactContext = true;
				const clearContextProp = getObjectPropertyByName(
					path.node.value,
					"clearContext",
				);
				if (clearContextProp && isTrueLike(clearContextProp.value)) {
					initialMessageClearContextStaticTrue = true;
				}
			},
			IfStatement(path) {
				if (
					(nodeContainsText(path.node.test, COMPACT_AUTO_VALUE) ||
						nodeContainsText(path.node.test, COMPACT_ACCEPT_EDITS_VALUE)) &&
					!testReferencesNonCompactYesValue(path.node.test)
				) {
					// Tighten bypass check: only flag a structural assignment
					// whose RIGHT side is the literal string "bypassPermissions"
					// AND whose LEFT side is some MemberExpression. A coincidental
					// substring like "bypassPermissions" appearing in a comment
					// stripped to text, a docstring, or a different attribute
					// name should not satisfy this. We also require the test to
					// reference ONLY compact values; the outer plan-exit gate
					// now contains compact values in its OR-chain after the
					// gate extension, and its body legitimately assigns
					// bypassPermissions for the non-compact bypass branch.
					if (consequentAssignsBypassPermissions(path.node.consequent)) {
						compactBranchAssignsBypass = true;
					}
				}
				if (
					nodeContainsMemberProperty(path.node.test, "compactContext") &&
					nodeContainsText(path.node.consequent, "compact") &&
					nodeContainsMemberProperty(
						path.node.consequent,
						"compactionResult",
					) &&
					nodeContainsMemberProperty(path.node.consequent, "boundaryMarker") &&
					nodeContainsMemberProperty(path.node.consequent, "messagesToKeep")
				) {
					compactInitialMessageHandler = true;
					if (nodeContainsMessagesToKeepArrayFallback(path.node.consequent)) {
						compactInitialMessageHandlerUsesMessagesToKeepFallback = true;
					}
				}
				// Plan-exit handoff: when upstream guards execution behind a
				// value allowlist (the `yes-bypass-permissions / yes-accept-edits
				// / yes-auto-clear-context` OR-chain), the compact selections
				// must be in that allowlist too. Otherwise everything the patch
				// inserts inside the block is dead and pressing the compact
				// option does nothing.
				if (
					nodeContainsText(path.node.consequent, PLAN_IMPLEMENT_PREFIX) &&
					nodeContainsText(path.node.test, "yes-auto-clear-context") &&
					nodeContainsText(path.node.test, "yes-bypass-permissions") &&
					(!nodeContainsText(path.node.test, COMPACT_AUTO_VALUE) ||
						!nodeContainsText(path.node.test, COMPACT_ACCEPT_EDITS_VALUE))
				) {
					planGateRestrictedWithoutCompact = true;
				}
			},
		});

		if (!compactAutoOption)
			return "Compact auto-mode plan approval option not found";
		if (!compactAcceptEditsOption) {
			return "Compact accept-edits plan approval option not found";
		}
		if (compactBypassOption)
			return "Compact plan option includes bypass-permissions wording";
		if (code.includes("yes-compact-bypass")) {
			return "Compact bypass-permissions option value must not be added";
		}
		if (compactBranchAssignsBypass) {
			return "Compact plan selection routes through bypassPermissions";
		}
		if (!initialMessageWithCompactContext) {
			return "Plan initialMessage compactContext flag not found";
		}
		if (initialMessageClearContextStaticTrue) {
			return "Compact-capable initialMessage still has static clearContext: true";
		}
		if (!compactInitialMessageHandler) {
			return "Initial message handler does not run compact command before executing plan";
		}
		if (!compactInitialMessageHandlerUsesMessagesToKeepFallback) {
			return "Initial message handler does not guard optional compact messagesToKeep with [] fallback";
		}
		if (planSelectorCount === 0) {
			return "Plan approval selector props not found";
		}
		if (patchedPlanSelectorCount !== planSelectorCount) {
			return "Plan approval selector visibleOptionCount does not track options.length";
		}
		if (planGateRestrictedWithoutCompact) {
			return "Plan execution gate restricts selection values without accepting yes-compact-auto / yes-compact-accept-edits; compact option would be a no-op";
		}
		return true;
	},
};

function createPlanCompactExecuteMutator(): Visitor {
	let patchedOptions = 0;
	let patchedPlanBranch = 0;
	let patchedInitialMessageHandler = 0;
	let patchedSelectors = 0;

	return {
		Function(path) {
			if (!t.isBlockStatement(path.node.body)) return;

			if (
				!nodeContainsText(path.node, COMPACT_AUTO_VALUE) &&
				nodeContainsText(path.node, "No, keep planning") &&
				nodeContainsText(path.node, "Yes, clear context")
			) {
				const showClearContextName = getDestructuredParamLocalName(
					path,
					"showClearContext",
				);
				const autoClearContextCondition =
					findAutoClearContextOptionCondition(path);
				const optionsName = findOptionsArrayName(path);
				if (showClearContextName && autoClearContextCondition && optionsName) {
					const insertionIndex = path.node.body.body.findIndex((statement) =>
						nodeContainsText(statement, "Yes, clear context"),
					);
					if (insertionIndex >= 0) {
						path.node.body.body.splice(
							insertionIndex + 1,
							0,
							buildCompactOptionStatement(
								optionsName,
								showClearContextName,
								autoClearContextCondition,
								findClearContextSuffixName(path),
							),
						);
						patchedOptions += 1;
					}
				}
			}
		},

		IfStatement(path) {
			if (
				nodeContainsText(path.node, PLAN_IMPLEMENT_PREFIX) &&
				nodeContainsText(path.node, "yes-auto-clear-context") &&
				!nodeContainsText(path.node, COMPACT_AUTO_VALUE) &&
				t.isBlockStatement(path.node.consequent)
			) {
				const selectionName = findComparedIdentifierName(
					path.node,
					"yes-auto-clear-context",
				);
				const autoBranch = findAutoModeBranch(path.node.consequent);
				const modeDeclaration = findModeDeclaration(path.node.consequent);
				if (selectionName && autoBranch && modeDeclaration) {
					// Upstream narrowed the outer guard to a value allowlist
					// (`o === "yes-bypass-permissions" || o === "yes-accept-edits"
					// || o === "yes-auto-clear-context"`). The inserted compact
					// branches below sit inside this guarded block, so without
					// extending the allowlist to include the compact values the
					// branches would be unreachable and selecting a compact
					// option would silently do nothing.
					const gateExtended = extendPlanGateOrChain(path, selectionName);
					if (gateExtended) {
						path.node.consequent.body.splice(
							modeDeclaration.statementIndex + 1,
							0,
							buildCompactAutoModeIf(selectionName, autoBranch),
							buildCompactAcceptEditsIf(
								selectionName,
								modeDeclaration.modeName,
							),
						);
						const clearContextPatches = patchClearContextProperties(
							path,
							selectionName,
						);
						const compactContextPatched = addCompactContextProperty(
							path,
							selectionName,
						);
						if (clearContextPatches > 0 && compactContextPatched)
							patchedPlanBranch += 1;
					}
				}
			}

			const initialMessageName = getClearContextObjectName(path.node.test);
			if (!initialMessageName) return;
			const handlerPath = path.getFunctionParent();
			if (!handlerPath || !t.isBlockStatement(handlerPath.node.body)) return;
			if (nodeContainsMemberProperty(handlerPath.node, "compactContext"))
				return;
			if (!nodeContainsMemberProperty(handlerPath.node, "planContent")) return;
			const insertionIndex = findInitialMessageContentStatementIndex(
				handlerPath.node.body.body,
				initialMessageName,
			);
			if (insertionIndex < 0) return;
			const ids = findInteractiveContextIds(
				handlerPath as NodePath<t.Function>,
			);
			if (!ids) return;
			handlerPath.node.body.body.splice(
				insertionIndex,
				0,
				buildCompactInitialMessageBlock(initialMessageName, ids),
			);
			patchedInitialMessageHandler += 1;
		},

		ObjectExpression(path) {
			const selector = selectorUsesDynamicPlanOptions(path.node);
			if (!selector) return;
			if (getObjectPropertyByName(path.node, "visibleOptionCount")) return;
			path.node.properties.push(
				t.objectProperty(
					t.identifier("visibleOptionCount"),
					member(t.identifier(selector.optionsName), "length"),
				),
			);
			patchedSelectors += 1;
		},

		Program: {
			exit() {
				if (patchedOptions === 0) {
					console.warn(
						"plan-compact-execute: Could not find plan approval option builder",
					);
				}
				if (patchedPlanBranch === 0) {
					console.warn(
						"plan-compact-execute: Could not find plan execution handoff branch",
					);
				}
				if (patchedInitialMessageHandler === 0) {
					console.warn(
						"plan-compact-execute: Could not find initial message handler",
					);
				}
				if (patchedSelectors === 0) {
					console.warn(
						"plan-compact-execute: Could not find plan approval selectors",
					);
				}
			},
		},
	};
}
