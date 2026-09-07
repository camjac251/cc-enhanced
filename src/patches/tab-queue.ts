import * as t from "@babel/types";
import { type NodePath, traverse } from "../babel.js";
import type { Patch, PatchAstPass } from "../types.js";
import { getObjectPropertyByName, getVerifyAst } from "./ast-helpers.js";

type FunctionLike =
	| t.FunctionDeclaration
	| t.FunctionExpression
	| t.ArrowFunctionExpression;
interface NativeQueueTarget {
	handler: NodePath<FunctionLike>;
	key: t.Identifier;
	input: t.MemberExpression;
	loading: t.Expression;
	submit: t.Identifier;
	gestureSpent: t.Identifier;
	suggestions: t.Identifier;
	ghostText: t.Expression;
	editQueued: t.Identifier;
}
function property(
	object: t.ObjectExpression,
	name: string,
): t.Expression | null {
	const value = getObjectPropertyByName(object, name)?.value;
	return t.isExpression(value) ? value : null;
}
function memberName(node: t.Node): string | null {
	if (!t.isMemberExpression(node) && !t.isOptionalMemberExpression(node))
		return null;
	if (!node.computed && t.isIdentifier(node.property))
		return node.property.name;
	return t.isStringLiteral(node.property) ? node.property.value : null;
}
function contains(node: t.Node, predicate: (node: t.Node) => boolean): boolean {
	let found = false;
	t.traverseFast(node, (candidate) => {
		if (!found && predicate(candidate)) found = true;
	});
	return found;
}
function bindingFunction(
	path: NodePath<t.Node>,
	name: string,
): NodePath<FunctionLike> | null {
	const binding = path.scope.getBinding(name)?.path;
	if (!binding) return null;
	if (
		binding.isFunctionDeclaration() ||
		binding.isFunctionExpression() ||
		binding.isArrowFunctionExpression()
	)
		return binding;
	if (!binding.isVariableDeclarator()) return null;
	const init = binding.get("init");
	if (init.isFunctionExpression() || init.isArrowFunctionExpression())
		return init;
	if (init.isCallExpression()) {
		const first = init.get("arguments")[0];
		if (first?.isFunctionExpression() || first?.isArrowFunctionExpression())
			return first;
	}
	return null;
}
function patternBinding(
	pattern: t.ObjectPattern,
	key: string,
): t.Identifier | null {
	for (const entry of pattern.properties) {
		if (!t.isObjectProperty(entry)) continue;
		const name = t.isIdentifier(entry.key)
			? entry.key.name
			: t.isStringLiteral(entry.key)
				? entry.key.value
				: null;
		if (name !== key) continue;
		const value = t.isAssignmentPattern(entry.value)
			? entry.value.left
			: entry.value;
		return t.isIdentifier(value) ? value : null;
	}
	return null;
}
function discoverTarget(
	path: NodePath<t.ObjectExpression>,
): NativeQueueTarget | null {
	if (
		![
			"onKeyDownBefore",
			"onSubmit",
			"onChange",
			"value",
			"disableEscapeDoublePress",
			"inputFilter",
			"inlineGhostText",
		].every((key) => property(path.node, key))
	)
		return null;
	const handlerRef = property(path.node, "onKeyDownBefore");
	const ghostText = property(path.node, "inlineGhostText");
	if (!t.isIdentifier(handlerRef) || !ghostText) return null;
	const owner = path.getFunctionParent();
	const handler = bindingFunction(path, handlerRef.name);
	if (
		!owner ||
		!handler ||
		!t.isBlockStatement(owner.node.body) ||
		!t.isBlockStatement(handler.node.body)
	)
		return null;
	const key = handler.node.params[0];
	if (!t.isIdentifier(key)) return null;
	let props: t.ObjectPattern | null = null;
	for (const statement of owner.node.body.body) {
		if (!t.isVariableDeclaration(statement)) continue;
		for (const declaration of statement.declarations) {
			if (!t.isObjectPattern(declaration.id)) continue;
			if (
				[
					"draft",
					"onSubmit",
					"chordGestureSpent",
					"suggestionsStore",
					"historySearchKeyDown",
				].every((name) =>
					patternBinding(declaration.id as t.ObjectPattern, name),
				)
			) {
				if (props) return null;
				props = declaration.id;
			}
		}
	}
	if (!props) return null;
	const draft = patternBinding(props, "draft");
	const submit = patternBinding(props, "onSubmit");
	const gestureSpent = patternBinding(props, "chordGestureSpent");
	const suggestions = patternBinding(props, "suggestionsStore");
	if (!draft || !submit || !gestureSpent || !suggestions) return null;
	const loading: t.Expression[] = [];
	handler.traverse({
		Function(inner) {
			inner.skip();
		},
		MemberExpression(inner) {
			if (memberName(inner.node) !== "isLoading") return;
			const object = inner.node.object;
			if (
				!t.isCallExpression(object) ||
				!t.isMemberExpression(object.callee) ||
				memberName(object.callee) !== "getSnapshot"
			)
				return;
			if (!loading.some((node) => t.isNodesEquivalent(node, inner.node)))
				loading.push(inner.node);
		},
	});
	if (loading.length !== 1) return null;
	const editors: t.Identifier[] = [];
	owner.traverse({
		Function(inner) {
			if (
				contains(
					inner.node,
					(node) =>
						t.isCallExpression(node) &&
						t.isMemberExpression(node.callee) &&
						memberName(node.callee) === "popAllEditable",
				)
			) {
				const parent = inner.parentPath;
				if (parent.isVariableDeclarator() && t.isIdentifier(parent.node.id))
					editors.push(parent.node.id);
				else if (
					parent.isAssignmentExpression() &&
					t.isIdentifier(parent.node.left)
				)
					editors.push(parent.node.left);
			}
			inner.skip();
		},
	});
	if (editors.length !== 1) return null;
	return {
		handler,
		key,
		input: t.memberExpression(t.cloneNode(draft), t.identifier("value")),
		loading: loading[0],
		submit,
		gestureSpent,
		suggestions,
		ghostText,
		editQueued: editors[0],
	};
}
function and(expressions: t.Expression[]): t.Expression {
	return expressions.reduce((left, right) =>
		t.logicalExpression("&&", left, right),
	);
}
function plainTab(key: t.Identifier): t.Expression {
	return and([
		t.binaryExpression(
			"===",
			t.memberExpression(t.cloneNode(key), t.identifier("name")),
			t.stringLiteral("tab"),
		),
		...["shift", "ctrl", "meta", "superKey"].map((name) =>
			t.unaryExpression(
				"!",
				t.memberExpression(t.cloneNode(key), t.identifier(name)),
			),
		),
	]);
}
function trimComparison(
	target: NativeQueueTarget,
	operator: "===" | "!==",
): t.Expression {
	return t.binaryExpression(
		operator,
		t.callExpression(
			t.memberExpression(t.cloneNode(target.input, true), t.identifier("trim")),
			[],
		),
		t.stringLiteral(""),
	);
}
function preventDefault(target: NativeQueueTarget): t.Statement {
	return t.expressionStatement(
		t.callExpression(
			t.memberExpression(
				t.cloneNode(target.key),
				t.identifier("preventDefault"),
			),
			[],
		),
	);
}
function buildQueueGuard(target: NativeQueueTarget): t.IfStatement {
	return t.ifStatement(
		and([
			plainTab(target.key),
			t.cloneNode(target.loading, true),
			trimComparison(target, "!=="),
		]),
		t.blockStatement([
			preventDefault(target),
			t.ifStatement(
				t.unaryExpression(
					"!",
					t.callExpression(t.cloneNode(target.gestureSpent), [
						t.unaryExpression("void", t.numericLiteral(0)),
					]),
				),
				t.blockStatement([
					// The input's ordinary one-argument wrapper drops native queue intent.
					t.expressionStatement(
						t.callExpression(t.cloneNode(target.submit), [
							t.cloneNode(target.input, true),
							t.booleanLiteral(true),
							t.unaryExpression("void", t.numericLiteral(0)),
							t.booleanLiteral(true),
						]),
					),
				]),
			),
			t.returnStatement(),
		]),
	);
}
function buildEditGuard(target: NativeQueueTarget): t.IfStatement {
	const activeSuggestions = t.memberExpression(
		t.memberExpression(
			t.callExpression(
				t.memberExpression(
					t.cloneNode(target.suggestions),
					t.identifier("getState"),
				),
				[],
			),
			t.identifier("suggestions"),
		),
		t.identifier("length"),
	);
	return t.ifStatement(
		and([
			plainTab(target.key),
			trimComparison(target, "==="),
			t.binaryExpression("===", activeSuggestions, t.numericLiteral(0)),
			t.unaryExpression("!", t.cloneNode(target.ghostText, true)),
			t.callExpression(t.cloneNode(target.editQueued), []),
		]),
		t.blockStatement([preventDefault(target), t.returnStatement()]),
	);
}
function preventionIndices(body: t.Statement[]): number[] {
	const indices: number[] = [];
	for (let index = 0; index < body.length; index++) {
		const statement = body[index];
		if (
			t.isIfStatement(statement) &&
			contains(statement.test, (node) =>
				["defaultPrevented", "didStopImmediatePropagation"].includes(
					memberName(node) ?? "",
				),
			)
		)
			indices.push(index);
	}
	return indices;
}
function guardIndices(
	target: NativeQueueTarget,
): { edit: number; queue: number; first: number; last: number } | null {
	if (!t.isBlockStatement(target.handler.node.body)) return null;
	const body = target.handler.node.body.body;
	const native = preventionIndices(body);
	if (native.length !== 2) return null;
	return {
		edit: body.findIndex((node) =>
			t.isNodesEquivalent(node, buildEditGuard(target)),
		),
		queue: body.findIndex((node) =>
			t.isNodesEquivalent(node, buildQueueGuard(target)),
		),
		first: native[0],
		last: native[1],
	};
}
function isPatched(target: NativeQueueTarget): boolean {
	const indices = guardIndices(target);
	return (
		!!indices &&
		indices.edit === indices.first + 1 &&
		indices.edit < indices.last &&
		indices.queue === indices.last + 1
	);
}
function patchTarget(target: NativeQueueTarget): boolean {
	if (isPatched(target)) return true;
	const indices = guardIndices(target);
	if (
		!indices ||
		indices.edit !== -1 ||
		indices.queue !== -1 ||
		!t.isBlockStatement(target.handler.node.body)
	)
		return false;
	const body = target.handler.node.body.body;
	body.splice(indices.last + 1, 0, buildQueueGuard(target));
	// History search keeps precedence; queued editing beats the empty-Tab hint.
	body.splice(indices.first + 1, 0, buildEditGuard(target));
	return isPatched(target);
}
function createPasses(): PatchAstPass[] {
	const targets: NativeQueueTarget[] = [];
	return [
		{
			pass: "discover",
			visitor: {
				ObjectExpression(path) {
					const target = discoverTarget(path);
					if (target) targets.push(target);
				},
			},
		},
		{
			pass: "finalize",
			visitor: {
				Program: {
					exit() {
						if (targets.length !== 1 || !patchTarget(targets[0]))
							console.warn(
								"Tab queue: native input routing did not match exactly one complete target",
							);
					},
				},
			},
		},
	];
}
export const tabQueue: Patch = {
	tag: "tab-queue",
	astPasses: () => createPasses(),
	verify(code, ast) {
		const file = getVerifyAst(code, ast);
		if (!file) return "Unable to parse AST during tab-queue verification";
		const targets: NativeQueueTarget[] = [];
		traverse(file, {
			ObjectExpression(path) {
				const target = discoverTarget(path);
				if (target) targets.push(target);
			},
		});
		if (targets.length !== 1)
			return "Native prompt input target is ambiguous or not found";
		if (!isPatched(targets[0]))
			return "Native Tab queue guards have incorrect routing, conditions, or precedence";
		return true;
	},
};
