import * as t from "@babel/types";
import { parse } from "../loader.js";

export type WorkflowModelFormatterState = "patched" | "unpatched" | "other";

export interface WorkflowModelFormatterProjection {
	displayResolver: t.ArrowFunctionExpression;
	displayParameterName: string;
	displayHelperName?: string;
	state: WorkflowModelFormatterState;
}

type NodeContains = (
	node: t.Node | null | undefined,
	predicate: (value: t.Node) => boolean,
) => boolean;

function isNonNullComparison(
	node: t.Node | null | undefined,
	identifierName: string,
): boolean {
	if (
		!t.isBinaryExpression(node) ||
		(node.operator !== "!=" && node.operator !== "!==")
	) {
		return false;
	}
	return (
		(t.isIdentifier(node.left, { name: identifierName }) &&
			t.isNullLiteral(node.right)) ||
		(t.isIdentifier(node.right, { name: identifierName }) &&
			t.isNullLiteral(node.left))
	);
}

function isCallWithIdentifierArgument(
	node: t.Node | null | undefined,
	calleeName: string,
	argumentName: string,
): boolean {
	return (
		t.isCallExpression(node) &&
		t.isIdentifier(node.callee, { name: calleeName }) &&
		node.arguments.length === 1 &&
		t.isIdentifier(node.arguments[0], { name: argumentName })
	);
}

function flattenNullish(node: t.Expression): t.Expression[] {
	if (t.isLogicalExpression(node, { operator: "??" })) {
		return [...flattenNullish(node.left), ...flattenNullish(node.right)];
	}
	return [node];
}

function isStockDisplayResolverBody(
	node: t.Node | null | undefined,
	parameterName: string,
): boolean {
	if (!t.isExpression(node)) return false;
	const operands = flattenNullish(node);
	return (
		operands.length === 2 &&
		t.isCallExpression(operands[0]) &&
		operands[0].arguments.length === 1 &&
		t.isIdentifier(operands[0].arguments[0], { name: parameterName }) &&
		t.isIdentifier(operands[1], { name: parameterName })
	);
}

export function projectWorkflowModelFormatter(
	node: t.FunctionDeclaration,
	referenceCount: number,
	contains: NodeContains,
): WorkflowModelFormatterProjection | null {
	if (
		node.params.length !== 2 ||
		!t.isIdentifier(node.params[0]) ||
		!t.isIdentifier(node.params[1]) ||
		referenceCount !== 2
	) {
		return null;
	}
	const modelParameter = node.params[0];
	const fallbackParameter = node.params[1];
	const statements = node.body.body;
	if (statements.length !== 3) return null;
	const [resolverStatement, fallbackStatement, defaultStatement] = statements;
	if (
		!t.isVariableDeclaration(resolverStatement) ||
		resolverStatement.declarations.length !== 1 ||
		!t.isIdentifier(resolverStatement.declarations[0].id) ||
		!t.isArrowFunctionExpression(resolverStatement.declarations[0].init) ||
		resolverStatement.declarations[0].init.params.length !== 1 ||
		!t.isIdentifier(resolverStatement.declarations[0].init.params[0]) ||
		!t.isIfStatement(fallbackStatement) ||
		!t.isReturnStatement(defaultStatement)
	) {
		return null;
	}
	if (!isNonNullComparison(fallbackStatement.test, fallbackParameter.name)) {
		return null;
	}
	const resolverName = resolverStatement.declarations[0].id.name;
	const displayResolver = resolverStatement.declarations[0].init;
	const displayParameter = displayResolver.params[0];
	if (!t.isIdentifier(displayParameter)) return null;
	const displayParameterName = displayParameter.name;
	if (
		!contains(fallbackStatement.consequent, (child) =>
			isCallWithIdentifierArgument(child, resolverName, modelParameter.name),
		) ||
		!contains(fallbackStatement.consequent, (child) =>
			isCallWithIdentifierArgument(child, resolverName, fallbackParameter.name),
		) ||
		!contains(defaultStatement.argument, (child) =>
			isCallWithIdentifierArgument(child, resolverName, modelParameter.name),
		)
	) {
		return null;
	}
	const base = { displayResolver, displayParameterName };
	if (isStockDisplayResolverBody(displayResolver.body, displayParameterName)) {
		return { ...base, state: "unpatched" };
	}
	const displayOperands = t.isExpression(displayResolver.body)
		? flattenNullish(displayResolver.body)
		: [];
	if (
		displayOperands.length === 3 &&
		t.isCallExpression(displayOperands[0]) &&
		t.isIdentifier(displayOperands[0].callee) &&
		displayOperands[0].arguments.length === 1 &&
		t.isIdentifier(displayOperands[0].arguments[0], {
			name: displayParameterName,
		}) &&
		t.isCallExpression(displayOperands[1]) &&
		displayOperands[1].arguments.length === 1 &&
		t.isIdentifier(displayOperands[1].arguments[0], {
			name: displayParameterName,
		}) &&
		t.isIdentifier(displayOperands[2], { name: displayParameterName })
	) {
		return {
			...base,
			displayHelperName: displayOperands[0].callee.name,
			state: "patched",
		};
	}
	return { ...base, state: "other" };
}

export function buildWorkflowAliasHelper(
	displayHelperName: string,
	modelAliasesEnv: string,
): t.FunctionDeclaration {
	const source = parse(`
function ${displayHelperName}(model) {
  if (typeof model !== "string" || process.env.${modelAliasesEnv} === void 0) return;
  let aliases;
  try {
    aliases = JSON.parse(process.env.${modelAliasesEnv});
  } catch {
    return;
  }
  if (aliases === null || Array.isArray(aliases) || typeof aliases !== "object") return;
  for (const [rawAlias, rawTarget] of Object.entries(aliases)) {
    if (typeof rawTarget !== "string" || rawTarget.trim() !== model.trim()) continue;
    const alias = rawAlias.trim();
    if (!alias) return;
    return alias.charAt(0).toUpperCase() + alias.slice(1);
  }
}
`);
	const displayHelper = source.program.body[0];
	if (!t.isFunctionDeclaration(displayHelper)) {
		throw new Error("model-aliases: failed to build workflow model helper");
	}
	return displayHelper;
}

export function buildWorkflowDisplayResolverBody(
	displayHelperName: string,
	displayParameterName: string,
	stockBody: t.Expression,
): t.LogicalExpression {
	return t.logicalExpression(
		"??",
		t.callExpression(t.identifier(displayHelperName), [
			t.identifier(displayParameterName),
		]),
		stockBody,
	);
}

export function isWorkflowAliasDisplayHelper(
	node: t.FunctionDeclaration | null,
	contains: NodeContains,
	isModelAliasEnvironmentMember: (node: t.Node) => boolean,
	isAliasesEntriesCall: (node: t.Node) => boolean,
	isUppercaseCall: (node: t.Node) => boolean,
): boolean {
	if (node?.params.length !== 1 || !t.isIdentifier(node.params[0])) {
		return false;
	}
	return (
		contains(node.body, isModelAliasEnvironmentMember) &&
		contains(node.body, isAliasesEntriesCall) &&
		contains(node.body, isUppercaseCall)
	);
}
