import * as t from "@babel/types";
import { type NodePath, traverse } from "../babel.js";
import { isValidPromptText } from "../prompt-corpus.js";
import { containsForbiddenPromptDashStyle } from "../prompt-dash-style.js";
import type { Patch } from "../types.js";
import { getObjectKeyName, getVerifyAst } from "./ast-helpers.js";

const SPACED_EM_DASH_BEFORE_LOWER_RE = /\s+\u2014\s+([a-z])/g;
const SPACED_EM_DASH_RE = /\s+\u2014\s+/g;
const NUMERIC_EN_DASH_RANGE_RE = /(\d)\s*\u2013\s*(\d)/g;
const HEADING_EM_DASH_RE = /^(#{1,6}\s+[^—\n]{1,100})\s+\u2014\s+/gm;
const BULLET_LABEL_EM_DASH_RE =
	/^(\s*(?:[-*+]\s+|\d+\.\s+)(?:`[^`\n]+`|\{[^}\n]+\}|\*\*[^*\n]+\*\*|[^—\n]{1,100}))\s+\u2014\s+/gm;

const PROMPT_PROPERTY_KEYS = new Set([
	"argumentHint",
	"description",
	"getPromptForCommand",
	"getPromptWhileMarketplaceIsPrivate",
	"getSystemPrompt",
	"instructions",
	"prompt",
	"systemPrompt",
	"text",
	"whenToUse",
]);

export function normalizePromptDashText(text: string): string {
	if (!containsForbiddenPromptDashStyle(text)) return text;

	let next = text.replace(NUMERIC_EN_DASH_RANGE_RE, "$1-$2");
	next = next.replace(/\u2013/g, "-");
	next = next.replace(HEADING_EM_DASH_RE, "$1: ");
	next = next.replace(BULLET_LABEL_EM_DASH_RE, "$1: ");
	next = next.replace(
		SPACED_EM_DASH_BEFORE_LOWER_RE,
		(_match, char: string) => `. ${char.toUpperCase()}`,
	);
	next = next.replace(SPACED_EM_DASH_RE, ". ");
	return next.replace(/\u2014/g, "-");
}

function escapeTemplateRaw(text: string): string {
	return text
		.replace(/\\/g, "\\\\")
		.replace(/`/g, "\\`")
		.replace(/\$\{/g, "\\${");
}

function getObjectPropertyKey(path: NodePath<t.Node>): string | null {
	const node = path.node;
	if (t.isObjectProperty(node) || t.isObjectMethod(node)) {
		return getObjectKeyName(node.key);
	}
	return null;
}

function hasPromptKeyAncestor(path: NodePath<t.Node>): boolean {
	let current: NodePath<t.Node> | null = path;
	while (current) {
		const key = getObjectPropertyKey(current);
		if (key && PROMPT_PROPERTY_KEYS.has(key)) return true;

		if (current.isFunction()) {
			const parent = current.parentPath;
			if (parent) {
				const parentKey = getObjectPropertyKey(parent);
				if (parentKey && PROMPT_PROPERTY_KEYS.has(parentKey)) return true;
			}
		}

		current = current.parentPath;
	}
	return false;
}

function isInstructionalSnippet(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.length < 20) return false;
	if (!/[A-Za-z]/.test(trimmed) || !/\s/.test(trimmed)) return false;

	const lower = trimmed.toLowerCase();
	return (
		trimmed.startsWith("#") ||
		trimmed.startsWith("<system-reminder>") ||
		trimmed.startsWith("You are ") ||
		trimmed.startsWith("Your job ") ||
		trimmed.startsWith("Your task ") ||
		lower.includes("must") ||
		lower.includes("should") ||
		lower.includes("always") ||
		lower.includes("do not") ||
		lower.includes("tool") ||
		lower.includes("agent") ||
		lower.includes("prompt")
	);
}

function isDashBearingProse(text: string): boolean {
	const trimmed = text.trim();
	return (
		trimmed.length >= 20 &&
		/[A-Za-z]/.test(trimmed) &&
		/\s/.test(trimmed) &&
		!trimmed.startsWith("data:") &&
		!trimmed.startsWith("http://") &&
		!trimmed.startsWith("https://")
	);
}

function isPromptDashCandidate(text: string, path: NodePath<t.Node>): boolean {
	if (!containsForbiddenPromptDashStyle(text)) return false;
	if (isValidPromptText(text, 80)) return true;
	if (isDashBearingProse(text)) return true;
	return hasPromptKeyAncestor(path) && isInstructionalSnippet(text);
}

function templateText(node: t.TemplateLiteral): string {
	return node.quasis
		.map((quasi, index) => {
			const text = quasi.value.cooked ?? quasi.value.raw;
			return index < node.expressions.length ? `${text}\${}` : text;
		})
		.join("");
}

function findResidualPromptDash(ast: t.File): string | null {
	let residual: string | null = null;
	traverse(ast, {
		StringLiteral(path) {
			if (residual) {
				path.skip();
				return;
			}
			if (!isPromptDashCandidate(path.node.value, path)) return;
			residual = path.node.value.trim().replace(/\s+/g, " ").slice(0, 140);
		},
		TemplateLiteral(path) {
			if (residual) {
				path.skip();
				return;
			}
			const text = templateText(path.node);
			if (!isPromptDashCandidate(text, path)) return;
			residual = text.trim().replace(/\s+/g, " ").slice(0, 140);
		},
	});
	return residual;
}

export const promptDashStyle: Patch = {
	tag: "prompt-dash-style",

	astPasses: () => [
		{
			// Register node visitors directly in the shared finalize pass instead of
			// a Program.exit hook that runs its own full traverse. prompt-dash-style
			// is the only finalize patch, so this is the finalize traversal: one walk
			// instead of two over the ~690K-node tree.
			pass: "finalize" as const,
			visitor: {
				StringLiteral(path) {
					if (!isPromptDashCandidate(path.node.value, path)) return;
					path.node.value = normalizePromptDashText(path.node.value);
				},
				TemplateLiteral(path) {
					const text = templateText(path.node);
					if (!isPromptDashCandidate(text, path)) return;

					for (const quasi of path.node.quasis) {
						const original = quasi.value.cooked ?? quasi.value.raw;
						const next = normalizePromptDashText(original);
						if (next === original) continue;
						quasi.value.cooked = next;
						quasi.value.raw = escapeTemplateRaw(next);
					}
				},
			},
		},
	],

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) return "Unable to parse AST during verification";

		const residual = findResidualPromptDash(verifyAst);
		if (residual) {
			return `Prompt text still contains Unicode dash punctuation: ${residual}`;
		}

		return true;
	},
};
