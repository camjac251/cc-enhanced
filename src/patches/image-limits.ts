import * as t from "@babel/types";
import { type NodePath, traverse, type Visitor } from "../babel.js";
import type { Patch } from "../types.js";
import { getObjectKeyName, getVerifyAst } from "./ast-helpers.js";

const OPUS_4_7_KEY = "claude-opus-4-7";
const TARGET_PIXELS = 2576;
const DOWNGRADED_PIXELS = 2000;

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

		let foundOverride = false;
		let downgraded = false;

		traverse(verifyAst, {
			ObjectExpression(path) {
				const props = isImageLimitsOverride(path.node);
				if (!props) return;
				foundOverride = true;
				const widthVal = (props.maxWidth.value as t.NumericLiteral).value;
				const heightVal = (props.maxHeight.value as t.NumericLiteral).value;
				if (widthVal === DOWNGRADED_PIXELS || heightVal === DOWNGRADED_PIXELS) {
					downgraded = true;
				}
				if (widthVal !== TARGET_PIXELS || heightVal !== TARGET_PIXELS) {
					downgraded = true;
				}
			},
		});

		if (!foundOverride) {
			return "Opus 4.7 image override table not found";
		}
		if (downgraded) {
			return `Opus 4.7 image override is not pinned to ${TARGET_PIXELS}px`;
		}
		return true;
	},
};
