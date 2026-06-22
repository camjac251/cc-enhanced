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
 * Use inside an ObjectExpression visitor. Returns the node or null.
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
 * Skips ObjectMethod nodes. Use `findToolMethod` when methods are expected.
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
 * Recognized React element-factory member names across the classic runtime
 * (`X.createElement(type, props, ...children)`) and the automatic JSX runtime
 * (`X.jsx(type, props)` / `X.jsxs(type, props)`). The bundle is transpiled with
 * the automatic runtime, so render code uses `jsx`/`jsxs`; `createElement`
 * stays recognized purely as a generic AST shape, not a per-patch fallback.
 */
const ELEMENT_FACTORY_NAMES = new Set(["createElement", "jsx", "jsxs"]);

/**
 * Check whether a node is a React element-factory call, runtime-agnostic.
 * Anchors on the callee's member-property name only; the receiving object is
 * minified and must never be matched on.
 */
export function isElementCall(
	node: t.Node | null | undefined,
): node is t.CallExpression {
	if (!t.isCallExpression(node)) return false;
	const callee = node.callee;
	if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) {
		return false;
	}
	const name = getMemberPropertyName(callee);
	return name !== null && ELEMENT_FACTORY_NAMES.has(name);
}

/**
 * The element type/component argument (arguments[0]) of an element-factory call.
 */
export function getElementType(node: t.CallExpression): t.Node | null {
	return node.arguments[0] ?? null;
}

/**
 * The props ObjectExpression (arguments[1]) of an element-factory call, if it is
 * an object literal. Returns null for spread-only or absent props.
 */
export function getElementProps(
	node: t.CallExpression,
): t.ObjectExpression | null {
	const props = node.arguments[1];
	return t.isObjectExpression(props) ? props : null;
}

/**
 * Children of an element-factory call, normalized across runtimes:
 *  - createElement(type, props, ...children): positional arguments after props.
 *  - jsx/jsxs(type, props): the `children` property of props, flattened when it
 *    is an array literal (the `jsxs` multi-child form), else the single value.
 */
export function getElementChildren(node: t.CallExpression): t.Expression[] {
	const callee = node.callee;
	const name =
		t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)
			? getMemberPropertyName(callee)
			: null;
	if (name === "createElement") {
		return node.arguments
			.slice(2)
			.filter((a): a is t.Expression => t.isExpression(a));
	}
	const props = getElementProps(node);
	if (!props) return [];
	const childrenProp = getObjectPropertyByName(props, "children");
	if (!childrenProp) return [];
	const value = childrenProp.value;
	if (t.isArrayExpression(value)) {
		return value.elements.filter(
			(e): e is t.Expression => e != null && t.isExpression(e),
		);
	}
	return t.isExpression(value) ? [value] : [];
}

/**
 * Append a child expression to an element-factory call, runtime-agnostic:
 *  - createElement(type, props, ...children): push as a trailing positional arg.
 *  - jsx/jsxs(type, props): push into the props `children` array, promoting a
 *    single `children` value to an array first, or adding a `children` property
 *    when absent. Returns false when props is not an object literal.
 */
export function appendElementChild(
	call: t.CallExpression,
	child: t.Expression,
): boolean {
	const callee = call.callee;
	const name =
		t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)
			? getMemberPropertyName(callee)
			: null;
	if (name === "createElement") {
		call.arguments.push(child);
		return true;
	}
	const props = getElementProps(call);
	if (!props) return false;
	const childrenProp = getObjectPropertyByName(props, "children");
	if (!childrenProp) {
		props.properties.push(t.objectProperty(t.identifier("children"), child));
		return true;
	}
	const value = childrenProp.value;
	if (t.isArrayExpression(value)) {
		value.elements.push(child);
		return true;
	}
	if (t.isExpression(value)) {
		childrenProp.value = t.arrayExpression([value, child]);
		return true;
	}
	return false;
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
