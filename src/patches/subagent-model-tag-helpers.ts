import * as t from "@babel/types";
import { getMemberPropertyName } from "./ast-helpers.js";

/**
 * Check if a node or any of its descendants match a predicate.
 */
export function nodeContains(
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

export function isVoidZero(node: t.Node | null | undefined): boolean {
	return (
		t.isIdentifier(node, { name: "undefined" }) ||
		(t.isUnaryExpression(node, { operator: "void" }) &&
			t.isNumericLiteral(node.argument, { value: 0 }))
	);
}

export function isMetadataPropertyExpression(
	node: t.Node | null | undefined,
	metadataName: string,
	propertyName: string,
): boolean {
	// Only OptionalMemberExpression carries optional-chain semantics; a plain
	// MemberExpression is never an optional read.
	return (
		t.isOptionalMemberExpression(node) &&
		t.isIdentifier(node.object, { name: metadataName }) &&
		getMemberPropertyName(node) === propertyName
	);
}

export function getOptionalMemberBase(
	node: t.Node | null | undefined,
	propertyName: string,
): string | null {
	if (!t.isOptionalMemberExpression(node)) {
		return null;
	}
	if (getMemberPropertyName(node) !== propertyName || node.optional !== true) {
		return null;
	}
	return t.isIdentifier(node.object) ? node.object.name : null;
}
