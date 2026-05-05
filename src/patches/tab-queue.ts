import * as t from "@babel/types";
import { type NodePath, traverse } from "../babel.js";
import type { Patch, PatchAstPass } from "../types.js";
import {
	getObjectKeyName,
	getObjectPropertyByName,
	getVerifyAst,
} from "./ast-helpers.js";

type FunctionLike =
	| t.FunctionDeclaration
	| t.FunctionExpression
	| t.ArrowFunctionExpression;

const TAB_QUEUE_SENTINEL = "__cc_enhanced_tab_queue";
const TAB_QUEUE_GLOBAL = "__ccEnhancedTabQueue";
const DEFER_UNTIL_TURN_END_OPTION = "deferUntilTurnEnd";

interface DraftQueueTarget {
	handler: NodePath<FunctionLike>;
	keyParam: t.Identifier;
	input: t.Expression;
	loading: t.Expression;
	submit: t.Expression;
}

interface DeferredSubmitReceiverTarget {
	functionPath: NodePath<FunctionLike>;
	inputParam: t.Identifier;
	helpersParam: t.Identifier;
	optionsParam: t.Identifier;
	inputSetter: t.Expression;
	pastedSetter: t.Expression;
}

interface EndTurnDrainTarget {
	functionPath: NodePath<FunctionLike>;
	drainBlock: NodePath<t.BlockStatement>;
	enqueue: t.Expression;
}

interface HintFactories {
	react: t.Expression;
	text: t.Expression;
	shortcut: t.Expression;
}

interface FooterHintTarget {
	functionPath: NodePath<FunctionLike>;
	queueParts: t.Identifier;
	queuePartsDeclaration: NodePath<t.VariableDeclaration>;
	showHint: t.Identifier;
	isInputEmpty: t.Identifier;
	isLoading: t.Identifier;
	factories: HintFactories;
	pushIf: NodePath<t.IfStatement>;
}

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

function getMemberName(node: t.Node | null | undefined): string | null {
	if (!node) return null;
	if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
		if (t.isIdentifier(node.property)) return node.property.name;
		if (t.isStringLiteral(node.property)) return node.property.value;
	}
	return null;
}

function isMemberAccess(
	node: t.Node | null | undefined,
	objectName: string,
	propertyName: string,
): boolean {
	return (
		!!node &&
		t.isMemberExpression(node) &&
		t.isIdentifier(node.object, { name: objectName }) &&
		getMemberName(node) === propertyName
	);
}

function isCallToMember(
	node: t.Node | null | undefined,
	objectName: string,
	propertyName: string,
): node is t.CallExpression {
	return (
		!!node &&
		t.isCallExpression(node) &&
		t.isMemberExpression(node.callee) &&
		t.isIdentifier(node.callee.object, { name: objectName }) &&
		getMemberName(node.callee) === propertyName
	);
}

function isCreateElementCall(
	node: t.Node | null | undefined,
): node is t.CallExpression {
	return (
		!!node &&
		t.isCallExpression(node) &&
		t.isMemberExpression(node.callee) &&
		getMemberName(node.callee) === "createElement"
	);
}

function getParamIdentifier(
	path: NodePath<FunctionLike>,
	index: number,
): t.Identifier | null {
	const param = path.node.params[index];
	if (t.isIdentifier(param)) return param;
	if (t.isAssignmentPattern(param) && t.isIdentifier(param.left)) {
		return param.left;
	}
	return null;
}

function getObjectPropertyValue(
	object: t.ObjectExpression,
	keyName: string,
): t.Expression | null {
	const prop = getObjectPropertyByName(object, keyName);
	if (!prop || !t.isExpression(prop.value)) return null;
	return prop.value;
}

function hasObjectProperty(
	object: t.ObjectExpression,
	keyName: string,
): boolean {
	return getObjectPropertyByName(object, keyName) !== null;
}

function expressionMatches(left: t.Expression, right: t.Expression): boolean {
	if (t.isIdentifier(left) && t.isIdentifier(right)) {
		return left.name === right.name;
	}
	return false;
}

function globalQueueMember(): t.MemberExpression {
	return t.memberExpression(
		t.identifier("globalThis"),
		t.identifier(TAB_QUEUE_GLOBAL),
	);
}

function buildTrimCall(input: t.Expression): t.CallExpression {
	return t.callExpression(
		t.memberExpression(t.cloneNode(input, true), t.identifier("trim")),
		[],
	);
}

function buildGlobalQueueRead(): t.LogicalExpression {
	return t.logicalExpression(
		"??",
		globalQueueMember(),
		t.assignmentExpression("=", globalQueueMember(), t.arrayExpression([])),
	);
}

function expressionHasBooleanProp(
	node: t.Node | null | undefined,
	propName: string,
	value: boolean,
): boolean {
	return nodeContains(
		node,
		(candidate) =>
			t.isObjectProperty(candidate) &&
			getObjectKeyName(candidate.key) === propName &&
			t.isBooleanLiteral(candidate.value, { value }),
	);
}

function findFunctionBinding(
	scopePath: NodePath<t.Node>,
	name: string,
): NodePath<FunctionLike> | null {
	const binding = scopePath.scope.getBinding(name);
	if (!binding) return null;
	const bindingPath = binding.path;
	if (bindingPath.isFunctionDeclaration()) return bindingPath;
	if (bindingPath.isFunctionExpression()) return bindingPath;
	if (bindingPath.isArrowFunctionExpression()) return bindingPath;
	if (bindingPath.isVariableDeclarator()) {
		const init = bindingPath.get("init");
		if (Array.isArray(init)) return null;
		if (init?.isFunctionExpression() || init?.isArrowFunctionExpression()) {
			return init as NodePath<FunctionLike>;
		}
		if (init?.isCallExpression()) {
			const args = init.get("arguments");
			const firstArg = Array.isArray(args) ? args[0] : null;
			if (
				firstArg?.isFunctionExpression() ||
				firstArg?.isArrowFunctionExpression()
			) {
				return firstArg as NodePath<FunctionLike>;
			}
		}
	}
	return null;
}

function getFirstIdentifierParam(
	path: NodePath<FunctionLike>,
): t.Identifier | null {
	const param = path.node.params[0];
	return t.isIdentifier(param) ? param : null;
}

function getLocalObjectPatternName(
	pattern: t.ObjectPattern,
	keyName: string,
): t.Identifier | null {
	for (const prop of pattern.properties) {
		if (!t.isObjectProperty(prop)) continue;
		const key = getObjectKeyName(prop.key);
		if (key !== keyName) continue;
		if (t.isIdentifier(prop.value)) return prop.value;
	}
	return null;
}

function getFunctionObjectParam(
	path: NodePath<FunctionLike>,
): t.ObjectPattern | null {
	const param = path.node.params[0];
	return t.isObjectPattern(param) ? param : null;
}

function getInputFromSuppressHint(value: t.Expression): t.Expression | null {
	if (
		!t.isBinaryExpression(value, { operator: ">" }) ||
		!t.isNumericLiteral(value.right, { value: 0 })
	) {
		return null;
	}
	if (!t.isMemberExpression(value.left)) return null;
	if (getMemberName(value.left) !== "length") return null;
	return t.isExpression(value.left.object) ? value.left.object : null;
}

function findDraftState(functionNode: FunctionLike): {
	input: t.Expression;
	loading: t.Expression;
} | null {
	const matches: Array<{ input: t.Expression; loading: t.Expression }> = [];

	traverse(
		functionNode,
		{
			noScope: true,
			Function(path) {
				if (path.node !== functionNode) path.skip();
			},
			ObjectExpression(path) {
				const suppressHint = getObjectPropertyValue(path.node, "suppressHint");
				const isLoading = getObjectPropertyValue(path.node, "isLoading");
				if (!suppressHint || !isLoading) return;
				const input = getInputFromSuppressHint(suppressHint);
				if (!input) return;
				matches.push({ input, loading: isLoading });
			},
		},
		undefined,
		undefined,
	);

	return matches.length === 1 ? matches[0] : null;
}

function isInputConfigObject(object: t.ObjectExpression): boolean {
	return (
		hasObjectProperty(object, "onKeyDownBefore") &&
		hasObjectProperty(object, "onSubmit") &&
		hasObjectProperty(object, "onChange") &&
		hasObjectProperty(object, "value") &&
		hasObjectProperty(object, "disableEscapeDoublePress") &&
		hasObjectProperty(object, "inputFilter")
	);
}

function findNearestFunction(
	path: NodePath<t.Node>,
): NodePath<FunctionLike> | null {
	const parent = path.findParent((candidate) => candidate.isFunction());
	if (
		parent?.isFunctionDeclaration() ||
		parent?.isFunctionExpression() ||
		parent?.isArrowFunctionExpression()
	) {
		return parent as NodePath<FunctionLike>;
	}
	return null;
}

function getDraftQueueTarget(
	path: NodePath<t.ObjectExpression>,
): DraftQueueTarget | null {
	if (!isInputConfigObject(path.node)) return null;

	const handlerExpr = getObjectPropertyValue(path.node, "onKeyDownBefore");
	const submitExpr = getObjectPropertyValue(path.node, "onSubmit");
	if (!t.isIdentifier(handlerExpr) || !submitExpr) return null;

	const ownerFunction = findNearestFunction(path);
	if (!ownerFunction) return null;

	const draftState = findDraftState(ownerFunction.node);
	if (!draftState) return null;

	const handler = findFunctionBinding(path, handlerExpr.name);
	if (!handler) return null;
	const keyParam = getFirstIdentifierParam(handler);
	if (!keyParam) return null;

	return {
		handler,
		keyParam,
		input: draftState.input,
		loading: draftState.loading,
		submit: submitExpr,
	};
}

function isPreventedGuardStatement(
	stmt: t.Statement,
	keyParamName: string,
): stmt is t.IfStatement {
	if (!t.isIfStatement(stmt)) return false;
	return (
		nodeContains(stmt.test, (node) =>
			isMemberAccess(node, keyParamName, "defaultPrevented"),
		) &&
		nodeContains(stmt.test, (node) =>
			isCallToMember(node, keyParamName, "didStopImmediatePropagation"),
		)
	);
}

function findInsertionIndex(
	handler: NodePath<FunctionLike>,
	keyParamName: string,
): number {
	if (!t.isBlockStatement(handler.node.body)) return -1;
	let lastGuardIndex = -1;
	for (const [index, stmt] of handler.node.body.body.entries()) {
		if (isPreventedGuardStatement(stmt, keyParamName)) {
			lastGuardIndex = index;
			continue;
		}
		if (lastGuardIndex !== -1) break;
	}
	return lastGuardIndex;
}

function hasTabQueueGuard(target: DraftQueueTarget): boolean {
	const { handler, keyParam, input, loading, submit } = target;
	if (!t.isBlockStatement(handler.node.body)) return false;

	return handler.node.body.body.some((stmt) => {
		if (!t.isIfStatement(stmt)) return false;
		const test = stmt.test;
		const hasTabCheck = nodeContains(
			test,
			(node) =>
				t.isBinaryExpression(node, { operator: "===" }) &&
				isMemberAccess(node.left, keyParam.name, "name") &&
				t.isStringLiteral(node.right, { value: "tab" }),
		);
		if (!hasTabCheck) return false;

		const blocksModifiedTab = ["shift", "ctrl", "meta"].every((prop) =>
			nodeContains(
				test,
				(node) =>
					t.isUnaryExpression(node, { operator: "!" }) &&
					isMemberAccess(node.argument, keyParam.name, prop),
			),
		);
		if (!blocksModifiedTab) return false;

		if (
			!nodeContains(test, (node) =>
				expressionMatches(node as t.Expression, loading),
			)
		) {
			return false;
		}
		const checksInput = nodeContains(
			test,
			(node) =>
				t.isCallExpression(node) &&
				t.isMemberExpression(node.callee) &&
				getMemberName(node.callee) === "trim" &&
				t.isExpression(node.callee.object) &&
				expressionMatches(node.callee.object, input),
		);
		if (!checksInput) return false;

		return (
			nodeContains(stmt.consequent, (node) =>
				isCallToMember(node, keyParam.name, "preventDefault"),
			) &&
			nodeContains(
				stmt.consequent,
				(node) =>
					t.isCallExpression(node) &&
					t.isExpression(node.callee) &&
					expressionMatches(node.callee, submit) &&
					node.arguments.some(
						(arg) => t.isExpression(arg) && expressionMatches(arg, input),
					) &&
					node.arguments.some((arg) =>
						t.isStringLiteral(arg, { value: TAB_QUEUE_SENTINEL }),
					),
			)
		);
	});
}

function buildTabQueueGuard(target: DraftQueueTarget): t.IfStatement {
	const key = t.identifier(target.keyParam.name);
	const input = t.cloneNode(target.input, true);
	const loading = t.cloneNode(target.loading, true);
	const submit = t.cloneNode(target.submit, true);

	return t.ifStatement(
		t.logicalExpression(
			"&&",
			t.logicalExpression(
				"&&",
				t.logicalExpression(
					"&&",
					t.logicalExpression(
						"&&",
						t.logicalExpression(
							"&&",
							t.binaryExpression(
								"===",
								t.memberExpression(t.cloneNode(key), t.identifier("name")),
								t.stringLiteral("tab"),
							),
							t.unaryExpression(
								"!",
								t.memberExpression(t.cloneNode(key), t.identifier("shift")),
							),
						),
						t.unaryExpression(
							"!",
							t.memberExpression(t.cloneNode(key), t.identifier("ctrl")),
						),
					),
					t.unaryExpression(
						"!",
						t.memberExpression(t.cloneNode(key), t.identifier("meta")),
					),
				),
				loading,
			),
			t.binaryExpression(
				"!==",
				t.callExpression(t.memberExpression(input, t.identifier("trim")), []),
				t.stringLiteral(""),
			),
		),
		t.blockStatement([
			t.expressionStatement(
				t.callExpression(
					t.memberExpression(t.cloneNode(key), t.identifier("preventDefault")),
					[],
				),
			),
			t.expressionStatement(
				t.callExpression(submit, [
					t.cloneNode(target.input, true),
					t.stringLiteral(TAB_QUEUE_SENTINEL),
				]),
			),
			t.returnStatement(),
		]),
	);
}

function patchTabQueueTarget(target: DraftQueueTarget): boolean {
	if (hasTabQueueGuard(target)) return true;
	if (!t.isBlockStatement(target.handler.node.body)) return false;

	const insertionIndex = findInsertionIndex(
		target.handler,
		target.keyParam.name,
	);
	if (insertionIndex === -1) return false;

	target.handler.node.body.body.splice(
		insertionIndex + 1,
		0,
		buildTabQueueGuard(target),
	);
	return true;
}

function getSubmitForwardFunction(
	target: DraftQueueTarget,
): NodePath<FunctionLike> | null {
	if (!t.isIdentifier(target.submit)) return null;
	return findFunctionBinding(target.handler, target.submit.name);
}

function isPromptSubmitForwardCall(
	node: t.CallExpression,
	inputParam: t.Identifier,
): boolean {
	if (node.arguments.length < 2) return false;
	const [inputArg, helpersArg] = node.arguments;
	return (
		t.isExpression(inputArg) &&
		expressionMatches(inputArg, inputParam) &&
		t.isObjectExpression(helpersArg) &&
		hasObjectProperty(helpersArg, "setCursorOffset") &&
		hasObjectProperty(helpersArg, "clearBuffer") &&
		hasObjectProperty(helpersArg, "resetHistory")
	);
}

function hasSubmitForwardDeferOption(target: DraftQueueTarget): boolean {
	const submitFunction = getSubmitForwardFunction(target);
	if (!submitFunction) return false;
	const inputParam = getFirstIdentifierParam(submitFunction);
	if (!inputParam) return false;

	let found = false;
	submitFunction.traverse({
		Function(path) {
			if (path.node !== submitFunction.node) path.skip();
		},
		CallExpression(path) {
			if (found || !isPromptSubmitForwardCall(path.node, inputParam)) return;
			if (
				expressionHasStringProp(path.node, "value", TAB_QUEUE_SENTINEL) ||
				expressionHasBooleanProp(path.node, DEFER_UNTIL_TURN_END_OPTION, true)
			) {
				found = true;
			}
		},
	});
	return found;
}

function patchSubmitForward(target: DraftQueueTarget): boolean {
	if (hasSubmitForwardDeferOption(target)) return true;
	const submitFunction = getSubmitForwardFunction(target);
	if (!submitFunction) return false;
	const inputParam = getFirstIdentifierParam(submitFunction);
	const queueFlagParam = getParamIdentifier(submitFunction, 1);
	if (!inputParam || !queueFlagParam) return false;

	let patched = false;
	submitFunction.traverse({
		Function(path) {
			if (path.node !== submitFunction.node) path.skip();
		},
		CallExpression(path) {
			if (patched || !isPromptSubmitForwardCall(path.node, inputParam)) return;
			while (path.node.arguments.length < 3) {
				path.node.arguments.push(
					t.unaryExpression("void", t.numericLiteral(0)),
				);
			}
			path.node.arguments[3] = t.conditionalExpression(
				t.binaryExpression(
					"===",
					t.identifier(queueFlagParam.name),
					t.stringLiteral(TAB_QUEUE_SENTINEL),
				),
				t.objectExpression([
					t.objectProperty(
						t.identifier(DEFER_UNTIL_TURN_END_OPTION),
						t.booleanLiteral(true),
					),
				]),
				t.unaryExpression("void", t.numericLiteral(0)),
			);
			patched = true;
		},
	});
	return patched;
}

function isDeferredSubmitReceiverConfig(object: t.ObjectExpression): boolean {
	return (
		hasObjectProperty(object, "input") &&
		hasObjectProperty(object, "helpers") &&
		hasObjectProperty(object, "queryGuard") &&
		hasObjectProperty(object, "isExternalLoading") &&
		hasObjectProperty(object, "mode") &&
		hasObjectProperty(object, "onInputChange") &&
		hasObjectProperty(object, "setPastedContents") &&
		hasObjectProperty(object, "onQuery") &&
		hasObjectProperty(object, "setMessages")
	);
}

function getDeferredSubmitReceiverTarget(
	path: NodePath<t.ObjectExpression>,
): DeferredSubmitReceiverTarget | null {
	if (!isDeferredSubmitReceiverConfig(path.node)) return null;
	const functionPath = findNearestFunction(path);
	if (!functionPath || !t.isBlockStatement(functionPath.node.body)) return null;

	const inputParam = getParamIdentifier(functionPath, 0);
	const helpersParam = getParamIdentifier(functionPath, 1);
	const optionsParam = getParamIdentifier(functionPath, 3);
	if (!inputParam || !helpersParam || !optionsParam) return null;

	const inputExpr = getObjectPropertyValue(path.node, "input");
	const helpersExpr = getObjectPropertyValue(path.node, "helpers");
	const inputSetter = getObjectPropertyValue(path.node, "onInputChange");
	const pastedSetter = getObjectPropertyValue(path.node, "setPastedContents");
	if (
		!inputExpr ||
		!helpersExpr ||
		!inputSetter ||
		!pastedSetter ||
		!expressionMatches(inputExpr, inputParam) ||
		!expressionMatches(helpersExpr, helpersParam)
	) {
		return null;
	}

	return {
		functionPath,
		inputParam,
		helpersParam,
		optionsParam,
		inputSetter,
		pastedSetter,
	};
}

function hasDeferredSubmitReceiver(
	target: DeferredSubmitReceiverTarget,
): boolean {
	return nodeContains(target.functionPath.node, (node) => {
		if (
			t.isMemberExpression(node) &&
			t.isIdentifier(node.object, { name: "globalThis" }) &&
			getMemberName(node) === TAB_QUEUE_GLOBAL
		) {
			return true;
		}
		return expressionHasBooleanProp(node, DEFER_UNTIL_TURN_END_OPTION, true);
	});
}

function buildDeferredSubmitReceiverStatement(
	target: DeferredSubmitReceiverTarget,
): t.IfStatement {
	const input = t.identifier(target.inputParam.name);
	const helpers = t.identifier(target.helpersParam.name);
	const options = t.identifier(target.optionsParam.name);

	return t.ifStatement(
		t.logicalExpression(
			"&&",
			t.logicalExpression(
				"&&",
				options,
				t.memberExpression(
					t.cloneNode(options),
					t.identifier(DEFER_UNTIL_TURN_END_OPTION),
				),
			),
			t.binaryExpression("!==", buildTrimCall(input), t.stringLiteral("")),
		),
		t.blockStatement([
			t.expressionStatement(
				t.callExpression(
					t.memberExpression(buildGlobalQueueRead(), t.identifier("push")),
					[buildTrimCall(input)],
				),
			),
			t.expressionStatement(
				t.callExpression(t.cloneNode(target.inputSetter, true), [
					t.stringLiteral(""),
				]),
			),
			t.expressionStatement(
				t.callExpression(
					t.memberExpression(
						t.cloneNode(helpers),
						t.identifier("setCursorOffset"),
					),
					[t.numericLiteral(0)],
				),
			),
			t.expressionStatement(
				t.callExpression(t.cloneNode(target.pastedSetter, true), [
					t.objectExpression([]),
				]),
			),
			t.expressionStatement(
				t.callExpression(
					t.memberExpression(t.cloneNode(helpers), t.identifier("clearBuffer")),
					[],
				),
			),
			t.returnStatement(),
		]),
	);
}

function patchDeferredSubmitReceiver(
	target: DeferredSubmitReceiverTarget,
): boolean {
	if (hasDeferredSubmitReceiver(target)) return true;
	if (!t.isBlockStatement(target.functionPath.node.body)) return false;
	target.functionPath.node.body.body.unshift(
		buildDeferredSubmitReceiverStatement(target),
	);
	return true;
}

function findEndTurnDrainBlock(
	path: NodePath<FunctionLike>,
): NodePath<t.BlockStatement> | null {
	let drainBlock: NodePath<t.BlockStatement> | null = null;
	path.traverse({
		Function(inner) {
			if (inner.node !== path.node) inner.skip();
		},
		IfStatement(inner) {
			if (drainBlock) return;
			if (
				nodeContains(
					inner.node.test,
					(node) =>
						t.isCallExpression(node) &&
						t.isMemberExpression(node.callee) &&
						getMemberName(node.callee) === "end",
				) &&
				t.isBlockStatement(inner.node.consequent)
			) {
				const consequent = inner.get("consequent");
				if (consequent.isBlockStatement()) drainBlock = consequent;
			}
		},
	});

	return drainBlock;
}

function getPromptQueueCalleeFromBranch(
	path: NodePath<t.IfStatement>,
): t.Expression | null {
	let enqueue: t.Expression | null = null;
	path.traverse({
		Function(inner) {
			inner.skip();
		},
		CallExpression(candidate) {
			if (enqueue) return;
			const arg = candidate.node.arguments[0];
			if (!t.isObjectExpression(arg)) return;
			const mode = getObjectPropertyValue(arg, "mode");
			if (!t.isStringLiteral(mode, { value: "prompt" })) return;
			if (!hasObjectProperty(arg, "value")) return;
			if (t.isExpression(candidate.node.callee)) {
				enqueue = candidate.node.callee;
			}
		},
	});
	return enqueue;
}

function getTryStartGenerationName(
	functionPath: NodePath<FunctionLike>,
): string | null {
	let name: string | null = null;
	functionPath.traverse({
		Function(path) {
			if (path.node !== functionPath.node) path.skip();
		},
		VariableDeclarator(path) {
			if (name || !t.isIdentifier(path.node.id)) return;
			const init = path.node.init;
			if (
				t.isCallExpression(init) &&
				t.isMemberExpression(init.callee) &&
				getMemberName(init.callee) === "tryStart"
			) {
				name = path.node.id.name;
			}
		},
	});
	return name;
}

function getEnqueueCallFromConcurrentBranch(
	functionPath: NodePath<FunctionLike>,
): t.Expression | null {
	let enqueue: t.Expression | null = null;
	const generationName = getTryStartGenerationName(functionPath);
	if (!generationName) return null;

	functionPath.traverse({
		Function(path) {
			if (path.node !== functionPath.node) path.skip();
		},
		IfStatement(path) {
			if (enqueue) return;
			const branchEnqueue = getPromptQueueCalleeFromBranch(path);
			if (!branchEnqueue) return;
			const usesGeneration = nodeContains(path.node.test, (node) =>
				t.isIdentifier(node, { name: generationName }),
			);
			const handlesNullStart = nodeContains(
				path.node.test,
				(node) =>
					t.isBinaryExpression(node) &&
					["===", "=="].includes(node.operator) &&
					(t.isNullLiteral(node.left) || t.isNullLiteral(node.right)),
			);
			if (usesGeneration && handlesNullStart) enqueue = branchEnqueue;
		},
	});
	return enqueue;
}

function getEndTurnDrainTarget(
	path: NodePath<FunctionLike>,
): EndTurnDrainTarget | null {
	const drainBlock = findEndTurnDrainBlock(path);
	if (!drainBlock) return null;
	const enqueue = getEnqueueCallFromConcurrentBranch(path);
	if (!enqueue) return null;

	return { functionPath: path, drainBlock, enqueue };
}

function hasEndTurnDrain(target: EndTurnDrainTarget): boolean {
	return nodeContains(
		target.drainBlock.node,
		(node) =>
			t.isMemberExpression(node) &&
			t.isIdentifier(node.object, { name: "globalThis" }) &&
			getMemberName(node) === TAB_QUEUE_GLOBAL,
	);
}

function buildEndTurnDrainStatement(
	target: EndTurnDrainTarget,
): t.BlockStatement {
	const queueId = t.identifier("__ccTabQueue");
	const queuedInputId = t.identifier("__ccQueuedInput");

	return t.blockStatement([
		t.variableDeclaration("let", [
			t.variableDeclarator(queueId, globalQueueMember()),
		]),
		t.ifStatement(
			t.logicalExpression(
				"&&",
				t.callExpression(
					t.memberExpression(t.identifier("Array"), t.identifier("isArray")),
					[t.cloneNode(queueId)],
				),
				t.binaryExpression(
					">",
					t.memberExpression(t.cloneNode(queueId), t.identifier("length")),
					t.numericLiteral(0),
				),
			),
			t.blockStatement([
				t.variableDeclaration("let", [
					t.variableDeclarator(
						queuedInputId,
						t.callExpression(
							t.memberExpression(t.cloneNode(queueId), t.identifier("shift")),
							[],
						),
					),
				]),
				t.ifStatement(
					t.logicalExpression(
						"&&",
						t.binaryExpression(
							"===",
							t.unaryExpression("typeof", t.cloneNode(queuedInputId)),
							t.stringLiteral("string"),
						),
						t.binaryExpression(
							"!==",
							buildTrimCall(t.cloneNode(queuedInputId)),
							t.stringLiteral(""),
						),
					),
					t.blockStatement([
						t.expressionStatement(
							t.callExpression(t.cloneNode(target.enqueue, true), [
								t.objectExpression([
									t.objectProperty(
										t.identifier("value"),
										t.cloneNode(queuedInputId),
									),
									t.objectProperty(
										t.identifier("mode"),
										t.stringLiteral("prompt"),
									),
								]),
							]),
						),
					]),
				),
			]),
		),
	]);
}

function patchEndTurnDrainTarget(target: EndTurnDrainTarget): boolean {
	if (hasEndTurnDrain(target)) return true;
	target.drainBlock.node.body.push(buildEndTurnDrainStatement(target));
	return true;
}

function expressionHasStringProp(
	node: t.Node | null | undefined,
	propName: string,
	value: string,
): boolean {
	return nodeContains(
		node,
		(candidate) =>
			t.isObjectProperty(candidate) &&
			getObjectKeyName(candidate.key) === propName &&
			t.isStringLiteral(candidate.value, { value }),
	);
}

function findQueueFactories(functionNode: FunctionLike): HintFactories | null {
	let factories: HintFactories | null = null;

	traverse(
		functionNode,
		{
			noScope: true,
			Function(path) {
				if (path.node !== functionNode) path.skip();
			},
			CallExpression(path) {
				if (factories || !isCreateElementCall(path.node)) return;
				if (
					!expressionHasStringProp(path.node, "action", "return to team lead")
				) {
					return;
				}
				const shortcutCall = path.node.arguments.find(
					(arg): arg is t.CallExpression =>
						t.isCallExpression(arg) &&
						isCreateElementCall(arg) &&
						expressionHasStringProp(arg, "action", "return to team lead"),
				);
				if (!shortcutCall) return;
				const callee = path.node.callee;
				if (!t.isMemberExpression(callee) || !t.isExpression(callee.object)) {
					return;
				}
				const text = path.node.arguments[0];
				const shortcut = shortcutCall.arguments[0];
				if (!t.isExpression(text) || !t.isExpression(shortcut)) return;

				factories = {
					react: callee.object,
					text,
					shortcut,
				};
			},
		},
		undefined,
		undefined,
	);

	return factories;
}

function getQueuePartsDeclarator(
	functionPath: NodePath<FunctionLike>,
	showHint: t.Identifier,
): {
	queueParts: t.Identifier;
	declaration: NodePath<t.VariableDeclaration>;
} | null {
	let result: {
		queueParts: t.Identifier;
		declaration: NodePath<t.VariableDeclaration>;
	} | null = null;

	functionPath.traverse({
		Function(path) {
			if (path.node !== functionPath.node) path.skip();
		},
		VariableDeclarator(path) {
			if (result || !t.isIdentifier(path.node.id)) return;
			const init = path.node.init;
			if (!t.isConditionalExpression(init)) return;
			if (!t.isIdentifier(init.test, { name: showHint.name })) return;
			if (
				!t.isArrayExpression(init.alternate) ||
				init.alternate.elements.length !== 0
			) {
				return;
			}
			if (!t.isCallExpression(init.consequent)) return;
			const declaration = path.parentPath;
			if (!declaration.isVariableDeclaration()) return;
			result = { queueParts: path.node.id, declaration };
		},
	});

	return result;
}

function getSpreadPushIf(
	functionPath: NodePath<FunctionLike>,
	showHint: t.Identifier,
	queueParts: t.Identifier,
): NodePath<t.IfStatement> | null {
	let result: NodePath<t.IfStatement> | null = null;
	functionPath.traverse({
		Function(path) {
			if (path.node !== functionPath.node) path.skip();
		},
		IfStatement(path) {
			if (result) return;
			if (
				!nodeContains(
					path.node.consequent,
					(node) =>
						t.isSpreadElement(node) &&
						t.isIdentifier(node.argument, { name: queueParts.name }),
				)
			) {
				return;
			}
			if (
				!nodeContains(path.node.test, (node) =>
					t.isIdentifier(node, { name: showHint.name }),
				)
			) {
				return;
			}
			result = path;
		},
	});
	return result;
}

function getFooterHintTarget(
	path: NodePath<FunctionLike>,
): FooterHintTarget | null {
	const pattern = getFunctionObjectParam(path);
	if (!pattern) return null;

	const showHint = getLocalObjectPatternName(pattern, "showHint");
	const isInputEmpty = getLocalObjectPatternName(pattern, "isInputEmpty");
	const isLoading = getLocalObjectPatternName(pattern, "isLoading");
	if (!showHint || !isInputEmpty || !isLoading) return null;

	const queuePartsResult = getQueuePartsDeclarator(path, showHint);
	if (!queuePartsResult) return null;
	const pushIf = getSpreadPushIf(path, showHint, queuePartsResult.queueParts);
	if (!pushIf) return null;
	const factories = findQueueFactories(path.node);
	if (!factories) return null;

	return {
		functionPath: path,
		queueParts: queuePartsResult.queueParts,
		queuePartsDeclaration: queuePartsResult.declaration,
		showHint,
		isInputEmpty,
		isLoading,
		factories,
		pushIf,
	};
}

function hasQueueHint(target: FooterHintTarget): boolean {
	return nodeContains(
		target.functionPath.node,
		(node) =>
			t.isCallExpression(node) &&
			t.isMemberExpression(node.callee) &&
			t.isIdentifier(node.callee.object, { name: target.queueParts.name }) &&
			getMemberName(node.callee) === "unshift" &&
			expressionHasStringProp(node, "key", "queue-draft") &&
			expressionHasStringProp(node, "chord", "tab") &&
			expressionHasStringProp(node, "action", "queue"),
	);
}

function hasQueuePartsLengthFallback(target: FooterHintTarget): boolean {
	return nodeContains(
		target.pushIf.node.test,
		(node) =>
			t.isBinaryExpression(node, { operator: ">" }) &&
			t.isMemberExpression(node.left) &&
			t.isIdentifier(node.left.object, { name: target.queueParts.name }) &&
			getMemberName(node.left) === "length" &&
			t.isNumericLiteral(node.right, { value: 0 }),
	);
}

function buildQueueHintElement(target: FooterHintTarget): t.CallExpression {
	const react = t.cloneNode(target.factories.react, true);
	const text = t.cloneNode(target.factories.text, true);
	const shortcut = t.cloneNode(target.factories.shortcut, true);

	return t.callExpression(
		t.memberExpression(react, t.identifier("createElement")),
		[
			text,
			t.objectExpression([
				t.objectProperty(t.identifier("dimColor"), t.booleanLiteral(true)),
				t.objectProperty(t.identifier("key"), t.stringLiteral("queue-draft")),
			]),
			t.callExpression(
				t.memberExpression(
					t.cloneNode(target.factories.react, true),
					t.identifier("createElement"),
				),
				[
					shortcut,
					t.objectExpression([
						t.objectProperty(t.identifier("chord"), t.stringLiteral("tab")),
						t.objectProperty(t.identifier("action"), t.stringLiteral("queue")),
						t.objectProperty(
							t.identifier("format"),
							t.objectExpression([
								t.objectProperty(
									t.identifier("keyCase"),
									t.stringLiteral("lower"),
								),
							]),
						),
					]),
				],
			),
		],
	);
}

function buildQueueHintStatement(target: FooterHintTarget): t.IfStatement {
	return t.ifStatement(
		t.logicalExpression(
			"&&",
			t.identifier(target.isLoading.name),
			t.unaryExpression("!", t.identifier(target.isInputEmpty.name)),
		),
		t.blockStatement([
			t.expressionStatement(
				t.callExpression(
					t.memberExpression(
						t.identifier(target.queueParts.name),
						t.identifier("unshift"),
					),
					[buildQueueHintElement(target)],
				),
			),
		]),
	);
}

function patchPushCondition(target: FooterHintTarget): boolean {
	if (hasQueuePartsLengthFallback(target)) return true;

	const test = target.pushIf.node.test;
	if (
		t.isLogicalExpression(test, { operator: "&&" }) &&
		t.isIdentifier(test.right, { name: target.showHint.name })
	) {
		target.pushIf.node.test = t.logicalExpression(
			"&&",
			t.cloneNode(test.left, true),
			t.logicalExpression(
				"||",
				t.identifier(target.showHint.name),
				t.binaryExpression(
					">",
					t.memberExpression(
						t.identifier(target.queueParts.name),
						t.identifier("length"),
					),
					t.numericLiteral(0),
				),
			),
		);
		return true;
	}

	return false;
}

function patchFooterHintTarget(target: FooterHintTarget): boolean {
	const hintReady = hasQueueHint(target);
	if (!hintReady) {
		target.queuePartsDeclaration.insertAfter(buildQueueHintStatement(target));
	}
	return patchPushCondition(target);
}

function createTabQueuePasses(): PatchAstPass[] {
	const draftTargets: DraftQueueTarget[] = [];
	const receiverTargets: DeferredSubmitReceiverTarget[] = [];
	const drainTargets: EndTurnDrainTarget[] = [];
	const footerTargets: FooterHintTarget[] = [];
	let patchedDraft = false;
	let patchedSubmitForward = false;
	let patchedReceiver = false;
	let patchedDrain = false;
	let patchedFooter = false;

	return [
		{
			pass: "discover",
			visitor: {
				ObjectExpression(path) {
					const target = getDraftQueueTarget(path);
					if (target) draftTargets.push(target);
					const receiverTarget = getDeferredSubmitReceiverTarget(path);
					if (receiverTarget) receiverTargets.push(receiverTarget);
				},
				FunctionDeclaration(path) {
					const drainTarget = getEndTurnDrainTarget(path);
					if (drainTarget) drainTargets.push(drainTarget);
					const target = getFooterHintTarget(path);
					if (target) footerTargets.push(target);
				},
				FunctionExpression(path) {
					const drainTarget = getEndTurnDrainTarget(path);
					if (drainTarget) drainTargets.push(drainTarget);
					const target = getFooterHintTarget(path);
					if (target) footerTargets.push(target);
				},
				ArrowFunctionExpression(path) {
					const drainTarget = getEndTurnDrainTarget(path);
					if (drainTarget) drainTargets.push(drainTarget);
					const target = getFooterHintTarget(path);
					if (target) footerTargets.push(target);
				},
			},
		},
		{
			pass: "mutate",
			visitor: {
				Program: {
					exit() {
						const uniqueDraftTargets = Array.from(new Set(draftTargets));
						const uniqueReceiverTargets = Array.from(new Set(receiverTargets));
						const uniqueDrainTargets = Array.from(new Set(drainTargets));
						const uniqueFooterTargets = Array.from(new Set(footerTargets));
						if (uniqueDraftTargets.length === 1) {
							patchedDraft = patchTabQueueTarget(uniqueDraftTargets[0]);
							patchedSubmitForward = patchSubmitForward(uniqueDraftTargets[0]);
						}
						if (uniqueReceiverTargets.length === 1) {
							patchedReceiver = patchDeferredSubmitReceiver(
								uniqueReceiverTargets[0],
							);
						}
						if (uniqueDrainTargets.length === 1) {
							patchedDrain = patchEndTurnDrainTarget(uniqueDrainTargets[0]);
						}
						if (uniqueFooterTargets.length === 1) {
							patchedFooter = patchFooterHintTarget(uniqueFooterTargets[0]);
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
						const uniqueDraftTargets = Array.from(new Set(draftTargets));
						const uniqueReceiverTargets = Array.from(new Set(receiverTargets));
						const uniqueDrainTargets = Array.from(new Set(drainTargets));
						const uniqueFooterTargets = Array.from(new Set(footerTargets));
						if (
							uniqueDraftTargets.length !== 1 ||
							!patchedDraft ||
							!patchedSubmitForward
						) {
							console.warn(
								`Tab queue: expected one draft key handler target, found ${uniqueDraftTargets.length}`,
							);
						}
						if (uniqueReceiverTargets.length !== 1 || !patchedReceiver) {
							console.warn(
								`Tab queue: expected one deferred submit receiver target, found ${uniqueReceiverTargets.length}`,
							);
						}
						if (uniqueDrainTargets.length !== 1 || !patchedDrain) {
							console.warn(
								`Tab queue: expected one end-turn drain target, found ${uniqueDrainTargets.length}`,
							);
						}
						if (uniqueFooterTargets.length !== 1 || !patchedFooter) {
							console.warn(
								`Tab queue: expected one footer hint target, found ${uniqueFooterTargets.length}`,
							);
						}
					},
				},
			},
		},
	];
}

function countVerifiedDraftTargets(ast: t.File): number {
	let count = 0;
	traverse(ast, {
		ObjectExpression(path) {
			const target = getDraftQueueTarget(path);
			if (
				target &&
				hasTabQueueGuard(target) &&
				hasSubmitForwardDeferOption(target)
			) {
				count++;
			}
		},
	});
	return count;
}

function countVerifiedDeferredSubmitReceivers(ast: t.File): number {
	let count = 0;
	traverse(ast, {
		ObjectExpression(path) {
			const target = getDeferredSubmitReceiverTarget(path);
			if (target && hasDeferredSubmitReceiver(target)) count++;
		},
	});
	return count;
}

function countVerifiedEndTurnDrains(ast: t.File): number {
	let count = 0;
	traverse(ast, {
		FunctionDeclaration(path) {
			const target = getEndTurnDrainTarget(path);
			if (target && hasEndTurnDrain(target)) count++;
		},
		FunctionExpression(path) {
			const target = getEndTurnDrainTarget(path);
			if (target && hasEndTurnDrain(target)) count++;
		},
		ArrowFunctionExpression(path) {
			const target = getEndTurnDrainTarget(path);
			if (target && hasEndTurnDrain(target)) count++;
		},
	});
	return count;
}

function countVerifiedFooterTargets(ast: t.File): number {
	let count = 0;
	traverse(ast, {
		FunctionDeclaration(path) {
			const target = getFooterHintTarget(path);
			if (
				target &&
				hasQueueHint(target) &&
				hasQueuePartsLengthFallback(target)
			) {
				count++;
			}
		},
		FunctionExpression(path) {
			const target = getFooterHintTarget(path);
			if (
				target &&
				hasQueueHint(target) &&
				hasQueuePartsLengthFallback(target)
			) {
				count++;
			}
		},
		ArrowFunctionExpression(path) {
			const target = getFooterHintTarget(path);
			if (
				target &&
				hasQueueHint(target) &&
				hasQueuePartsLengthFallback(target)
			) {
				count++;
			}
		},
	});
	return count;
}

export const tabQueue: Patch = {
	tag: "tab-queue",

	astPasses: () => createTabQueuePasses(),

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) return "Unable to parse AST during tab-queue verification";

		const draftTargetCount = countVerifiedDraftTargets(verifyAst);
		if (draftTargetCount === 0) {
			return "Draft Tab queue key handler not found";
		}
		if (draftTargetCount > 1) {
			return `Draft Tab queue key handler is ambiguous (${draftTargetCount} handlers found)`;
		}

		const receiverTargetCount = countVerifiedDeferredSubmitReceivers(verifyAst);
		if (receiverTargetCount === 0) {
			return "Deferred Tab queue submit receiver not found";
		}
		if (receiverTargetCount > 1) {
			return `Deferred Tab queue submit receiver is ambiguous (${receiverTargetCount} receivers found)`;
		}

		const drainTargetCount = countVerifiedEndTurnDrains(verifyAst);
		if (drainTargetCount === 0) {
			return "Deferred Tab queue end-turn drain not found";
		}
		if (drainTargetCount > 1) {
			return `Deferred Tab queue end-turn drain is ambiguous (${drainTargetCount} drains found)`;
		}

		const footerTargetCount = countVerifiedFooterTargets(verifyAst);
		if (footerTargetCount === 0) {
			return "Draft Tab queue footer hint not found";
		}
		if (footerTargetCount > 1) {
			return `Draft Tab queue footer hint is ambiguous (${footerTargetCount} hints found)`;
		}

		return true;
	},
};
