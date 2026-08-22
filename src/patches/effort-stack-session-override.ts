import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";

export function buildProcessEnvMember(name: string): t.MemberExpression {
	return t.memberExpression(
		t.memberExpression(t.identifier("process"), t.identifier("env")),
		t.identifier(name),
	);
}

function buildSessionOverrideMember(name: string): t.MemberExpression {
	return t.memberExpression(t.identifier("globalThis"), t.identifier(name));
}

function buildSessionOverrideEnabledCheck(name: string): t.BinaryExpression {
	return t.binaryExpression(
		"===",
		buildSessionOverrideMember(name),
		t.booleanLiteral(true),
	);
}

function buildSessionOverrideStatement(name: string): t.ExpressionStatement {
	return t.expressionStatement(
		t.assignmentExpression(
			"=",
			buildSessionOverrideMember(name),
			t.booleanLiteral(true),
		),
	);
}

function isSessionOverrideAssignment(
	expr: t.Expression,
	name: string,
): boolean {
	return (
		t.isAssignmentExpression(expr, { operator: "=" }) &&
		t.isMemberExpression(expr.left) &&
		t.isIdentifier(expr.left.object, { name: "globalThis" }) &&
		t.isIdentifier(expr.left.property, { name }) &&
		t.isBooleanLiteral(expr.right, { value: true })
	);
}

function isSessionOverrideStatement(stmt: t.Statement, name: string): boolean {
	return (
		t.isExpressionStatement(stmt) &&
		isSessionOverrideAssignment(stmt.expression, name)
	);
}

export function isProcessEnvMember(expr: t.Expression, name: string): boolean {
	if (!t.isMemberExpression(expr)) return false;
	if (!t.isIdentifier(expr.property, { name })) return false;
	const object = expr.object;
	return (
		t.isMemberExpression(object) &&
		t.isIdentifier(object.object, { name: "process" }) &&
		t.isIdentifier(object.property, { name: "env" })
	);
}

function isRuntimeEnvMember(expr: t.Expression, name: string): boolean {
	return (
		t.isMemberExpression(expr) &&
		t.isIdentifier(expr.object) &&
		t.isIdentifier(expr.property, { name })
	);
}

export function isFalseLiteralExpression(
	expr: t.Expression | null | undefined,
): boolean {
	return (
		t.isBooleanLiteral(expr, { value: false }) ||
		(t.isUnaryExpression(expr, { operator: "!" }) &&
			t.isNumericLiteral(expr.argument, { value: 1 }))
	);
}

export function isVoidZeroExpression(expr: t.Expression): boolean {
	return (
		t.isUnaryExpression(expr, { operator: "void" }) &&
		t.isNumericLiteral(expr.argument, { value: 0 })
	);
}

function buildRawEnvIsSetCheck(name: string): t.BinaryExpression {
	return t.binaryExpression(
		"!==",
		buildProcessEnvMember(name),
		t.unaryExpression("void", t.numericLiteral(0)),
	);
}

function isSessionOverrideEnvResolverGuard(
	stmt: t.Statement,
	sessionOverrideGlobal: string,
): boolean {
	return (
		t.isIfStatement(stmt) &&
		t.isBinaryExpression(stmt.test, { operator: "===" }) &&
		t.isMemberExpression(stmt.test.left) &&
		t.isIdentifier(stmt.test.left.object, { name: "globalThis" }) &&
		t.isIdentifier(stmt.test.left.property, {
			name: sessionOverrideGlobal,
		}) &&
		t.isBooleanLiteral(stmt.test.right, { value: true }) &&
		t.isReturnStatement(stmt.consequent)
	);
}

export function patchEnvEffortResolverFunction(
	fn: t.Function,
	envEffortLevel: string,
	sessionOverrideGlobal: string,
): boolean | null {
	if (fn.params.length !== 0 || !t.isBlockStatement(fn.body)) return null;
	if (
		fn.body.body.some((stmt) =>
			isSessionOverrideEnvResolverGuard(stmt, sessionOverrideGlobal),
		)
	) {
		return true;
	}
	const readsEffortEnv = fn.body.body.some((stmt) => {
		if (!t.isVariableDeclaration(stmt)) return false;
		return stmt.declarations.some(
			(declaration) =>
				t.isIdentifier(declaration.id) &&
				declaration.init &&
				t.isExpression(declaration.init) &&
				isRuntimeEnvMember(declaration.init, envEffortLevel),
		);
	});
	if (!readsEffortEnv) return null;
	const returnsParsedEnv = fn.body.body.some(
		(stmt) => t.isReturnStatement(stmt) && stmt.argument !== null,
	);
	if (!returnsParsedEnv) return null;
	fn.body.body.unshift(
		t.ifStatement(
			buildSessionOverrideEnabledCheck(sessionOverrideGlobal),
			t.returnStatement(),
		),
	);
	return true;
}

export function hasPatchedEnvEffortResolverFunction(
	fn: t.Function,
	sessionOverrideGlobal: string,
): boolean {
	return (
		fn.params.length === 0 &&
		t.isBlockStatement(fn.body) &&
		fn.body.body.some((stmt) =>
			isSessionOverrideEnvResolverGuard(stmt, sessionOverrideGlobal),
		)
	);
}

function getObjectKeyName(node: t.Expression | t.PrivateName): string | null {
	if (t.isIdentifier(node)) return node.name;
	if (t.isStringLiteral(node)) return node.value;
	return null;
}

function isEffortLevelObject(
	node: t.Node | null | undefined,
	valueParamName: string,
): node is t.ObjectExpression {
	if (!t.isObjectExpression(node) || node.properties.length !== 1) return false;
	const [property] = node.properties;
	return (
		t.isObjectProperty(property) &&
		getObjectKeyName(property.key) === "effortLevel" &&
		t.isIdentifier(property.value, { name: valueParamName })
	);
}

function isModelScopedEffortObject(
	node: t.Node | null | undefined,
	valueParamName: string,
): node is t.ObjectExpression {
	if (!t.isObjectExpression(node) || node.properties.length !== 1) return false;
	const [modelSettingsProperty] = node.properties;
	if (
		!t.isObjectProperty(modelSettingsProperty) ||
		getObjectKeyName(modelSettingsProperty.key) !== "modelSettings" ||
		!t.isObjectExpression(modelSettingsProperty.value) ||
		modelSettingsProperty.value.properties.length !== 1
	) {
		return false;
	}
	const [modelProperty] = modelSettingsProperty.value.properties;
	return (
		t.isObjectProperty(modelProperty) &&
		modelProperty.computed &&
		isEffortLevelObject(modelProperty.value, valueParamName)
	);
}

function isCurrentEffortSettingsBuilderCall(
	writerPath: NodePath<t.Function>,
	expr: t.Expression,
	modelParamName: string,
	valueParamName: string,
): boolean {
	if (
		!t.isCallExpression(expr) ||
		!t.isIdentifier(expr.callee) ||
		expr.arguments.length !== 2 ||
		!t.isIdentifier(expr.arguments[0], { name: modelParamName }) ||
		!t.isIdentifier(expr.arguments[1], { name: valueParamName })
	) {
		return false;
	}
	const binding = writerPath.scope.getBinding(expr.callee.name);
	if (!binding || !t.isFunctionDeclaration(binding.path.node)) return false;
	const helper = binding.path.node;
	if (
		helper.params.length !== 2 ||
		!t.isIdentifier(helper.params[0]) ||
		!t.isIdentifier(helper.params[1]) ||
		!t.isBlockStatement(helper.body)
	) {
		return false;
	}
	const helperValueParamName = helper.params[1].name;
	const returns = helper.body.body.filter(
		(statement): statement is t.ReturnStatement =>
			t.isReturnStatement(statement) && statement.argument !== null,
	);
	if (returns.length !== 1) return false;
	const result = returns[0].argument;
	return (
		t.isConditionalExpression(result) &&
		isEffortLevelObject(result.consequent, helperValueParamName) &&
		isModelScopedEffortObject(result.alternate, helperValueParamName)
	);
}

function isCurrentEffortSettingsWrite(
	path: NodePath<t.Function>,
	stmt: t.Statement,
): stmt is t.ReturnStatement {
	if (!t.isReturnStatement(stmt) || !t.isCallExpression(stmt.argument)) {
		return false;
	}
	if (path.node.params.length !== 3 || !path.node.async) return false;
	const [valueParam, modelParam, scopeParam] = path.node.params;
	if (
		!t.isIdentifier(valueParam) ||
		!t.isIdentifier(modelParam) ||
		!t.isIdentifier(scopeParam)
	) {
		return false;
	}
	const call = stmt.argument;
	if (call.arguments.length !== 4) return false;
	const [settingsScope, settings, updateMode, targetScope] = call.arguments;
	if (!t.isStringLiteral(settingsScope, { value: "userSettings" })) {
		return false;
	}
	if (
		!t.isExpression(settings) ||
		!isCurrentEffortSettingsBuilderCall(
			path,
			settings,
			modelParam.name,
			valueParam.name,
		) ||
		!t.isExpression(updateMode) ||
		!isVoidZeroExpression(updateMode) ||
		!t.isIdentifier(targetScope, { name: scopeParam.name })
	) {
		return false;
	}
	return true;
}

function isSessionOnlySettingsGuard(
	stmt: t.Statement,
	envEffortLevel: string,
): boolean {
	if (!t.isIfStatement(stmt)) return false;
	if (
		!t.isBinaryExpression(stmt.test, { operator: "!==" }) ||
		!isProcessEnvMember(stmt.test.left as t.Expression, envEffortLevel) ||
		!isVoidZeroExpression(stmt.test.right as t.Expression)
	) {
		return false;
	}
	return (
		t.isReturnStatement(stmt.consequent) && stmt.consequent.argument === null
	);
}

export function patchEffortSettingsWriterFunction(
	path: NodePath<t.Function>,
	envEffortLevel: string,
): boolean | null {
	const fn = path.node;
	if (!t.isBlockStatement(fn.body)) return null;
	if (
		fn.body.body.some((stmt) =>
			isSessionOnlySettingsGuard(stmt, envEffortLevel),
		)
	) {
		return fn.body.body.some((stmt) =>
			isCurrentEffortSettingsWrite(path, stmt),
		);
	}
	if (
		fn.body.body.length !== 1 ||
		!isCurrentEffortSettingsWrite(path, fn.body.body[0])
	) {
		return null;
	}
	fn.body.body.unshift(
		t.ifStatement(buildRawEnvIsSetCheck(envEffortLevel), t.returnStatement()),
	);
	return true;
}

export function hasPatchedEffortSettingsWriterFunction(
	path: NodePath<t.Function>,
	envEffortLevel: string,
): boolean {
	const fn = path.node;
	if (!t.isBlockStatement(fn.body)) return false;
	return (
		fn.body.body.length === 2 &&
		isSessionOnlySettingsGuard(fn.body.body[0], envEffortLevel) &&
		isCurrentEffortSettingsWrite(path, fn.body.body[1])
	);
}

function getRollbackEffortResultName(expr: t.Expression): string | null {
	if (!t.isLogicalExpression(expr, { operator: "&&" })) return null;
	const right = expr.right;
	if (!t.isUnaryExpression(right, { operator: "!" })) return null;
	const target = right.argument;
	if (!t.isMemberExpression(target)) return null;
	if (!t.isIdentifier(target.object)) return null;
	if (!t.isIdentifier(target.property, { name: "effortUpdate" })) return null;
	return target.object.name;
}

function isSessionOverrideResultStatement(
	stmt: t.Statement,
	resultName: string,
	sessionOverrideGlobal: string,
): boolean {
	if (!t.isIfStatement(stmt)) return false;
	const test = stmt.test;
	if (!t.isMemberExpression(test)) return false;
	if (!t.isIdentifier(test.object, { name: resultName })) return false;
	if (!t.isIdentifier(test.property, { name: "effortUpdate" })) return false;
	const consequent = stmt.consequent;
	if (t.isBlockStatement(consequent)) {
		return consequent.body.some((child) =>
			isSessionOverrideStatement(child, sessionOverrideGlobal),
		);
	}
	return isSessionOverrideStatement(consequent, sessionOverrideGlobal);
}

function functionReturnsIdentifier(
	body: t.BlockStatement,
	resultName: string,
): boolean {
	return body.body.some(
		(stmt) =>
			t.isReturnStatement(stmt) &&
			t.isIdentifier(stmt.argument, { name: resultName }),
	);
}

function hasEffortRollbackGuard(
	body: t.BlockStatement,
	resultName: string,
): boolean {
	return body.body.some(
		(stmt) =>
			t.isIfStatement(stmt) &&
			getRollbackEffortResultName(stmt.test) === resultName,
	);
}

function isAwaitedEffortExecutorCall(
	init: t.Expression | null | undefined,
): boolean {
	if (!init || !t.isAwaitExpression(init)) return false;
	const argument = init.argument;
	if (!t.isCallExpression(argument)) return false;
	return argument.arguments.some((arg) => t.isArrowFunctionExpression(arg));
}

export function patchEffortUpdateResultOverride(
	fn: t.Function,
	sessionOverrideGlobal: string,
): boolean | null {
	if (!t.isBlockStatement(fn.body)) return null;
	const body = fn.body;
	for (let index = 0; index < body.body.length; index += 1) {
		const stmt = body.body[index];
		if (!t.isVariableDeclaration(stmt)) continue;
		for (const declaration of stmt.declarations) {
			if (!t.isIdentifier(declaration.id)) continue;
			const resultName = declaration.id.name;
			if (!isAwaitedEffortExecutorCall(declaration.init as t.Expression)) {
				continue;
			}
			if (!hasEffortRollbackGuard(body, resultName)) continue;
			if (!functionReturnsIdentifier(body, resultName)) continue;
			if (
				body.body.some((candidate) =>
					isSessionOverrideResultStatement(
						candidate,
						resultName,
						sessionOverrideGlobal,
					),
				)
			) {
				return true;
			}
			body.body.splice(
				index + 1,
				0,
				t.ifStatement(
					t.memberExpression(
						t.identifier(resultName),
						t.identifier("effortUpdate"),
					),
					buildSessionOverrideStatement(sessionOverrideGlobal),
				),
			);
			return true;
		}
	}
	return null;
}

export function hasPatchedEffortUpdateResultOverride(
	fn: t.Function,
	sessionOverrideGlobal: string,
): boolean {
	if (!t.isBlockStatement(fn.body)) return false;
	for (const stmt of fn.body.body) {
		if (!t.isVariableDeclaration(stmt)) continue;
		for (const declaration of stmt.declarations) {
			if (!t.isIdentifier(declaration.id)) continue;
			const resultName = declaration.id.name;
			if (!isAwaitedEffortExecutorCall(declaration.init as t.Expression)) {
				continue;
			}
			if (!hasEffortRollbackGuard(fn.body, resultName)) continue;
			if (!functionReturnsIdentifier(fn.body, resultName)) continue;
			return fn.body.body.some((candidate) =>
				isSessionOverrideResultStatement(
					candidate,
					resultName,
					sessionOverrideGlobal,
				),
			);
		}
	}
	return false;
}

export function isLegacyEffectiveEffortNoopGuard(node: t.IfStatement): boolean {
	if (!t.isBinaryExpression(node.test, { operator: "===" })) return false;
	if (
		!t.isCallExpression(node.test.left) ||
		!t.isCallExpression(node.test.right)
	) {
		return false;
	}
	if (
		node.test.left.arguments.length !== 2 ||
		node.test.right.arguments.length !== 2
	) {
		return false;
	}
	if (
		!t.isIdentifier(node.test.left.callee) ||
		!t.isIdentifier(node.test.right.callee)
	) {
		return false;
	}
	if (node.test.left.callee.name !== node.test.right.callee.name) return false;
	const consequent = node.consequent;
	return (
		t.isReturnStatement(consequent) &&
		isFalseLiteralExpression(consequent.argument)
	);
}

export function isPatchedEffectiveEffortNoopGuard(
	node: t.IfStatement,
	envEffortLevel: string,
): boolean {
	if (!t.isLogicalExpression(node.test, { operator: "&&" })) return false;
	if (!t.isBinaryExpression(node.test.left, { operator: "===" })) return false;
	const right = node.test.right;
	if (!t.isUnaryExpression(right, { operator: "!" })) return false;
	const guard = right.argument;
	if (!t.isLogicalExpression(guard, { operator: "&&" })) return false;
	return (
		t.isBinaryExpression(guard.left, { operator: "!==" }) &&
		t.isBinaryExpression(guard.right, { operator: "!==" }) &&
		isProcessEnvMember(guard.left.left as t.Expression, envEffortLevel)
	);
}

export function patchEffectiveEffortNoopGuard(
	node: t.IfStatement,
	envEffortLevel: string,
): boolean | null {
	if (isPatchedEffectiveEffortNoopGuard(node, envEffortLevel)) return true;
	if (!isLegacyEffectiveEffortNoopGuard(node)) return null;
	const comparison = node.test as t.BinaryExpression;
	const leftCall = comparison.left as t.CallExpression;
	const rightCall = comparison.right as t.CallExpression;
	const selected = leftCall.arguments[1];
	const current = rightCall.arguments[1];
	if (!t.isExpression(selected) || !t.isExpression(current)) return null;
	node.test = t.logicalExpression(
		"&&",
		comparison,
		t.unaryExpression(
			"!",
			t.logicalExpression(
				"&&",
				buildRawEnvIsSetCheck(envEffortLevel),
				t.binaryExpression("!==", t.cloneNode(selected), t.cloneNode(current)),
			),
			true,
		),
	);
	return true;
}
