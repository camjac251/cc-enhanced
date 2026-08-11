import * as t from "@babel/types";
import { traverse } from "../babel.js";
import { parse } from "../loader.js";

/**
 * Shared AST helpers for patch implementations and verifiers.
 */

/**
 * Child-process environment allowlist entry that gates whether a globally
 * configured subagent model name is forwarded to spawned children. Model-facing
 * patches append their own env keys into every forwarding array alongside this
 * entry, so they share this anchor and the array-discovery helpers below rather
 * than each carrying a private copy.
 */
export const SUBAGENT_MODEL_ENV = "CLAUDE_CODE_SUBAGENT_MODEL";

/**
 * Whether an ArrayExpression is one of the child-process env passthrough lists,
 * identified by carrying the SUBAGENT_MODEL_ENV string literal among its
 * elements. Count-agnostic: matches every such array wherever it appears.
 */
export function isSubagentModelEnvArray(
	node: t.Node | null | undefined,
): node is t.ArrayExpression {
	return (
		t.isArrayExpression(node) &&
		node.elements.some((element) =>
			t.isStringLiteral(element, { value: SUBAGENT_MODEL_ENV }),
		)
	);
}

/**
 * Collect every child-process env passthrough array in an AST. Returns the
 * ArrayExpression nodes in traversal order without asserting how many exist, so
 * patches append their keys to whatever forwarding arrays the current bundle
 * carries instead of hard-coding a count.
 */
export function collectSubagentModelEnvArrays(
	ast: t.File,
): t.ArrayExpression[] {
	const arrays: t.ArrayExpression[] = [];
	traverse(ast, {
		ArrayExpression(path) {
			if (isSubagentModelEnvArray(path.node)) arrays.push(path.node);
		},
	});
	return arrays;
}

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

function getReturnedSchemaFactory(
	property: t.ObjectProperty | null,
): t.Expression | null {
	if (!property || !t.isExpression(property.value)) return null;
	const value = property.value;
	if (t.isArrowFunctionExpression(value)) {
		if (t.isExpression(value.body)) return value.body;
		for (const statement of value.body.body) {
			if (
				t.isReturnStatement(statement) &&
				statement.argument &&
				t.isExpression(statement.argument)
			) {
				return statement.argument;
			}
		}
		return null;
	}
	if (!t.isFunctionExpression(value)) return null;
	for (const statement of value.body.body) {
		if (
			t.isReturnStatement(statement) &&
			statement.argument &&
			t.isExpression(statement.argument)
		) {
			return statement.argument;
		}
	}
	return null;
}

/**
 * Resolve the zero-argument schema factory beneath a `.describe(...)` call.
 * Supports both namespace members and direct factory functions.
 */
export function getDescribedSchemaFactory(
	expr: t.Expression,
): t.Expression | null {
	if (!t.isCallExpression(expr) || !t.isMemberExpression(expr.callee)) {
		return null;
	}
	if (!isMemberPropertyName(expr.callee, "describe")) return null;
	const schemaCall = expr.callee.object;
	if (!t.isCallExpression(schemaCall) || schemaCall.arguments.length !== 0) {
		return null;
	}
	return t.isExpression(schemaCall.callee) ? schemaCall.callee : null;
}

/**
 * Resolve a sibling schema factory from the same namespace or exported
 * factory table as an observed string factory.
 */
export function resolveSiblingSchemaFactory(
	ast: t.File,
	knownFactory: t.Expression,
	targetMethod: string,
): t.Expression | null {
	if (
		t.isMemberExpression(knownFactory) &&
		isMemberPropertyName(knownFactory, "string")
	) {
		return t.memberExpression(
			t.cloneNode(knownFactory.object, true) as t.Expression,
			t.identifier(targetMethod),
		);
	}
	if (!t.isIdentifier(knownFactory)) return null;

	let resolved: t.Expression | null = null;
	traverse(ast, {
		ObjectExpression(path) {
			if (resolved) return;
			const stringFactory = getReturnedSchemaFactory(
				getObjectPropertyByName(path.node, "string"),
			);
			if (!stringFactory || !t.isNodesEquivalent(stringFactory, knownFactory)) {
				return;
			}
			const targetFactory = getReturnedSchemaFactory(
				getObjectPropertyByName(path.node, targetMethod),
			);
			if (targetFactory) resolved = t.cloneNode(targetFactory, true);
		},
	});
	return resolved;
}

/**
 * Resolve the direct array factory from the string-list schema anchored by its
 * stable `lines` property. Other schema wrappers also accept a string schema
 * directly, so the argument shape alone is not unique.
 */
export function resolveDirectArraySchemaFactory(
	ast: t.File,
	knownStringFactory: t.Expression,
	preferredFactory?: t.Expression,
): t.Expression | null {
	const candidates: t.Expression[] = [];
	traverse(ast, {
		CallExpression(path) {
			if (!t.isObjectProperty(path.parent)) return;
			if (getObjectKeyName(path.parent.key) !== "lines") return;
			if (path.node.arguments.length !== 1) return;
			const [argument] = path.node.arguments;
			if (
				!t.isCallExpression(argument) ||
				argument.arguments.length !== 0 ||
				!t.isNodesEquivalent(argument.callee, knownStringFactory) ||
				!t.isExpression(path.node.callee)
			) {
				return;
			}
			if (
				!candidates.some((candidate) =>
					t.isNodesEquivalent(candidate, path.node.callee),
				)
			) {
				candidates.push(t.cloneNode(path.node.callee, true));
			}
		},
	});
	if (preferredFactory) {
		return (
			candidates.find((candidate) =>
				t.isNodesEquivalent(candidate, preferredFactory),
			) ?? null
		);
	}
	return candidates.length === 1 ? candidates[0] : null;
}

function isFalseSchemaDefault(node: t.Node): boolean {
	return (
		t.isBooleanLiteral(node, { value: false }) ||
		(t.isUnaryExpression(node, { operator: "!" }) &&
			t.isNumericLiteral(node.argument, { value: 1 }))
	);
}

/** Resolve a boolean factory from a schema chain containing `.default(false)`. */
export function getDefaultedBooleanSchemaFactory(
	expr: t.Expression,
): t.Expression | null {
	const candidates: t.Expression[] = [];
	t.traverseFast(expr, (node) => {
		if (!t.isCallExpression(node) || !t.isMemberExpression(node.callee)) return;
		if (!isMemberPropertyName(node.callee, "default")) return;
		if (
			node.arguments.length !== 1 ||
			!isFalseSchemaDefault(node.arguments[0])
		) {
			return;
		}
		const receiver = node.callee.object;
		if (
			!t.isCallExpression(receiver) ||
			receiver.arguments.length !== 0 ||
			!t.isExpression(receiver.callee)
		) {
			return;
		}
		if (
			!candidates.some((candidate) =>
				t.isNodesEquivalent(candidate, receiver.callee),
			)
		) {
			candidates.push(t.cloneNode(receiver.callee, true));
		}
	});
	return candidates.length === 1 ? candidates[0] : null;
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

/**
 * Get the name of a function or the identifier it is assigned to.
 */
export function getCallableFunctionName(path: any): string | null {
	const node = path.node;
	if (t.isFunctionDeclaration(node) && node.id?.name) return node.id.name;
	if (t.isFunctionExpression(node) && node.id?.name) return node.id.name;

	const parent = path.parentPath;
	if (
		parent?.isVariableDeclarator() &&
		t.isIdentifier(parent.node.id) &&
		parent.node.init === node
	) {
		return parent.node.id.name;
	}
	if (
		parent?.isAssignmentExpression() &&
		t.isIdentifier(parent.node.left) &&
		parent.node.right === node
	) {
		return parent.node.left.name;
	}
	return null;
}
