import * as t from "@babel/types";
import {
	getElementChildren,
	getObjectKeyName,
	getObjectPropertyByName,
	isElementCall,
} from "./ast-helpers.js";

function getCreateElementProps(
	node: t.CallExpression,
): t.ObjectExpression | null {
	const props = node.arguments[1];
	return t.isObjectExpression(props) ? props : null;
}

function buildReactElementCall(
	react: t.Expression,
	component: t.Expression,
	props: t.Expression | null,
	children: t.Expression[],
): t.CallExpression {
	const propsObject =
		props && t.isObjectExpression(props) ? props : t.objectExpression([]);
	if (children.length > 0) {
		propsObject.properties.push(
			t.objectProperty(
				t.identifier("children"),
				children.length === 1 ? children[0] : t.arrayExpression(children),
			),
		);
	}
	return t.callExpression(
		t.memberExpression(t.cloneNode(react, true), t.identifier("jsx")),
		[t.cloneNode(component, true), propsObject],
	);
}

export function isTextInputChoice(node: t.Node | null | undefined): boolean {
	if (!t.isConditionalExpression(node)) return false;
	return [node.consequent, node.alternate].every((branch) => {
		if (!isElementCall(branch)) return false;
		const props = getCreateElementProps(branch);
		return !!props && props.properties.some((prop) => t.isSpreadElement(prop));
	});
}

export function getPromptBarBoxComponent(
	node: t.CallExpression,
	textInputId: t.Identifier,
): t.Expression | null {
	if (!isElementCall(node)) return null;
	const props = getCreateElementProps(node);
	if (
		!props ||
		!getObjectPropertyByName(props, "flexGrow") ||
		!getObjectPropertyByName(props, "flexShrink")
	) {
		return null;
	}
	if (
		!getElementChildren(node).some((arg) =>
			t.isIdentifier(arg, { name: textInputId.name }),
		)
	) {
		return null;
	}
	const component = node.arguments[0];
	return t.isExpression(component) ? component : null;
}

export function getPromptBarTextComponent(
	node: t.CallExpression,
): t.Expression | null {
	if (!isElementCall(node)) return null;
	const props = getCreateElementProps(node);
	if (!props || !getObjectPropertyByName(props, "dimColor")) return null;
	if (!getElementChildren(node).some((arg) => t.isStringLiteral(arg))) {
		return null;
	}
	const component = node.arguments[0];
	return t.isExpression(component) ? component : null;
}

export function isPromptBarPreviewKey(
	node: t.Node,
	value: "tab-queue-status" | "tab-queue-draft",
): boolean {
	return (
		t.isObjectProperty(node) &&
		getObjectKeyName(node.key) === "key" &&
		t.isStringLiteral(node.value, { value })
	);
}

export function buildPromptBarPreviewDeclarations(
	react: t.Expression,
	box: t.Expression,
	text: t.Expression,
	globalQueue: t.Expression,
): t.VariableDeclaration[] {
	const queuedDrafts = t.identifier("__ccTabQueuedDrafts");
	const queuedDraft = t.identifier("__ccTabQueuedDraft");
	const queuedPreview = t.identifier("__ccTabQueuedPreview");
	const lastIndex = t.binaryExpression(
		"-",
		t.memberExpression(t.cloneNode(queuedDrafts), t.identifier("length")),
		t.numericLiteral(1),
	);
	const countSuffix = t.conditionalExpression(
		t.binaryExpression(
			">",
			t.memberExpression(t.cloneNode(queuedDrafts), t.identifier("length")),
			t.numericLiteral(1),
		),
		t.binaryExpression(
			"+",
			t.binaryExpression(
				"+",
				t.stringLiteral(" ("),
				t.memberExpression(t.cloneNode(queuedDrafts), t.identifier("length")),
			),
			t.stringLiteral(")"),
		),
		t.stringLiteral(""),
	);

	return [
		t.variableDeclaration("let", [
			t.variableDeclarator(queuedDrafts, t.cloneNode(globalQueue, true)),
		]),
		t.variableDeclaration("let", [
			t.variableDeclarator(
				queuedDraft,
				t.conditionalExpression(
					t.logicalExpression(
						"&&",
						t.callExpression(
							t.memberExpression(
								t.identifier("Array"),
								t.identifier("isArray"),
							),
							[t.cloneNode(queuedDrafts)],
						),
						t.binaryExpression(
							">",
							t.memberExpression(
								t.cloneNode(queuedDrafts),
								t.identifier("length"),
							),
							t.numericLiteral(0),
						),
					),
					t.memberExpression(t.cloneNode(queuedDrafts), lastIndex, true),
					t.stringLiteral(""),
				),
			),
		]),
		t.variableDeclaration("let", [
			t.variableDeclarator(
				queuedPreview,
				t.conditionalExpression(
					t.cloneNode(queuedDraft),
					buildReactElementCall(
						react,
						box,
						t.objectExpression([
							t.objectProperty(
								t.identifier("flexDirection"),
								t.stringLiteral("column"),
							),
							t.objectProperty(t.identifier("width"), t.stringLiteral("100%")),
						]),
						[
							buildReactElementCall(
								react,
								text,
								t.objectExpression([
									t.objectProperty(
										t.identifier("color"),
										t.stringLiteral("warning"),
									),
									t.objectProperty(
										t.identifier("key"),
										t.stringLiteral("tab-queue-status"),
									),
									t.objectProperty(
										t.identifier("wrap"),
										t.stringLiteral("truncate"),
									),
								]),
								[
									t.stringLiteral("Queued follow-up"),
									countSuffix,
									t.stringLiteral(" | Tab to edit"),
								],
							),
							buildReactElementCall(
								react,
								text,
								t.objectExpression([
									t.objectProperty(
										t.identifier("dimColor"),
										t.booleanLiteral(true),
									),
									t.objectProperty(
										t.identifier("italic"),
										t.booleanLiteral(true),
									),
									t.objectProperty(
										t.identifier("key"),
										t.stringLiteral("tab-queue-draft"),
									),
									t.objectProperty(
										t.identifier("wrap"),
										t.stringLiteral("truncate"),
									),
								]),
								[t.stringLiteral("> "), t.cloneNode(queuedDraft)],
							),
						],
					),
					t.nullLiteral(),
				),
			),
		]),
	];
}

export function buildWrappedTextInputElement(
	react: t.Expression,
	box: t.Expression,
	originalInit: t.Expression,
): t.ConditionalExpression {
	const wrappedInput = buildReactElementCall(
		react,
		box,
		t.objectExpression([
			t.objectProperty(
				t.identifier("flexDirection"),
				t.stringLiteral("column"),
			),
			t.objectProperty(t.identifier("width"), t.stringLiteral("100%")),
		]),
		[t.identifier("__ccTabQueuedPreview"), t.cloneNode(originalInit, true)],
	);

	return t.conditionalExpression(
		t.identifier("__ccTabQueuedPreview"),
		wrappedInput,
		originalInit,
	);
}

export function isThinkingToggleHintKey(node: t.Node): boolean {
	return (
		t.isObjectProperty(node) &&
		getObjectKeyName(node.key) === "key" &&
		t.isStringLiteral(node.value, { value: "thinking-toggle-hint" })
	);
}

export function isPreventDefaultCall(node: t.Node): boolean {
	return (
		t.isCallExpression(node) &&
		t.isMemberExpression(node.callee) &&
		getObjectKeyName(node.callee.property) === "preventDefault"
	);
}

export function isTrimmedEmptyInputTest(node: t.Node): boolean {
	return (
		t.isBinaryExpression(node, { operator: "===" }) &&
		t.isStringLiteral(node.right, { value: "" }) &&
		t.isCallExpression(node.left) &&
		t.isMemberExpression(node.left.callee) &&
		getObjectKeyName(node.left.callee.property) === "trim"
	);
}

export function isNegatedQueueHasItems(
	node: t.Node,
	isQueueMember: (candidate: t.Node | null | undefined) => boolean,
): boolean {
	if (!t.isUnaryExpression(node, { operator: "!" })) return false;
	const inner = node.argument;
	if (!t.isLogicalExpression(inner, { operator: "&&" })) return false;

	const isArrayCheck =
		t.isCallExpression(inner.left) &&
		t.isMemberExpression(inner.left.callee) &&
		t.isIdentifier(inner.left.callee.object, { name: "Array" }) &&
		getObjectKeyName(inner.left.callee.property) === "isArray" &&
		inner.left.arguments.length === 1 &&
		isQueueMember(inner.left.arguments[0]);
	const isLengthCheck =
		t.isBinaryExpression(inner.right, { operator: ">" }) &&
		t.isMemberExpression(inner.right.left) &&
		getObjectKeyName(inner.right.left.property) === "length" &&
		isQueueMember(inner.right.left.object) &&
		t.isNumericLiteral(inner.right.right, { value: 0 });

	return isArrayCheck && isLengthCheck;
}

export function buildTypeaheadQueueBypass(
	test: t.Expression,
	queueHasItems: t.Expression,
): t.LogicalExpression {
	return t.logicalExpression(
		"&&",
		t.cloneNode(test, true),
		t.unaryExpression("!", queueHasItems),
	);
}

export function isStringProperty(
	node: t.Node,
	propName: string,
	value: string,
): boolean {
	return (
		t.isObjectProperty(node) &&
		getObjectKeyName(node.key) === propName &&
		t.isStringLiteral(node.value, { value })
	);
}

export function isQueuePartsUnshiftCall(
	node: t.Node,
	queueParts: t.Identifier,
): node is t.CallExpression {
	return (
		t.isCallExpression(node) &&
		t.isMemberExpression(node.callee) &&
		t.isIdentifier(node.callee.object, { name: queueParts.name }) &&
		getObjectKeyName(node.callee.property) === "unshift"
	);
}

export function isQueuePartsLengthFallback(
	node: t.Node,
	queueParts: t.Identifier,
): boolean {
	return (
		t.isBinaryExpression(node, { operator: ">" }) &&
		t.isMemberExpression(node.left) &&
		t.isIdentifier(node.left.object, { name: queueParts.name }) &&
		getObjectKeyName(node.left.property) === "length" &&
		t.isNumericLiteral(node.right, { value: 0 })
	);
}

function buildShortcutHintElement(
	react: t.Expression,
	text: t.Expression,
	shortcut: t.Expression,
	key: string,
	action: string,
): t.CallExpression {
	const shortcutElement = buildReactElementCall(
		react,
		shortcut,
		t.objectExpression([
			t.objectProperty(t.identifier("chord"), t.stringLiteral("tab")),
			t.objectProperty(t.identifier("action"), t.stringLiteral(action)),
			t.objectProperty(
				t.identifier("format"),
				t.objectExpression([
					t.objectProperty(t.identifier("keyCase"), t.stringLiteral("lower")),
				]),
			),
		]),
		[],
	);

	return buildReactElementCall(
		react,
		text,
		t.objectExpression([
			t.objectProperty(t.identifier("dimColor"), t.booleanLiteral(true)),
			t.objectProperty(t.identifier("key"), t.stringLiteral(key)),
		]),
		[shortcutElement],
	);
}

export function buildQueueHintStatement(
	queueParts: t.Identifier,
	isLoading: t.Identifier,
	isInputEmpty: t.Identifier,
	react: t.Expression,
	text: t.Expression,
	shortcut: t.Expression,
): t.IfStatement {
	return t.ifStatement(
		t.logicalExpression(
			"&&",
			t.identifier(isLoading.name),
			t.unaryExpression("!", t.identifier(isInputEmpty.name)),
		),
		t.blockStatement([
			t.expressionStatement(
				t.callExpression(
					t.memberExpression(
						t.identifier(queueParts.name),
						t.identifier("unshift"),
					),
					[
						buildShortcutHintElement(
							react,
							text,
							shortcut,
							"queue-draft",
							"queue",
						),
					],
				),
			),
		]),
	);
}

export function buildEditHintStatement(
	queueParts: t.Identifier,
	isInputEmpty: t.Identifier,
	react: t.Expression,
	text: t.Expression,
	shortcut: t.Expression,
	queueHasItems: t.Expression,
): t.IfStatement {
	return t.ifStatement(
		t.logicalExpression("&&", t.identifier(isInputEmpty.name), queueHasItems),
		t.blockStatement([
			t.expressionStatement(
				t.callExpression(
					t.memberExpression(
						t.identifier(queueParts.name),
						t.identifier("unshift"),
					),
					[
						buildShortcutHintElement(
							react,
							text,
							shortcut,
							"edit-queued-draft",
							"edit queued",
						),
					],
				),
			),
		]),
	);
}

export function buildQueuePartsFallbackCondition(
	showHint: t.Identifier,
	queueParts: t.Identifier,
): t.LogicalExpression {
	return t.logicalExpression(
		"||",
		t.identifier(showHint.name),
		t.binaryExpression(
			">",
			t.memberExpression(t.identifier(queueParts.name), t.identifier("length")),
			t.numericLiteral(0),
		),
	);
}
