import * as t from "@babel/types";
import { type NodePath, traverse, type Visitor } from "../babel.js";
import type { Patch } from "../types.js";
import { getObjectKeyName, getVerifyAst } from "./ast-helpers.js";

const OPUS_4_7_KEY = "claude-opus-4-7";
const TARGET_PIXELS = 2576;

function getOpusOverride(
	objectExpr: t.ObjectExpression,
): t.ObjectExpression | null {
	for (const prop of objectExpr.properties) {
		if (!t.isObjectProperty(prop)) continue;
		if (getObjectKeyName(prop.key) !== OPUS_4_7_KEY) continue;
		return t.isObjectExpression(prop.value) ? prop.value : null;
	}
	return null;
}

function getNumericProp(
	objectExpr: t.ObjectExpression,
	keyName: string,
): t.ObjectProperty | null {
	for (const prop of objectExpr.properties) {
		if (!t.isObjectProperty(prop)) continue;
		if (getObjectKeyName(prop.key) !== keyName) continue;
		if (!t.isNumericLiteral(prop.value)) return null;
		return prop;
	}
	return null;
}

function isImageLimitsOverride(
	objectExpr: t.ObjectExpression,
): { maxWidth: t.ObjectProperty; maxHeight: t.ObjectProperty } | null {
	const inner = getOpusOverride(objectExpr);
	if (!inner) return null;
	const maxWidth = getNumericProp(inner, "maxWidth");
	const maxHeight = getNumericProp(inner, "maxHeight");
	if (!maxWidth || !maxHeight) return null;
	return { maxWidth, maxHeight };
}

function createImageLimitsMutator(): Visitor {
	let patched = 0;

	function patchObjectExpression(path: NodePath<t.ObjectExpression>): void {
		const props = isImageLimitsOverride(path.node);
		if (!props) return;
		const widthVal = (props.maxWidth.value as t.NumericLiteral).value;
		const heightVal = (props.maxHeight.value as t.NumericLiteral).value;
		if (widthVal === TARGET_PIXELS && heightVal === TARGET_PIXELS) return;
		props.maxWidth.value = t.numericLiteral(TARGET_PIXELS);
		props.maxHeight.value = t.numericLiteral(TARGET_PIXELS);
		patched += 1;
	}

	return {
		ObjectExpression(path) {
			patchObjectExpression(path);
		},

		Program: {
			exit() {
				if (patched === 0) {
					console.warn(
						"image-limits: Could not find Opus 4.7 image override table",
					);
				}
			},
		},
	};
}

export const imageLimits: Patch = {
	tag: "image-limits",

	astPasses: () => [
		{
			pass: "mutate",
			visitor: createImageLimitsMutator(),
		},
	],

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) return "Unable to parse AST during verification";

		let overrideCount = 0;
		let downgraded = false;

		traverse(verifyAst, {
			ObjectExpression(path) {
				const props = isImageLimitsOverride(path.node);
				if (!props) return;
				overrideCount++;
				const widthVal = (props.maxWidth.value as t.NumericLiteral).value;
				const heightVal = (props.maxHeight.value as t.NumericLiteral).value;
				// Any override that doesn't pin BOTH dimensions to TARGET_PIXELS
				// is a failure. The previous separate DOWNGRADED_PIXELS clause
				// was redundant; the !== TARGET check already catches it.
				if (widthVal !== TARGET_PIXELS || heightVal !== TARGET_PIXELS) {
					downgraded = true;
				}
			},
		});

		if (overrideCount === 0) {
			return "Opus 4.7 image override table not found";
		}
		// Bound the count. The upstream bundle is expected to ship exactly
		// one override table that matches isImageLimitsOverride; finding
		// multiple is suspicious (the matcher is too loose, or upstream
		// restructured).
		if (overrideCount > 1) {
			return `Expected exactly one Opus 4.7 image override table, found ${overrideCount}`;
		}
		if (downgraded) {
			return `Opus 4.7 image override is not pinned to ${TARGET_PIXELS}px`;
		}
		return true;
	},
};
