import * as t from "@babel/types";
import { type NodePath, traverse } from "../babel.js";
import type { Patch, PatchAstPass } from "../types.js";
import { getObjectPropertyByName, getVerifyAst } from "./ast-helpers.js";

type FunctionLike =
	| t.FunctionDeclaration
	| t.FunctionExpression
	| t.ArrowFunctionExpression;

interface NativeQueueTarget {
	ownerFunction: NodePath<FunctionLike>;
	handler: NodePath<FunctionLike>;
	keyParam: t.Identifier;
	input: t.Expression;
	loading: t.Expression;
	submit: t.Expression;
	editQueued: t.Identifier;
}

function getObjectPropertyValue(
	object: t.ObjectExpression,
	name: string,
): t.Expression | null {
	const property = getObjectPropertyByName(object, name);
	return property && t.isExpression(property.value) ? property.value : null;
}

function hasObjectProperty(object: t.ObjectExpression, name: string): boolean {
	return getObjectPropertyByName(object, name) !== null;
}

function getMemberName(node: t.Node | null | undefined): string | null {
	if (!node) return null;
	if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
		if (t.isIdentifier(node.property)) return node.property.name;
		if (t.isStringLiteral(node.property)) return node.property.value;
	}
	return null;
}

function nodeContains(
	node: t.Node | null | undefined,
	predicate: (candidate: t.Node) => boolean,
): boolean {
	if (!node) return false;
	let found = false;
	t.traverseFast(node, (candidate) => {
		if (!found && predicate(candidate)) found = true;
	});
	return found;
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
	if (!bindingPath.isVariableDeclarator()) return null;
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
	return null;
}

function getFirstIdentifierParam(
	path: NodePath<FunctionLike>,
): t.Identifier | null {
	const [parameter] = path.node.params;
	return t.isIdentifier(parameter) ? parameter : null;
}

function isInputConfigObject(object: t.ObjectExpression): boolean {
	return [
		"onKeyDownBefore",
		"onSubmit",
		"onChange",
		"value",
		"disableEscapeDoublePress",
		"inputFilter",
	].every((name) => hasObjectProperty(object, name));
}

function findLoadingExpression(
	handler: NodePath<FunctionLike>,
): t.Expression | null {
	const candidates: t.Expression[] = [];
	handler.traverse({
		Function(path) {
			if (path.node !== handler.node) path.skip();
		},
		MemberExpression(path) {
			if (getMemberName(path.node) !== "isLoading") return;
			const object = path.node.object;
			if (
				!t.isCallExpression(object) ||
				!t.isMemberExpression(object.callee) ||
				getMemberName(object.callee) !== "getSnapshot"
			) {
				return;
			}
			if (
				!candidates.some((candidate) =>
					t.isNodesEquivalent(candidate, path.node),
				)
			) {
				candidates.push(path.node);
			}
		},
	});
	return candidates.length === 1 ? candidates[0] : null;
}

function findNativeEditCallback(
	owner: NodePath<FunctionLike>,
): t.Identifier | null {
	const candidates: t.Identifier[] = [];
	owner.traverse({
		Function(path) {
			if (path.node === owner.node) return;
			if (
				!nodeContains(
					path.node,
					(candidate) =>
						t.isCallExpression(candidate) &&
						t.isMemberExpression(candidate.callee) &&
						getMemberName(candidate.callee) === "popAllEditable",
				)
			) {
				path.skip();
				return;
			}
			const parent = path.parentPath;
			if (
				parent?.isAssignmentExpression() &&
				parent.node.right === path.node &&
				t.isIdentifier(parent.node.left)
			) {
				candidates.push(parent.node.left);
			} else if (
				parent?.isVariableDeclarator() &&
				parent.node.init === path.node &&
				t.isIdentifier(parent.node.id)
			) {
				candidates.push(parent.node.id);
			}
			path.skip();
		},
	});
	return candidates.length === 1 ? candidates[0] : null;
}

function getNativeQueueTarget(
	path: NodePath<t.ObjectExpression>,
): NativeQueueTarget | null {
	if (!isInputConfigObject(path.node)) return null;
	const handlerExpression = getObjectPropertyValue(
		path.node,
		"onKeyDownBefore",
	);
	const submit = getObjectPropertyValue(path.node, "onSubmit");
	const input = getObjectPropertyValue(path.node, "value");
	if (!t.isIdentifier(handlerExpression) || !submit || !input) return null;
	const ownerFunction = findNearestFunction(path);
	if (!ownerFunction) return null;
	const handler = findFunctionBinding(path, handlerExpression.name);
	if (!handler) return null;
	const keyParam = getFirstIdentifierParam(handler);
	if (!keyParam) return null;
	const loading = findLoadingExpression(handler);
	if (!loading) return null;
	const editQueued = findNativeEditCallback(ownerFunction);
	if (!editQueued) return null;
	return {
		ownerFunction,
		handler,
		keyParam,
		input,
		loading,
		submit,
		editQueued,
	};
}

function buildAnd(expressions: t.Expression[]): t.Expression {
	let current = expressions[0];
	for (let index = 1; index < expressions.length; index += 1) {
		current = t.logicalExpression("&&", current, expressions[index]);
	}
	return current;
}

function buildTabKeyTest(key: t.Identifier): t.Expression {
	return buildAnd([
		t.binaryExpression(
			"===",
			t.memberExpression(t.cloneNode(key), t.identifier("name")),
			t.stringLiteral("tab"),
		),
		...(["shift", "ctrl", "meta"] as const).map((property) =>
			t.unaryExpression(
				"!",
				t.memberExpression(t.cloneNode(key), t.identifier(property)),
			),
		),
	]);
}

function buildTrimCall(input: t.Expression): t.CallExpression {
	return t.callExpression(
		t.memberExpression(t.cloneNode(input, true), t.identifier("trim")),
		[],
	);
}

function buildPreventDefault(key: t.Identifier): t.Statement {
	return t.expressionStatement(
		t.callExpression(
			t.memberExpression(t.cloneNode(key), t.identifier("preventDefault")),
			[],
		),
	);
}

function buildQueueGuard(target: NativeQueueTarget): t.IfStatement {
	return t.ifStatement(
		buildAnd([
			buildTabKeyTest(target.keyParam),
			t.cloneNode(target.loading, true),
			t.binaryExpression(
				"!==",
				buildTrimCall(target.input),
				t.stringLiteral(""),
			),
		]),
		t.blockStatement([
			buildPreventDefault(target.keyParam),
			t.expressionStatement(
				t.callExpression(t.cloneNode(target.submit, true), [
					t.cloneNode(target.input, true),
				]),
			),
			t.returnStatement(),
		]),
	);
}

function buildEditGuard(target: NativeQueueTarget): t.IfStatement {
	return t.ifStatement(
		buildAnd([
			buildTabKeyTest(target.keyParam),
			t.binaryExpression(
				"===",
				buildTrimCall(target.input),
				t.stringLiteral(""),
			),
			t.callExpression(t.cloneNode(target.editQueued), []),
		]),
		t.blockStatement([
			buildPreventDefault(target.keyParam),
			t.returnStatement(),
		]),
	);
}

function expressionHasTabKeyTest(
	expression: t.Expression,
	key: t.Identifier,
): boolean {
	return nodeContains(
		expression,
		(candidate) =>
			t.isBinaryExpression(candidate, { operator: "===" }) &&
			t.isMemberExpression(candidate.left) &&
			t.isIdentifier(candidate.left.object, { name: key.name }) &&
			getMemberName(candidate.left) === "name" &&
			t.isStringLiteral(candidate.right, { value: "tab" }),
	);
}

function expressionHasTrimComparison(
	expression: t.Expression,
	input: t.Expression,
	operator: "===" | "!==",
): boolean {
	return nodeContains(expression, (candidate) => {
		if (!t.isBinaryExpression(candidate, { operator })) return false;
		if (!t.isStringLiteral(candidate.right, { value: "" })) return false;
		const left = candidate.left;
		return (
			t.isCallExpression(left) &&
			t.isMemberExpression(left.callee) &&
			getMemberName(left.callee) === "trim" &&
			t.isNodesEquivalent(left.callee.object, input)
		);
	});
}

function statementPreventsDefault(
	statement: t.Statement,
	key: t.Identifier,
): boolean {
	return nodeContains(
		statement,
		(candidate) =>
			t.isCallExpression(candidate) &&
			t.isMemberExpression(candidate.callee) &&
			t.isIdentifier(candidate.callee.object, { name: key.name }) &&
			getMemberName(candidate.callee) === "preventDefault",
	);
}

function hasQueueGuard(target: NativeQueueTarget): boolean {
	if (!t.isBlockStatement(target.handler.node.body)) return false;
	return target.handler.node.body.body.some((statement) => {
		if (!t.isIfStatement(statement)) return false;
		return (
			expressionHasTabKeyTest(statement.test, target.keyParam) &&
			nodeContains(statement.test, (candidate) =>
				t.isNodesEquivalent(candidate, target.loading),
			) &&
			expressionHasTrimComparison(statement.test, target.input, "!==") &&
			nodeContains(
				statement.consequent,
				(candidate) =>
					t.isCallExpression(candidate) &&
					t.isNodesEquivalent(candidate.callee, target.submit) &&
					candidate.arguments.length === 1 &&
					t.isNodesEquivalent(candidate.arguments[0] as t.Node, target.input),
			) &&
			statementPreventsDefault(statement.consequent, target.keyParam)
		);
	});
}

function hasEditGuard(target: NativeQueueTarget): boolean {
	if (!t.isBlockStatement(target.handler.node.body)) return false;
	return target.handler.node.body.body.some((statement) => {
		if (!t.isIfStatement(statement)) return false;
		return (
			expressionHasTabKeyTest(statement.test, target.keyParam) &&
			expressionHasTrimComparison(statement.test, target.input, "===") &&
			nodeContains(
				statement.test,
				(candidate) =>
					t.isCallExpression(candidate) &&
					t.isIdentifier(candidate.callee, { name: target.editQueued.name }),
			) &&
			statementPreventsDefault(statement.consequent, target.keyParam)
		);
	});
}

function isPreventedGuard(statement: t.Statement): boolean {
	return (
		t.isIfStatement(statement) &&
		nodeContains(
			statement.test,
			(candidate) =>
				(t.isMemberExpression(candidate) ||
					t.isOptionalMemberExpression(candidate)) &&
				["defaultPrevented", "didStopImmediatePropagation"].includes(
					getMemberName(candidate) ?? "",
				),
		)
	);
}

function patchNativeQueueTarget(target: NativeQueueTarget): boolean {
	if (!t.isBlockStatement(target.handler.node.body)) return false;
	const queuePatched = hasQueueGuard(target);
	const editPatched = hasEditGuard(target);
	if (queuePatched && editPatched) return true;
	let insertionIndex = -1;
	for (
		let index = 0;
		index < target.handler.node.body.body.length;
		index += 1
	) {
		if (isPreventedGuard(target.handler.node.body.body[index]))
			insertionIndex = index;
	}
	const statements: t.Statement[] = [];
	if (!editPatched) statements.push(buildEditGuard(target));
	if (!queuePatched) statements.push(buildQueueGuard(target));
	target.handler.node.body.body.splice(insertionIndex + 1, 0, ...statements);
	return hasQueueGuard(target) && hasEditGuard(target);
}

function createTabQueuePasses(): PatchAstPass[] {
	const targets: NativeQueueTarget[] = [];
	let patched = false;
	return [
		{
			pass: "discover",
			visitor: {
				ObjectExpression(path) {
					const target = getNativeQueueTarget(path);
					if (target) targets.push(target);
				},
			},
		},
		{
			pass: "finalize",
			visitor: {
				Program: {
					exit() {
						if (targets.length === 1)
							patched = patchNativeQueueTarget(targets[0]);
						if (!patched) {
							console.warn(
								`Tab queue: native prompt input targets found ${targets.length} (expected 1)`,
							);
						}
					},
				},
			},
		},
	];
}

export const tabQueue: Patch = {
	tag: "tab-queue",
	astPasses: () => createTabQueuePasses(),
	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) return "Unable to parse AST during tab-queue verification";
		const targets: NativeQueueTarget[] = [];
		traverse(verifyAst, {
			ObjectExpression(path) {
				const target = getNativeQueueTarget(path);
				if (target) targets.push(target);
			},
		});
		if (targets.length !== 1) {
			return `Native prompt input target is ambiguous or not found (${targets.length} sites found)`;
		}
		if (!hasQueueGuard(targets[0])) {
			return "Native Tab queue guard not found";
		}
		if (!hasEditGuard(targets[0])) {
			return "Native Tab queue edit guard not found";
		}
		return true;
	},
};
