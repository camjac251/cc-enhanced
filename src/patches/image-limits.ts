import * as t from "@babel/types";
import { type NodePath, traverse, type Visitor } from "../babel.js";
import type { Patch } from "../types.js";
import { getObjectKeyName, getVerifyAst } from "./ast-helpers.js";

const TARGET_OPUS_KEYS = new Set(["claude-opus-4-7", "claude-opus-4-8"]);
const TARGET_PIXELS = 2576;

interface OpusOverrideEntry {
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

function getOpusOverrideEntries(
	objectExpr: t.ObjectExpression,
): OpusOverrideEntry[] {
	const entries: OpusOverrideEntry[] = [];
	for (const prop of objectExpr.properties) {
		if (!t.isObjectProperty(prop)) continue;
		const keyName = getObjectKeyName(prop.key);
		if (!keyName || !TARGET_OPUS_KEYS.has(keyName)) continue;
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
		const entries = getOpusOverrideEntries(path.node);
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
						"image-limits: Could not find Opus 4.7/4.8 image override table",
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

		traverse(verifyAst, {
			ObjectExpression(path) {
				const entries = getOpusOverrideEntries(path.node);
				if (entries.length === 0) return;
				tablesWithEntries++;
				for (const entry of entries) {
					entriesSeen++;
					const widthVal = (entry.maxWidth.value as t.NumericLiteral).value;
					const heightVal = (entry.maxHeight.value as t.NumericLiteral).value;
					if (widthVal !== TARGET_PIXELS || heightVal !== TARGET_PIXELS) {
						downgradedKey ??= entry.key;
					}
				}
			},
		});

		if (entriesSeen === 0) {
			return "Opus 4.7/4.8 image override entries not found";
		}
		// Upstream is expected to ship a single image-override table that
		// contains the targeted Opus entries together. Finding the entries
		// spread across multiple tables means the matcher is too loose or
		// upstream restructured; either way it should be reviewed before
		// proceeding.
		if (tablesWithEntries > 1) {
			return `Opus image override entries split across ${tablesWithEntries} tables`;
		}
		if (downgradedKey) {
			return `Opus image override for "${downgradedKey}" is not pinned to ${TARGET_PIXELS}px`;
		}
		return true;
	},
};
