import * as t from "@babel/types";
import { traverse } from "../babel.js";
import type { Patch } from "../types.js";
import { getVerifyAst } from "./ast-helpers.js";

const VERSION_SUFFIX = " (Claude Code)";
const PATCHED_VERSION_MARKER = "(Claude Code; patched:";
const PATCHED_TITLE_MARKER = " • patched";
const TITLE_BRAND_LITERAL = "Claude Code";

function replaceVersionSuffix(text: string, sigFull: string): string {
	return text.replace(VERSION_SUFFIX, ` (Claude Code; ${sigFull})`);
}

function isVersionStringTarget(text: string): boolean {
	return text.endsWith(VERSION_SUFFIX) && !text.includes("patched:");
}

function hasPatchedVersionString(text: string): boolean {
	return text.includes(PATCHED_VERSION_MARKER);
}

function getTemplateText(quasi: t.TemplateElement): string {
	return quasi.value.raw;
}

function getVersionQuasiIndex(node: t.TemplateLiteral): number {
	return node.quasis.findIndex((q) =>
		isVersionStringTarget(getTemplateText(q)),
	);
}

function isVersionTemplateTarget(node: t.TemplateLiteral): boolean {
	return getVersionQuasiIndex(node) >= 0;
}

function hasPatchedVersionTemplate(node: t.TemplateLiteral): boolean {
	return node.quasis.some((q) => hasPatchedVersionString(getTemplateText(q)));
}

/**
 * The real UI title is a composite TemplateLiteral that interpolates two
 * helper calls: the first renders the product label "Claude Code", the
 * second renders the version string. The quasis are just the spaces
 * around the two interpolations.
 *
 * Identify it by the outer TemplateLiteral having an expression that is a
 * CallExpression with the literal "Claude Code" as its sole argument. This
 * deliberately avoids matching error-text templates whose first quasi merely
 * starts with "Claude Code v...".
 */
function isCompositeUiTitleTemplate(node: t.TemplateLiteral): boolean {
	if (node.expressions.length < 1) return false;
	return node.expressions.some((expr) => {
		if (!t.isCallExpression(expr)) return false;
		if (expr.arguments.length !== 1) return false;
		const arg = expr.arguments[0];
		return t.isStringLiteral(arg) && arg.value === TITLE_BRAND_LITERAL;
	});
}

function hasPatchedCompositeUiTitle(node: t.TemplateLiteral): boolean {
	return node.quasis.some((q) =>
		getTemplateText(q).includes(PATCHED_TITLE_MARKER),
	);
}

export const signature: Patch = {
	tag: "signature",

	postApply: (ast, appliedTags) => {
		const tags = appliedTags;
		if (tags.length === 0) return;

		const sigFull = `patched: ${tags.join(", ")}`;

		traverse(ast, {
			StringLiteral(path: any) {
				const val = path.node.value;
				if (isVersionStringTarget(val)) {
					path.node.value = replaceVersionSuffix(val, sigFull);
				}
			},
			TemplateLiteral(path: any) {
				const versionIdx = getVersionQuasiIndex(path.node);
				if (versionIdx >= 0) {
					const quasi = path.node.quasis[versionIdx];
					const replaced = replaceVersionSuffix(
						getTemplateText(quasi),
						sigFull,
					);
					quasi.value.raw = replaced;
					quasi.value.cooked = replaced;
				}

				if (
					isCompositeUiTitleTemplate(path.node) &&
					!hasPatchedCompositeUiTitle(path.node)
				) {
					const lastQuasi = path.node.quasis[path.node.quasis.length - 1];
					lastQuasi.value.raw += PATCHED_TITLE_MARKER;
					lastQuasi.value.cooked =
						(lastQuasi.value.cooked ?? "") + PATCHED_TITLE_MARKER;
				}
			},
		});
	},

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) return "Unable to parse AST during signature verification";

		let hasPatchedVersion = false;
		let hasLegacyVersionTemplate = false;
		let compositeTitleCount = 0;
		let patchedTitleCount = 0;
		let nonTitleTemplateDecorated = false;

		traverse(verifyAst, {
			StringLiteral(path) {
				const value = path.node.value;
				if (hasPatchedVersionString(value)) {
					hasPatchedVersion = true;
				}
			},
			TemplateLiteral(path) {
				if (isVersionTemplateTarget(path.node)) {
					hasLegacyVersionTemplate = true;
				}
				if (hasPatchedVersionTemplate(path.node)) {
					hasPatchedVersion = true;
				}
				if (isCompositeUiTitleTemplate(path.node)) {
					compositeTitleCount++;
					if (hasPatchedCompositeUiTitle(path.node)) {
						patchedTitleCount++;
					}
				} else if (hasPatchedCompositeUiTitle(path.node)) {
					// postApply appends the title marker only to composite UI title
					// templates; the marker in any other template means a wrong anchor
					// decorated foreign text.
					nonTitleTemplateDecorated = true;
				}
			},
		});

		if (hasLegacyVersionTemplate) {
			return "Missing patched version signature in version output";
		}
		if (!hasPatchedVersion) {
			return "Did not find patched version output";
		}
		if (nonTitleTemplateDecorated) {
			return "Patched title marker leaked into a non-title template (wrong anchor)";
		}
		if (compositeTitleCount === 0) {
			return "Composite UI title template not found (upstream may have restructured)";
		}
		if (patchedTitleCount === 0) {
			return "Composite UI title was not decorated with patched marker";
		}
		if (patchedTitleCount !== compositeTitleCount) {
			return `Patched ${patchedTitleCount} of ${compositeTitleCount} composite UI titles`;
		}
		return true;
	},
};
