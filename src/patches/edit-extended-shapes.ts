import * as t from "@babel/types";
import { getObjectKeyName, hasObjectKeyName } from "./ast-helpers.js";

export function visitNodeValues(
	value: unknown,
	visit: (node: t.Node) => boolean,
): boolean {
	if (!value) return false;
	if (Array.isArray(value)) {
		return value.some((item) => visitNodeValues(item, visit));
	}
	if (typeof value !== "object") return false;
	const maybeNode = value as t.Node;
	if (typeof (maybeNode as { type?: unknown }).type !== "string") return false;
	if (visit(maybeNode)) return true;
	return Object.values(maybeNode as unknown as Record<string, unknown>).some(
		(child) => visitNodeValues(child, visit),
	);
}

export function getObjectPatternKeySet(pattern: t.ObjectPattern): Set<string> {
	const keys = new Set<string>();
	for (const prop of pattern.properties) {
		if (!t.isObjectProperty(prop)) continue;
		const keyName = getObjectKeyName(prop.key);
		if (keyName) keys.add(keyName);
	}
	return keys;
}

export function getObjectPatternBindingName(
	pattern: t.ObjectPattern,
	propertyName: string,
): string | null {
	for (const prop of pattern.properties) {
		if (!t.isObjectProperty(prop) || !hasObjectKeyName(prop, propertyName)) {
			continue;
		}
		if (t.isIdentifier(prop.value)) return prop.value.name;
		if (t.isAssignmentPattern(prop.value) && t.isIdentifier(prop.value.left)) {
			return prop.value.left.name;
		}
	}
	return null;
}
