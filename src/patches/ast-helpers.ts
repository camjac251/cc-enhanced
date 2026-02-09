import * as t from "@babel/types";

/**
 * Shared AST helpers for patch implementations and verifiers.
 */

/**
 * Resolve a node to its string value, following single-level identifier bindings.
 */
export function resolveStringValue(
	path: any,
	node: t.Expression | t.Pattern | null | undefined,
): string | null {
	if (!node) return null;
	if (t.isStringLiteral(node)) return node.value;
	if (t.isIdentifier(node)) {
		const binding = path.scope.getBinding(node.name);
		if (binding && t.isVariableDeclarator(binding.path.node)) {
			const init = binding.path.node.init;
			if (t.isStringLiteral(init)) return init.value;
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
