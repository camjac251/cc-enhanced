import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch } from "../types.js";
import { getVerifyAst } from "./ast-helpers.js";
import { MODERN_FINDING_TOOLS } from "./modern-cli.js";

// Functions containing these anchors have an EMBEDDED_SEARCH_TOOLS gate (Yz()
// or equivalent) as the init of their first VariableDeclarator.  Since tools-off
// disables Glob/Grep, we force the gate to true so tool-list conditionals pick
// the branch that omits Glob/Grep names.
const EMBEDDED_SEARCH_GATE_ANCHORS = [
	"Executes a given bash command", // Bash prompt builder
	"You are the Claude guide agent", // Guide agent prompt
	"# Using your tools", // System prompt tool-guidance section
];

const SEARCH_GUIDANCE_FRAGMENTS = [
	"find or ls",
	"grep or rg",
	"`find`",
	"`grep`",
	"`fd` and `eza`",
	"`rg` for text",
	"shell-native file discovery",
	"Content search: Use `rg`",
	"`fd`, `rg`, `sg`, `eza`, and `bat`",
];

const MODERN_BASH_IMPORTANT_LINE =
	"IMPORTANT: Prefer dedicated tools and modern CLI utilities whenever possible. Recommended defaults:";

const MODERN_GUIDE_FINDING_TOOLS = MODERN_FINDING_TOOLS;

function templatePattern(node: t.TemplateLiteral): string {
	return node.quasis
		.map((quasi, index) => {
			const text = quasi.value.cooked ?? quasi.value.raw;
			return index < node.expressions.length ? `${text}\${}` : text;
		})
		.join("");
}

/** Escape a cooked string for use in a template literal's raw slot. */
const escapeTemplateRaw = (text: string) =>
	text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

function createSingleExpressionTemplate(
	expression: t.Expression | t.TSType,
	before: string,
	after: string,
): t.TemplateLiteral {
	return t.templateLiteral(
		[
			t.templateElement(
				{ raw: escapeTemplateRaw(before), cooked: before },
				false,
			),
			t.templateElement({ raw: escapeTemplateRaw(after), cooked: after }, true),
		],
		[expression],
	);
}

function rewriteLegacyText(text: string): string {
	let next = text
		.replace(
			"If your command will create new directories or files, first use this tool to run `ls` to verify the parent directory exists and is the correct location.",
			"If your command will create new directories or files, first use this tool to run `eza` or `fd` to verify the parent directory exists and is the correct location.",
		)
		.replace(
			"Communication: Output text directly (NOT echo/printf)",
			"Communication: Output text directly",
		)
		.replace("`find`, and `grep`", MODERN_GUIDE_FINDING_TOOLS)
		.replace(
			"`cat`, `head`, `tail`, `sed`, `awk`, or `echo`",
			"`file viewing, editing, creation, or output formatting`",
		)
		.replace(
			"`find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo`",
			"`file discovery, search, listing, editing, creation, or output formatting`",
		);

	if (next.includes("find -regex")) {
		next =
			"Use `fd` for file discovery rather than crafting legacy shell search expressions.";
	}

	return next;
}

function containsAnchor(path: traverse.NodePath<t.Function>): boolean {
	let found = false;
	path.traverse({
		StringLiteral(inner) {
			for (const anchor of EMBEDDED_SEARCH_GATE_ANCHORS) {
				if (inner.node.value.startsWith(anchor)) {
					found = true;
					inner.stop();
					return;
				}
			}
		},
		TemplateLiteral(inner) {
			for (const quasi of inner.node.quasis) {
				const text = quasi.value.cooked ?? quasi.value.raw;
				for (const anchor of EMBEDDED_SEARCH_GATE_ANCHORS) {
					if (text.includes(anchor)) {
						found = true;
						inner.stop();
						return;
					}
				}
			}
		},
	});
	return found;
}

function nodeContainsSearchGuidance(node: t.Node | null | undefined): boolean {
	let found = false;
	const visit = (value: unknown): void => {
		if (found || !value) return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (typeof value !== "object") return;
		const maybeNode = value as t.Node;
		if (typeof (maybeNode as { type?: unknown }).type !== "string") return;
		if (t.isStringLiteral(maybeNode)) {
			if (
				SEARCH_GUIDANCE_FRAGMENTS.some((fragment) =>
					maybeNode.value.includes(fragment),
				)
			) {
				found = true;
			}
			return;
		}
		if (t.isTemplateElement(maybeNode)) {
			const text = maybeNode.value.cooked ?? maybeNode.value.raw;
			if (
				SEARCH_GUIDANCE_FRAGMENTS.some((fragment) => text.includes(fragment))
			) {
				found = true;
			}
			return;
		}
		for (const child of Object.values(
			maybeNode as unknown as Record<string, unknown>,
		)) {
			visit(child);
		}
	};
	visit(node);
	return found;
}

function isZeroArgIdentifierCall(
	node: t.Node | null | undefined,
): node is t.CallExpression {
	return (
		!!node &&
		t.isCallExpression(node) &&
		node.arguments.length === 0 &&
		t.isIdentifier(node.callee)
	);
}

function findEmbeddedSearchGateDeclarator(
	path: traverse.NodePath<t.Function>,
): traverse.NodePath<t.VariableDeclarator> | null {
	const candidates: traverse.NodePath<t.VariableDeclarator>[] = [];

	path.traverse({
		VariableDeclarator(declPath) {
			if (!t.isIdentifier(declPath.node.id)) return;

			const binding = declPath.scope.getBinding(declPath.node.id.name);
			if (!binding || binding.path.node !== declPath.node) return;

			const init = declPath.node.init;
			if (isZeroArgIdentifierCall(init) || isForcedTrue(init)) {
				const controlsGuidance = binding.referencePaths.some((refPath) => {
					const conditional = refPath.findParent((parentPath) =>
						parentPath.isConditionalExpression(),
					);
					if (!conditional?.isConditionalExpression()) return false;
					if (conditional.node.test !== refPath.node) return false;
					return (
						nodeContainsSearchGuidance(conditional.node.consequent) ||
						nodeContainsSearchGuidance(conditional.node.alternate)
					);
				});
				if (controlsGuidance) candidates.push(declPath);
				return;
			}

			if (
				!t.isConditionalExpression(init) ||
				(!isZeroArgIdentifierCall(init.test) && !isForcedTrue(init.test))
			) {
				return;
			}
			if (
				!nodeContainsSearchGuidance(init.consequent) &&
				!nodeContainsSearchGuidance(init.alternate)
			) {
				return;
			}
			candidates.push(declPath);
		},
	});

	return candidates.length === 1 ? candidates[0] : null;
}

function patchGateInFunction(path: traverse.NodePath<t.Function>): boolean {
	const declPath = findEmbeddedSearchGateDeclarator(path);
	if (!declPath) return false;
	const init = declPath.node.init;
	if (isZeroArgIdentifierCall(init)) {
		declPath.node.init = t.unaryExpression("!", t.numericLiteral(0));
		return true;
	}
	if (t.isConditionalExpression(init) && isZeroArgIdentifierCall(init.test)) {
		init.test = t.unaryExpression("!", t.numericLiteral(0));
		return true;
	}
	return false;
}

function patchPromptTextInFunction(path: traverse.NodePath<t.Function>): void {
	path.traverse({
		TemplateLiteral(templatePath) {
			const pattern = templatePattern(templatePath.node);
			switch (pattern) {
				case "IMPORTANT: Avoid using this tool to run ${} commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user:":
					templatePath.replaceWith(t.stringLiteral(MODERN_BASH_IMPORTANT_LINE));
					return;
				case "To read files use ${} instead of cat, head, tail, or sed":
					templatePath.replaceWith(
						createSingleExpressionTemplate(
							templatePath.node.expressions[0],
							"To read files use ",
							"; for shell-native viewing use `bat`.",
						),
					);
					return;
				case "To edit files use ${} instead of sed or awk":
					templatePath.replaceWith(
						createSingleExpressionTemplate(
							templatePath.node.expressions[0],
							"To edit files use ",
							"; for shell-native replacement use `sd`.",
						),
					);
					return;
				case "To create files use ${} instead of cat with heredoc or echo redirection":
					templatePath.replaceWith(
						createSingleExpressionTemplate(
							templatePath.node.expressions[0],
							"To create files use ",
							" for file creation or large rewrites.",
						),
					);
					return;
				case "To search for files use ${} instead of find or ls":
					templatePath.replaceWith(
						t.stringLiteral(
							"For shell-native file discovery use `fd` and `eza`.",
						),
					);
					return;
				case "To search the content of files, use ${} instead of grep or rg":
					templatePath.replaceWith(
						t.stringLiteral(
							"For text search use `rg`; use `sg` for structural code search when available.",
						),
					);
					return;
				case "Read files: Use ${} (NOT cat/head/tail)":
					templatePath.replaceWith(
						createSingleExpressionTemplate(
							templatePath.node.expressions[0],
							"Read files: Use ",
							" or `bat` for shell-native viewing",
						),
					);
					return;
				case "Edit files: Use ${} (NOT sed/awk)":
					templatePath.replaceWith(
						createSingleExpressionTemplate(
							templatePath.node.expressions[0],
							"Edit files: Use ",
							" or `sd` for lightweight replacement",
						),
					);
					return;
				case "Write files: Use ${} (NOT echo >/cat <<EOF)":
					templatePath.replaceWith(
						createSingleExpressionTemplate(
							templatePath.node.expressions[0],
							"Write files: Use ",
							" for file creation or major rewrites",
						),
					);
					return;
				case "File search: Use ${} (NOT find or ls)":
					templatePath.replaceWith(
						t.stringLiteral("File discovery: Use `fd` and `eza`"),
					);
					return;
				case "Content search: Use ${} (NOT grep or rg)":
					templatePath.replaceWith(
						t.stringLiteral(
							"Content search: Use `rg` for text and `sg` for structural code search",
						),
					);
					return;
			}

			for (const quasi of templatePath.node.quasis) {
				const original = quasi.value.cooked ?? quasi.value.raw;
				const next = rewriteLegacyText(original);
				if (next === original) continue;
				quasi.value.raw = escapeTemplateRaw(next);
				quasi.value.cooked = next;
			}
		},
		StringLiteral(stringPath) {
			const next = rewriteLegacyText(stringPath.node.value);
			if (next !== stringPath.node.value) stringPath.node.value = next;
		},
	});
}

function findAnchor(path: traverse.NodePath<t.Function>): string | null {
	let matched: string | null = null;
	path.traverse({
		StringLiteral(inner) {
			for (const anchor of EMBEDDED_SEARCH_GATE_ANCHORS) {
				if (inner.node.value.startsWith(anchor)) {
					matched = anchor;
					inner.stop();
					return;
				}
			}
		},
		TemplateLiteral(inner) {
			for (const quasi of inner.node.quasis) {
				const text = quasi.value.cooked ?? quasi.value.raw;
				for (const anchor of EMBEDDED_SEARCH_GATE_ANCHORS) {
					if (text.includes(anchor)) {
						matched = anchor;
						inner.stop();
						return;
					}
				}
			}
		},
	});
	return matched;
}

const isForcedTrue = (node: t.Expression | null | undefined) =>
	t.isUnaryExpression(node) &&
	node.operator === "!" &&
	t.isNumericLiteral(node.argument) &&
	node.argument.value === 0;

export const bashPrompt: Patch = {
	tag: "bash-prompt",

	// Use a Function visitor directly so the combined-pass engine visits each
	// function node natively, avoiding nested traverse conflicts.
	astPasses: () => [
		{
			pass: "mutate" as const,
			visitor: {
				Function(path: traverse.NodePath<t.Function>) {
					if (!containsAnchor(path)) return;
					patchGateInFunction(path);
					patchPromptTextInFunction(path);
					path.skip();
				},
			},
		},
	],

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) return "Unable to parse AST during verification";

		if (code.includes("Avoid using Bash with the `find`")) {
			return "Old 'Avoid using Bash with' text still present";
		}

		if (
			code.includes("find or ls") ||
			code.includes("grep or rg") ||
			code.includes("(NOT cat/head/tail)") ||
			code.includes("(NOT sed/awk)") ||
			code.includes("(NOT echo >/cat <<EOF)") ||
			code.includes("find -regex") ||
			code.includes("run `ls` to verify") ||
			code.includes("appropriate dedicated tool")
		) {
			return "Legacy Bash prompt guidance still present";
		}

		if (
			!code.includes(MODERN_BASH_IMPORTANT_LINE) ||
			!code.includes("fd") ||
			!code.includes("eza") ||
			!code.includes("rg") ||
			!code.includes("sg") ||
			!code.includes("bat") ||
			!code.includes("sd")
		) {
			return "Expected modern CLI Bash guidance missing";
		}

		// AST check: verify both functions have the specific embedded-search
		// gate forced to !0, not just any zero-arg helper call.
		const forcedAnchors = new Set<string>();
		traverse.default(verifyAst, {
			Function(path) {
				const anchor = findAnchor(path);
				if (!anchor) return;
				const gateDecl = findEmbeddedSearchGateDeclarator(path);
				if (!gateDecl) return;
				const init = gateDecl.node.init;
				if (isForcedTrue(init)) {
					forcedAnchors.add(anchor);
				} else if (t.isConditionalExpression(init) && isForcedTrue(init.test)) {
					forcedAnchors.add(anchor);
				}

				path.skip();
			},
		});

		for (const anchor of EMBEDDED_SEARCH_GATE_ANCHORS) {
			if (!forcedAnchors.has(anchor)) {
				return `EMBEDDED_SEARCH_TOOLS gate not forced in function with: "${anchor.slice(0, 40)}..."`;
			}
		}

		return true;
	},
};
