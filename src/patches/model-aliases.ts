import * as t from "@babel/types";
import { type NodePath, traverse } from "../babel.js";
import { parse } from "../loader.js";
import type { Patch, PatchAstPass } from "../types.js";
import {
	collectSubagentModelEnvArrays,
	getMemberPropertyName,
	getObjectKeyName,
	getVerifyAst,
	isSubagentModelEnvArray,
	SUBAGENT_MODEL_ENV,
} from "./ast-helpers.js";

const MODEL_ALIASES_ENV = "CLAUDE_CODE_MODEL_ALIASES";
const MODEL_NORMALIZER_CASES = [
	"fable",
	"opusplan",
	"sonnet",
	"haiku",
	"opus",
	"best",
] as const;
const RESERVED_ALIAS_NAMES = [
	"inherit",
	"fable",
	"opusplan",
	"sonnet",
	"haiku",
	"opus",
	"best",
] as const;
type MemberCall = t.CallExpression & { callee: t.MemberExpression };
type PatchSiteState = "patched" | "unpatched" | "other";

interface ModelNormalizerCandidate {
	path: NodePath<t.FunctionDeclaration>;
	parameterName: string;
	state: PatchSiteState;
}

interface TeammateResolverCandidate {
	path: NodePath<t.FunctionDeclaration>;
	explicitModelName: string;
	validationIndex: number;
	state: PatchSiteState;
}

interface TeammateResolverShape {
	path: NodePath<t.FunctionDeclaration>;
	explicitModelName: string;
	validationIndex: number;
}

interface WorkflowModelFormatterCandidate {
	path: NodePath<t.FunctionDeclaration>;
	displayResolver: t.ArrowFunctionExpression;
	displayParameterName: string;
	displayHelperName?: string;
	state: PatchSiteState;
}

function getMemberCall(
	node: t.Node | null | undefined,
	methodName: string,
): MemberCall | null {
	if (!t.isCallExpression(node) || !t.isMemberExpression(node.callee)) {
		return null;
	}
	if (getMemberPropertyName(node.callee) !== methodName) return null;
	return node as MemberCall;
}

function getStaticString(node: t.Node | null | undefined): string | null {
	if (t.isStringLiteral(node)) return node.value;
	if (
		t.isTemplateLiteral(node) &&
		node.expressions.length === 0 &&
		node.quasis.length === 1
	) {
		return node.quasis[0].value.cooked ?? node.quasis[0].value.raw;
	}
	return null;
}

function nodeContains(
	node: t.Node | null | undefined,
	predicate: (value: t.Node) => boolean,
): boolean {
	if (!node) return false;
	if (predicate(node)) return true;
	let found = false;
	t.traverseFast(node, (child) => {
		if (!found && predicate(child)) found = true;
	});
	return found;
}

function isProcessEnvMember(node: t.Node, envName: string): boolean {
	if (!t.isMemberExpression(node) || node.computed) return false;
	if (
		getObjectKeyName(node.property as t.Expression | t.Identifier) !== envName
	) {
		return false;
	}

	const envObject = node.object;
	if (!t.isMemberExpression(envObject) || envObject.computed) return false;
	if (
		getObjectKeyName(envObject.property as t.Expression | t.Identifier) !==
		"env"
	) {
		return false;
	}

	const processObject = envObject.object;
	if (t.isIdentifier(processObject, { name: "process" })) return true;
	return (
		t.isMemberExpression(processObject) &&
		!processObject.computed &&
		t.isIdentifier(processObject.object, { name: "globalThis" }) &&
		getObjectKeyName(processObject.property as t.Expression | t.Identifier) ===
			"process"
	);
}

function switchHasNormalizerCases(node: t.SwitchStatement): boolean {
	const cases = new Set(
		node.cases
			.map((switchCase) => getStaticString(switchCase.test))
			.filter((value): value is string => value !== null),
	);
	return MODEL_NORMALIZER_CASES.every((value) => cases.has(value));
}

function hasNormalizerSwitch(node: t.FunctionDeclaration): boolean {
	let matchingSwitches = 0;
	t.traverseFast(node.body, (child) => {
		if (t.isSwitchStatement(child) && switchHasNormalizerCases(child)) {
			matchingSwitches++;
		}
	});
	return matchingSwitches === 1;
}

function isModelNormalizerFunction(node: t.FunctionDeclaration): boolean {
	if (node.params.length !== 1 || !t.isIdentifier(node.params[0])) return false;
	const parameterName = node.params[0].name;
	const hasTrim = nodeContains(node.body, (child) => {
		const trimCall = getMemberCall(child, "trim");
		return (
			trimCall?.arguments.length === 0 &&
			t.isIdentifier(trimCall.callee.object, { name: parameterName })
		);
	});
	const hasContextSuffix = nodeContains(
		node.body,
		(child) => getStaticString(child) === "[1m]",
	);
	return hasTrim && hasContextSuffix && hasNormalizerSwitch(node);
}

function isIdentifierMethodCall(
	node: t.Node | null | undefined,
	objectName: string,
	methodName: string,
	argumentPredicates: Array<(argument: t.Node) => boolean> = [],
): boolean {
	const call = getMemberCall(node, methodName);
	return (
		call !== null &&
		t.isIdentifier(call.callee.object, { name: objectName }) &&
		call.arguments.length === argumentPredicates.length &&
		call.arguments.every((argument, index) =>
			argumentPredicates[index](argument),
		)
	);
}

function isTrimmedIdentifier(
	node: t.Node | null | undefined,
	identifierName: string,
): boolean {
	return isIdentifierMethodCall(node, identifierName, "trim");
}

function isLowercasedIdentifier(
	node: t.Node | null | undefined,
	identifierName: string,
): boolean {
	return isIdentifierMethodCall(node, identifierName, "toLowerCase");
}

function isTrimmedLowercasedIdentifier(
	node: t.Node | null | undefined,
	identifierName: string,
): boolean {
	const call = getMemberCall(node, "toLowerCase");
	return (
		call !== null &&
		call.arguments.length === 0 &&
		isTrimmedIdentifier(call.callee.object, identifierName)
	);
}

function getDirectDeclarators(
	statements: readonly t.Statement[],
): t.VariableDeclarator[] {
	return statements.flatMap((statement) =>
		t.isVariableDeclaration(statement) ? statement.declarations : [],
	);
}

function getUniqueDirectBinding(
	statements: readonly t.Statement[],
	predicate: (initializer: t.Expression | null | undefined) => boolean,
): string | null {
	const matches = getDirectDeclarators(statements).filter(
		(declarator) => t.isIdentifier(declarator.id) && predicate(declarator.init),
	);
	return matches.length === 1 && t.isIdentifier(matches[0].id)
		? matches[0].id.name
		: null;
}

function flattenLogicalOr(node: t.Expression): t.Expression[] {
	if (t.isLogicalExpression(node, { operator: "||" })) {
		return [...flattenLogicalOr(node.left), ...flattenLogicalOr(node.right)];
	}
	return [node];
}

function hasDirectThrow(node: t.Statement): boolean {
	if (t.isThrowStatement(node)) return true;
	return (
		t.isBlockStatement(node) &&
		node.body.some((statement) => t.isThrowStatement(statement))
	);
}

function hasThrowingGuard(
	statements: readonly t.Statement[],
	predicate: (test: t.Expression) => boolean,
): boolean {
	return statements.some(
		(statement) =>
			t.isIfStatement(statement) &&
			t.isExpression(statement.test) &&
			predicate(statement.test) &&
			hasDirectThrow(statement.consequent),
	);
}

function isReservedAliasIncludes(
	node: t.Node | null | undefined,
	identifierName: string,
): boolean {
	const call = getMemberCall(node, "includes");
	if (
		call?.arguments.length !== 1 ||
		!t.isIdentifier(call.arguments[0], { name: identifierName }) ||
		!t.isArrayExpression(call.callee.object)
	) {
		return false;
	}
	const values = call.callee.object.elements.map((element) =>
		t.isStringLiteral(element) ? element.value : null,
	);
	return (
		values.length === RESERVED_ALIAS_NAMES.length &&
		RESERVED_ALIAS_NAMES.every((value) => values.includes(value))
	);
}

function isStringIncludes(
	node: t.Node | null | undefined,
	identifierName: string,
	value: string,
): boolean {
	return isIdentifierMethodCall(node, identifierName, "includes", [
		(argument) => t.isStringLiteral(argument, { value }),
	]);
}

function getForOfBindingNames(node: t.ForOfStatement): string[] | null {
	if (
		!t.isVariableDeclaration(node.left) ||
		node.left.declarations.length !== 1
	) {
		return null;
	}
	const binding = node.left.declarations[0].id;
	if (t.isIdentifier(binding)) return [binding.name];
	if (!t.isArrayPattern(binding)) return null;
	const names = binding.elements.map((element) =>
		t.isIdentifier(element) ? element.name : null,
	);
	return names.every((name): name is string => name !== null) ? names : null;
}

function isObjectEntriesCall(
	node: t.Node | null | undefined,
	identifierName: string,
): boolean {
	if (!t.isCallExpression(node) || !t.isMemberExpression(node.callee)) {
		return false;
	}
	return (
		t.isIdentifier(node.callee.object, { name: "Object" }) &&
		getMemberPropertyName(node.callee) === "entries" &&
		node.arguments.length === 1 &&
		t.isIdentifier(node.arguments[0], { name: identifierName })
	);
}

function isAliasEnvPresenceTest(node: t.Expression): boolean {
	return (
		t.isBinaryExpression(node, { operator: "!==" }) &&
		isProcessEnvMember(node.left, MODEL_ALIASES_ENV) &&
		isVoidZero(node.right)
	);
}

function hasJsonParseGuard(
	statements: readonly t.Statement[],
	parsedName: string,
	rawName: string,
): boolean {
	return statements.some((statement) => {
		if (!t.isTryStatement(statement) || !statement.handler) return false;
		const parsesRawValue = nodeContains(
			statement.block,
			(child) =>
				t.isAssignmentExpression(child, { operator: "=" }) &&
				t.isIdentifier(child.left, { name: parsedName }) &&
				t.isCallExpression(child.right) &&
				t.isMemberExpression(child.right.callee) &&
				t.isIdentifier(child.right.callee.object, { name: "JSON" }) &&
				getMemberPropertyName(child.right.callee) === "parse" &&
				child.right.arguments.length === 1 &&
				t.isIdentifier(child.right.arguments[0], { name: rawName }),
		);
		return (
			parsesRawValue &&
			statement.handler.body.body.some((child) => t.isThrowStatement(child))
		);
	});
}

function hasParsedObjectGuard(
	statements: readonly t.Statement[],
	parsedName: string,
): boolean {
	return hasThrowingGuard(statements, (test) => {
		const terms = flattenLogicalOr(test);
		const rejectsNull = terms.some(
			(term) =>
				t.isBinaryExpression(term, { operator: "===" }) &&
				t.isIdentifier(term.left, { name: parsedName }) &&
				t.isNullLiteral(term.right),
		);
		const rejectsArray = terms.some(
			(term) =>
				t.isCallExpression(term) &&
				t.isMemberExpression(term.callee) &&
				t.isIdentifier(term.callee.object, { name: "Array" }) &&
				getMemberPropertyName(term.callee) === "isArray" &&
				term.arguments.length === 1 &&
				t.isIdentifier(term.arguments[0], { name: parsedName }),
		);
		const rejectsNonObject = terms.some(
			(term) =>
				t.isBinaryExpression(term, { operator: "!==" }) &&
				t.isUnaryExpression(term.left, { operator: "typeof" }) &&
				t.isIdentifier(term.left.argument, { name: parsedName }) &&
				t.isStringLiteral(term.right, { value: "object" }),
		);
		return rejectsNull && rejectsArray && rejectsNonObject;
	});
}

function hasAliasEntryValidation(
	loop: t.ForOfStatement,
	aliasesName: string,
): boolean {
	const bindingNames = getForOfBindingNames(loop);
	if (bindingNames?.length !== 2 || !t.isBlockStatement(loop.body)) {
		return false;
	}
	const [rawAliasName, rawTargetName] = bindingNames;
	const statements = loop.body.body;
	const aliasName = getUniqueDirectBinding(statements, (initializer) => {
		return isTrimmedLowercasedIdentifier(initializer, rawAliasName);
	});
	const targetName = getUniqueDirectBinding(statements, (initializer) =>
		isTrimmedIdentifier(initializer, rawTargetName),
	);
	if (!aliasName || !targetName) return false;
	const loweredTargetName = getUniqueDirectBinding(statements, (initializer) =>
		isLowercasedIdentifier(initializer, targetName),
	);
	if (!loweredTargetName) return false;

	const hasAliasNameGuard = hasThrowingGuard(statements, (test) => {
		const terms = flattenLogicalOr(test);
		return (
			terms.some(
				(term) =>
					t.isUnaryExpression(term, { operator: "!" }) &&
					t.isIdentifier(term.argument, { name: aliasName }),
			) && terms.some((term) => isStringIncludes(term, aliasName, "[1m]"))
		);
	});
	const hasReservedGuard = hasThrowingGuard(statements, (test) =>
		isReservedAliasIncludes(test, aliasName),
	);
	const hasDuplicateGuard = hasThrowingGuard(statements, (test) =>
		isIdentifierMethodCall(test, aliasesName, "has", [
			(argument) => t.isIdentifier(argument, { name: aliasName }),
		]),
	);
	const hasTargetTypeGuard = hasThrowingGuard(statements, (test) => {
		const terms = flattenLogicalOr(test);
		return (
			terms.some(
				(term) =>
					t.isBinaryExpression(term, { operator: "!==" }) &&
					t.isUnaryExpression(term.left, { operator: "typeof" }) &&
					t.isIdentifier(term.left.argument, { name: rawTargetName }) &&
					t.isStringLiteral(term.right, { value: "string" }),
			) &&
			terms.some(
				(term) =>
					t.isUnaryExpression(term, { operator: "!" }) &&
					isTrimmedIdentifier(term.argument, rawTargetName),
			)
		);
	});
	const hasTargetSuffixGuard = hasThrowingGuard(statements, (test) =>
		isStringIncludes(test, loweredTargetName, "[1m]"),
	);
	const storesAlias = nodeContains(loop.body, (child) =>
		isIdentifierMethodCall(child, aliasesName, "set", [
			(argument) => t.isIdentifier(argument, { name: aliasName }),
			(argument) => t.isIdentifier(argument, { name: targetName }),
		]),
	);
	return (
		hasAliasNameGuard &&
		hasReservedGuard &&
		hasDuplicateGuard &&
		hasTargetTypeGuard &&
		hasTargetSuffixGuard &&
		storesAlias
	);
}

function hasAliasTargetValidation(
	loop: t.ForOfStatement,
	aliasesName: string,
): boolean {
	const bindingNames = getForOfBindingNames(loop);
	if (bindingNames?.length !== 1 || !t.isBlockStatement(loop.body)) {
		return false;
	}
	const targetName = bindingNames[0];
	const statements = loop.body.body;
	const loweredTargetName = getUniqueDirectBinding(statements, (initializer) =>
		isLowercasedIdentifier(initializer, targetName),
	);
	if (!loweredTargetName) return false;
	return hasThrowingGuard(statements, (test) => {
		const terms = flattenLogicalOr(test);
		return (
			terms.some((term) =>
				isIdentifierMethodCall(term, aliasesName, "has", [
					(argument) => t.isIdentifier(argument, { name: loweredTargetName }),
				]),
			) &&
			terms.some((term) => isReservedAliasIncludes(term, loweredTargetName))
		);
	});
}

function hasGuardedAliasResolution(
	statements: readonly t.Statement[],
	aliasesName: string,
	parameterName: string,
): boolean {
	const resolvedName = getUniqueDirectBinding(statements, (initializer) =>
		isIdentifierMethodCall(initializer, aliasesName, "get", [
			(argument) => isTrimmedLowercasedIdentifier(argument, parameterName),
		]),
	);
	if (!resolvedName) return false;
	return statements.some((statement) => {
		if (
			!t.isIfStatement(statement) ||
			!t.isBinaryExpression(statement.test, { operator: "!==" }) ||
			!t.isIdentifier(statement.test.left, { name: resolvedName }) ||
			!isVoidZero(statement.test.right)
		) {
			return false;
		}
		const assignment = t.isBlockStatement(statement.consequent)
			? statement.consequent.body[0]
			: statement.consequent;
		return (
			t.isExpressionStatement(assignment) &&
			t.isAssignmentExpression(assignment.expression, { operator: "=" }) &&
			t.isIdentifier(assignment.expression.left, { name: parameterName }) &&
			t.isIdentifier(assignment.expression.right, { name: resolvedName })
		);
	});
}

function isAliasMapBranch(
	node: t.Node | null | undefined,
	parameterName: string,
): boolean {
	if (
		!t.isIfStatement(node) ||
		!t.isExpression(node.test) ||
		!isAliasEnvPresenceTest(node.test) ||
		!t.isBlockStatement(node.consequent)
	) {
		return false;
	}
	const statements = node.consequent.body;
	const rawName = getUniqueDirectBinding(statements, (initializer) =>
		initializer ? isProcessEnvMember(initializer, MODEL_ALIASES_ENV) : false,
	);
	const parsedName = getUniqueDirectBinding(
		statements,
		(initializer) => initializer === null,
	);
	const aliasesName = getUniqueDirectBinding(
		statements,
		(initializer) =>
			t.isNewExpression(initializer) &&
			t.isIdentifier(initializer.callee, { name: "Map" }) &&
			initializer.arguments.length === 0,
	);
	if (!rawName || !parsedName || !aliasesName) return false;
	if (
		!hasJsonParseGuard(statements, parsedName, rawName) ||
		!hasParsedObjectGuard(statements, parsedName)
	) {
		return false;
	}

	const entryLoops = statements.filter(
		(statement): statement is t.ForOfStatement =>
			t.isForOfStatement(statement) &&
			isObjectEntriesCall(statement.right, parsedName),
	);
	const targetLoops = statements.filter(
		(statement): statement is t.ForOfStatement =>
			t.isForOfStatement(statement) &&
			isIdentifierMethodCall(statement.right, aliasesName, "values"),
	);
	return (
		entryLoops.length === 1 &&
		targetLoops.length === 1 &&
		hasAliasEntryValidation(entryLoops[0], aliasesName) &&
		hasAliasTargetValidation(targetLoops[0], aliasesName) &&
		hasGuardedAliasResolution(statements, aliasesName, parameterName)
	);
}

function classifyModelNormalizer(
	path: NodePath<t.FunctionDeclaration>,
): ModelNormalizerCandidate | null {
	if (!path.node.id || !isModelNormalizerFunction(path.node)) return null;
	const parameter = path.node.params[0];
	if (!t.isIdentifier(parameter)) return null;
	const aliasBranches = path.node.body.body.filter((statement) =>
		isAliasMapBranch(statement, parameter.name),
	);
	const mentionsAliasEnv = nodeContains(path.node.body, (child) =>
		isProcessEnvMember(child, MODEL_ALIASES_ENV),
	);
	return {
		path,
		parameterName: parameter.name,
		state:
			aliasBranches.length === 1
				? "patched"
				: aliasBranches.length === 0 && !mentionsAliasEnv
					? "unpatched"
					: "other",
	};
}

function buildAliasMapBranch(
	path: NodePath<t.FunctionDeclaration>,
	parameterName: string,
): t.IfStatement {
	const rawName = path.scope.generateUidIdentifier("rawModelAliases").name;
	const parsedName =
		path.scope.generateUidIdentifier("parsedModelAliases").name;
	const aliasesName = path.scope.generateUidIdentifier("modelAliases").name;
	const rawAliasName = path.scope.generateUidIdentifier("rawAliasName").name;
	const rawTargetName = path.scope.generateUidIdentifier("rawAliasTarget").name;
	const aliasName = path.scope.generateUidIdentifier("aliasName").name;
	const targetName = path.scope.generateUidIdentifier("aliasTarget").name;
	const loweredTargetName =
		path.scope.generateUidIdentifier("loweredAliasTarget").name;
	const resolvedName =
		path.scope.generateUidIdentifier("resolvedModelAlias").name;
	const reserved = JSON.stringify(RESERVED_ALIAS_NAMES);
	const program = parse(`
if (process.env.${MODEL_ALIASES_ENV} !== void 0) {
  const ${rawName} = process.env.${MODEL_ALIASES_ENV};
  let ${parsedName};
  try {
    ${parsedName} = JSON.parse(${rawName});
  } catch {
    throw new Error("${MODEL_ALIASES_ENV} must be a valid JSON object mapping aliases to model IDs.");
  }
  if (${parsedName} === null || Array.isArray(${parsedName}) || typeof ${parsedName} !== "object") {
    throw new Error("${MODEL_ALIASES_ENV} must be a JSON object mapping aliases to model IDs.");
  }
  const ${aliasesName} = new Map();
  for (const [${rawAliasName}, ${rawTargetName}] of Object.entries(${parsedName})) {
    const ${aliasName} = ${rawAliasName}.trim().toLowerCase();
    if (!${aliasName} || ${aliasName}.includes("[1m]")) {
      throw new Error("${MODEL_ALIASES_ENV} alias names must be nonempty and cannot include [1m].");
    }
    if (${reserved}.includes(${aliasName})) {
      throw new Error("${MODEL_ALIASES_ENV} cannot override native model aliases or inherit.");
    }
    if (${aliasesName}.has(${aliasName})) {
      throw new Error("${MODEL_ALIASES_ENV} contains duplicate aliases after case-insensitive normalization.");
    }
    if (typeof ${rawTargetName} !== "string" || !${rawTargetName}.trim()) {
      throw new Error("${MODEL_ALIASES_ENV} targets must be nonempty model ID strings.");
    }
    const ${targetName} = ${rawTargetName}.trim();
    const ${loweredTargetName} = ${targetName}.toLowerCase();
    if (${loweredTargetName}.includes("[1m]")) {
      throw new Error("${MODEL_ALIASES_ENV} targets cannot include [1m].");
    }
    ${aliasesName}.set(${aliasName}, ${targetName});
  }
  for (const ${targetName} of ${aliasesName}.values()) {
    const ${loweredTargetName} = ${targetName}.toLowerCase();
    if (${aliasesName}.has(${loweredTargetName}) || ${reserved}.includes(${loweredTargetName})) {
      throw new Error("${MODEL_ALIASES_ENV} does not allow alias chaining or native alias targets.");
    }
  }
  const ${resolvedName} = ${aliasesName}.get(${parameterName}.trim().toLowerCase());
  if (${resolvedName} !== void 0) ${parameterName} = ${resolvedName};
}
`);
	const statement = program.program.body[0];
	if (!t.isIfStatement(statement)) {
		throw new Error("model-aliases: failed to build alias-map resolver");
	}
	return statement;
}

function isVoidZero(node: t.Node | null | undefined): boolean {
	return (
		t.isUnaryExpression(node, { operator: "void" }) &&
		t.isNumericLiteral(node.argument, { value: 0 })
	);
}

function flattenLogicalAnd(node: t.Expression): t.Expression[] {
	if (t.isLogicalExpression(node, { operator: "&&" })) {
		return [...flattenLogicalAnd(node.left), ...flattenLogicalAnd(node.right)];
	}
	return [node];
}

function isUndefinedComparison(
	node: t.Node,
	identifierName: string,
	operator: "!==" | "!=",
): boolean {
	if (!t.isBinaryExpression(node, { operator })) return false;
	return (
		(t.isIdentifier(node.left, { name: identifierName }) &&
			isVoidZero(node.right)) ||
		(t.isIdentifier(node.right, { name: identifierName }) &&
			isVoidZero(node.left))
	);
}

function isNegatedSingleArgumentCall(
	node: t.Node,
	identifierName: string,
): boolean {
	return (
		t.isUnaryExpression(node, { operator: "!" }) &&
		t.isCallExpression(node.argument) &&
		node.argument.arguments.length >= 1 &&
		t.isIdentifier(node.argument.arguments[0], { name: identifierName })
	);
}

function isExplicitModelValidation(
	node: t.Node,
	identifierName: string,
): boolean {
	if (!t.isLogicalExpression(node, { operator: "&&" })) return false;
	const operands = flattenLogicalAnd(node);
	return (
		operands.some(
			(operand) =>
				isUndefinedComparison(operand, identifierName, "!==") ||
				isUndefinedComparison(operand, identifierName, "!="),
		) &&
		operands.some((operand) =>
			isNegatedSingleArgumentCall(operand, identifierName),
		)
	);
}

function isInheritBranch(node: t.Node, identifierName: string): boolean {
	if (!t.isIfStatement(node) || !t.isBinaryExpression(node.test)) return false;
	if (node.test.operator !== "===" && node.test.operator !== "==") return false;
	return (
		(t.isIdentifier(node.test.left, { name: identifierName }) &&
			getStaticString(node.test.right) === "inherit") ||
		(t.isIdentifier(node.test.right, { name: identifierName }) &&
			getStaticString(node.test.left) === "inherit")
	);
}

function isExplicitModelNormalization(
	node: t.Node | null | undefined,
	explicitModelName: string,
	normalizerName: string,
): boolean {
	if (!t.isIfStatement(node)) return false;
	if (
		!t.isBinaryExpression(node.test, { operator: "===" }) ||
		!t.isUnaryExpression(node.test.left, { operator: "typeof" }) ||
		!t.isIdentifier(node.test.left.argument, { name: explicitModelName }) ||
		!t.isStringLiteral(node.test.right, { value: "string" })
	) {
		return false;
	}
	const statement = t.isBlockStatement(node.consequent)
		? node.consequent.body[0]
		: node.consequent;
	if (!t.isExpressionStatement(statement)) return false;
	const assignment = statement.expression;
	return (
		t.isAssignmentExpression(assignment, { operator: "=" }) &&
		t.isIdentifier(assignment.left, { name: explicitModelName }) &&
		t.isCallExpression(assignment.right) &&
		t.isIdentifier(assignment.right.callee, { name: normalizerName }) &&
		assignment.right.arguments.length === 1 &&
		t.isIdentifier(assignment.right.arguments[0], {
			name: explicitModelName,
		})
	);
}

function getTeammateResolverShape(
	path: NodePath<t.FunctionDeclaration>,
): TeammateResolverShape | null {
	const firstParameter = path.node.params[0];
	if (!t.isIdentifier(firstParameter) || path.node.params.length < 2) {
		return null;
	}
	const explicitModelName = firstParameter.name;
	if (
		!nodeContains(path.node.body, (child) =>
			isProcessEnvMember(child, SUBAGENT_MODEL_ENV),
		)
	) {
		return null;
	}
	const statements = path.node.body.body;
	if (
		!statements.some((statement) =>
			isInheritBranch(statement, explicitModelName),
		)
	) {
		return null;
	}
	const validationIndexes = statements
		.map((statement, index) =>
			t.isIfStatement(statement) &&
			isExplicitModelValidation(statement.test, explicitModelName)
				? index
				: -1,
		)
		.filter((index) => index >= 0);
	if (validationIndexes.length !== 1) return null;
	return {
		path,
		explicitModelName,
		validationIndex: validationIndexes[0],
	};
}

function classifyTeammateResolver(
	shape: TeammateResolverShape,
	normalizerName: string,
): TeammateResolverCandidate {
	const { path, explicitModelName, validationIndex } = shape;
	return {
		path,
		explicitModelName,
		validationIndex,
		state: isExplicitModelNormalization(
			path.node.body.body[validationIndex - 1],
			explicitModelName,
			normalizerName,
		)
			? "patched"
			: "unpatched",
	};
}

function buildExplicitModelNormalization(
	explicitModelName: string,
	normalizerName: string,
): t.IfStatement {
	const program = parse(`
if (typeof ${explicitModelName} === "string") {
  ${explicitModelName} = ${normalizerName}(${explicitModelName});
}
`);
	const statement = program.program.body[0];
	if (!t.isIfStatement(statement)) {
		throw new Error("model-aliases: failed to build teammate normalization");
	}
	return statement;
}

function getEnvironmentArrayState(node: t.ArrayExpression): PatchSiteState {
	const subagentIndexes: number[] = [];
	const aliasIndexes: number[] = [];
	for (const [index, element] of node.elements.entries()) {
		if (t.isStringLiteral(element, { value: SUBAGENT_MODEL_ENV })) {
			subagentIndexes.push(index);
		}
		if (t.isStringLiteral(element, { value: MODEL_ALIASES_ENV })) {
			aliasIndexes.push(index);
		}
	}
	if (subagentIndexes.length !== 1) return "other";
	if (aliasIndexes.length === 0) return "unpatched";
	return aliasIndexes.length === 1 && aliasIndexes[0] === subagentIndexes[0] + 1
		? "patched"
		: "other";
}

function patchEnvironmentArray(node: t.ArrayExpression): boolean {
	const state = getEnvironmentArrayState(node);
	if (state === "patched") return true;
	if (state !== "unpatched") return false;
	const index = node.elements.findIndex((element) =>
		t.isStringLiteral(element, { value: SUBAGENT_MODEL_ENV }),
	);
	if (index < 0) return false;
	node.elements.splice(index + 1, 0, t.stringLiteral(MODEL_ALIASES_ENV));
	return getEnvironmentArrayState(node) === "patched";
}

function getMemberObjectName(
	node: t.Node | null | undefined,
	propertyName: string,
): string | null {
	if (!t.isMemberExpression(node) || !t.isIdentifier(node.object)) return null;
	return getMemberPropertyName(node) === propertyName ? node.object.name : null;
}

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

function flattenNullish(node: t.Expression): t.Expression[] {
	if (t.isLogicalExpression(node, { operator: "??" })) {
		return [...flattenNullish(node.left), ...flattenNullish(node.right)];
	}
	return [node];
}

function getWorkflowFormatterReferenceCount(
	path: NodePath<t.FunctionDeclaration>,
): number {
	const functionName = path.node.id?.name;
	if (!functionName) return 0;
	const binding = path.scope.getBinding(functionName);
	if (!binding) return 0;
	return binding.referencePaths.filter((referencePath) => {
		const call = referencePath.parentPath?.node;
		if (
			!t.isCallExpression(call) ||
			call.callee !== referencePath.node ||
			call.arguments.length !== 2
		) {
			return false;
		}
		const modelObject = getMemberObjectName(call.arguments[0], "model");
		const fallbackObject = getMemberObjectName(
			call.arguments[1],
			"fallbackModel",
		);
		return modelObject !== null && modelObject === fallbackObject;
	}).length;
}

function classifyWorkflowModelFormatter(
	path: NodePath<t.FunctionDeclaration>,
): WorkflowModelFormatterCandidate | null {
	if (
		path.node.params.length !== 2 ||
		!t.isIdentifier(path.node.params[0]) ||
		!t.isIdentifier(path.node.params[1]) ||
		getWorkflowFormatterReferenceCount(path) !== 2
	) {
		return null;
	}
	const modelParameter = path.node.params[0];
	const fallbackParameter = path.node.params[1];
	const statements = path.node.body.body;
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
		!nodeContains(fallbackStatement.consequent, (child) =>
			isCallWithIdentifierArgument(child, resolverName, modelParameter.name),
		) ||
		!nodeContains(fallbackStatement.consequent, (child) =>
			isCallWithIdentifierArgument(child, resolverName, fallbackParameter.name),
		) ||
		!nodeContains(defaultStatement.argument, (child) =>
			isCallWithIdentifierArgument(child, resolverName, modelParameter.name),
		)
	) {
		return null;
	}
	const base = {
		path,
		displayResolver,
		displayParameterName,
	};
	if (isStockDisplayResolverBody(displayResolver.body, displayParameterName)) {
		return {
			...base,
			state: "unpatched",
		};
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
	return {
		...base,
		state: "other",
	};
}

function buildWorkflowAliasHelper(
	path: NodePath<t.FunctionDeclaration>,
): t.FunctionDeclaration {
	const displayHelperName = path.scope.generateUidIdentifier(
		"configuredModelAliasLabel",
	).name;
	const source = parse(`
function ${displayHelperName}(model) {
  if (typeof model !== "string" || process.env.${MODEL_ALIASES_ENV} === void 0) return;
  let aliases;
  try {
    aliases = JSON.parse(process.env.${MODEL_ALIASES_ENV});
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

function patchWorkflowModelFormatter(
	candidate: WorkflowModelFormatterCandidate,
	displayHelperName: string,
): boolean {
	if (candidate.state === "patched") return true;
	if (candidate.state !== "unpatched") return false;
	if (!t.isExpression(candidate.displayResolver.body)) return false;
	candidate.displayResolver.body = t.logicalExpression(
		"??",
		t.callExpression(t.identifier(displayHelperName), [
			t.identifier(candidate.displayParameterName),
		]),
		candidate.displayResolver.body,
	);
	candidate.displayHelperName = displayHelperName;
	candidate.state = "patched";
	return true;
}

function getFunctionBinding(
	path: NodePath<t.Node>,
	name: string | undefined,
): t.FunctionDeclaration | null {
	if (!name) return null;
	const binding = path.scope.getBinding(name);
	return binding && t.isFunctionDeclaration(binding.path.node)
		? binding.path.node
		: null;
}

function isAliasDisplayHelper(node: t.FunctionDeclaration | null): boolean {
	if (node?.params.length !== 1 || !t.isIdentifier(node.params[0])) {
		return false;
	}
	return (
		nodeContains(node.body, (child) =>
			isProcessEnvMember(child, MODEL_ALIASES_ENV),
		) &&
		nodeContains(node.body, (child) => isObjectEntriesCall(child, "aliases")) &&
		nodeContains(
			node.body,
			(child) => getMemberCall(child, "toUpperCase") !== null,
		)
	);
}

function createModelAliasPasses(): PatchAstPass[] {
	const modelNormalizers: ModelNormalizerCandidate[] = [];
	const teammateResolverShapes: TeammateResolverShape[] = [];
	const environmentArrays: t.ArrayExpression[] = [];
	const workflowModelFormatters: WorkflowModelFormatterCandidate[] = [];
	let normalizerPatched = false;
	let teammateResolverPatched = false;
	let environmentForwardingPatched = false;
	let workflowModelFormatterPatched = false;

	return [
		{
			pass: "discover",
			visitor: {
				FunctionDeclaration(path) {
					const candidate = classifyWorkflowModelFormatter(path);
					if (candidate) workflowModelFormatters.push(candidate);
				},
				SwitchStatement(path) {
					if (!switchHasNormalizerCases(path.node)) return;
					const functionPath = path.getFunctionParent();
					if (!functionPath || !t.isFunctionDeclaration(functionPath.node)) {
						return;
					}
					const candidate = classifyModelNormalizer(
						functionPath as NodePath<t.FunctionDeclaration>,
					);
					if (
						candidate &&
						!modelNormalizers.some(
							(existing) => existing.path.node === candidate.path.node,
						)
					) {
						modelNormalizers.push(candidate);
					}
				},
				MemberExpression(path) {
					if (!isProcessEnvMember(path.node, SUBAGENT_MODEL_ENV)) {
						return;
					}
					const functionPath = path.getFunctionParent();
					if (!functionPath || !t.isFunctionDeclaration(functionPath.node)) {
						return;
					}
					const candidate = getTeammateResolverShape(
						functionPath as NodePath<t.FunctionDeclaration>,
					);
					if (
						candidate &&
						!teammateResolverShapes.some(
							(existing) => existing.path.node === candidate.path.node,
						)
					) {
						teammateResolverShapes.push(candidate);
					}
				},
				ArrayExpression(path) {
					if (isSubagentModelEnvArray(path.node)) {
						environmentArrays.push(path.node);
					}
				},
			},
		},
		{
			pass: "mutate",
			visitor: {
				Program: {
					exit() {
						if (modelNormalizers.length !== 1) return;
						const normalizer = modelNormalizers[0];
						if (normalizer.state === "unpatched") {
							normalizer.path.node.body.body.unshift(
								buildAliasMapBranch(normalizer.path, normalizer.parameterName),
							);
							normalizer.state = "patched";
						}
						normalizerPatched = normalizer.state === "patched";

						const normalizerName = normalizer.path.node.id?.name;
						if (normalizerName) {
							const teammateResolvers = teammateResolverShapes.map(
								(candidate) =>
									classifyTeammateResolver(candidate, normalizerName),
							);
							if (teammateResolvers.length === 1) {
								const teammate = teammateResolvers[0];
								if (teammate.state === "unpatched") {
									teammate.path.node.body.body.splice(
										teammate.validationIndex,
										0,
										buildExplicitModelNormalization(
											teammate.explicitModelName,
											normalizerName,
										),
									);
									teammate.state = "patched";
								}
								teammateResolverPatched = teammate.state === "patched";
							}
						}

						environmentForwardingPatched =
							environmentArrays.length > 0 &&
							environmentArrays.every((array) => patchEnvironmentArray(array));

						if (workflowModelFormatters.length === 1) {
							const formatter = workflowModelFormatters[0];
							if (formatter.state === "unpatched") {
								const displayHelper = buildWorkflowAliasHelper(normalizer.path);
								normalizer.path.insertBefore(displayHelper);
								const displayHelperName = displayHelper.id?.name;
								if (displayHelperName) {
									workflowModelFormatterPatched = patchWorkflowModelFormatter(
										formatter,
										displayHelperName,
									);
								}
							} else {
								workflowModelFormatterPatched = formatter.state === "patched";
							}
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
						if (!normalizerPatched) {
							console.warn(
								`Model aliases: Could not patch the unique model normalizer (${modelNormalizers.length} candidates)`,
							);
						}
						if (!teammateResolverPatched) {
							console.warn(
								`Model aliases: Could not patch the unique teammate resolver (${teammateResolverShapes.length} candidates)`,
							);
						}
						if (!environmentForwardingPatched) {
							console.warn(
								`Model aliases: Could not forward the alias map to every subagent environment array (${environmentArrays.length} found)`,
							);
						}
						if (!workflowModelFormatterPatched) {
							console.warn(
								`Model aliases: Could not patch the unique workflow model formatter (${workflowModelFormatters.length} candidates)`,
							);
						}
					},
				},
			},
		},
	];
}

export const modelAliases: Patch = {
	tag: "model-aliases",
	astPasses: () => createModelAliasPasses(),
	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst)
			return "Unable to parse AST during model-aliases verification";
		const candidates: ModelNormalizerCandidate[] = [];
		const teammateResolverShapes: TeammateResolverShape[] = [];
		const environmentArrays = collectSubagentModelEnvArrays(verifyAst);
		const workflowModelFormatters: WorkflowModelFormatterCandidate[] = [];
		traverse(verifyAst, {
			FunctionDeclaration(path) {
				const candidate = classifyWorkflowModelFormatter(path);
				if (candidate) workflowModelFormatters.push(candidate);
			},
			SwitchStatement(path) {
				if (!switchHasNormalizerCases(path.node)) return;
				const functionPath = path.getFunctionParent();
				if (!functionPath || !t.isFunctionDeclaration(functionPath.node)) {
					return;
				}
				const candidate = classifyModelNormalizer(
					functionPath as NodePath<t.FunctionDeclaration>,
				);
				if (
					candidate &&
					!candidates.some(
						(existing) => existing.path.node === candidate.path.node,
					)
				) {
					candidates.push(candidate);
				}
			},
			MemberExpression(path) {
				if (!isProcessEnvMember(path.node, SUBAGENT_MODEL_ENV)) {
					return;
				}
				const functionPath = path.getFunctionParent();
				if (!functionPath || !t.isFunctionDeclaration(functionPath.node)) {
					return;
				}
				const candidate = getTeammateResolverShape(
					functionPath as NodePath<t.FunctionDeclaration>,
				);
				if (
					candidate &&
					!teammateResolverShapes.some(
						(existing) => existing.path.node === candidate.path.node,
					)
				) {
					teammateResolverShapes.push(candidate);
				}
			},
		});
		if (candidates.length !== 1) {
			return `Model normalizer is ambiguous or missing (${candidates.length} sites found)`;
		}
		if (candidates[0].state !== "patched") {
			return "Model normalizer does not resolve configured aliases";
		}
		const normalizerName = candidates[0].path.node.id?.name;
		if (!normalizerName)
			return "Model normalizer has no stable function binding";
		const teammateResolvers = teammateResolverShapes.map((candidate) =>
			classifyTeammateResolver(candidate, normalizerName),
		);
		if (teammateResolvers.length !== 1) {
			return `Teammate model resolver is ambiguous or missing (${teammateResolvers.length} sites found)`;
		}
		if (teammateResolvers[0].state !== "patched") {
			return "Teammate model resolver does not normalize explicit aliases";
		}
		if (environmentArrays.length === 0) {
			return "Subagent environment forwarding not found";
		}
		if (
			environmentArrays.some(
				(array) => getEnvironmentArrayState(array) !== "patched",
			)
		) {
			return "Subagent environment forwarding omits the model alias map";
		}
		if (workflowModelFormatters.length !== 1) {
			return `Workflow model formatter is ambiguous or missing (${workflowModelFormatters.length} sites found)`;
		}
		const workflowFormatter = workflowModelFormatters[0];
		if (workflowFormatter.state !== "patched") {
			return "Workflow model formatter does not display configured aliases";
		}
		const displayHelper = getFunctionBinding(
			workflowFormatter.path,
			workflowFormatter.displayHelperName,
		);
		if (!isAliasDisplayHelper(displayHelper)) {
			return "Workflow model formatter alias-label helper is missing or invalid";
		}
		return true;
	},
};
