import traverse from "@babel/traverse";
import type * as t from "@babel/types";
import type { Patch } from "../types.js";
import { getVerifyAst } from "./ast-helpers.js";

const VERSION_SUFFIX = " (Claude Code)";
const UI_TITLE_PREFIX = "Claude Code v";

function replaceVersionSuffix(text: string, sigFull: string): string {
	return text.replace(VERSION_SUFFIX, ` (Claude Code; ${sigFull})`);
}

function isVersionStringTarget(text: string): boolean {
	return text.endsWith(VERSION_SUFFIX) && !text.includes("patched:");
}

function hasPatchedVersionString(text: string): boolean {
	return text.includes("(Claude Code; patched:");
}

function getTemplateText(quasi: t.TemplateElement): string {
	return quasi.value.raw;
}

function isVersionTemplateTarget(node: t.TemplateLiteral): boolean {
	const lastQuasi = node.quasis[node.quasis.length - 1];
	if (!lastQuasi) return false;
	return isVersionStringTarget(getTemplateText(lastQuasi));
}

function hasPatchedVersionTemplate(node: t.TemplateLiteral): boolean {
	const lastQuasi = node.quasis[node.quasis.length - 1];
	return !!lastQuasi && hasPatchedVersionString(getTemplateText(lastQuasi));
}

function isUiTitleTemplate(node: t.TemplateLiteral): boolean {
	const firstQuasi = node.quasis[0];
	return (
		!!firstQuasi && getTemplateText(firstQuasi).startsWith(UI_TITLE_PREFIX)
	);
}

function hasPatchedUiTitle(node: t.TemplateLiteral): boolean {
	const lastQuasi = node.quasis[node.quasis.length - 1];
	return !!lastQuasi && getTemplateText(lastQuasi).includes(" • patched");
}

/**
 * Inject signature into version strings.
 * The signature is built from all patches that passed verification.
 */
export const signature: Patch = {
	tag: "signature",

	// Runs after verification with all applied tags
	postApply: (ast, appliedTags) => {
		const tags = appliedTags;
		if (tags.length === 0) return;

		// Short signature for UI display (avoids width overflow)
		const sigShort = "patched";
		// Full signature for --version output
		const sigFull = `patched: ${tags.join(", ")}`;

		traverse.default(ast, {
			StringLiteral(path: any) {
				const val = path.node.value;
				if (isVersionStringTarget(val)) {
					path.node.value = replaceVersionSuffix(val, sigFull);
				}
			},
			TemplateLiteral(path: any) {
				if (isVersionTemplateTarget(path.node)) {
					const lastQuasi = path.node.quasis[path.node.quasis.length - 1];
					const replaced = replaceVersionSuffix(
						getTemplateText(lastQuasi),
						sigFull,
					);
					lastQuasi.value.raw = replaced;
					lastQuasi.value.cooked = replaced;
				}

				if (isUiTitleTemplate(path.node) && !hasPatchedUiTitle(path.node)) {
					const lastQuasi = path.node.quasis[path.node.quasis.length - 1];
					const suffix = ` • ${sigShort}`;
					lastQuasi.value.raw += suffix;
					lastQuasi.value.cooked = (lastQuasi.value.cooked ?? "") + suffix;
				}
			},
		});
	},

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) return "Unable to parse AST during signature verification";

		let hasPatchedVersion = false;
		let hasLegacyVersion = false;
		let hasPatchedTitle = false;
		let hasLegacyTitle = false;

		traverse.default(verifyAst, {
			StringLiteral(path) {
				const value = path.node.value;
				if (isVersionStringTarget(value)) {
					hasLegacyVersion = true;
				}
				if (hasPatchedVersionString(value)) {
					hasPatchedVersion = true;
				}
			},
			TemplateLiteral(path) {
				if (isVersionTemplateTarget(path.node)) {
					hasLegacyVersion = true;
				}
				if (hasPatchedVersionTemplate(path.node)) {
					hasPatchedVersion = true;
				}
				if (isUiTitleTemplate(path.node)) {
					if (hasPatchedUiTitle(path.node)) {
						hasPatchedTitle = true;
					} else {
						hasLegacyTitle = true;
					}
				}
			},
		});

		if (hasLegacyVersion) {
			return "Missing patched version signature in version output";
		}
		if (!hasPatchedVersion) {
			return "Did not find patched version output";
		}
		if (hasLegacyTitle) {
			return "Missing patched UI title signature";
		}
		if (!hasPatchedTitle) {
			return "Did not find patched UI title";
		}
		return true;
	},
};
