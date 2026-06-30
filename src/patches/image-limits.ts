import * as t from "@babel/types";
import { type NodePath, traverse, type Visitor } from "../babel.js";
import type { Patch } from "../types.js";
import { getObjectKeyName, getVerifyAst } from "./ast-helpers.js";

const TARGET_METADATA_MODEL_KEYS = new Set([
	"claude-fable-5",
	"claude-opus-4-7",
	"claude-opus-4-8",
]);
const TARGET_FALLBACK_MODEL_KEYS = new Set(["claude-mythos-5"]);
const TARGET_MODEL_KEYS = new Set([
	...TARGET_METADATA_MODEL_KEYS,
	...TARGET_FALLBACK_MODEL_KEYS,
]);
const TARGET_PIXELS = 2576;

interface ImageLimitEntry {
	key: string;
	maxWidth: t.ObjectProperty;
	maxHeight: t.ObjectProperty;
}

function getObjectProp(
	objectExpr: t.ObjectExpression,
	keyName: string,
): t.ObjectProperty | null {
	for (const prop of objectExpr.properties) {
		if (!t.isObjectProperty(prop)) continue;
		if (getObjectKeyName(prop.key) !== keyName) continue;
		return prop;
	}
	return null;
}

function getNumericProp(
	objectExpr: t.ObjectExpression,
	keyName: string,
): t.ObjectProperty | null {
	const prop = getObjectProp(objectExpr, keyName);
	if (!prop || !t.isNumericLiteral(prop.value)) return null;
	return prop;
}

function getNumericLimitEntry(
	objectExpr: t.ObjectExpression,
	key: string,
): ImageLimitEntry | null {
	const maxWidth = getNumericProp(objectExpr, "maxWidth");
	const maxHeight = getNumericProp(objectExpr, "maxHeight");
	if (!maxWidth || !maxHeight) return null;
	return { key, maxWidth, maxHeight };
}

function getModelMetadataImageLimitEntry(
	objectExpr: t.ObjectExpression,
): ImageLimitEntry | null {
	const idProp = getObjectProp(objectExpr, "id");
	if (!idProp || !t.isStringLiteral(idProp.value)) return null;
	const key = idProp.value.value;
	if (!TARGET_METADATA_MODEL_KEYS.has(key)) return null;
	const imageLimitsProp = getObjectProp(objectExpr, "image_limits");
	if (!imageLimitsProp || !t.isObjectExpression(imageLimitsProp.value)) {
		return null;
	}
	return getNumericLimitEntry(imageLimitsProp.value, key);
}

function isVoidZeroExpression(expr: t.Expression): boolean {
	return (
		t.isUnaryExpression(expr, { operator: "void" }) &&
		t.isNumericLiteral(expr.argument, { value: 0 })
	);
}

function getComparedModelKey(expr: t.Expression): string | null {
	if (!t.isBinaryExpression(expr, { operator: "===" })) return null;
	if (t.isStringLiteral(expr.left)) return expr.left.value;
	if (t.isStringLiteral(expr.right)) return expr.right.value;
	return null;
}

function getFallbackLimitIdentifier(
	node: t.ConditionalExpression,
): { key: string; identifierName: string } | null {
	const key = getComparedModelKey(node.test);
	if (!key || !TARGET_FALLBACK_MODEL_KEYS.has(key)) return null;
	if (t.isIdentifier(node.consequent) && isVoidZeroExpression(node.alternate)) {
		return { key, identifierName: node.consequent.name };
	}
	if (t.isIdentifier(node.alternate) && isVoidZeroExpression(node.consequent)) {
		return { key, identifierName: node.alternate.name };
	}
	return null;
}

function getAssignedIdentifierName(
	path: NodePath<t.ObjectExpression>,
): string | null {
	const parent = path.parentPath?.node;
	if (
		t.isAssignmentExpression(parent) &&
		parent.right === path.node &&
		t.isIdentifier(parent.left)
	) {
		return parent.left.name;
	}
	if (
		t.isVariableDeclarator(parent) &&
		parent.init === path.node &&
		t.isIdentifier(parent.id)
	) {
		return parent.id.name;
	}
	return null;
}

function setEntryPixels(entry: ImageLimitEntry): void {
	entry.maxWidth.value = t.numericLiteral(TARGET_PIXELS);
	entry.maxHeight.value = t.numericLiteral(TARGET_PIXELS);
}

function createImageLimitsDiscoverer(
	fallbackLimitIdentifiers: Map<string, string>,
): Visitor {
	return {
		ConditionalExpression(path) {
			const fallback = getFallbackLimitIdentifier(path.node);
			if (fallback) {
				fallbackLimitIdentifiers.set(fallback.identifierName, fallback.key);
			}
		},
	};
}

function createImageLimitsMutator(
	fallbackLimitIdentifiers: Map<string, string>,
): Visitor {
	const entriesSeen = new Set<string>();

	function patchObjectExpression(path: NodePath<t.ObjectExpression>): void {
		const metadataEntry = getModelMetadataImageLimitEntry(path.node);
		if (metadataEntry) {
			entriesSeen.add(metadataEntry.key);
			setEntryPixels(metadataEntry);
			return;
		}
		const assignedIdentifier = getAssignedIdentifierName(path);
		const fallbackKey =
			assignedIdentifier && fallbackLimitIdentifiers.get(assignedIdentifier);
		if (!fallbackKey) return;
		const fallbackEntry = getNumericLimitEntry(path.node, fallbackKey);
		if (fallbackEntry) {
			entriesSeen.add(fallbackEntry.key);
			setEntryPixels(fallbackEntry);
		}
	}

	return {
		ObjectExpression(path) {
			patchObjectExpression(path);
		},

		Program: {
			exit() {
				const missingKeys = [...TARGET_MODEL_KEYS].filter(
					(key) => !entriesSeen.has(key),
				);
				if (missingKeys.length > 0) {
					console.warn(
						`image-limits: Could not find image-limit entries for: ${missingKeys.join(", ")}`,
					);
				}
			},
		},
	};
}

export const imageLimits: Patch = {
	tag: "image-limits",

	astPasses: () => {
		const fallbackLimitIdentifiers = new Map<string, string>();
		return [
			{
				pass: "discover",
				visitor: createImageLimitsDiscoverer(fallbackLimitIdentifiers),
			},
			{
				pass: "mutate",
				visitor: createImageLimitsMutator(fallbackLimitIdentifiers),
			},
		];
	},

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) return "Unable to parse AST during verification";

		let downgradedKey: string | null = null;
		const seenKeys = new Set<string>();
		const fallbackLimitIdentifiers = new Map<string, string>();

		traverse(verifyAst, {
			ConditionalExpression(path) {
				const fallback = getFallbackLimitIdentifier(path.node);
				if (fallback) {
					fallbackLimitIdentifiers.set(fallback.identifierName, fallback.key);
				}
			},
		});

		traverse(verifyAst, {
			ObjectExpression(path) {
				const metadataEntry = getModelMetadataImageLimitEntry(path.node);
				const assignedIdentifier = getAssignedIdentifierName(path);
				const fallbackKey =
					assignedIdentifier &&
					fallbackLimitIdentifiers.get(assignedIdentifier);
				const entry =
					metadataEntry ??
					(fallbackKey ? getNumericLimitEntry(path.node, fallbackKey) : null);
				if (!entry) return;
				seenKeys.add(entry.key);
				const widthVal = (entry.maxWidth.value as t.NumericLiteral).value;
				const heightVal = (entry.maxHeight.value as t.NumericLiteral).value;
				if (widthVal !== TARGET_PIXELS || heightVal !== TARGET_PIXELS) {
					downgradedKey ??= entry.key;
				}
			},
		});

		const missingKeys = [...TARGET_MODEL_KEYS].filter(
			(key) => !seenKeys.has(key),
		);
		if (missingKeys.length > 0) {
			return `Image override entries missing for: ${missingKeys.join(", ")}`;
		}
		if (downgradedKey) {
			return `Image override for "${downgradedKey}" is not pinned to ${TARGET_PIXELS}px`;
		}
		return true;
	},
};
