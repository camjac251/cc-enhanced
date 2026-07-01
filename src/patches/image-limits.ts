import * as t from "@babel/types";
import { type NodePath, traverse, type Visitor } from "../babel.js";
import type { Patch } from "../types.js";
import { getObjectKeyName, getVerifyAst } from "./ast-helpers.js";

const TARGET_METADATA_MODEL_KEYS = new Set([
	"claude-fable-5",
	"claude-mythos-5",
	"claude-sonnet-5",
	"claude-opus-4-7",
	"claude-opus-4-8",
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

function setEntryPixels(entry: ImageLimitEntry): void {
	entry.maxWidth.value = t.numericLiteral(TARGET_PIXELS);
	entry.maxHeight.value = t.numericLiteral(TARGET_PIXELS);
}

function createImageLimitsMutator(): Visitor {
	const entriesSeen = new Set<string>();

	function patchObjectExpression(path: NodePath<t.ObjectExpression>): void {
		const metadataEntry = getModelMetadataImageLimitEntry(path.node);
		if (metadataEntry) {
			entriesSeen.add(metadataEntry.key);
			setEntryPixels(metadataEntry);
		}
	}

	return {
		ObjectExpression(path) {
			patchObjectExpression(path);
		},

		Program: {
			exit() {
				const missingKeys = [...TARGET_METADATA_MODEL_KEYS].filter(
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
		return [
			{
				pass: "mutate",
				visitor: createImageLimitsMutator(),
			},
		];
	},

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) return "Unable to parse AST during verification";

		let downgradedKey: string | null = null;
		const seenKeys = new Set<string>();

		traverse(verifyAst, {
			ObjectExpression(path) {
				const metadataEntry = getModelMetadataImageLimitEntry(path.node);
				if (!metadataEntry) return;
				seenKeys.add(metadataEntry.key);
				const widthVal = (metadataEntry.maxWidth.value as t.NumericLiteral)
					.value;
				const heightVal = (metadataEntry.maxHeight.value as t.NumericLiteral)
					.value;
				if (widthVal !== TARGET_PIXELS || heightVal !== TARGET_PIXELS) {
					downgradedKey ??= metadataEntry.key;
				}
			},
		});

		const missingKeys = [...TARGET_METADATA_MODEL_KEYS].filter(
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
