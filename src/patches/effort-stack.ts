import * as t from "@babel/types";
import { type NodePath, traverse, type Visitor } from "../babel.js";
import type { Patch } from "../types.js";
import { getObjectKeyName, getVerifyAst } from "./ast-helpers.js";

const ENV_EFFORT_LEVEL = "CLAUDE_CODE_EFFORT_LEVEL";
const ENV_ULTRACODE = "CLAUDE_CODE_ULTRACODE";
const ENV_ULTRACODE_TRUE_VALUES = ["1", "true", "yes", "on"] as const;
const SESSION_OVERRIDE_GLOBAL = "__claudeCodeEffortSessionOverride";
const MAX_NOTIFICATION_TEXT = "Effort set to max for this turn";
const EM_DASH = "—";

const ULTRACODE_COMMAND_ENV_OVERRIDE_ORIGINAL_QUASIS = [
	`${ENV_EFFORT_LEVEL}=`,
	` overrides effort this session ${EM_DASH} clear it and ultracode takes over`,
] as const;
const ULTRACODE_COMMAND_STACKED_QUASIS = [
	"Ultracode workflows active for this session. Effort stays at ",
	" (stacked).",
] as const;
const ULTRACODE_COMMAND_SESSION_QUASIS = [
	`${ENV_EFFORT_LEVEL}=`,
	" remains the launch default for new sessions. Set effort level to ultracode for this session.",
] as const;

const EFFORT_COMMAND_ENV_OVERRIDE_ORIGINAL_QUASIS = [
	`${ENV_EFFORT_LEVEL}=`,
	` overrides this session ${EM_DASH} clear it and `,
	" takes over",
] as const;
const EFFORT_COMMAND_ENV_OVERRIDE_PATCHED_QUASIS = [
	`${ENV_EFFORT_LEVEL}=`,
	" remains the launch default for new sessions. Set effort level to ",
	" for this session.",
] as const;
const EFFORT_SESSION_ONLY_ENV_OVERRIDE_ORIGINAL_QUASIS = [
	`Not applied: ${ENV_EFFORT_LEVEL}=`,
	" overrides effort this session, and ",
	" is session-only (nothing saved)",
] as const;
const EFFORT_SESSION_ONLY_ENV_OVERRIDE_PATCHED_QUASIS = [
	`${ENV_EFFORT_LEVEL}=`,
	" remains the launch default for new sessions. Set effort level to ",
	" for this session.",
] as const;
const EFFORT_AUTO_ENV_OVERRIDE_ORIGINAL_QUASIS = [
	`Cleared effort from settings, but ${ENV_EFFORT_LEVEL}=`,
	" still controls this session",
] as const;
const EFFORT_AUTO_ENV_OVERRIDE_PATCHED_QUASIS = [
	`Effort level set to auto for this session. ${ENV_EFFORT_LEVEL}=`,
	" remains the launch default for new sessions.",
] as const;

const CURRENT_EFFORT_ULTRACODE_ANCHOR =
	"Current effort level: ultracode (xhigh + dynamic workflow orchestration; this session only)";
const CURRENT_EFFORT_STACKED_MESSAGE =
	"Current effort level: max effort + ultracode workflows (env-stacked)";

const ULTRACODE_MENU_XHIGH_QUASI_TAIL =
	" ultracode · xhigh effort + dynamic workflows for maximum thoroughness";
const ULTRACODE_MENU_MAX_QUASI_TAIL =
	" ultracode · max effort + dynamic workflows for maximum thoroughness";

function getObjectProp(
	objectExpr: t.ObjectExpression,
	keyName: string,
): t.ObjectProperty | null {
	for (const prop of objectExpr.properties) {
		if (t.isObjectProperty(prop) && getObjectKeyName(prop.key) === keyName) {
			return prop;
		}
	}
	return null;
}

function isUltracodeEqualsTrueTest(
	test: t.Expression,
): { receiverName: string } | null {
	if (!t.isBinaryExpression(test, { operator: "===" })) return null;
	const right = test.right;
	const isTrueLit =
		t.isBooleanLiteral(right, { value: true }) ||
		(t.isUnaryExpression(right, { operator: "!" }) &&
			t.isNumericLiteral(right.argument, { value: 0 }));
	if (!isTrueLit) return null;
	const left = test.left;
	if (!t.isMemberExpression(left)) return null;
	if (!t.isIdentifier(left.property, { name: "ultracode" })) return null;
	const settingsMember = left.object;
	if (!t.isMemberExpression(settingsMember)) return null;
	if (!t.isIdentifier(settingsMember.property, { name: "settings" })) {
		return null;
	}
	const receiver = settingsMember.object;
	if (!t.isIdentifier(receiver)) return null;
	return { receiverName: receiver.name };
}

function consequentReturnsXhigh(consequent: t.Statement): boolean {
	let stmt: t.Statement | null = consequent;
	if (t.isBlockStatement(stmt) && stmt.body.length === 1) {
		stmt = stmt.body[0];
	}
	if (!stmt || !t.isReturnStatement(stmt)) return false;
	return t.isStringLiteral(stmt.argument, { value: "xhigh" });
}

function isUltracodeForcesXhighGuard(
	node: t.IfStatement,
): { receiverName: string } | null {
	const match = isUltracodeEqualsTrueTest(node.test);
	if (!match) return null;
	if (!consequentReturnsXhigh(node.consequent)) return null;
	return match;
}

function buildProcessEnvMember(name: string): t.MemberExpression {
	return t.memberExpression(
		t.memberExpression(t.identifier("process"), t.identifier("env")),
		t.identifier(name),
	);
}

function buildSessionOverrideMember(): t.MemberExpression {
	return t.memberExpression(
		t.identifier("globalThis"),
		t.identifier(SESSION_OVERRIDE_GLOBAL),
	);
}

function buildSessionOverrideEnabledCheck(): t.BinaryExpression {
	return t.binaryExpression(
		"===",
		buildSessionOverrideMember(),
		t.booleanLiteral(true),
	);
}

function buildSessionOverrideAssignment(): t.AssignmentExpression {
	return t.assignmentExpression(
		"=",
		buildSessionOverrideMember(),
		t.booleanLiteral(true),
	);
}

function buildSessionOverrideStatement(): t.ExpressionStatement {
	return t.expressionStatement(buildSessionOverrideAssignment());
}

function isSessionOverrideAssignment(expr: t.Expression): boolean {
	return (
		t.isAssignmentExpression(expr, { operator: "=" }) &&
		t.isMemberExpression(expr.left) &&
		t.isIdentifier(expr.left.object, { name: "globalThis" }) &&
		t.isIdentifier(expr.left.property, { name: SESSION_OVERRIDE_GLOBAL }) &&
		t.isBooleanLiteral(expr.right, { value: true })
	);
}

function isSessionOverrideStatement(stmt: t.Statement): boolean {
	return (
		t.isExpressionStatement(stmt) &&
		isSessionOverrideAssignment(stmt.expression)
	);
}

function isProcessEnvMember(expr: t.Expression, name: string): boolean {
	if (!t.isMemberExpression(expr)) return false;
	if (!t.isIdentifier(expr.property, { name })) return false;
	const object = expr.object;
	return (
		t.isMemberExpression(object) &&
		t.isIdentifier(object.property, { name: "env" }) &&
		t.isIdentifier(object.object, { name: "process" })
	);
}

function buildNormalizedEnvValue(name: string): t.CallExpression {
	return t.callExpression(
		t.memberExpression(
			t.callExpression(t.identifier("String"), [buildProcessEnvMember(name)]),
			t.identifier("toLowerCase"),
		),
		[],
	);
}

function isNormalizedEnvValue(expr: t.Expression, name: string): boolean {
	if (!t.isCallExpression(expr) || expr.arguments.length !== 0) return false;
	const callee = expr.callee;
	if (!t.isMemberExpression(callee)) return false;
	if (!t.isIdentifier(callee.property, { name: "toLowerCase" })) return false;
	const stringCall = callee.object;
	if (!t.isCallExpression(stringCall) || stringCall.arguments.length !== 1) {
		return false;
	}
	if (!t.isIdentifier(stringCall.callee, { name: "String" })) return false;
	const [arg] = stringCall.arguments;
	return t.isExpression(arg) && isProcessEnvMember(arg, name);
}

function buildEnvEqualsCheck(name: string, value: string): t.BinaryExpression {
	return t.binaryExpression(
		"===",
		buildNormalizedEnvValue(name),
		t.stringLiteral(value),
	);
}

function buildEnvNotEqualsCheck(
	name: string,
	value: string,
): t.BinaryExpression {
	return t.binaryExpression(
		"!==",
		buildNormalizedEnvValue(name),
		t.stringLiteral(value),
	);
}

function isEnvComparison(
	expr: t.Expression,
	name: string,
	value: string,
	operator: "===" | "!==",
): boolean {
	return (
		t.isBinaryExpression(expr, { operator }) &&
		t.isStringLiteral(expr.right, { value }) &&
		isNormalizedEnvValue(expr.left as t.Expression, name)
	);
}

function buildRawEnvIsSetCheck(name: string): t.BinaryExpression {
	return t.binaryExpression(
		"!==",
		buildProcessEnvMember(name),
		t.unaryExpression("void", t.numericLiteral(0), true),
	);
}

function buildEnvEffortLevelNotMaxCheck(): t.BinaryExpression {
	return buildEnvNotEqualsCheck(ENV_EFFORT_LEVEL, "max");
}

function buildEnvEffortLevelEqualsMaxCheck(): t.BinaryExpression {
	return buildEnvEqualsCheck(ENV_EFFORT_LEVEL, "max");
}

function buildEnvUltracodeEnabledCheck(): t.CallExpression {
	return t.callExpression(
		t.memberExpression(
			t.arrayExpression(
				ENV_ULTRACODE_TRUE_VALUES.map((value) => t.stringLiteral(value)),
			),
			t.identifier("includes"),
		),
		[buildNormalizedEnvValue(ENV_ULTRACODE)],
	);
}

function isEnvUltracodeEnabledCheck(expr: t.Expression): boolean {
	if (!t.isCallExpression(expr) || expr.arguments.length !== 1) return false;
	const callee = expr.callee;
	if (!t.isMemberExpression(callee)) return false;
	if (!t.isIdentifier(callee.property, { name: "includes" })) return false;
	const values = callee.object;
	if (!t.isArrayExpression(values)) return false;
	const actualValues = values.elements.map((element) =>
		t.isStringLiteral(element) ? element.value : null,
	);
	if (actualValues.join("\0") !== ENV_ULTRACODE_TRUE_VALUES.join("\0")) {
		return false;
	}
	const [arg] = expr.arguments;
	return t.isExpression(arg) && isNormalizedEnvValue(arg, ENV_ULTRACODE);
}

function isSettingsUltracodeSourceWithEnv(expr: t.Expression): boolean {
	if (!t.isLogicalExpression(expr, { operator: "||" })) return false;
	return (
		isUltracodeEqualsTrueTest(expr.left as t.Expression) !== null &&
		isEnvUltracodeEnabledCheck(expr.right as t.Expression)
	);
}

function isRawUltracodeEqualsTrueTest(expr: t.Expression): boolean {
	if (
		t.isLogicalExpression(expr, { operator: "||" }) &&
		isFalseLiteralExpression(expr.right as t.Expression)
	) {
		return isRawUltracodeEqualsTrueTest(expr.left as t.Expression);
	}
	if (!t.isBinaryExpression(expr, { operator: "===" })) return false;
	if (!isTrueLiteralExpression(expr.right as t.Expression)) return false;
	const left = expr.left;
	if (!t.isMemberExpression(left)) return false;
	if (!t.isIdentifier(left.property, { name: "ultracode" })) return false;
	return t.isCallExpression(left.object);
}

function flattenLogicalOr(expr: t.Expression): t.Expression[] {
	if (!t.isLogicalExpression(expr, { operator: "||" })) return [expr];
	return [
		...flattenLogicalOr(expr.left as t.Expression),
		...flattenLogicalOr(expr.right as t.Expression),
	];
}

function isRawUltracodeSourceWithEnv(expr: t.Expression): boolean {
	const parts = flattenLogicalOr(expr);
	return (
		parts.some(isRawUltracodeEqualsTrueTest) &&
		parts.some(isEnvUltracodeEnabledCheck)
	);
}

function isPatchableRawUltracodeSource(expr: t.Expression): boolean {
	const parts = flattenLogicalOr(expr);
	return (
		parts.some(isRawUltracodeEqualsTrueTest) &&
		!parts.some(isEnvUltracodeEnabledCheck)
	);
}

function isPatchedUltracodeResolver(node: t.IfStatement): boolean {
	const test = node.test;
	if (!t.isLogicalExpression(test, { operator: "&&" })) return false;
	if (!isSettingsUltracodeSourceWithEnv(test.left as t.Expression))
		return false;
	const right = test.right;
	if (!isEnvComparison(right as t.Expression, ENV_EFFORT_LEVEL, "max", "!=="))
		return false;
	if (!consequentReturnsXhigh(node.consequent)) return false;
	return true;
}

function isTrueLiteralExpression(expr: t.Expression): boolean {
	return (
		t.isBooleanLiteral(expr, { value: true }) ||
		(t.isUnaryExpression(expr, { operator: "!" }) &&
			t.isNumericLiteral(expr.argument, { value: 0 }))
	);
}

function isFalseLiteralExpression(
	expr: t.Expression | null | undefined,
): boolean {
	return (
		t.isBooleanLiteral(expr, { value: false }) ||
		(t.isUnaryExpression(expr, { operator: "!" }) &&
			t.isNumericLiteral(expr.argument, { value: 1 }))
	);
}

function isXhighResolverComparison(
	expr: t.Expression,
): expr is t.BinaryExpression {
	return (
		t.isBinaryExpression(expr, { operator: "===" }) &&
		t.isStringLiteral(expr.right, { value: "xhigh" }) &&
		t.isCallExpression(expr.left) &&
		expr.left.arguments.length === 2
	);
}

function isMaxResolverComparison(expr: t.Expression): boolean {
	return (
		t.isBinaryExpression(expr, { operator: "===" }) &&
		t.isStringLiteral(expr.right, { value: "max" }) &&
		t.isCallExpression(expr.left) &&
		expr.left.arguments.length === 2
	);
}

function isZeroArgCallExpression(expr: t.Expression): expr is t.CallExpression {
	return t.isCallExpression(expr) && expr.arguments.length === 0;
}

function getIdentifierCalleeName(call: t.CallExpression): string | null {
	return t.isIdentifier(call.callee) ? call.callee.name : null;
}

function isUltracodeFlagAndWorkflowCheck(expr: t.Expression): boolean {
	if (!t.isLogicalExpression(expr, { operator: "&&" })) return false;
	const flagCheck = expr.left;
	if (!t.isBinaryExpression(flagCheck, { operator: "===" })) return false;
	if (!t.isIdentifier(flagCheck.left)) return false;
	if (!isTrueLiteralExpression(flagCheck.right as t.Expression)) return false;
	const workflowCheck = expr.right;
	return isZeroArgCallExpression(workflowCheck);
}

function isUltracodeFlagAndAvailabilityCheck(expr: t.Expression): boolean {
	if (!t.isLogicalExpression(expr, { operator: "&&" })) return false;
	const flagCheck = expr.left;
	if (!t.isBinaryExpression(flagCheck, { operator: "===" })) return false;
	if (!t.isIdentifier(flagCheck.left)) return false;
	if (!isTrueLiteralExpression(flagCheck.right as t.Expression)) return false;
	const availabilityCheck = expr.right;
	return (
		t.isCallExpression(availabilityCheck) &&
		availabilityCheck.arguments.length === 1
	);
}

function isLegacyUltracodeActiveGate(
	node: t.ReturnStatement,
): t.LogicalExpression | null {
	const arg = node.argument;
	if (!arg || !t.isLogicalExpression(arg, { operator: "&&" })) return null;
	if (!isUltracodeFlagAndWorkflowCheck(arg.left as t.Expression)) return null;
	if (!isXhighResolverComparison(arg.right as t.Expression)) return null;
	return arg;
}

function isPatchedUltracodeActiveGate(node: t.ReturnStatement): boolean {
	const arg = node.argument;
	if (!arg || !t.isLogicalExpression(arg, { operator: "&&" })) return false;
	if (!isUltracodeFlagAndAvailabilityCheck(arg.left as t.Expression)) {
		return false;
	}
	const right = arg.right;
	if (!t.isLogicalExpression(right, { operator: "||" })) return false;
	return (
		isXhighResolverComparison(right.left as t.Expression) &&
		isMaxResolverComparison(right.right as t.Expression)
	);
}

function getResolvedEffortModelArgument(
	comparison: t.BinaryExpression,
): t.Expression | null {
	const left = comparison.left;
	if (!t.isCallExpression(left)) return null;
	const [model] = left.arguments;
	return t.isExpression(model) ? model : null;
}

function getWorkflowCalleeName(expr: t.LogicalExpression): string | null {
	const left = expr.left;
	if (!t.isLogicalExpression(left, { operator: "&&" })) return null;
	const workflowCheck = left.right;
	return isZeroArgCallExpression(workflowCheck)
		? getIdentifierCalleeName(workflowCheck)
		: null;
}

function isVoidZeroCheck(expr: t.Expression, paramName: string): boolean {
	return (
		t.isBinaryExpression(expr, { operator: "===" }) &&
		t.isIdentifier(expr.left, { name: paramName }) &&
		isVoidZeroExpression(expr.right as t.Expression)
	);
}

function isXhighSupportCall(expr: t.Expression, paramName: string): boolean {
	if (!t.isCallExpression(expr) || expr.arguments.length !== 2) return false;
	const [effort, model] = expr.arguments;
	return (
		t.isStringLiteral(effort, { value: "xhigh" }) &&
		t.isExpression(model) &&
		t.isIdentifier(model, { name: paramName })
	);
}

function expressionContainsXhighSupportCall(
	expr: t.Expression,
	paramName: string,
): boolean {
	if (isXhighSupportCall(expr, paramName)) return true;
	if (t.isLogicalExpression(expr)) {
		return (
			expressionContainsXhighSupportCall(
				expr.left as t.Expression,
				paramName,
			) ||
			expressionContainsXhighSupportCall(expr.right as t.Expression, paramName)
		);
	}
	return false;
}

function isAvailabilityHelperReturn(
	expr: t.Expression,
	workflowCalleeName: string,
	paramName: string,
): boolean {
	if (!t.isLogicalExpression(expr, { operator: "&&" })) return false;
	const left = expr.left;
	if (!isZeroArgCallExpression(left)) return false;
	if (getIdentifierCalleeName(left) !== workflowCalleeName) return false;
	const right = expr.right;
	if (!t.isLogicalExpression(right, { operator: "||" })) return false;
	return (
		isVoidZeroCheck(right.left as t.Expression, paramName) &&
		expressionContainsXhighSupportCall(right.right as t.Expression, paramName)
	);
}

function findUltracodeAvailabilityHelperName(
	path: NodePath,
	workflowCalleeName: string,
): string | null {
	const program = path.findParent((parentPath) => parentPath.isProgram());
	if (!program?.isProgram()) return null;
	for (const stmt of program.node.body) {
		if (!t.isFunctionDeclaration(stmt) || !stmt.id) continue;
		const [param] = stmt.params;
		if (!t.isIdentifier(param) || !t.isBlockStatement(stmt.body)) continue;
		if (stmt.body.body.length !== 1) continue;
		const returnStmt = stmt.body.body[0];
		if (!t.isReturnStatement(returnStmt) || !returnStmt.argument) continue;
		if (
			isAvailabilityHelperReturn(
				returnStmt.argument as t.Expression,
				workflowCalleeName,
				param.name,
			)
		) {
			return stmt.id.name;
		}
	}
	return null;
}

function buildPatchedUltracodeActiveGate(
	legacyGate: t.LogicalExpression,
	availabilityHelperName: string,
): t.LogicalExpression {
	const effortComparison = legacyGate.right as t.Expression;
	if (!isXhighResolverComparison(effortComparison)) {
		return legacyGate;
	}
	const modelArg = getResolvedEffortModelArgument(effortComparison);
	if (!modelArg) return legacyGate;
	const maxComparison = t.binaryExpression(
		"===",
		t.cloneNode(effortComparison.left),
		t.stringLiteral("max"),
	);
	return t.logicalExpression(
		"&&",
		t.logicalExpression(
			"&&",
			t.cloneNode(
				(legacyGate.left as t.LogicalExpression).left as t.Expression,
			),
			t.callExpression(t.identifier(availabilityHelperName), [
				t.cloneNode(modelArg),
			]),
		),
		t.logicalExpression("||", t.cloneNode(effortComparison), maxComparison),
	);
}

function patchRawUltracodeFlagFunction(fn: t.Function): boolean | null {
	if (fn.params.length > 1 || !t.isBlockStatement(fn.body)) return null;
	for (const stmt of fn.body.body) {
		if (!t.isVariableDeclaration(stmt)) continue;
		for (const declaration of stmt.declarations) {
			if (!t.isIdentifier(declaration.id) || !declaration.init) continue;
			if (isRawUltracodeSourceWithEnv(declaration.init as t.Expression)) {
				return true;
			}
			if (!isPatchableRawUltracodeSource(declaration.init as t.Expression)) {
				continue;
			}
			declaration.init = t.logicalExpression(
				"||",
				t.cloneNode(declaration.init as t.Expression),
				buildEnvUltracodeEnabledCheck(),
			);
			return true;
		}
	}
	return null;
}

function hasPatchedRawUltracodeFlagFunction(fn: t.Function): boolean {
	if (fn.params.length > 1 || !t.isBlockStatement(fn.body)) return false;
	for (const stmt of fn.body.body) {
		if (!t.isVariableDeclaration(stmt)) continue;
		for (const declaration of stmt.declarations) {
			if (!t.isIdentifier(declaration.id) || !declaration.init) continue;
			if (isRawUltracodeSourceWithEnv(declaration.init as t.Expression)) {
				return true;
			}
		}
	}
	return false;
}

function isSessionOverrideEnvResolverGuard(stmt: t.Statement): boolean {
	return (
		t.isIfStatement(stmt) &&
		t.isBinaryExpression(stmt.test, { operator: "===" }) &&
		t.isMemberExpression(stmt.test.left) &&
		t.isIdentifier(stmt.test.left.object, { name: "globalThis" }) &&
		t.isIdentifier(stmt.test.left.property, {
			name: SESSION_OVERRIDE_GLOBAL,
		}) &&
		t.isBooleanLiteral(stmt.test.right, { value: true }) &&
		t.isReturnStatement(stmt.consequent)
	);
}

function patchEnvEffortResolverFunction(fn: t.Function): boolean | null {
	if (fn.params.length !== 0 || !t.isBlockStatement(fn.body)) return null;
	if (fn.body.body.some(isSessionOverrideEnvResolverGuard)) return true;
	const readsEffortEnv = fn.body.body.some((stmt) => {
		if (!t.isVariableDeclaration(stmt)) return false;
		return stmt.declarations.some(
			(declaration) =>
				t.isIdentifier(declaration.id) &&
				declaration.init &&
				t.isExpression(declaration.init) &&
				isProcessEnvMember(declaration.init, ENV_EFFORT_LEVEL),
		);
	});
	if (!readsEffortEnv) return null;
	const returnsParsedEnv = fn.body.body.some(
		(stmt) => t.isReturnStatement(stmt) && stmt.argument !== null,
	);
	if (!returnsParsedEnv) return null;
	fn.body.body.unshift(
		t.ifStatement(buildSessionOverrideEnabledCheck(), t.returnStatement()),
	);
	return true;
}

function hasPatchedEnvEffortResolverFunction(fn: t.Function): boolean {
	return (
		fn.params.length === 0 &&
		t.isBlockStatement(fn.body) &&
		fn.body.body.some(isSessionOverrideEnvResolverGuard)
	);
}

function expressionContainsUserSettingsEffortWrite(
	expr: t.Expression,
): boolean {
	let found = false;
	traverse(t.file(t.program([t.expressionStatement(t.cloneNode(expr))])), {
		CallExpression(path) {
			const [scopeArg, settingsArg] = path.node.arguments;
			if (!t.isStringLiteral(scopeArg, { value: "userSettings" })) return;
			if (!t.isObjectExpression(settingsArg)) return;
			if (getObjectProp(settingsArg, "effortLevel")) found = true;
		},
	});
	return found;
}

function isZeroArgCallStatement(
	stmt: t.Statement,
): stmt is t.ExpressionStatement {
	return (
		t.isExpressionStatement(stmt) &&
		t.isCallExpression(stmt.expression) &&
		stmt.expression.arguments.length === 0
	);
}

function findUnpinEffortStatement(fn: t.Function): t.Statement | null {
	if (!t.isBlockStatement(fn.body)) return null;
	for (const stmt of fn.body.body) {
		if (isZeroArgCallStatement(stmt)) return stmt;
		if (!t.isIfStatement(stmt)) continue;
		if (isZeroArgCallStatement(stmt.consequent)) return stmt;
		if (
			t.isBlockStatement(stmt.consequent) &&
			stmt.consequent.body.some(isZeroArgCallStatement)
		) {
			return stmt;
		}
	}
	return null;
}

function isSessionOnlySettingsGuard(stmt: t.Statement): boolean {
	if (!t.isIfStatement(stmt)) return false;
	if (
		!t.isBinaryExpression(stmt.test, { operator: "!==" }) ||
		!isProcessEnvMember(stmt.test.left as t.Expression, ENV_EFFORT_LEVEL) ||
		!isVoidZeroExpression(stmt.test.right as t.Expression)
	) {
		return false;
	}
	const consequent = stmt.consequent;
	if (!t.isBlockStatement(consequent)) return false;
	return consequent.body.some((child) => t.isReturnStatement(child));
}

function patchEffortSettingsWriterFunction(fn: t.Function): boolean | null {
	if (fn.params.length !== 2 || !t.isBlockStatement(fn.body)) return null;
	if (fn.body.body.some(isSessionOnlySettingsGuard)) return true;
	let hasEffortSettingsWrite = false;
	for (const stmt of fn.body.body) {
		if (t.isExpressionStatement(stmt)) {
			hasEffortSettingsWrite ||= expressionContainsUserSettingsEffortWrite(
				stmt.expression,
			);
		}
		if (t.isIfStatement(stmt) && t.isBlockStatement(stmt.consequent)) {
			for (const child of stmt.consequent.body) {
				if (t.isVariableDeclaration(child)) {
					hasEffortSettingsWrite ||= child.declarations.some(
						(declaration) =>
							declaration.init &&
							t.isExpression(declaration.init) &&
							expressionContainsUserSettingsEffortWrite(declaration.init),
					);
				}
			}
		}
	}
	if (!hasEffortSettingsWrite) return null;
	const unpinStatement = findUnpinEffortStatement(fn);
	if (!unpinStatement) return null;
	fn.body.body.unshift(
		t.ifStatement(
			buildRawEnvIsSetCheck(ENV_EFFORT_LEVEL),
			t.blockStatement([t.cloneNode(unpinStatement), t.returnStatement()]),
		),
	);
	return true;
}

function hasPatchedEffortSettingsWriterFunction(fn: t.Function): boolean {
	return (
		fn.params.length === 2 &&
		t.isBlockStatement(fn.body) &&
		fn.body.body.some(isSessionOnlySettingsGuard)
	);
}

function quasiCookedAt(tmpl: t.TemplateLiteral, index: number): string | null {
	const q = tmpl.quasis[index];
	if (!q) return null;
	return q.value.cooked ?? q.value.raw;
}

function setQuasiText(
	tmpl: t.TemplateLiteral,
	index: number,
	text: string,
): void {
	const q = tmpl.quasis[index];
	if (!q) return;
	q.value = { raw: text, cooked: text };
}

function templateMatchesQuasiPattern(
	tmpl: t.TemplateLiteral,
	expected: readonly string[],
): boolean {
	if (tmpl.quasis.length !== expected.length) return false;
	for (let i = 0; i < expected.length; i++) {
		if (quasiCookedAt(tmpl, i) !== expected[i]) return false;
	}
	return true;
}

function isHy8FunctionByContent(funcPath: NodePath<t.Function>): boolean {
	let found = false;
	funcPath.traverse({
		StringLiteral(p) {
			if (p.node.value === CURRENT_EFFORT_ULTRACODE_ANCHOR) found = true;
		},
	});
	return found;
}

function isPatchedHy8FirstStatement(stmt: t.Statement): boolean {
	if (!t.isIfStatement(stmt)) return false;
	let returnStmt: t.Statement | null = stmt.consequent;
	if (t.isBlockStatement(returnStmt) && returnStmt.body.length === 1) {
		returnStmt = returnStmt.body[0];
	}
	if (!returnStmt || !t.isReturnStatement(returnStmt)) return false;
	const arg = returnStmt.argument;
	if (!arg || !t.isObjectExpression(arg)) return false;
	const msgProp = arg.properties.find(
		(p) => t.isObjectProperty(p) && getObjectKeyName(p.key) === "message",
	);
	if (!msgProp || !t.isObjectProperty(msgProp)) return false;
	return t.isStringLiteral(msgProp.value, {
		value: CURRENT_EFFORT_STACKED_MESSAGE,
	});
}

function buildHy8StackingBranch(activeTest: t.Expression): t.IfStatement {
	return t.ifStatement(
		t.logicalExpression(
			"&&",
			t.cloneNode(activeTest),
			buildEnvEffortLevelEqualsMaxCheck(),
		),
		t.returnStatement(
			t.objectExpression([
				t.objectProperty(
					t.identifier("message"),
					t.stringLiteral(CURRENT_EFFORT_STACKED_MESSAGE),
				),
			]),
		),
	);
}

function findCurrentEffortActiveTest(
	body: t.BlockStatement,
): t.Expression | null {
	for (const stmt of body.body) {
		if (!t.isIfStatement(stmt)) continue;
		let consequent: t.Statement | null = stmt.consequent;
		if (t.isBlockStatement(consequent) && consequent.body.length === 1) {
			consequent = consequent.body[0];
		}
		if (!consequent || !t.isReturnStatement(consequent)) continue;
		const arg = consequent.argument;
		if (!arg || !t.isObjectExpression(arg)) continue;
		const messageProp = getObjectProp(arg, "message");
		if (
			messageProp &&
			t.isStringLiteral(messageProp.value, {
				value: CURRENT_EFFORT_ULTRACODE_ANCHOR,
			})
		) {
			return stmt.test;
		}
	}
	return null;
}

function isLegacyUltracodeMenuReturnArg(
	arg: t.Expression | null | undefined,
): boolean {
	if (!arg || !t.isTemplateLiteral(arg)) return false;
	if (arg.quasis.length !== 2 || arg.expressions.length !== 1) return false;
	if ((arg.quasis[0].value.cooked ?? arg.quasis[0].value.raw) !== "") {
		return false;
	}
	return (
		(arg.quasis[1].value.cooked ?? arg.quasis[1].value.raw) ===
		ULTRACODE_MENU_XHIGH_QUASI_TAIL
	);
}

function isPatchedUltracodeMenuReturn(node: t.ReturnStatement): boolean {
	const arg = node.argument;
	if (!arg || !t.isConditionalExpression(arg)) return false;
	const test = arg.test;
	if (!isEnvComparison(test, ENV_EFFORT_LEVEL, "max", "===")) return false;
	if (!t.isTemplateLiteral(arg.consequent)) return false;
	const consequentTail =
		arg.consequent.quasis[1]?.value.cooked ??
		arg.consequent.quasis[1]?.value.raw;
	if (consequentTail !== ULTRACODE_MENU_MAX_QUASI_TAIL) return false;
	if (!t.isTemplateLiteral(arg.alternate)) return false;
	const alternateTail =
		arg.alternate.quasis[1]?.value.cooked ?? arg.alternate.quasis[1]?.value.raw;
	if (alternateTail !== ULTRACODE_MENU_XHIGH_QUASI_TAIL) return false;
	return true;
}

function buildUltracodeMenuConditional(
	original: t.TemplateLiteral,
): t.ConditionalExpression {
	const expr = t.cloneNode(original.expressions[0] as t.Expression);
	const maxTmpl = t.templateLiteral(
		[
			t.templateElement({ raw: "", cooked: "" }, false),
			t.templateElement(
				{
					raw: ULTRACODE_MENU_MAX_QUASI_TAIL,
					cooked: ULTRACODE_MENU_MAX_QUASI_TAIL,
				},
				true,
			),
		],
		[expr],
	);
	return t.conditionalExpression(
		buildEnvEffortLevelEqualsMaxCheck(),
		maxTmpl,
		t.cloneNode(original),
	);
}

function objectHasEffortStateUpdate(object: t.ObjectExpression): boolean {
	return Boolean(
		getObjectProp(object, "effortValue") && getObjectProp(object, "ultracode"),
	);
}

function expressionHasEffortStateUpdate(expr: t.Expression): boolean {
	let found = false;
	traverse(t.file(t.program([t.expressionStatement(t.cloneNode(expr))])), {
		ObjectExpression(path) {
			if (objectHasEffortStateUpdate(path.node)) found = true;
		},
	});
	return found;
}

function patchEffortStateUpdaterArrow(fn: t.ArrowFunctionExpression): boolean {
	if (t.isBlockStatement(fn.body)) {
		if (fn.body.body.some(isSessionOverrideStatement)) return true;
		const updatesEffortState = fn.body.body.some(
			(stmt) =>
				t.isReturnStatement(stmt) &&
				stmt.argument &&
				t.isExpression(stmt.argument) &&
				expressionHasEffortStateUpdate(stmt.argument),
		);
		if (!updatesEffortState) return false;
		fn.body.body.unshift(buildSessionOverrideStatement());
		return true;
	}
	if (t.isSequenceExpression(fn.body)) {
		if (fn.body.expressions.some(isSessionOverrideAssignment)) return true;
	}
	if (!expressionHasEffortStateUpdate(fn.body)) return false;
	fn.body = t.sequenceExpression([
		buildSessionOverrideAssignment(),
		t.cloneNode(fn.body),
	]);
	return true;
}

function patchEffortUpdateStateOverride(
	path: NodePath<t.IfStatement>,
): boolean | null {
	const test = path.node.test;
	if (!t.isMemberExpression(test)) return null;
	if (!t.isIdentifier(test.property, { name: "effortUpdate" })) return null;
	let found = false;
	path.traverse({
		ArrowFunctionExpression(arrowPath) {
			if (patchEffortStateUpdaterArrow(arrowPath.node)) found = true;
		},
	});
	return found ? true : null;
}

function hasPatchedEffortUpdateStateOverride(
	path: NodePath<t.IfStatement>,
): boolean {
	const test = path.node.test;
	if (!t.isMemberExpression(test)) return false;
	if (!t.isIdentifier(test.property, { name: "effortUpdate" })) return false;
	let found = false;
	path.traverse({
		ArrowFunctionExpression(arrowPath) {
			const body = arrowPath.node.body;
			if (
				t.isBlockStatement(body) &&
				body.body.some(isSessionOverrideStatement)
			) {
				found = true;
			}
			if (
				t.isSequenceExpression(body) &&
				body.expressions.some(isSessionOverrideAssignment)
			) {
				found = true;
			}
		},
	});
	return found;
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
): boolean {
	if (!t.isIfStatement(stmt)) return false;
	const test = stmt.test;
	if (!t.isMemberExpression(test)) return false;
	if (!t.isIdentifier(test.object, { name: resultName })) return false;
	if (!t.isIdentifier(test.property, { name: "effortUpdate" })) return false;
	const consequent = stmt.consequent;
	if (t.isBlockStatement(consequent)) {
		return consequent.body.some(isSessionOverrideStatement);
	}
	return isSessionOverrideStatement(consequent);
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

function patchEffortUpdateResultOverride(fn: t.Function): boolean | null {
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
					isSessionOverrideResultStatement(candidate, resultName),
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
					buildSessionOverrideStatement(),
				),
			);
			return true;
		}
	}
	return null;
}

function hasPatchedEffortUpdateResultOverride(fn: t.Function): boolean {
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
				isSessionOverrideResultStatement(candidate, resultName),
			);
		}
	}
	return false;
}

function isLegacyEffectiveEffortNoopGuard(node: t.IfStatement): boolean {
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

function isPatchedEffectiveEffortNoopGuard(node: t.IfStatement): boolean {
	if (!t.isLogicalExpression(node.test, { operator: "&&" })) return false;
	if (!t.isBinaryExpression(node.test.left, { operator: "===" })) return false;
	const right = node.test.right;
	if (!t.isUnaryExpression(right, { operator: "!" })) return false;
	const guard = right.argument;
	if (!t.isLogicalExpression(guard, { operator: "&&" })) return false;
	return (
		t.isBinaryExpression(guard.left, { operator: "!==" }) &&
		t.isBinaryExpression(guard.right, { operator: "!==" }) &&
		isProcessEnvMember(guard.left.left as t.Expression, ENV_EFFORT_LEVEL)
	);
}

function patchEffectiveEffortNoopGuard(node: t.IfStatement): boolean | null {
	if (isPatchedEffectiveEffortNoopGuard(node)) return true;
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
				buildRawEnvIsSetCheck(ENV_EFFORT_LEVEL),
				t.binaryExpression("!==", t.cloneNode(selected), t.cloneNode(current)),
			),
			true,
		),
	);
	return true;
}

function buildSingleExpressionTemplate(
	quasis: readonly [string, string],
	expr: t.Expression,
): t.TemplateLiteral {
	return t.templateLiteral(
		[
			t.templateElement({ raw: quasis[0], cooked: quasis[0] }, false),
			t.templateElement({ raw: quasis[1], cooked: quasis[1] }, true),
		],
		[expr],
	);
}

function isVoidZeroExpression(expr: t.Expression): boolean {
	return (
		t.isUnaryExpression(expr, { operator: "void" }) &&
		t.isNumericLiteral(expr.argument, { value: 0 })
	);
}

function getEnvOverrideIdentifier(test: t.Expression): string | null {
	if (!t.isLogicalExpression(test, { operator: "&&" })) return null;
	const left = test.left;
	const right = test.right;
	if (
		!t.isBinaryExpression(left, { operator: "!==" }) ||
		!t.isIdentifier(left.left) ||
		!isVoidZeroExpression(left.right as t.Expression)
	) {
		return null;
	}
	if (
		!t.isBinaryExpression(right, { operator: "!==" }) ||
		!t.isIdentifier(right.left, { name: left.left.name }) ||
		!t.isStringLiteral(right.right, { value: "xhigh" })
	) {
		return null;
	}
	return left.left.name;
}

function getConsequentIfStatement(
	path: NodePath<t.ReturnStatement>,
): t.IfStatement | null {
	const parent = path.parentPath;
	if (parent?.isIfStatement() && parent.node.consequent === path.node) {
		return parent.node;
	}
	if (!parent?.isBlockStatement()) return null;
	const maybeIf = parent.parentPath;
	if (maybeIf?.isIfStatement() && maybeIf.node.consequent === parent.node) {
		return maybeIf.node;
	}
	return null;
}

function getReturnMessageProp(
	node: t.ReturnStatement,
): t.ObjectProperty | null {
	const arg = node.argument;
	if (!arg || !t.isObjectExpression(arg)) return null;
	return getObjectProp(arg, "message");
}

function isUltracodeCommandStackedMessage(value: t.Expression): boolean {
	if (!t.isConditionalExpression(value)) return false;
	const test = value.test;
	if (
		!t.isBinaryExpression(test, { operator: "===" }) ||
		!t.isIdentifier(test.left) ||
		!t.isStringLiteral(test.right, { value: "max" })
	) {
		return false;
	}
	return (
		t.isTemplateLiteral(value.consequent) &&
		templateMatchesQuasiPattern(
			value.consequent,
			ULTRACODE_COMMAND_STACKED_QUASIS,
		) &&
		t.isTemplateLiteral(value.alternate) &&
		templateMatchesQuasiPattern(
			value.alternate,
			ULTRACODE_COMMAND_SESSION_QUASIS,
		)
	);
}

function patchUltracodeCommandEffortUpdateValue(
	returnNode: t.ReturnStatement,
	overrideIdentifier: string,
): void {
	const arg = returnNode.argument;
	if (!arg || !t.isObjectExpression(arg)) return;
	const effortUpdateProp = getObjectProp(arg, "effortUpdate");
	if (!effortUpdateProp || !t.isObjectExpression(effortUpdateProp.value))
		return;
	const valueProp = getObjectProp(effortUpdateProp.value, "value");
	if (!valueProp) return;
	if (
		t.isConditionalExpression(valueProp.value) &&
		t.isBinaryExpression(valueProp.value.test, { operator: "===" }) &&
		t.isIdentifier(valueProp.value.test.left, { name: overrideIdentifier }) &&
		t.isStringLiteral(valueProp.value.test.right, { value: "max" })
	) {
		return;
	}
	valueProp.value = t.conditionalExpression(
		t.binaryExpression(
			"===",
			t.identifier(overrideIdentifier),
			t.stringLiteral("max"),
		),
		t.stringLiteral("max"),
		t.stringLiteral("xhigh"),
	);
}

function isPatchedUltracodeCommandEffortUpdateValue(
	returnNode: t.ReturnStatement,
): boolean {
	const arg = returnNode.argument;
	if (!arg || !t.isObjectExpression(arg)) return false;
	const effortUpdateProp = getObjectProp(arg, "effortUpdate");
	if (!effortUpdateProp || !t.isObjectExpression(effortUpdateProp.value)) {
		return false;
	}
	const valueProp = getObjectProp(effortUpdateProp.value, "value");
	if (!valueProp) return false;
	const value = valueProp.value;
	return (
		t.isConditionalExpression(value) &&
		t.isBinaryExpression(value.test, { operator: "===" }) &&
		t.isIdentifier(value.test.left) &&
		t.isStringLiteral(value.test.right, { value: "max" }) &&
		t.isStringLiteral(value.consequent, { value: "max" }) &&
		t.isStringLiteral(value.alternate, { value: "xhigh" })
	);
}

function patchUltracodeCommandEnvMessage(
	path: NodePath<t.ReturnStatement>,
): boolean | null {
	const messageProp = getReturnMessageProp(path.node);
	if (!messageProp || !t.isExpression(messageProp.value)) return null;
	if (isUltracodeCommandStackedMessage(messageProp.value)) return true;
	if (
		!t.isTemplateLiteral(messageProp.value) ||
		!templateMatchesQuasiPattern(
			messageProp.value,
			ULTRACODE_COMMAND_ENV_OVERRIDE_ORIGINAL_QUASIS,
		)
	) {
		return null;
	}
	const containingIf = getConsequentIfStatement(path);
	if (!containingIf) return null;
	const overrideIdentifier = getEnvOverrideIdentifier(containingIf.test);
	if (!overrideIdentifier) return null;
	const envValue = buildProcessEnvMember(ENV_EFFORT_LEVEL);
	messageProp.value = t.conditionalExpression(
		t.binaryExpression(
			"===",
			t.identifier(overrideIdentifier),
			t.stringLiteral("max"),
		),
		buildSingleExpressionTemplate(
			ULTRACODE_COMMAND_STACKED_QUASIS,
			t.cloneNode(envValue),
		),
		buildSingleExpressionTemplate(
			ULTRACODE_COMMAND_SESSION_QUASIS,
			t.cloneNode(envValue),
		),
	);
	patchUltracodeCommandEffortUpdateValue(path.node, overrideIdentifier);
	return true;
}

function createEffortStackMutator(): Visitor {
	let patchedResolver = 0;
	let patchedNotification = 0;
	let patchedByz = 0;
	let patchedUyz = 0;
	let patchedHy8 = 0;
	let patchedUltracodeMenu = 0;
	let patchedActiveGate = 0;
	let patchedFlagSource = 0;
	let patchedEnvResolver = 0;
	let patchedSettingsWriter = 0;
	let patchedSessionOverrideUpdate = 0;
	let patchedEffectiveNoopGuard = 0;

	return {
		IfStatement(path) {
			const stateOverridePatched = patchEffortUpdateStateOverride(path);
			if (stateOverridePatched) {
				patchedSessionOverrideUpdate += 1;
				return;
			}
			const noopGuardPatched = patchEffectiveEffortNoopGuard(path.node);
			if (noopGuardPatched) {
				patchedEffectiveNoopGuard += 1;
				return;
			}
			if (isPatchedUltracodeResolver(path.node)) {
				patchedResolver += 1;
				return;
			}
			const match = isUltracodeForcesXhighGuard(path.node);
			if (!match) return;
			path.node.test = t.logicalExpression(
				"&&",
				t.logicalExpression(
					"||",
					t.cloneNode(path.node.test),
					buildEnvUltracodeEnabledCheck(),
				),
				buildEnvEffortLevelNotMaxCheck(),
			);
			patchedResolver += 1;
		},

		ObjectExpression(path) {
			const keyProp = getObjectProp(path.node, "key");
			const textProp = getObjectProp(path.node, "text");
			if (
				!keyProp ||
				!textProp ||
				!t.isStringLiteral(keyProp.value, { value: "ultrathink-active" }) ||
				!t.isStringLiteral(textProp.value)
			) {
				return;
			}
			if (textProp.value.value === MAX_NOTIFICATION_TEXT) {
				patchedNotification += 1;
				return;
			}
			textProp.value = t.stringLiteral(MAX_NOTIFICATION_TEXT);
			patchedNotification += 1;
		},

		TemplateLiteral(path) {
			if (
				templateMatchesQuasiPattern(
					path.node,
					EFFORT_COMMAND_ENV_OVERRIDE_PATCHED_QUASIS,
				)
			) {
				patchedUyz += 1;
				return;
			}
			if (
				templateMatchesQuasiPattern(
					path.node,
					EFFORT_SESSION_ONLY_ENV_OVERRIDE_PATCHED_QUASIS,
				)
			) {
				patchedUyz += 1;
				return;
			}
			if (
				templateMatchesQuasiPattern(
					path.node,
					EFFORT_AUTO_ENV_OVERRIDE_PATCHED_QUASIS,
				)
			) {
				patchedUyz += 1;
				return;
			}
			if (
				templateMatchesQuasiPattern(
					path.node,
					EFFORT_COMMAND_ENV_OVERRIDE_ORIGINAL_QUASIS,
				)
			) {
				setQuasiText(
					path.node,
					0,
					EFFORT_COMMAND_ENV_OVERRIDE_PATCHED_QUASIS[0],
				);
				setQuasiText(
					path.node,
					1,
					EFFORT_COMMAND_ENV_OVERRIDE_PATCHED_QUASIS[1],
				);
				setQuasiText(
					path.node,
					2,
					EFFORT_COMMAND_ENV_OVERRIDE_PATCHED_QUASIS[2],
				);
				patchedUyz += 1;
				return;
			}
			if (
				templateMatchesQuasiPattern(
					path.node,
					EFFORT_SESSION_ONLY_ENV_OVERRIDE_ORIGINAL_QUASIS,
				)
			) {
				setQuasiText(
					path.node,
					0,
					EFFORT_SESSION_ONLY_ENV_OVERRIDE_PATCHED_QUASIS[0],
				);
				setQuasiText(
					path.node,
					1,
					EFFORT_SESSION_ONLY_ENV_OVERRIDE_PATCHED_QUASIS[1],
				);
				setQuasiText(
					path.node,
					2,
					EFFORT_SESSION_ONLY_ENV_OVERRIDE_PATCHED_QUASIS[2],
				);
				patchedUyz += 1;
				return;
			}
			if (
				templateMatchesQuasiPattern(
					path.node,
					EFFORT_AUTO_ENV_OVERRIDE_ORIGINAL_QUASIS,
				)
			) {
				setQuasiText(path.node, 0, EFFORT_AUTO_ENV_OVERRIDE_PATCHED_QUASIS[0]);
				setQuasiText(path.node, 1, EFFORT_AUTO_ENV_OVERRIDE_PATCHED_QUASIS[1]);
				patchedUyz += 1;
				return;
			}
		},

		Function(path) {
			const envResolverPatched = patchEnvEffortResolverFunction(path.node);
			if (envResolverPatched) patchedEnvResolver += 1;
			const settingsWriterPatched = patchEffortSettingsWriterFunction(
				path.node,
			);
			if (settingsWriterPatched) patchedSettingsWriter += 1;
			const resultOverridePatched = patchEffortUpdateResultOverride(path.node);
			if (resultOverridePatched) patchedSessionOverrideUpdate += 1;
			const flagSourcePatched = patchRawUltracodeFlagFunction(path.node);
			if (flagSourcePatched) patchedFlagSource += 1;
			if (!isHy8FunctionByContent(path)) return;
			const body = path.node.body;
			if (!t.isBlockStatement(body)) return;
			if (body.body.length > 0 && isPatchedHy8FirstStatement(body.body[0])) {
				patchedHy8 += 1;
				return;
			}
			const activeTest = findCurrentEffortActiveTest(body);
			if (!activeTest) return;
			body.body.unshift(buildHy8StackingBranch(activeTest));
			patchedHy8 += 1;
		},

		ReturnStatement(path) {
			const commandMessagePatched = patchUltracodeCommandEnvMessage(path);
			if (commandMessagePatched) {
				patchedByz += 1;
				return;
			}
			if (isPatchedUltracodeActiveGate(path.node)) {
				patchedActiveGate += 1;
				return;
			}
			const legacyGate = isLegacyUltracodeActiveGate(path.node);
			if (legacyGate) {
				const workflowCalleeName = getWorkflowCalleeName(legacyGate);
				const availabilityHelperName =
					workflowCalleeName &&
					findUltracodeAvailabilityHelperName(path, workflowCalleeName);
				if (!availabilityHelperName) return;
				path.node.argument = buildPatchedUltracodeActiveGate(
					legacyGate,
					availabilityHelperName,
				);
				patchedActiveGate += 1;
				return;
			}
			if (isPatchedUltracodeMenuReturn(path.node)) {
				patchedUltracodeMenu += 1;
				return;
			}
			const arg = path.node.argument;
			if (!isLegacyUltracodeMenuReturnArg(arg)) return;
			path.node.argument = buildUltracodeMenuConditional(
				arg as t.TemplateLiteral,
			);
			patchedUltracodeMenu += 1;
		},

		Program: {
			exit() {
				if (patchedResolver === 0) {
					console.warn(
						"effort-stack: Could not find ultracode-forces-xhigh resolver guard",
					);
				}
				if (patchedNotification === 0) {
					console.warn(
						"effort-stack: Could not find ultrathink notification text",
					);
				}
				if (patchedByz === 0) {
					console.warn(
						"effort-stack: Could not find ultracode-picker override message",
					);
				}
				if (patchedUyz === 0) {
					console.warn(
						"effort-stack: Could not find effort-picker override message",
					);
				}
				if (patchedHy8 === 0) {
					console.warn(
						"effort-stack: Could not find current-effort display function",
					);
				}
				if (patchedUltracodeMenu === 0) {
					console.warn(
						"effort-stack: Could not find ultracode description template",
					);
				}
				if (patchedActiveGate === 0) {
					console.warn(
						"effort-stack: Could not find ultracode active-state gate",
					);
				}
				if (patchedFlagSource === 0) {
					console.warn(
						"effort-stack: Could not find ultracode settings/env source",
					);
				}
				if (patchedEnvResolver === 0) {
					console.warn("effort-stack: Could not find env effort resolver");
				}
				if (patchedSettingsWriter === 0) {
					console.warn("effort-stack: Could not find effort settings writer");
				}
				if (patchedSessionOverrideUpdate === 0) {
					console.warn(
						"effort-stack: Could not find effort session override updates",
					);
				}
				if (patchedEffectiveNoopGuard === 0) {
					console.warn(
						"effort-stack: Could not find effort picker no-op guard",
					);
				}
			},
		},
	};
}

export const effortStack: Patch = {
	tag: "effort-stack",

	astPasses: () => [
		{
			pass: "mutate",
			visitor: createEffortStackMutator(),
		},
	],

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) return "Unable to parse AST during verification";

		let hasLegacyResolver = false;
		let hasPatchedResolver = false;
		let hasMaxNotification = false;
		let hasPatchedByz = false;
		let hasPatchedCommandEffortValue = false;
		let hasLegacyByz = false;
		let hasPatchedUyz = false;
		let hasLegacyUyz = false;
		let hasPatchedHy8 = false;
		let hasPatchedUltracodeMenu = false;
		let hasLegacyUltracodeMenu = false;
		let hasLegacyActiveGate = false;
		let hasPatchedActiveGate = false;
		let hasPatchedFlagSource = false;
		let hasPatchedEnvResolver = false;
		let hasPatchedSettingsWriter = false;
		let hasPatchedSessionOverrideUpdate = false;
		let hasLegacyEffectiveNoopGuard = false;
		let hasPatchedEffectiveNoopGuard = false;

		traverse(verifyAst, {
			IfStatement(path) {
				if (hasPatchedEffortUpdateStateOverride(path)) {
					hasPatchedSessionOverrideUpdate = true;
				}
				if (isLegacyEffectiveEffortNoopGuard(path.node)) {
					hasLegacyEffectiveNoopGuard = true;
				}
				if (isPatchedEffectiveEffortNoopGuard(path.node)) {
					hasPatchedEffectiveNoopGuard = true;
				}
				if (isUltracodeForcesXhighGuard(path.node)) hasLegacyResolver = true;
				if (isPatchedUltracodeResolver(path.node)) hasPatchedResolver = true;
			},
			ObjectExpression(path) {
				const keyProp = getObjectProp(path.node, "key");
				const textProp = getObjectProp(path.node, "text");
				if (
					keyProp &&
					textProp &&
					t.isStringLiteral(keyProp.value, { value: "ultrathink-active" }) &&
					t.isStringLiteral(textProp.value, { value: MAX_NOTIFICATION_TEXT })
				) {
					hasMaxNotification = true;
				}
			},
			TemplateLiteral(path) {
				if (
					templateMatchesQuasiPattern(
						path.node,
						ULTRACODE_COMMAND_ENV_OVERRIDE_ORIGINAL_QUASIS,
					)
				) {
					hasLegacyByz = true;
				}
				if (
					templateMatchesQuasiPattern(
						path.node,
						EFFORT_COMMAND_ENV_OVERRIDE_PATCHED_QUASIS,
					)
				) {
					hasPatchedUyz = true;
				}
				if (
					templateMatchesQuasiPattern(
						path.node,
						EFFORT_SESSION_ONLY_ENV_OVERRIDE_PATCHED_QUASIS,
					)
				) {
					hasPatchedUyz = true;
				}
				if (
					templateMatchesQuasiPattern(
						path.node,
						EFFORT_AUTO_ENV_OVERRIDE_PATCHED_QUASIS,
					)
				) {
					hasPatchedUyz = true;
				}
				if (
					templateMatchesQuasiPattern(
						path.node,
						EFFORT_COMMAND_ENV_OVERRIDE_ORIGINAL_QUASIS,
					)
				) {
					hasLegacyUyz = true;
				}
				if (
					templateMatchesQuasiPattern(
						path.node,
						EFFORT_SESSION_ONLY_ENV_OVERRIDE_ORIGINAL_QUASIS,
					)
				) {
					hasLegacyUyz = true;
				}
				if (
					templateMatchesQuasiPattern(
						path.node,
						EFFORT_AUTO_ENV_OVERRIDE_ORIGINAL_QUASIS,
					)
				) {
					hasLegacyUyz = true;
				}
			},
			Function(path) {
				if (hasPatchedEnvEffortResolverFunction(path.node)) {
					hasPatchedEnvResolver = true;
				}
				if (hasPatchedEffortSettingsWriterFunction(path.node)) {
					hasPatchedSettingsWriter = true;
				}
				if (hasPatchedEffortUpdateResultOverride(path.node)) {
					hasPatchedSessionOverrideUpdate = true;
				}
				if (hasPatchedRawUltracodeFlagFunction(path.node)) {
					hasPatchedFlagSource = true;
				}
				if (!isHy8FunctionByContent(path)) return;
				const body = path.node.body;
				if (!t.isBlockStatement(body)) return;
				if (body.body.length > 0 && isPatchedHy8FirstStatement(body.body[0])) {
					hasPatchedHy8 = true;
				}
			},
			ReturnStatement(path) {
				if (isLegacyUltracodeActiveGate(path.node)) hasLegacyActiveGate = true;
				if (isPatchedUltracodeActiveGate(path.node)) {
					hasPatchedActiveGate = true;
				}
				const messageProp = getReturnMessageProp(path.node);
				if (
					messageProp &&
					t.isExpression(messageProp.value) &&
					isUltracodeCommandStackedMessage(messageProp.value)
				) {
					hasPatchedByz = true;
					if (isPatchedUltracodeCommandEffortUpdateValue(path.node)) {
						hasPatchedCommandEffortValue = true;
					}
				}
				if (isPatchedUltracodeMenuReturn(path.node)) {
					hasPatchedUltracodeMenu = true;
				}
				if (isLegacyUltracodeMenuReturnArg(path.node.argument)) {
					hasLegacyUltracodeMenu = true;
				}
			},
		});

		if (hasLegacyResolver) {
			return "Ultracode-forces-xhigh resolver still ignores CLAUDE_CODE_EFFORT_LEVEL=max";
		}
		if (!hasPatchedResolver) {
			return "Did not find patched ultracode resolver with env-var guard";
		}
		if (!hasMaxNotification) {
			return 'Did not find "Effort set to max for this turn" notification';
		}
		if (hasLegacyActiveGate) {
			return "Ultracode active-state gate still treats max effort as inactive";
		}
		if (!hasPatchedActiveGate) {
			return "Did not find patched ultracode active-state gate";
		}
		if (!hasPatchedFlagSource) {
			return `Did not find ${ENV_ULTRACODE} ultracode source`;
		}
		if (hasLegacyByz) {
			return "Ultracode command env-override message still hides stacked max behavior";
		}
		if (!hasPatchedByz) {
			return "Did not find env-aware ultracode command message";
		}
		if (!hasPatchedCommandEffortValue) {
			return "Did not find stacked-max ultracode command effortUpdate value";
		}
		if (!hasPatchedEnvResolver) {
			return "Did not find session override guard in env effort resolver";
		}
		if (!hasPatchedSettingsWriter) {
			return "Did not find env-scoped session-only effort settings guard";
		}
		if (!hasPatchedSessionOverrideUpdate) {
			return "Did not find /effort session override state update";
		}
		if (hasLegacyEffectiveNoopGuard) {
			return "Effort picker still treats env-overridden choices as no-ops";
		}
		if (!hasPatchedEffectiveNoopGuard) {
			return "Did not find patched effort picker no-op guard";
		}

		if (hasLegacyUyz) {
			return "Effort command env-override message still claims env controls this session";
		}
		if (!hasPatchedUyz) {
			return "Did not find session-aware effort command env override message";
		}
		if (!hasPatchedHy8) {
			console.warn(
				"effort-stack[soft]: current-effort env-stacking branch not present; /effort no-args display may understate the state",
			);
		}
		if (hasLegacyUltracodeMenu) {
			console.warn(
				"effort-stack[soft]: ultracode description anchor drifted; upstream 'xhigh effort' text returned",
			);
		} else if (!hasPatchedUltracodeMenu) {
			console.warn(
				"effort-stack[soft]: ultracode description anchor not found; menu sublabel may be stale",
			);
		}
		return true;
	},
};
