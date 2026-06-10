import * as t from "@babel/types";
import { type NodePath, traverse, type Visitor } from "../babel.js";
import type { Patch } from "../types.js";
import { getObjectKeyName, getVerifyAst } from "./ast-helpers.js";

const TARGET_MODEL_KEYS = new Set([
	"claude-fable-5",
	"claude-mythos-5",
	"claude-opus-4-7",
	"claude-opus-4-8",
]);
const TARGET_PIXELS = 2576;

interface ModelOverrideEntry {
	key: string;
	maxWidth: t.ObjectProperty;
	maxHeight: t.ObjectProperty;
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

function getModelOverrideEntries(
	objectExpr: t.ObjectExpression,
): ModelOverrideEntry[] {
	const entries: ModelOverrideEntry[] = [];
	for (const prop of objectExpr.properties) {
		if (!t.isObjectProperty(prop)) continue;
		const keyName = getObjectKeyName(prop.key);
		if (!keyName || !TARGET_MODEL_KEYS.has(keyName)) continue;
		if (!t.isObjectExpression(prop.value)) continue;
		const maxWidth = getNumericProp(prop.value, "maxWidth");
		const maxHeight = getNumericProp(prop.value, "maxHeight");
		if (!maxWidth || !maxHeight) continue;
		entries.push({ key: keyName, maxWidth, maxHeight });
	}
	return entries;
}

function createImageLimitsMutator(): Visitor {
	let entriesSeen = 0;

	function patchObjectExpression(path: NodePath<t.ObjectExpression>): void {
		const entries = getModelOverrideEntries(path.node);
		for (const entry of entries) {
			entriesSeen += 1;
			const widthVal = (entry.maxWidth.value as t.NumericLiteral).value;
			const heightVal = (entry.maxHeight.value as t.NumericLiteral).value;
			if (widthVal === TARGET_PIXELS && heightVal === TARGET_PIXELS) continue;
			entry.maxWidth.value = t.numericLiteral(TARGET_PIXELS);
			entry.maxHeight.value = t.numericLiteral(TARGET_PIXELS);
		}
	}

	return {
		ObjectExpression(path) {
			patchObjectExpression(path);
		},

		Program: {
			exit() {
				if (entriesSeen === 0) {
					console.warn(
						"image-limits: Could not find the high-res model image override table",
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

		let entriesSeen = 0;
		let downgradedKey: string | null = null;
		let tablesWithEntries = 0;
		const seenKeys = new Set<string>();

		traverse(verifyAst, {
			ObjectExpression(path) {
				const entries = getModelOverrideEntries(path.node);
				if (entries.length === 0) return;
				tablesWithEntries++;
				for (const entry of entries) {
					entriesSeen++;
					seenKeys.add(entry.key);
					const widthVal = (entry.maxWidth.value as t.NumericLiteral).value;
					const heightVal = (entry.maxHeight.value as t.NumericLiteral).value;
					if (widthVal !== TARGET_PIXELS || heightVal !== TARGET_PIXELS) {
						downgradedKey ??= entry.key;
					}
				}
			},
		});

		if (entriesSeen === 0) {
			return "High-res model image override entries not found";
		}
		// Upstream is expected to ship a single image-override table that
		// contains the targeted model entries together. Finding the entries
		// spread across multiple tables means the matcher is too loose or
		// upstream restructured; either way it should be reviewed before
		// proceeding.
		if (tablesWithEntries > 1) {
			return `Image override entries split across ${tablesWithEntries} tables`;
		}
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
