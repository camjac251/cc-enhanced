import * as t from "@babel/types";
import { parse } from "../loader.js";

/**
 * Shared AST helpers for patch implementations and verifiers.
 */

/**
 * Resolve object/member key name for Identifier or StringLiteral keys.
 */
export function getObjectKeyName(
	key: t.Expression | t.PrivateName | t.Identifier,
): string | null {
	if (t.isIdentifier(key)) return key.name;
	if (t.isStringLiteral(key)) return key.value;
	return null;
}

/**
 * Resolve a node to its string value, following single-level identifier bindings.
 */
export function resolveStringValue(
	path: any,
	node: t.Expression | t.Pattern | null | undefined,
): string | null {
	if (!node) return null;
	if (t.isStringLiteral(node)) return node.value;
	if (t.isTemplateLiteral(node) && node.expressions.length === 0) {
		return node.quasis
			.map((quasi) => quasi.value.cooked ?? quasi.value.raw)
			.join("");
	}
	if (t.isIdentifier(node)) {
		const binding = path.scope.getBinding(node.name);
		if (binding && t.isVariableDeclarator(binding.path.node)) {
			const init = binding.path.node.init;
			if (t.isExpression(init)) {
				return resolveStringValue(path, init);
			}
		}
	}
	return null;
}

/**
 * Check if a node represents a false-like value: `false` or `!1`.
 */
export function isFalseLike(node: t.Node | null | undefined): boolean {
	if (!node) return false;
	if (t.isBooleanLiteral(node, { value: false })) return true;
	return (
		t.isUnaryExpression(node, { operator: "!" }) &&
		t.isNumericLiteral(node.argument, { value: 1 })
	);
}

/**
 * Check if a node represents a true-like value: `true` or `!0`.
 */
export function isTrueLike(node: t.Node | null | undefined): boolean {
	if (!node) return false;
	if (t.isBooleanLiteral(node, { value: true })) return true;
	return (
		t.isUnaryExpression(node, { operator: "!" }) &&
		t.isNumericLiteral(node.argument, { value: 0 })
	);
}

/**
 * Check if an ObjectExpression has a `name` property resolving to `toolName`.
 * Use inside an ObjectExpression visitor — returns the node or null.
 */
export function findToolObject(
	path: { node: t.ObjectExpression; scope: any },
	toolName: string,
): t.ObjectExpression | null {
	const props = path.node.properties;
	const nameProp = props.find(
		(p): p is t.ObjectProperty =>
			t.isObjectProperty(p) && getObjectKeyName(p.key) === "name",
	);
	if (!nameProp) return null;
	const nameVal = resolveStringValue(path, nameProp.value as t.Expression);
	if (nameVal !== toolName) return null;
	return path.node;
}

/**
 * Find an ObjectMethod or ObjectProperty by key name on a tool object.
 */
export function findToolMethod(
	toolNode: t.ObjectExpression,
	methodName: string,
): t.ObjectMethod | t.ObjectProperty | null {
	for (const prop of toolNode.properties) {
		if (
			(t.isObjectMethod(prop) || t.isObjectProperty(prop)) &&
			getObjectKeyName(prop.key) === methodName
		) {
			return prop;
		}
	}
	return null;
}

/**
 * Check if an ObjectProperty/ObjectMethod has the given key name.
 * Accepts SpreadElement/RestElement for convenience in .properties iterations
 * (always returns false for non-keyed nodes).
 */
export function hasObjectKeyName(
	prop: t.ObjectProperty | t.ObjectMethod | t.SpreadElement | t.RestElement,
	keyName: string,
): boolean {
	return (
		(t.isObjectProperty(prop) || t.isObjectMethod(prop)) &&
		getObjectKeyName(prop.key) === keyName
	);
}

/**
 * Get the property name from a MemberExpression/OptionalMemberExpression.
 */
export function getMemberPropertyName(
	member: t.MemberExpression | t.OptionalMemberExpression,
): string | null {
	if (t.isIdentifier(member.property)) return member.property.name;
	if (t.isStringLiteral(member.property)) return member.property.value;
	return null;
}

/**
 * Check if a MemberExpression/OptionalMemberExpression accesses the given property name.
 */
export function isMemberPropertyName(
	member: t.MemberExpression | t.OptionalMemberExpression,
	propertyName: string,
): boolean {
	return getMemberPropertyName(member) === propertyName;
}

/**
 * Find an ObjectProperty by key name in an ObjectExpression.
 * Skips ObjectMethod nodes — use `findToolMethod` when methods are expected.
 */
export function getObjectPropertyByName(
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

/**
 * Parse code into AST, returning null on parse failure. Convenience for verifiers.
 */
export function getVerifyAst(code: string, ast?: t.File): t.File | null {
	if (ast) return ast;
	try {
		return parse(code);
	} catch {
		return null;
	}
}

/**
 * Check if an ObjectPattern destructuring has a property with the given key name.
 */
export function objectPatternHasKey(
	pattern: t.ObjectPattern,
	keyName: string,
): boolean {
	return pattern.properties.some((prop) => {
		if (!t.isObjectProperty(prop)) return false;
		if (t.isIdentifier(prop.key, { name: keyName })) return true;
		return t.isStringLiteral(prop.key, { value: keyName });
	});
}
