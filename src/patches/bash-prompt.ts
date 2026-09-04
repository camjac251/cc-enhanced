import * as t from "@babel/types";
import { type NodePath, traverse } from "../babel.js";
import type { Patch } from "../types.js";
import { getVerifyAst } from "./ast-helpers.js";
import {
	BACKGROUND_TASK_POLICY,
	MODERN_BASH_SEARCH_GUIDANCE,
	MODERN_CODE_SEARCH_POLICY,
	MODERN_DEDICATED_TOOLS_NUDGE_PARTS,
	MODERN_FINDING_TOOLS,
	MODERN_OUTPUT_LIMIT_WARNING,
	MODERN_TOOL_PREFERENCE,
} from "./prompt-policy.js";

const LEGACY_TOKEN_WARNING_RE =
	/Pipe output through head, tail, or grep to reduce result size\. Avoid cat on large files (?:—|\\u2014) use Read with offset\/limit instead\./g;

const LEGACY_POWERSHELL_TOKEN_WARNING_RE =
	/Pipe output through Select-Object -First\/-Last or Select-String to reduce result size\. Avoid Get-Content on large files (?:—|\\u2014) use Read with offset\/limit instead\./g;

const LEGACY_WORKING_DIRECTORY_GUIDANCE =
	"The working directory persists between commands, but shell state does not. The shell environment is initialized from the user's profile (bash or zsh).";

const RUNTIME_NEUTRAL_WORKING_DIRECTORY_GUIDANCE =
	"Working-directory behavior is controlled by runtime policy. Do not rely on `cd`, shell variables, or other shell state carrying between calls; use explicit paths.";

const STOCK_BACKGROUND_EXECUTION_GUIDANCE =
	"You can use the `run_in_background` parameter to run the command in the background. Only use this if you don't need the result immediately and are OK being notified when the command completes later. You do not need to check the output right away - you'll be notified when it finishes. You do not need to use '&' at the end of the command when using this parameter.";

const STOCK_ONE_SHOT_BACKGROUND_GUIDANCE =
	'Use the Monitor tool to stream events from a background process (each stdout line is a notification). For one-shot "wait until done," use Bash with run_in_background instead.';

const MODERN_ONE_SHOT_FOREGROUND_GUIDANCE =
	"Use the Monitor tool to stream events from a background process (each stdout line is a notification). For a one-shot result needed now, run Bash in the foreground with an appropriate timeout.";

const FULL_BASH_PROMPT_ANCHOR = "Executes a given bash command";

// Functions containing these anchors have an EMBEDDED_SEARCH_TOOLS gate (Yz()
// or equivalent) as the init of their first VariableDeclarator.  Since tools-off
// disables Glob/Grep, we force the gate to true so tool-list conditionals pick
// the branch that omits Glob/Grep names.
const EMBEDDED_SEARCH_GATE_ANCHORS = [
	FULL_BASH_PROMPT_ANCHOR, // Bash prompt builder
	"You are the Claude guide agent", // Guide agent prompt
	"# Using your tools", // System prompt tool-guidance section
];

const PROMPT_TEXT_ANCHORS = [
	"Executes a bash command", // Short Bash prompt surface
	...EMBEDDED_SEARCH_GATE_ANCHORS,
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
	"Serena",
	"raw LSP",
	"ChunkHound",
	"`fd`, `rg`, `ast-grep`, `eza`, and `bat`",
];

const MODERN_BASH_IMPORTANT_LINE =
	"IMPORTANT: Prefer dedicated symbol/semantic tools and modern CLI utilities whenever possible. Recommended defaults:";

const MODERN_GUIDE_FINDING_TOOLS = MODERN_FINDING_TOOLS;

const LEAN_BASH_PROMPT_SURFACE =
	"Executes a bash command and returns its output.";

/** Routing block for the current lean Bash builder. */
const MODERN_LEAN_BASH_GUIDANCE = [
	`- ${MODERN_BASH_IMPORTANT_LINE}`,
	`- ${MODERN_TOOL_PREFERENCE}`,
	"- For changes: Edit for one known site; ast-grep run -r for a repeated shape (preview, then -U); comby for malformed or mixed syntax; sd only for non-code text",
	`- ${MODERN_CODE_SEARCH_POLICY}`,
].join("\n");

const STRICT_BASH_FIRST_NUDGE_PATTERN =
	"Do your work through the ${} tool wherever it can accomplish the job: read files with cat, head, or sed -n, search with grep and find, and make file changes with sed, heredocs, or short scripts, rather than using the dedicated ${}, ${}, or ${} tools. Fall back to a dedicated tool only when ${} genuinely cannot do the job.";
const RELAXED_BASH_FIRST_NUDGE_PATTERN =
	"You can do much of your work through the ${} tool when it is the simpler route: read files with cat, head, or sed -n, search with grep and find, and make small, mechanical file changes with sed, heredocs, or short scripts instead of the dedicated ${}, ${}, or ${} tools. The choice is yours: prefer ${} or ${} when a shell edit would be fragile, such as exact or multi-line replacements, or sed/awk flags that differ between GNU and BSD/macOS.";
const BASH_FIRST_NUDGE_SOURCE_PATTERNS = [
	STRICT_BASH_FIRST_NUDGE_PATTERN,
	RELAXED_BASH_FIRST_NUDGE_PATTERN,
] as const;
const LEGACY_BASH_FIRST_NUDGE_SIGNAL =
	"read files with cat, head, or sed -n, search with grep and find";
const BASH_FIRST_NUDGE_SURFACE_ANCHOR = "While auto mode is active:";
const MODERN_DEDICATED_TOOLS_NUDGE_PATTERN =
	MODERN_DEDICATED_TOOLS_NUDGE_PARTS.join("${}");

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

function createTwoExpressionTemplate(
	first: t.Expression | t.TSType,
	second: t.Expression | t.TSType,
	before: string,
	between: string,
	after: string,
): t.TemplateLiteral {
	return t.templateLiteral(
		[
			t.templateElement(
				{ raw: escapeTemplateRaw(before), cooked: before },
				false,
			),
			t.templateElement(
				{ raw: escapeTemplateRaw(between), cooked: between },
				false,
			),
			t.templateElement({ raw: escapeTemplateRaw(after), cooked: after }, true),
		],
		[first, second],
	);
}

function rewriteLegacyText(text: string): string {
	let next = text
		.replace(
			"If your command will create new directories or files, first use this tool to run `ls` to verify the parent directory exists and is the correct location.",
			"If your command will create new directories or files, first use this tool to run `eza` or `fd` to verify the parent directory exists and is the correct location.",
		)
		.replace(
			/When running `find`, search from `\.` \(or a specific path\), not `\/`(?:\.|\s+(?:\u2014|\\u2014))\s+[Ss]canning the full filesystem can exhaust system resources on large trees\./g,
			"Use `fd` for file discovery. If an explicit user request or portability constraint requires `find`, search from `.` (or a specific path), not `/`.",
		)
		.replace(
			"Communication: Output text directly (NOT echo/printf)",
			"Communication: Output text directly",
		)
		.replace(
			STOCK_ONE_SHOT_BACKGROUND_GUIDANCE,
			MODERN_ONE_SHOT_FOREGROUND_GUIDANCE,
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

function containsAnchor(path: NodePath<t.Function>): boolean {
	let found = false;
	path.traverse({
		StringLiteral(inner) {
			for (const anchor of PROMPT_TEXT_ANCHORS) {
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
				for (const anchor of PROMPT_TEXT_ANCHORS) {
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

function nodeContainsPromptText(
	node: t.Node | null | undefined,
	text: string,
): boolean {
	const visit = (value: unknown): boolean => {
		if (!value) return false;
		if (Array.isArray(value)) return value.some((item) => visit(item));
		if (typeof value !== "object") return false;
		const maybeNode = value as t.Node;
		if (typeof (maybeNode as { type?: unknown }).type !== "string") {
			return false;
		}
		if (t.isStringLiteral(maybeNode)) return maybeNode.value.includes(text);
		if (t.isTemplateElement(maybeNode)) {
			return (
				maybeNode.value.raw.includes(text) ||
				maybeNode.value.cooked?.includes(text) === true
			);
		}
		return Object.values(maybeNode as unknown as Record<string, unknown>).some(
			(child) => visit(child),
		);
	};
	return visit(node);
}

function directReturnedString(
	node: t.FunctionDeclaration,
	text: string,
): t.StringLiteral | null {
	if (node.params.length !== 0) return null;
	for (const statement of node.body.body) {
		if (
			t.isReturnStatement(statement) &&
			t.isStringLiteral(statement.argument, { value: text })
		) {
			return statement.argument;
		}
	}
	return null;
}

function isBackgroundGuidanceHelperForBash(
	path: NodePath<t.FunctionDeclaration>,
	text: string,
): boolean {
	if (!path.node.id || !directReturnedString(path.node, text)) return false;
	const binding = path.scope.getBinding(path.node.id.name);
	if (!binding || binding.path.node !== path.node) return false;

	return binding.referencePaths.some((referencePath) => {
		const callPath = referencePath.parentPath;
		if (
			!callPath?.isCallExpression() ||
			callPath.node.callee !== referencePath.node ||
			callPath.node.arguments.length !== 0
		) {
			return false;
		}
		const consumer = callPath.findParent((parent) => parent.isFunction());
		return (
			consumer?.isFunction() === true &&
			nodeContainsPromptText(consumer.node, FULL_BASH_PROMPT_ANCHOR)
		);
	});
}

function patchBackgroundGuidanceHelper(
	path: NodePath<t.FunctionDeclaration>,
): boolean {
	if (
		!isBackgroundGuidanceHelperForBash(
			path,
			STOCK_BACKGROUND_EXECUTION_GUIDANCE,
		)
	) {
		return false;
	}
	const returned = directReturnedString(
		path.node,
		STOCK_BACKGROUND_EXECUTION_GUIDANCE,
	);
	if (!returned) return false;
	returned.value = BACKGROUND_TASK_POLICY;
	return true;
}

function inspectBackgroundGuidanceHelpers(ast: t.File): {
	legacy: number;
	policy: number;
} {
	let legacy = 0;
	let policy = 0;
	traverse(ast, {
		FunctionDeclaration(path) {
			if (
				isBackgroundGuidanceHelperForBash(
					path,
					STOCK_BACKGROUND_EXECUTION_GUIDANCE,
				)
			) {
				legacy += 1;
			}
			if (isBackgroundGuidanceHelperForBash(path, BACKGROUND_TASK_POLICY)) {
				policy += 1;
			}
		},
	});
	return { legacy, policy };
}

function isEmptyLikeBranch(node: t.Node | null | undefined): boolean {
	if (!node) return true;
	if (t.isArrayExpression(node)) return node.elements.length === 0;
	if (t.isStringLiteral(node)) return node.value.length === 0;
	if (t.isTemplateLiteral(node)) {
		return (
			node.expressions.length === 0 &&
			node.quasis.length === 1 &&
			(node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw ?? "")
				.length === 0
		);
	}
	return (
		t.isNullLiteral(node) ||
		t.isIdentifier(node, { name: "undefined" }) ||
		(t.isBooleanLiteral(node) && node.value === false)
	);
}

function isAsymmetricPresenceConditional(
	node: t.ConditionalExpression,
): boolean {
	const consequentEmpty = isEmptyLikeBranch(node.consequent);
	const alternateEmpty = isEmptyLikeBranch(node.alternate);
	return consequentEmpty !== alternateEmpty;
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

/**
 * Matches a logical combination (&&/||) whose operands are zero-arg identifier
 * calls. Upstream sometimes composes the search-tool gate from two helpers.
 */
function isZeroArgLogicalCall(
	node: t.Node | null | undefined,
): node is t.LogicalExpression {
	return (
		!!node &&
		t.isLogicalExpression(node) &&
		(node.operator === "&&" || node.operator === "||") &&
		isZeroArgIdentifierCall(node.left) &&
		isZeroArgIdentifierCall(node.right)
	);
}

/**
 * The init-level gate shape: bare zero-arg call, logical combination of two
 * zero-arg calls, or the forced-true sentinel the patcher itself injects.
 */
function isGateInitExpression(node: t.Node | null | undefined): boolean {
	return (
		isZeroArgIdentifierCall(node) ||
		isZeroArgLogicalCall(node) ||
		isForcedTrue(node as t.Expression)
	);
}

/**
 * Walk up through any LogicalExpression wrappers to find the innermost enclosing
 * ConditionalExpression for which this path sits in the `test` slot. Returns the
 * conditional only when the reference is part of its test, not a branch value.
 */
function findEnclosingConditionalTest(
	refPath: NodePath<t.Node>,
): NodePath<t.ConditionalExpression> | null {
	let current: NodePath<t.Node> | null = refPath;
	while (current) {
		const parent: NodePath<t.Node> | null = current.parentPath;
		if (!parent) return null;
		if (parent.isConditionalExpression() && parent.node.test === current.node) {
			return parent;
		}
		if (parent.isLogicalExpression()) {
			current = parent;
			continue;
		}
		return null;
	}
	return null;
}

interface GateCandidate {
	declPath: NodePath<t.VariableDeclarator>;
	/**
	 * When set, mutation targets the test of this conditional rather than the
	 * declarator init. Used when the variable is referenced through a logical
	 * combination that forms a guidance conditional's test.
	 */
	conditionalToForce?: NodePath<t.ConditionalExpression>;
	/**
	 * True when a guarded conditional's branches contain search-guidance text,
	 * not just a presence/absence shape. Prompt builders also splice in
	 * optional notices (`gate ? ["", notice] : []` from a zero-arg helper that
	 * returns null when inapplicable); those match the asymmetric-presence
	 * shape, so guidance text is the disambiguating signal when several
	 * declarators qualify.
	 */
	hasGuidance: boolean;
}

function findEmbeddedSearchGateDeclarator(
	path: NodePath<t.Function>,
): GateCandidate | null {
	const candidates: GateCandidate[] = [];

	path.traverse({
		VariableDeclarator(declPath) {
			if (!t.isIdentifier(declPath.node.id)) return;

			const binding = declPath.scope.getBinding(declPath.node.id.name);
			if (!binding || binding.path.node !== declPath.node) return;

			const init = declPath.node.init;
			if (isGateInitExpression(init)) {
				let conditionalToForce: NodePath<t.ConditionalExpression> | undefined;
				let qualifies = false;
				let hasGuidance = false;
				for (const refPath of binding.referencePaths) {
					const conditional = findEnclosingConditionalTest(refPath);
					if (!conditional) continue;
					const guidance =
						nodeContainsSearchGuidance(conditional.node.consequent) ||
						nodeContainsSearchGuidance(conditional.node.alternate);
					if (!guidance && !isAsymmetricPresenceConditional(conditional.node)) {
						continue;
					}
					// If the first qualifying reference is nested inside a logical
					// wrapper that forms the conditional test, rewrite the
					// conditional test directly: the declarator alone is not enough
					// to suppress guidance.
					if (!qualifies && conditional.node.test !== refPath.node) {
						conditionalToForce = conditional;
					}
					qualifies = true;
					if (guidance) hasGuidance = true;
				}
				if (qualifies) {
					candidates.push({ declPath, conditionalToForce, hasGuidance });
				}
				return;
			}

			if (!init || !t.isConditionalExpression(init)) return;
			const condInit = init;
			const test = condInit.test;
			if (
				!isZeroArgIdentifierCall(test) &&
				!isZeroArgLogicalCall(test) &&
				!isForcedTrue(test)
			) {
				return;
			}
			if (
				!nodeContainsSearchGuidance(condInit.consequent) &&
				!nodeContainsSearchGuidance(condInit.alternate)
			) {
				return;
			}
			candidates.push({ declPath, hasGuidance: true });
		},
	});

	if (candidates.length === 1) return candidates[0];
	const guided = candidates.filter((candidate) => candidate.hasGuidance);
	return guided.length === 1 ? (guided[0] ?? null) : null;
}

function patchGateInFunction(path: NodePath<t.Function>): boolean {
	const candidate = findEmbeddedSearchGateDeclarator(path);
	if (!candidate) return false;
	const { declPath, conditionalToForce } = candidate;
	const init = declPath.node.init;
	// When the reference is threaded through a logical wrapper that forms a
	// conditional test, force that test. Rewriting the declarator alone would
	// leave the remaining logical operands to gate the guidance at runtime.
	if (conditionalToForce) {
		conditionalToForce.node.test = t.unaryExpression("!", t.numericLiteral(0));
		return true;
	}
	if (isZeroArgIdentifierCall(init) || isZeroArgLogicalCall(init)) {
		declPath.node.init = t.unaryExpression("!", t.numericLiteral(0));
		return true;
	}
	if (
		t.isConditionalExpression(init) &&
		(isZeroArgIdentifierCall(init.test) || isZeroArgLogicalCall(init.test))
	) {
		init.test = t.unaryExpression("!", t.numericLiteral(0));
		return true;
	}
	return false;
}

const isNegatedIdentifier = (node: t.Node | null | undefined): boolean =>
	t.isUnaryExpression(node, { operator: "!" }) && t.isIdentifier(node.argument);

/** Force the current lean builder's single guidance guard. */
function forceLeanGuidanceGate(path: NodePath<t.Node>): boolean {
	const guard = path.findParent((parent) => parent.isIfStatement());
	if (!guard?.isIfStatement()) return false;
	const test = guard.node.test;
	if (!isNegatedIdentifier(test)) return false;
	guard.node.test = t.unaryExpression("!", t.numericLiteral(0));
	return true;
}

function patchPromptTextInFunction(path: NodePath<t.Function>): void {
	path.traverse({
		TemplateLiteral(templatePath) {
			const pattern = templatePattern(templatePath.node);
			switch (pattern) {
				case "- IMPORTANT: Avoid using this tool to run ${} commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user.":
					if (!forceLeanGuidanceGate(templatePath)) return;
					templatePath.replaceWith(t.stringLiteral(MODERN_LEAN_BASH_GUIDANCE));
					return;
				case "IMPORTANT: Avoid using this tool to run ${} commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user:":
					templatePath.replaceWith(t.stringLiteral(MODERN_BASH_IMPORTANT_LINE));
					return;
				case "Read files: Use ${} (NOT cat/head/tail)":
					templatePath.replaceWith(
						createSingleExpressionTemplate(
							templatePath.node.expressions[0],
							"Read files: Use ",
							" for non-code files or known code ranges; use `bat -r START:END` for shell file slices",
						),
					);
					return;
				case "Edit files: Use ${} (NOT sed/awk)":
					templatePath.replaceWith(
						createSingleExpressionTemplate(
							templatePath.node.expressions[0],
							"Edit files: Use ",
							" or `ast-grep run` for repeated structural code rewrites; use `sd` only for non-code text",
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
						t.stringLiteral(
							"For shell-native file discovery use `fd` and `eza`.",
						),
					);
					return;
				case "Content search: Use ${} (NOT grep or rg)":
					templatePath.replaceWith(
						t.stringLiteral(MODERN_BASH_SEARCH_GUIDANCE),
					);
					return;
				case "Prefer dedicated tools over ${} when one fits (${}) — reserve ${} for shell-only operations.":
					templatePath.replaceWith(
						createTwoExpressionTemplate(
							templatePath.node.expressions[0],
							templatePath.node.expressions[2],
							"Prefer dedicated tools over ",
							" when one fits — reserve ",
							" for shell-only operations.",
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

	// Upstream wraps the modern-tools guidance behind a gate that is true when
	// bundled search tools are available: `...(gate ? [] : [modernGuidance])`.
	// tools-off disables those search tools, so the fallback guidance is what
	// the model should see. Unwrap the conditional so the guidance renders.
	path.traverse({
		ConditionalExpression(conditionalPath) {
			const { consequent, alternate } = conditionalPath.node;
			if (!t.isArrayExpression(consequent) || consequent.elements.length !== 0)
				return;
			if (!t.isArrayExpression(alternate)) return;
			const firstEl = alternate.elements[0];
			if (!firstEl || !t.isStringLiteral(firstEl)) return;
			if (
				!firstEl.value.startsWith("For shell-native") &&
				!firstEl.value.startsWith("For source code")
			)
				return;
			if (!t.isSpreadElement(conditionalPath.parent)) return;
			conditionalPath.replaceWith(alternate);
		},
	});
}

/**
 * Runtime policy governs working-directory behavior, so the full Bash builder's
 * working-directory guidance is replaced with the runtime-neutral wording. The
 * builder is identified by its "Executes a given bash command" surface, and the
 * guidance line by a durable fragment ("working directory persists between" plus
 * "the user's profile") so an upstream reword of the exact sentence does not
 * silently skip the replacement.
 */
function forceRuntimeNeutralWorkingDirectory(path: NodePath<t.Function>): void {
	let isFullBuilder = false;
	path.traverse({
		StringLiteral(inner) {
			if (inner.node.value.startsWith("Executes a given bash command")) {
				isFullBuilder = true;
				inner.stop();
			}
		},
	});
	if (!isFullBuilder) return;

	path.traverse({
		StringLiteral(inner) {
			const lower = inner.node.value.toLowerCase();
			if (
				lower.includes("working directory persists between") &&
				lower.includes("the user's profile")
			) {
				inner.node.value = RUNTIME_NEUTRAL_WORKING_DIRECTORY_GUIDANCE;
				inner.stop();
			}
		},
	});
}

function findAnchor(path: NodePath<t.Function>): string | null {
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

function sourceIncludesPromptText(code: string, text: string): boolean {
	return (
		code.includes(text) || code.includes(JSON.stringify(text).slice(1, -1))
	);
}

/** Rewrite both current bash-first variants to one dedicated-tool policy. */
function rewriteBashFirstNudge(path: NodePath<t.TemplateLiteral>): boolean {
	const pattern = templatePattern(path.node);
	const expressions = path.node.expressions;
	let replacementExpressions: Array<t.Expression | t.TSType>;
	if (pattern === STRICT_BASH_FIRST_NUDGE_PATTERN) {
		if (
			expressions.length !== 5 ||
			!t.isNodesEquivalent(expressions[0], expressions[4])
		) {
			return false;
		}
		replacementExpressions = expressions;
	} else if (pattern === RELAXED_BASH_FIRST_NUDGE_PATTERN) {
		if (
			expressions.length !== 6 ||
			!t.isNodesEquivalent(expressions[2], expressions[4]) ||
			!t.isNodesEquivalent(expressions[3], expressions[5])
		) {
			return false;
		}
		replacementExpressions = [...expressions.slice(0, 4), expressions[0]];
	} else {
		return false;
	}

	const quasis = MODERN_DEDICATED_TOOLS_NUDGE_PARTS.map((part, index) =>
		t.templateElement(
			{ raw: escapeTemplateRaw(part), cooked: part },
			index === MODERN_DEDICATED_TOOLS_NUDGE_PARTS.length - 1,
		),
	);
	path.replaceWith(
		t.templateLiteral(
			quasis,
			replacementExpressions.map((expression) => t.cloneNode(expression, true)),
		),
	);
	return true;
}

function inspectBashFirstNudge(ast: t.File): {
	legacy: number;
	modern: number;
} {
	let legacy = 0;
	let modern = 0;
	traverse(ast, {
		TemplateLiteral(path) {
			const pattern = templatePattern(path.node);
			if (
				BASH_FIRST_NUDGE_SOURCE_PATTERNS.some((source) => source === pattern)
			) {
				legacy += 1;
			} else if (pattern === MODERN_DEDICATED_TOOLS_NUDGE_PATTERN) {
				modern += 1;
			}
		},
	});
	return { legacy, modern };
}

function inspectLeanBuilderGuidance(ast: t.File): {
	guidance: number;
	forced: number;
} {
	let guidance = 0;
	let forced = 0;
	traverse(ast, {
		StringLiteral(path) {
			if (path.node.value !== MODERN_LEAN_BASH_GUIDANCE) return;
			guidance += 1;
			const guard = path.findParent((parent) => parent.isIfStatement());
			if (!guard?.isIfStatement() || isForcedTrue(guard.node.test)) {
				forced += 1;
			}
		},
	});
	return { guidance, forced };
}

export const bashPrompt: Patch = {
	tag: "bash-prompt",
	string: (code) =>
		code
			.replace(LEGACY_TOKEN_WARNING_RE, MODERN_OUTPUT_LIMIT_WARNING)
			.replace(LEGACY_POWERSHELL_TOKEN_WARNING_RE, MODERN_OUTPUT_LIMIT_WARNING),

	// Use a Function visitor directly so the combined-pass engine visits each
	// function node natively, avoiding nested traverse conflicts.
	astPasses: () => [
		{
			pass: "mutate" as const,
			visitor: {
				Function(path: NodePath<t.Function>) {
					if (
						path.isFunctionDeclaration() &&
						patchBackgroundGuidanceHelper(path)
					) {
						path.skip();
						return;
					}
					if (!containsAnchor(path)) return;
					patchGateInFunction(path);
					patchPromptTextInFunction(path);
					forceRuntimeNeutralWorkingDirectory(path);
					path.skip();
				},
				TemplateLiteral(path: NodePath<t.TemplateLiteral>) {
					rewriteBashFirstNudge(path);
				},
			},
		},
	],

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) return "Unable to parse AST during verification";
		if (
			code.includes("Pipe output through head, tail, or grep") ||
			code.includes("Pipe output through Select-Object -First/-Last")
		) {
			return "Legacy oversized-output guidance still present";
		}
		if (code.includes(LEGACY_WORKING_DIRECTORY_GUIDANCE)) {
			return "Legacy Bash working-directory guidance still present";
		}
		const backgroundGuidance = inspectBackgroundGuidanceHelpers(verifyAst);
		if (backgroundGuidance.legacy > 0) {
			return "Legacy Bash background execution guidance still present";
		}
		if (backgroundGuidance.policy === 0) {
			return "Expected shared background execution policy missing from Bash prompt";
		}
		if (backgroundGuidance.policy !== 1) {
			return `Expected one Bash background execution policy helper, found ${backgroundGuidance.policy}`;
		}
		if (
			code.includes("Executes a given bash command") &&
			!code.includes(RUNTIME_NEUTRAL_WORKING_DIRECTORY_GUIDANCE)
		) {
			return "Runtime-neutral Bash working-directory guidance missing";
		}

		if (
			code.includes("find or ls") ||
			code.includes("grep or rg") ||
			code.includes("(NOT cat/head/tail)") ||
			code.includes("(NOT sed/awk)") ||
			code.includes("(NOT echo >/cat <<EOF)") ||
			code.includes("find -regex") ||
			code.includes("When running `find`") ||
			code.includes("run `ls` to verify") ||
			code.includes("appropriate dedicated tool") ||
			code.includes("when one fits (")
		) {
			return "Legacy Bash prompt guidance still present";
		}

		if (
			!code.includes(MODERN_BASH_IMPORTANT_LINE) ||
			!code.includes("For shell-native file discovery use `fd` and `eza`.") ||
			!sourceIncludesPromptText(code, MODERN_BASH_SEARCH_GUIDANCE)
		) {
			return "Expected modern CLI Bash guidance missing";
		}
		const nudge = inspectBashFirstNudge(verifyAst);
		if (nudge.legacy > 0 || code.includes(LEGACY_BASH_FIRST_NUDGE_SIGNAL)) {
			return "Legacy bash-first auto-mode guidance still present";
		}
		if (
			code.includes(BASH_FIRST_NUDGE_SURFACE_ANCHOR) &&
			nudge.modern !== BASH_FIRST_NUDGE_SOURCE_PATTERNS.length
		) {
			return `Expected ${BASH_FIRST_NUDGE_SOURCE_PATTERNS.length} dedicated-tools auto-mode guidance templates, found ${nudge.modern}`;
		}
		if (code.includes(LEAN_BASH_PROMPT_SURFACE)) {
			const lean = inspectLeanBuilderGuidance(verifyAst);
			if (lean.guidance !== 1) {
				return `Expected one lean Bash builder routing block, found ${lean.guidance}`;
			}
			if (lean.forced !== 1) {
				return "Lean Bash builder routing gate not forced";
			}
		}
		// AST check: verify the embedded-search gate in each anchored function
		// has been forced. Mutation may have forced any of these locations:
		//   - declarator init itself (`H = !0`)
		//   - conditional-init test (`H = !0 ? ... : ...`)
		//   - a guidance conditional's test directly (`!0 ? [] : [...]`)
		// After mutation the pre-patch reference shape is gone, so scan the
		// function for evidence of forcing rather than re-detecting the gate.
		const forcedAnchors = new Set<string>();
		let legacyOneShotGuidanceFound = false;
		let modernOneShotGuidanceFound = false;
		traverse(verifyAst, {
			Function(path) {
				const anchor = findAnchor(path);
				if (!anchor) return;
				if (anchor === FULL_BASH_PROMPT_ANCHOR) {
					legacyOneShotGuidanceFound = nodeContainsPromptText(
						path.node,
						STOCK_ONE_SHOT_BACKGROUND_GUIDANCE,
					);
					modernOneShotGuidanceFound = nodeContainsPromptText(
						path.node,
						MODERN_ONE_SHOT_FOREGROUND_GUIDANCE,
					);
				}

				let forced = false;
				path.traverse({
					VariableDeclarator(decl) {
						if (forced) {
							decl.stop();
							return;
						}
						if (!t.isIdentifier(decl.node.id)) return;
						const init = decl.node.init;
						if (isForcedTrue(init)) {
							// Declarator forced to !0. Confirm it participates in a
							// guidance conditional via a direct reference test.
							const binding = decl.scope.getBinding(decl.node.id.name);
							if (!binding) return;
							const guardsGuidance = binding.referencePaths.some((refPath) => {
								const conditional = refPath.findParent((parent) =>
									parent.isConditionalExpression(),
								);
								if (!conditional?.isConditionalExpression()) return false;
								if (conditional.node.test !== refPath.node) return false;
								return (
									nodeContainsSearchGuidance(conditional.node.consequent) ||
									nodeContainsSearchGuidance(conditional.node.alternate) ||
									isAsymmetricPresenceConditional(conditional.node)
								);
							});
							if (guardsGuidance) forced = true;
							return;
						}
						if (
							t.isConditionalExpression(init) &&
							isForcedTrue(init.test) &&
							(nodeContainsSearchGuidance(init.consequent) ||
								nodeContainsSearchGuidance(init.alternate))
						) {
							forced = true;
						}
					},
					ConditionalExpression(cond) {
						if (forced) {
							cond.stop();
							return;
						}
						if (!isForcedTrue(cond.node.test)) return;
						if (
							nodeContainsSearchGuidance(cond.node.consequent) ||
							nodeContainsSearchGuidance(cond.node.alternate) ||
							isAsymmetricPresenceConditional(cond.node)
						) {
							forced = true;
						}
					},
				});

				if (forced) forcedAnchors.add(anchor);
				path.skip();
			},
		});

		for (const anchor of EMBEDDED_SEARCH_GATE_ANCHORS) {
			if (!forcedAnchors.has(anchor)) {
				return `EMBEDDED_SEARCH_TOOLS gate not forced in function with: "${anchor.slice(0, 40)}..."`;
			}
		}
		if (legacyOneShotGuidanceFound) {
			return "Legacy one-shot Bash background guidance still present";
		}
		if (!modernOneShotGuidanceFound) {
			return "Expected one-shot foreground Bash guidance missing";
		}
		return true;
	},
};
